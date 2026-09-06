// Payroll-3D-3 (2026-09-05) — Timesheet approval scope model.
//
// The manager approval unit is (clubId × payPeriodId × departmentId).
// Scope derived from `PayrollTimesheetEntry.employmentAssignmentId ->
// EmployeeEmploymentAssignment.departmentId` — NEVER from
// `Employee.departmentId` (brief §4, §53). An employee whose primary
// department is Food & Beverage but whose worked assignment for a
// given entry is Banquets appears in the Banquets scope, not F&B.
//
// This module provides:
//   - listReviewableScopes(club, period)         — one entry per scope
//   - getScopeReview(club, period, dept)         — full manager view
//   - computeScopeRevision(club, period, dept)   — deterministic hash
//   - assessReadiness(scope)                     — approval-ready or not
//
// Revision hash (§72): a manager approval attests to a specific
// revision of the source facts. When a correction is approved or a
// new session is materialised, the hash changes. On approval, we
// snapshot the hash into PayrollDepartmentTimeApproval.approvedRevision;
// a subsequent read of the scope compares current-vs-approved and
// invalidates via manager-approval.ts if they drift.

import { createHash } from "node:crypto";
import { prisma } from "../prisma";
import { NotFoundError } from "../errors";

export interface ScopeExceptionSummary {
  missingClockOutCount:  number;
  openBreakCount:        number;
  missingAssignmentCount: number;
}

export interface ScopeEmployeeSummary {
  employeeId:      string;
  employeeNumber:  string | null;
  firstName:       string;
  lastName:        string;
  recordedSeconds: number;
  entryCount:      number;
  exceptionCount:  number;
  pendingCorrectionCount: number;
}

export interface ScopeEntry {
  id:                     string;
  employeeId:             string;
  workDate:               Date;
  clockInAt:              Date;
  clockOutAt:             Date;
  recordedSeconds:        number;
  breakSeconds:           number;
  employmentAssignmentId: string | null;
  earningClassification:  string;
}

export interface ScopeCorrection {
  id:                    string;
  employeeId:            string;
  requestType:           string;
  requestedOccurredAt:   Date | null;
  originalClockEventId:  string | null;
  reason:                string;
  status:                "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED";
  createdAt:             Date;
}

export interface ReadinessBlockingReason {
  kind:  "MISSING_CLOCK_OUT" | "OPEN_BREAK" | "MISSING_ASSIGNMENT" | "PENDING_CORRECTION";
  count: number;
  detail: string;
}

export interface ApprovalRecordView {
  id:                 string;
  state:              "APPROVED" | "REOPENED" | "REVIEW_REQUIRED";
  approvedAt:         Date;
  approvedByUserId:   string;
  approvedRevision:   string | null;
  workIntakeItemId:   string | null;
  reopenedAt:         Date | null;
  reopenedByUserId:   string | null;
  reopenReason:       string | null;
}

export interface ScopeReview {
  clubId:            string;
  payPeriodId:       string;
  departmentId:      string;
  departmentCode:    string;
  departmentName:    string;
  payPeriod: {
    periodStart: Date; periodEnd: Date; payDate: Date;
    taxYear: number; sequenceInYear: number;
  };
  employees:         ScopeEmployeeSummary[];
  entries:           ScopeEntry[];
  pendingCorrections: ScopeCorrection[];
  totalRecordedSeconds: number;
  exceptionSummary:   ScopeExceptionSummary;
  currentRevision:    string;
  approval:          ApprovalRecordView | null;
  readiness:         {
    ready:            boolean;
    blockingReasons:  ReadinessBlockingReason[];
    approvalValid:    boolean; // approvedRevision == currentRevision
  };
}

// -------------------------------------------------------------------
// Scope enumeration
// -------------------------------------------------------------------
export interface ReviewableScope {
  clubId:            string;
  payPeriodId:       string;
  departmentId:      string;
  departmentCode:    string;
  departmentName:    string;
  employeeCount:     number;
  entryCount:        number;
  exceptionCount:    number;
  pendingCorrectionCount: number;
  recordedSeconds:   number;
  currentRevision:   string;
}

