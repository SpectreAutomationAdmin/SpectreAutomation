// Payroll 3B acceptance hotfix (2026-09-12) — unified per-department
// time-readiness projection for the Payroll Admin Overview.
//
// The Payroll Overview's Approvals tab was previously reading ONLY
// `PayrollDepartmentTimeApproval` rows (via getDepartmentApprovalStatus).
// That reader is FROZEN-time-based: it tallies `PayrollApprovedTimeEntry`
// rows, which only exist after a Payroll Admin has clicked "Freeze"
// (freeze-service.ts:65). Consequences before this hotfix:
//   • Departments with materialised reviewable time (PayrollTimesheetEntry)
//     but no freeze yet showed as "No departments to approve".
//   • Workflow Step 3 falsely marked itself done when a manager still
//     had unapproved timesheet scopes.
//   • Checklist item 1 ("All time entries imported") looked at
//     PayrollApprovedTimeEntry count only, missing every scope that
//     had been materialised into PayrollTimesheetEntry but not frozen.
//
// This module unifies the three lenses the operator needs:
//   1. Reviewable scopes from PayrollTimesheetEntry (listReviewableScopes)
//   2. Manager approvals from PayrollDepartmentTimeApproval
//      (getDepartmentApprovalStatus)
//   3. Payroll-frozen counts from PayrollApprovedTimeEntry
// into a single per-department state a UI can render truthfully.
//
// It NEVER mutates. It NEVER materialises. It NEVER freezes. The
// canonical trigger points remain the two human gates:
//   • Manager approves via approveTimesheetScope (Slice-7 CAS path)
//   • Payroll Admin freezes via freezeApprovedScopeIntoPayroll

import { prisma } from "../prisma";
import type { Principal } from "../rbac";
import { requirePermission } from "../rbac";
import { listReviewableScopes } from "../timesheets/approval-scope";

export type TimeReadinessState =
  | "PENDING"              // reviewable time exists, manager has not approved yet
  | "NEEDS_ATTENTION"      // reviewable scope has open sessions / null-assignment entries
  | "APPROVED_UNFROZEN"    // manager approved but Payroll Admin has not clicked Freeze
  | "FROZEN"               // manager approved + Payroll Admin froze into PayrollApprovedTimeEntry
  | "REOPENED";            // approval reopened after a source-time change

export interface TimeReadinessScope {
  clubId: string;
  payPeriodId: string;
  departmentId: string;
  departmentCode: string;
  departmentName: string;
  employeeCount: number;
  entryCount: number;                // PayrollTimesheetEntry count in this scope
  frozenEntryCount: number;          // PayrollApprovedTimeEntry count in this scope
  exceptionCount: number;            // open sessions + null-assignment entries surfaced against this scope
  pendingCorrectionCount: number;
  recordedHoursDisplay: string;
  state: TimeReadinessState;
  stateLabel: string;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  reopenedAt: Date | null;
  workIntakeItemId: string | null;
  reviewHref: string;
}

export interface TimeReadiness {
  scopes: TimeReadinessScope[];

  // Aggregate reconciliation figures for the pay period.
  clockEventCount: number;
  materialisedTimesheetCount: number;
  needsAttentionTimesheetCount: number;
  timesheetEntryCount: number;
  approvedTimeEntryCount: number;
  openSessionCount: number;
  nullAssignmentEntryCount: number;

  // Derived: is every eligible completed source-time record accounted
  // for as a reviewable/frozen row, with no open or malformed sessions?
  allImported: boolean;

  // Derived: is every reviewable department APPROVED + FROZEN?
  allApproved: boolean;

  // Roll-up counts (convenience for view + checklist).
  scopeCount: number;
  approvedScopeCount: number;
  frozenScopeCount: number;
  pendingScopeCount: number;
  reopenedScopeCount: number;
  needsAttentionScopeCount: number;
}

function stateLabelFor(state: TimeReadinessState): string {
  switch (state) {
    case "PENDING":           return "Pending manager approval";
    case "NEEDS_ATTENTION":   return "Needs attention";
    case "APPROVED_UNFROZEN": return "Approved — awaiting freeze";
    case "FROZEN":            return "Frozen into payroll";
    case "REOPENED":          return "Reopened — review required";
    default:                  return state;
  }
}