export async function listReviewableScopes(
  clubId: string, payPeriodId: string,
): Promise<ReviewableScope[]> {
  const period = await prisma.payrollPayPeriod.findFirst({
    where: { id: payPeriodId, clubId },
    select: { id: true },
  });
  if (!period) throw new NotFoundError("PayrollPayPeriod", payPeriodId);

  // Timesheet entries with resolvable department scope.
  const entries = await prisma.payrollTimesheetEntry.findMany({
    where: { clubId, timesheet: { payPeriodId } },
    select: {
      id: true, employeeId: true, recordedSeconds: true,
      employmentAssignmentId: true,
      employmentAssignment: { select: { departmentId: true } },
    },
  });

  // Group by departmentId (null → UNASSIGNED synthetic bucket).
  const byDept = new Map<string | null, {
    employees: Set<string>;
    entries:   number;
    exceptions: number;
    recordedSeconds: number;
    pendingCorrections: number;
  }>();
  for (const e of entries) {
    const did = e.employmentAssignment?.departmentId ?? null;
    const row = byDept.get(did) ?? {
      employees: new Set<string>(), entries: 0, exceptions: 0,
      recordedSeconds: 0, pendingCorrections: 0,
    };
    row.employees.add(e.employeeId);
    row.entries += 1;
    row.recordedSeconds += e.recordedSeconds;
    if (!e.employmentAssignmentId) row.exceptions += 1;
    byDept.set(did, row);
  }

  // Timesheets that carry exceptions from open-session state — walk
  // TimeClockEvent live via the materializer's guarantee: NEEDS_ATTENTION
  // status marks any timesheet with unresolved issues. Count them into
  // the exception tally so managers see live open-session cards.
  const noisyTimesheets = await prisma.payrollTimesheet.findMany({
    where: { clubId, payPeriodId, status: "NEEDS_ATTENTION" },
    select: {
      employeeId: true,
      entries: {
        select: { employmentAssignmentId: true, employmentAssignment: { select: { departmentId: true } } },
      },
    },
  });
  for (const t of noisyTimesheets) {
    // Attribute exception to the FIRST entry's department (fallback null).
    const first = t.entries[0];
    const did = first?.employmentAssignment?.departmentId ?? null;
    const row = byDept.get(did) ?? {
      employees: new Set<string>(), entries: 0, exceptions: 0,
      recordedSeconds: 0, pendingCorrections: 0,
    };
    row.exceptions += 1;
    row.employees.add(t.employeeId);
    byDept.set(did, row);
  }

  // Pending corrections attributed to work assignment's department.
  const pendingCorr = await prisma.timeClockCorrectionRequest.findMany({
    where: { clubId, status: "PENDING" },
    select: {
      employeeId: true,
      employmentAssignmentId: true,
      originalClockEventId: true,
    },
  });
  const assnDeptCache = new Map<string, string | null>();
  const eventDeptCache = new Map<string, string | null>();
  for (const c of pendingCorr) {
    let did: string | null = null;
    if (c.employmentAssignmentId) {
      let cached = assnDeptCache.get(c.employmentAssignmentId);
      if (cached === undefined) {
        const a = await prisma.employeeEmploymentAssignment.findUnique({
          where: { id: c.employmentAssignmentId }, select: { departmentId: true },
        });
        cached = a?.departmentId ?? null;
        assnDeptCache.set(c.employmentAssignmentId, cached);
      }
      did = cached;
    } else if (c.originalClockEventId) {
      let cached = eventDeptCache.get(c.originalClockEventId);
      if (cached === undefined) {
        const ev = await prisma.timeClockEvent.findUnique({
          where: { id: c.originalClockEventId },
          select: { employmentAssignment: { select: { departmentId: true } } },
        });
        cached = ev?.employmentAssignment?.departmentId ?? null;
        eventDeptCache.set(c.originalClockEventId, cached);
      }
      did = cached;
    }
    // Only count a correction against a scope that already has time
    // in it (avoid inventing scopes from correction-only rows).
    const row = byDept.get(did);
    if (row) {
      row.pendingCorrections += 1;
      row.employees.add(c.employeeId);
    }
  }

  const departmentIds = Array.from(byDept.keys()).filter((k): k is string => !!k);
  const departments = departmentIds.length
    ? await prisma.department.findMany({
        where: { id: { in: departmentIds }, clubId },
        select: { id: true, code: true, name: true },
      })
    : [];
  const deptById = new Map(departments.map((d) => [d.id, d]));

  const out: ReviewableScope[] = [];
  for (const [did, row] of byDept.entries()) {
    if (!did) continue; // suppress synthetic UNASSIGNED bucket — the entries surface as exceptions in the assigned scopes' cards
    const d = deptById.get(did);
    if (!d) continue;
    const rev = await computeScopeRevision(clubId, payPeriodId, did);
    out.push({
      clubId, payPeriodId, departmentId: did,
      departmentCode: d.code, departmentName: d.name,
      employeeCount: row.employees.size,
      entryCount: row.entries,
      exceptionCount: row.exceptions,
      pendingCorrectionCount: row.pendingCorrections,
      recordedSeconds: row.recordedSeconds,
      currentRevision: rev,
    });
  }
  out.sort((a, b) => a.departmentCode.localeCompare(b.departmentCode));
  return out;
}

// -------------------------------------------------------------------
// Revision hash (§72)
//
// Payroll-3D-3B Slice 7A (2026-09-06) — accepts an optional Prisma
// transaction client. Callers that need atomic revision reads inside
// a wider transaction (e.g., approveTimesheetScope's pre-check +
// post-write verify) pass their tx so the revision reads observe the
// transaction's snapshot of the material state. Callers that only
// need a snapshot pass no tx and use the global client.
// -------------------------------------------------------------------
type PrismaTxOrClient = typeof prisma | Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

export async function computeScopeRevision(
  clubId: string, payPeriodId: string, departmentId: string,
  tx?: PrismaTxOrClient,
): Promise<string> {
  const client = tx ?? prisma;
  // Materialised entries in the scope (stable ordered).
  const entries = await client.payrollTimesheetEntry.findMany({
    where: {
      clubId, timesheet: { payPeriodId },
      OR: [
        { employmentAssignment: { departmentId } },
        // Pull in null-assignment entries only if the exception is
        // being surfaced against THIS department (unassigned entries
        // do NOT contribute to a specific dept revision).
      ],
    },
    select: {
      id: true, clockInAt: true, clockOutAt: true,
      recordedSeconds: true, breakSeconds: true,
      employmentAssignmentId: true,
    },
    orderBy: [{ employeeId: "asc" }, { clockInAt: "asc" }],
  });

  // Pending correction requests that would affect entries whose
  // resolution scope is THIS department. We hash id+status+updatedAt
  // so a decision (approve/reject/cancel) flips the revision.
  // TimeClockCorrectionRequest.employmentAssignmentId is a scalar
  // with no relation on the model — resolve department via a subquery
  // on the assignment ids that are in this department.
  const deptAssignmentIds = await client.employeeEmploymentAssignment.findMany({
    where: { clubId, departmentId }, select: { id: true },
  });
  const assnIds = deptAssignmentIds.map((a) => a.id);
  const pendingCorrs = assnIds.length ? await client.timeClockCorrectionRequest.findMany({
    where: {
      clubId,
      status: { in: ["PENDING"] },
      OR: [
        { employmentAssignmentId: { in: assnIds } },
        { originalClockEvent: { employmentAssignmentId: { in: assnIds } } },
      ],
    },
    select: { id: true, status: true, updatedAt: true },
    orderBy: { id: "asc" },
  }) : [];

  const h = createHash("sha256");
  h.update(`club=${clubId}\n`);
  h.update(`period=${payPeriodId}\n`);
  h.update(`dept=${departmentId}\n`);
  for (const e of entries) {
    h.update([
      "E", e.id,
      e.clockInAt.toISOString(),
      e.clockOutAt.toISOString(),
      String(e.recordedSeconds),
      String(e.breakSeconds),
      String(e.employmentAssignmentId ?? ""),
    ].join("|") + "\n");
  }
  for (const c of pendingCorrs) {
    h.update(["C", c.id, c.status, c.updatedAt.toISOString()].join("|") + "\n");
  }
  return h.digest("hex").slice(0, 32);
}