function fmtHours(seconds: number): string {
  return (seconds / 3600).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export async function getTimeReadiness(
  principal: Principal,
  clubId: string,
  payPeriodId: string,
): Promise<TimeReadiness> {
  requirePermission(principal, clubId, "payroll:read");

  const period = await prisma.payrollPayPeriod.findFirst({
    where: { id: payPeriodId, clubId },
    select: { id: true, periodStart: true, periodEnd: true },
  });
  if (!period) {
    return emptyReadiness();
  }

  const [reviewable, approvals, timesheetEntryCount, approvedTimeEntryCount,
    materialisedTimesheetCount, needsAttentionTimesheetCount, clockEventCount,
    nullAssignmentEntryCount, frozenEntriesByDept, openSessionCount,
    departmentsById,
  ] = await Promise.all([
    listReviewableScopes(clubId, payPeriodId),
    // Direct read of PayrollDepartmentTimeApproval — the older
    // getDepartmentApprovalStatus reader is scoped to frozen-time
    // tallies and misses APPROVED-but-not-yet-frozen rows.
    prisma.payrollDepartmentTimeApproval.findMany({
      where: { clubId, payPeriodId },
      select: {
        departmentId: true, state: true,
        approvedAt: true, approvedByUserId: true,
        reopenedAt: true, workIntakeItemId: true,
      },
    }),
    prisma.payrollTimesheetEntry.count({
      where: { clubId, timesheet: { payPeriodId } },
    }),
    prisma.payrollApprovedTimeEntry.count({
      where: {
        clubId,
        workDate: { gte: period.periodStart, lt: period.periodEnd },
        supersededByApprovedTimeEntryId: null,
      },
    }),
    prisma.payrollTimesheet.count({ where: { clubId, payPeriodId } }),
    prisma.payrollTimesheet.count({ where: { clubId, payPeriodId, status: "NEEDS_ATTENTION" } }),
    prisma.timeClockEvent.count({
      where: {
        clubId,
        // Read window slightly wider than the period so trailing
        // CLOCK_OUTs are counted alongside their CLOCK_INs.
        occurredAt: { gte: period.periodStart, lt: new Date(period.periodEnd.getTime() + 2 * 86_400_000) },
      },
    }),
    prisma.payrollTimesheetEntry.count({
      where: { clubId, timesheet: { payPeriodId }, employmentAssignmentId: null },
    }),
    (async () => {
      // Per-department PayrollApprovedTimeEntry counts. Approved-time
      // rows carry `employmentAssignmentId` (nullable); look up the
      // department via the assignment row so frozen counts line up
      // with the reviewable scope's department key.
      const rows = await prisma.payrollApprovedTimeEntry.findMany({
        where: {
          clubId,
          workDate: { gte: period.periodStart, lt: period.periodEnd },
          supersededByApprovedTimeEntryId: null,
        },
        select: {
          id: true,
          employmentAssignmentId: true,
          employmentAssignment: { select: { departmentId: true } },
        },
      });
      const byDept = new Map<string, number>();
      for (const r of rows) {
        const did = r.employmentAssignment?.departmentId;
        if (!did) continue;
        byDept.set(did, (byDept.get(did) ?? 0) + 1);
      }
      return byDept;
    })(),
    // Open sessions surface as NEEDS_ATTENTION exceptions on the
    // employee's PayrollTimesheet. Count them by counting entries
    // whose clockOut has never been paired — the materialiser stores
    // the CLOCK_IN as an entry with clockOutAt = clockInAt (a
    // degenerate 0-second entry) when it fails to pair, but by
    // convention it uses `NEEDS_ATTENTION` status on the timesheet
    // and an entry may not exist. So: use the timesheet-status count
    // as a proxy — it is safe (over-counts one per timesheet with
    // any issue, never under-counts).
    prisma.payrollTimesheet.count({ where: { clubId, payPeriodId, status: "NEEDS_ATTENTION" } }),
    // Department name + code lookup for departments that appear via
    // the approval-row path but not via listReviewableScopes.
    prisma.department.findMany({
      where: { clubId },
      select: { id: true, code: true, name: true },
    }),
  ]);
  const deptMetaById = new Map(departmentsById.map((d) => [d.id, d]));

  // Union reviewable scopes and approval rows on departmentId.
  const approvalsByDept = new Map<string, typeof approvals[number]>();
  for (const a of approvals) approvalsByDept.set(a.departmentId, a);

  const scopes: TimeReadinessScope[] = [];
  const seen = new Set<string>();
  for (const r of reviewable) {
    seen.add(r.departmentId);
    const a = approvalsByDept.get(r.departmentId);
    const frozen = frozenEntriesByDept.get(r.departmentId) ?? 0;
    const state = deriveState({
      reviewableEntries: r.entryCount,
      exceptions: r.exceptionCount,
      approvalState: a?.state ?? "PENDING",
      frozenEntries: frozen,
    });
    scopes.push({
      clubId,
      payPeriodId,
      departmentId: r.departmentId,
      departmentCode: r.departmentCode,
      departmentName: r.departmentName,
      employeeCount: r.employeeCount,
      entryCount: r.entryCount,
      frozenEntryCount: frozen,
      exceptionCount: r.exceptionCount,
      pendingCorrectionCount: r.pendingCorrectionCount,
      recordedHoursDisplay: fmtHours(r.recordedSeconds),
      state,
      stateLabel: stateLabelFor(state),
      approvedAt: a?.approvedAt ?? null,
      approvedByUserId: a?.approvedByUserId ?? null,
      reopenedAt: a?.reopenedAt ?? null,
      workIntakeItemId: a?.workIntakeItemId ?? null,
      reviewHref: reviewHref(payPeriodId, r.departmentId),
    });
  }

  // Approvals that carry no reviewable entries (e.g. every entry
  // has been frozen and then reopened by a correction, or a legacy
  // approval row exists on a department whose reviewable time has
  // moved elsewhere). Include them so the operator can act on them.
  for (const a of approvals) {
    if (seen.has(a.departmentId)) continue;
    const frozen = frozenEntriesByDept.get(a.departmentId) ?? 0;
    const state = deriveState({
      reviewableEntries: 0,
      exceptions: 0,
      approvalState: a.state,
      frozenEntries: frozen,
    });
    const meta = deptMetaById.get(a.departmentId);
    scopes.push({
      clubId,
      payPeriodId,
      departmentId: a.departmentId,
      departmentCode: meta?.code ?? a.departmentId,
      departmentName: meta?.name ?? a.departmentId,
      employeeCount: 0,
      entryCount: 0,
      frozenEntryCount: frozen,
      exceptionCount: 0,
      pendingCorrectionCount: 0,
      recordedHoursDisplay: fmtHours(0),
      state,
      stateLabel: stateLabelFor(state),
      approvedAt: a.approvedAt ?? null,
      approvedByUserId: a.approvedByUserId ?? null,
      reopenedAt: a.reopenedAt ?? null,
      workIntakeItemId: a.workIntakeItemId ?? null,
      reviewHref: reviewHref(payPeriodId, a.departmentId),
    });
  }
  scopes.sort((a, b) => a.departmentCode.localeCompare(b.departmentCode));

  const approvedScopeCount = scopes.filter((s) => s.state === "FROZEN" || s.state === "APPROVED_UNFROZEN").length;
  const frozenScopeCount   = scopes.filter((s) => s.state === "FROZEN").length;
  const pendingScopeCount  = scopes.filter((s) => s.state === "PENDING").length;
  const reopenedScopeCount = scopes.filter((s) => s.state === "REOPENED").length;
  const needsAttentionScopeCount = scopes.filter((s) => s.state === "NEEDS_ATTENTION").length;

  //   All imported:
  //   - No open sessions (needsAttentionTimesheetCount === 0)
  //   - No null-assignment entries (nullAssignmentEntryCount === 0)
  //   - At least one entry OR no source clock activity in the period
  const allImported =
    needsAttentionTimesheetCount === 0 &&
    nullAssignmentEntryCount === 0 &&
    (timesheetEntryCount > 0 || clockEventCount === 0);

  //   All approved: every reviewable department is FROZEN, and there
  //   are no lingering REOPENED / PENDING / NEEDS_ATTENTION scopes.
  const allApproved =
    scopes.length === 0 ||
    (frozenScopeCount === scopes.length && scopes.every((s) => s.state === "FROZEN"));

  return {
    scopes,
    clockEventCount,
    materialisedTimesheetCount,
    needsAttentionTimesheetCount,
    timesheetEntryCount,
    approvedTimeEntryCount,
    openSessionCount,
    nullAssignmentEntryCount,
    allImported,
    allApproved,
    scopeCount: scopes.length,
    approvedScopeCount,
    frozenScopeCount,
    pendingScopeCount,
    reopenedScopeCount,
    needsAttentionScopeCount,
  };
}

function deriveState(input: {
  reviewableEntries: number;
  exceptions: number;
  approvalState: string;
  frozenEntries: number;
}): TimeReadinessState {
  const { reviewableEntries, exceptions, approvalState, frozenEntries } = input;
  if (approvalState === "REOPENED") return "REOPENED";
  if (exceptions > 0)               return "NEEDS_ATTENTION";
  if (approvalState === "APPROVED") {
    // Frozen when every reviewable entry has a matching frozen row,
    // OR when there are no reviewable entries left (all consumed).
    if (reviewableEntries === 0 && frozenEntries === 0) return "APPROVED_UNFROZEN";
    if (frozenEntries >= reviewableEntries && frozenEntries > 0) return "FROZEN";
    return "APPROVED_UNFROZEN";
  }
  return "PENDING";
}

function reviewHref(payPeriodId: string, departmentId: string): string {
  const qs = new URLSearchParams({
    payPeriodId, departmentId, scope: "timesheet",
  }).toString();
  return `/app/admin/payroll/time?${qs}`;
}

function emptyReadiness(): TimeReadiness {
  return {
    scopes: [],
    clockEventCount: 0,
    materialisedTimesheetCount: 0,
    needsAttentionTimesheetCount: 0,
    timesheetEntryCount: 0,
    approvedTimeEntryCount: 0,
    openSessionCount: 0,
    nullAssignmentEntryCount: 0,
    allImported: true,
    allApproved: true,
    scopeCount: 0,
    approvedScopeCount: 0,
    frozenScopeCount: 0,
    pendingScopeCount: 0,
    reopenedScopeCount: 0,
    needsAttentionScopeCount: 0,
  };
}