// -------------------------------------------------------------------
// Full manager view
// -------------------------------------------------------------------
export async function getScopeReview(
  clubId: string, payPeriodId: string, departmentId: string,
): Promise<ScopeReview> {
  const [period, dept] = await Promise.all([
    prisma.payrollPayPeriod.findFirst({ where: { id: payPeriodId, clubId } }),
    prisma.department.findFirst({ where: { id: departmentId, clubId } }),
  ]);
  if (!period) throw new NotFoundError("PayrollPayPeriod", payPeriodId);
  if (!dept) throw new NotFoundError("Department", departmentId);

  // Entries in scope (assignment.departmentId == this dept).
  const entryRows = await prisma.payrollTimesheetEntry.findMany({
    where: {
      clubId, timesheet: { payPeriodId },
      employmentAssignment: { departmentId },
    },
    orderBy: [{ employeeId: "asc" }, { clockInAt: "asc" }],
  });

  // Live exceptions: timesheets in this period that are NEEDS_ATTENTION
  // AND whose entries include this dept OR have no assignment at all
  // (open-session case where assignment is unknown). We use these
  // to surface exceptions the manager should resolve before approving.
  const noisyTimesheets = await prisma.payrollTimesheet.findMany({
    where: { clubId, payPeriodId, status: "NEEDS_ATTENTION" },
    select: {
      id: true, employeeId: true,
      entries: {
        select: { employmentAssignmentId: true, employmentAssignment: { select: { departmentId: true } } },
      },
    },
  });
  let missingClockOut = 0, openBreak = 0, missingAssignment = 0;
  const scopeEmployeeIds = new Set<string>();
  for (const e of entryRows) scopeEmployeeIds.add(e.employeeId);
  for (const t of noisyTimesheets) {
    const includesScope = t.entries.some((x) => x.employmentAssignment?.departmentId === departmentId)
                       || t.entries.length === 0;
    if (!includesScope) continue;
    scopeEmployeeIds.add(t.employeeId);
    // For MVP counting, one NEEDS_ATTENTION timesheet ≈ one exception.
    // A more granular breakdown is a later polish pass — the manager
    // reads the message string in the workspace.
    missingClockOut += 1;
    if (t.entries.some((x) => !x.employmentAssignmentId)) missingAssignment += 1;
  }

  // Employees list.
  const employeeMeta = scopeEmployeeIds.size
    ? await prisma.employee.findMany({
        where: { id: { in: Array.from(scopeEmployeeIds) }, clubId },
        select: { id: true, firstName: true, lastName: true, employeeNumber: true },
      })
    : [];
  const employees: ScopeEmployeeSummary[] = employeeMeta.map((emp) => {
    const empEntries = entryRows.filter((e) => e.employeeId === emp.id);
    return {
      employeeId: emp.id,
      employeeNumber: emp.employeeNumber ?? null,
      firstName: emp.firstName,
      lastName: emp.lastName,
      recordedSeconds: empEntries.reduce((s, x) => s + x.recordedSeconds, 0),
      entryCount: empEntries.length,
      exceptionCount: noisyTimesheets.filter((t) =>
        t.employeeId === emp.id
        && (t.entries.some((x) => x.employmentAssignment?.departmentId === departmentId) || t.entries.length === 0)
      ).length,
      pendingCorrectionCount: 0, // filled below
    };
  });

  const deptAssnRows = await prisma.employeeEmploymentAssignment.findMany({
    where: { clubId, departmentId }, select: { id: true },
  });
  const deptAssnIds = deptAssnRows.map((a) => a.id);
  const pendingCorrRows = deptAssnIds.length ? await prisma.timeClockCorrectionRequest.findMany({
    where: {
      clubId, status: "PENDING",
      OR: [
        { employmentAssignmentId: { in: deptAssnIds } },
        { originalClockEvent: { employmentAssignmentId: { in: deptAssnIds } } },
      ],
    },
    orderBy: { createdAt: "asc" },
  }) : [];
  for (const c of pendingCorrRows) {
    const emp = employees.find((e) => e.employeeId === c.employeeId);
    if (emp) emp.pendingCorrectionCount += 1;
    scopeEmployeeIds.add(c.employeeId);
  }

  const approvalRow = await prisma.payrollDepartmentTimeApproval.findUnique({
    where: { clubId_payPeriodId_departmentId: { clubId, payPeriodId, departmentId } },
  });

  const currentRevision = await computeScopeRevision(clubId, payPeriodId, departmentId);

  // Blocking readiness reasons (§29, §66).
  const blocking: ReadinessBlockingReason[] = [];
  if (missingClockOut > 0) blocking.push({
    kind: "MISSING_CLOCK_OUT", count: missingClockOut,
    detail: `${missingClockOut} timesheet${missingClockOut === 1 ? "" : "s"} with unresolved missing clock-out`,
  });
  if (openBreak > 0) blocking.push({
    kind: "OPEN_BREAK", count: openBreak,
    detail: `${openBreak} unresolved open break${openBreak === 1 ? "" : "s"}`,
  });
  if (missingAssignment > 0) blocking.push({
    kind: "MISSING_ASSIGNMENT", count: missingAssignment,
    detail: `${missingAssignment} session${missingAssignment === 1 ? "" : "s"} missing an assignment`,
  });
  if (pendingCorrRows.length > 0) blocking.push({
    kind: "PENDING_CORRECTION", count: pendingCorrRows.length,
    detail: `${pendingCorrRows.length} pending correction request${pendingCorrRows.length === 1 ? "" : "s"} — decide first`,
  });

  const approvalValid = !!approvalRow
    && approvalRow.state === "APPROVED"
    && approvalRow.approvedRevision === currentRevision;

  const approval: ApprovalRecordView | null = approvalRow ? {
    id: approvalRow.id,
    state: (approvalRow.state as ApprovalRecordView["state"]),
    approvedAt: approvalRow.approvedAt,
    approvedByUserId: approvalRow.approvedByUserId,
    approvedRevision: approvalRow.approvedRevision,
    workIntakeItemId: approvalRow.workIntakeItemId,
    reopenedAt: approvalRow.reopenedAt,
    reopenedByUserId: approvalRow.reopenedByUserId,
    reopenReason: approvalRow.reopenReason,
  } : null;

  return {
    clubId, payPeriodId, departmentId,
    departmentCode: dept.code, departmentName: dept.name,
    payPeriod: {
      periodStart: period.periodStart, periodEnd: period.periodEnd, payDate: period.payDate,
      taxYear: period.taxYear, sequenceInYear: period.sequenceInYear,
    },
    employees,
    entries: entryRows.map((e) => ({
      id: e.id, employeeId: e.employeeId,
      workDate: e.workDate, clockInAt: e.clockInAt, clockOutAt: e.clockOutAt,
      recordedSeconds: e.recordedSeconds, breakSeconds: e.breakSeconds,
      employmentAssignmentId: e.employmentAssignmentId,
      earningClassification: e.earningClassification,
    })),
    pendingCorrections: pendingCorrRows.map((c) => ({
      id: c.id, employeeId: c.employeeId,
      requestType: c.requestType,
      requestedOccurredAt: c.requestedOccurredAt,
      originalClockEventId: c.originalClockEventId,
      reason: c.reason,
      status: c.status as ScopeCorrection["status"],
      createdAt: c.createdAt,
    })),
    totalRecordedSeconds: entryRows.reduce((s, e) => s + e.recordedSeconds, 0),
    exceptionSummary: {
      missingClockOutCount: missingClockOut,
      openBreakCount: openBreak,
      missingAssignmentCount: missingAssignment,
    },
    currentRevision,
    approval,
    readiness: {
      ready: blocking.length === 0 && entryRows.length > 0,
      blockingReasons: blocking,
      approvalValid,
    },
  };
}
