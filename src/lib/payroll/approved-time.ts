// Payroll-3B-3 (2026-08-28) — canonical PayrollApprovedTimeEntry
// service.
//
// This service is the ONLY sanctioned write path for approved-time
// rows. Every write: `requirePermission` + `assertPostingAllowed` +
// `audit`. The service does not write `consumedByBatchId` /
// `consumedByBatchEmployeeId` — those are reserved system fields
// set exclusively by the future PayrollBatch preparation service.
//
// Time-entry lifecycle (per §25 of the ticket brief):
//   DRAFT     — pending/editable; single-line create/edit/delete OK.
//   APPROVED  — set by department-approval flow; single-row edits
//               are refused (correction must reopen the department
//               approval, or explicitly reset the entry back to
//               DRAFT via `resetTimeEntryToDraft` which itself is
//               guarded to require a REOPEN of the department).
//   POSTED    — `consumedByBatchId` is non-null. Row is immutable.
//               No edits, deletes, classification changes, hours
//               changes. Payroll correction workflow (later slice)
//               is the ONLY way to fix a posted entry.
//
// See `src/lib/payroll/department-approval.ts` for the department-
// scoped approval calls that flip DRAFT rows to APPROVED in bulk.

import type { Decimal } from "@prisma/client/runtime/library";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { ValidationError, NotFoundError } from "../errors";

const ENTITY = "PayrollApprovedTimeEntry";

export type EarningClassification =
  | "REGULAR"
  | "OVERTIME"
  | "STAT_HOLIDAY"
  | "VACATION"
  | "OTHER";

const ALLOWED_CLASSIFICATIONS: ReadonlySet<EarningClassification> = new Set([
  "REGULAR",
  "OVERTIME",
  "STAT_HOLIDAY",
  "VACATION",
  "OTHER",
]);

export type ApprovalState = "DRAFT" | "APPROVED" | "POSTED";

export interface TimeEntryView {
  id: string;
  clubId: string;
  employeeId: string;
  employmentAssignmentId: string | null;
  workDate: Date;
  hours: string;                 // decimal serialized as string
  earningClassification: EarningClassification;
  approvalState: ApprovalState;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  consumedByBatchId: string | null;
  consumedByBatchEmployeeId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

interface TimeEntryRow {
  id: string;
  clubId: string;
  employeeId: string;
  employmentAssignmentId: string | null;
  workDate: Date;
  hours: Decimal;
  earningClassification: string;
  approvalState: string;
  approvedAt: Date | null;
  approvedByUserId: string | null;
  consumedByBatchId: string | null;
  consumedByBatchEmployeeId: string | null;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function projectRow(row: TimeEntryRow): TimeEntryView {
  const cls: EarningClassification = ALLOWED_CLASSIFICATIONS.has(row.earningClassification as EarningClassification)
    ? (row.earningClassification as EarningClassification)
    : "REGULAR";
  const state: ApprovalState = row.consumedByBatchId
    ? "POSTED"
    : (row.approvalState === "APPROVED" ? "APPROVED" : "DRAFT");
  return {
    id: row.id,
    clubId: row.clubId,
    employeeId: row.employeeId,
    employmentAssignmentId: row.employmentAssignmentId,
    workDate: row.workDate,
    hours: row.hours.toString(),
    earningClassification: cls,
    approvalState: state,
    approvedAt: row.approvedAt,
    approvedByUserId: row.approvedByUserId,
    consumedByBatchId: row.consumedByBatchId,
    consumedByBatchEmployeeId: row.consumedByBatchEmployeeId,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function toCivilMidnight(d: Date): Date {
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError([{ path: "workDate", message: "Invalid work date" }]);
  }
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function validateHours(raw: number | string): string {
  const n = typeof raw === "string" ? Number(raw) : raw;
  if (!Number.isFinite(n)) {
    throw new ValidationError([{ path: "hours", message: "Hours must be a number" }]);
  }
  if (n <= 0) {
    throw new ValidationError([{ path: "hours", message: "Hours must be greater than zero" }]);
  }
  // 4 decimal places — enough for future 1/4-hour reporting.
  return n.toFixed(4);
}

function validateClassification(raw: string): EarningClassification {
  if (!ALLOWED_CLASSIFICATIONS.has(raw as EarningClassification)) {
    throw new ValidationError([
      {
        path: "earningClassification",
        message: `Must be one of ${Array.from(ALLOWED_CLASSIFICATIONS).join(", ")}`,
      },
    ]);
  }
  return raw as EarningClassification;
}

async function assertEmployeeBelongsToClub(clubId: string, employeeId: string): Promise<void> {
  const e = await prisma.employee.findFirst({
    where: { id: employeeId, clubId },
    select: { id: true },
  });
  if (!e) {
    throw new ValidationError([
      { path: "employeeId", message: "Employee does not exist at this Club" },
    ]);
  }
}

async function assertAssignmentValid(
  clubId: string,
  employeeId: string,
  employmentAssignmentId: string | null,
  workDate: Date,
): Promise<{ departmentId: string | null }> {
  if (!employmentAssignmentId) return { departmentId: null };
  const a = await prisma.employeeEmploymentAssignment.findFirst({
    where: { id: employmentAssignmentId, clubId, employeeId },
    select: { id: true, effectiveFrom: true, effectiveTo: true, departmentId: true },
  });
  if (!a) {
    throw new ValidationError([
      { path: "employmentAssignmentId", message: "Assignment does not belong to this Employee at this Club" },
    ]);
  }
  const wd = workDate.getTime();
  if (wd < a.effectiveFrom.getTime()) {
    throw new ValidationError([
      { path: "employmentAssignmentId", message: "Assignment is not effective on the work date" },
    ]);
  }
  if (a.effectiveTo && wd >= a.effectiveTo.getTime()) {
    throw new ValidationError([
      { path: "employmentAssignmentId", message: "Assignment ended before the work date" },
    ]);
  }
  return { departmentId: a.departmentId };
}

async function assertNotConsumed(row: { consumedByBatchId: string | null }): Promise<void> {
  if (row.consumedByBatchId) {
    throw new ValidationError([
      {
        path: "consumedByBatchId",
        message: "This time entry has been consumed by a payroll batch and is immutable. A payroll correction is required to change it.",
      },
    ]);
  }
}

// ---------------------------------------------------------------------------
// Read paths
// ---------------------------------------------------------------------------

export async function getTimeEntry(
  principal: Principal,
  clubId: string,
  id: string,
): Promise<TimeEntryView | null> {
  requirePermission(principal, clubId, "payroll:timesheets:read");
  const row = await prisma.payrollApprovedTimeEntry.findFirst({ where: { id, clubId } });
  return row ? projectRow(row) : null;
}

export interface ListTimeEntriesFilter {
  employeeId?: string;
  departmentId?: string;
  approvalState?: ApprovalState;
  from?: Date;
  to?: Date;
  payPeriodId?: string;
}

/** Tenant-scoped list with common filters. Ordered by workDate ASC
 *  then employee ASC for deterministic rendering. */
export async function listTimeEntries(
  principal: Principal,
  clubId: string,
  filter: ListTimeEntriesFilter = {},
): Promise<TimeEntryView[]> {
  requirePermission(principal, clubId, "payroll:timesheets:read");
  let periodBounds: { periodStart: Date; periodEnd: Date } | null = null;
  if (filter.payPeriodId) {
    const p = await prisma.payrollPayPeriod.findFirst({
      where: { id: filter.payPeriodId, clubId },
      select: { periodStart: true, periodEnd: true },
    });
    if (!p) return [];
    periodBounds = { periodStart: p.periodStart, periodEnd: p.periodEnd };
  }
  const rows = await prisma.payrollApprovedTimeEntry.findMany({
    where: {
      clubId,
      ...(filter.employeeId ? { employeeId: filter.employeeId } : {}),
      ...(filter.approvalState === "DRAFT" ? { approvalState: "DRAFT", consumedByBatchId: null } : {}),
      ...(filter.approvalState === "APPROVED" ? { approvalState: "APPROVED", consumedByBatchId: null } : {}),
      ...(filter.approvalState === "POSTED" ? { consumedByBatchId: { not: null } } : {}),
      ...(filter.departmentId
        ? { employmentAssignment: { departmentId: filter.departmentId, clubId } }
        : {}),
      ...(periodBounds
        ? { workDate: { gte: periodBounds.periodStart, lt: periodBounds.periodEnd } }
        : {}),
      ...(filter.from ? { workDate: { gte: filter.from } } : {}),
      ...(filter.to ? { workDate: { lt: filter.to } } : {}),
    },
    orderBy: [{ workDate: "asc" }, { employeeId: "asc" }],
  });
  return rows.map(projectRow);
}

/** Canonical query for future PayrollBatch preparation. Returns
 *  approved-and-not-consumed rows whose workDate falls in the
 *  Period's half-open window. */
export async function listApprovedTimeForPeriod(
  principal: Principal,
  clubId: string,
  payPeriodId: string,
): Promise<TimeEntryView[]> {
  return listTimeEntries(principal, clubId, { payPeriodId, approvalState: "APPROVED" });
}

// ---------------------------------------------------------------------------
// Write paths
// ---------------------------------------------------------------------------

export interface CreateTimeEntryInput {
  employeeId: string;
  employmentAssignmentId?: string | null;
  workDate: Date;
  hours: number | string;
  earningClassification?: EarningClassification;
  notes?: string | null;
}

/** Return type for the department-approval orchestrator to consume;
 *  keeps the departmentId snapshot so the orchestrator can decide
 *  which departments to touch without re-querying. */
export interface CreateTimeEntryResult {
  entry: TimeEntryView;
  departmentId: string | null;
}

export async function createTimeEntry(
  principal: Principal,
  clubId: string,
  input: CreateTimeEntryInput,
): Promise<CreateTimeEntryResult> {
  requirePermission(principal, clubId, "payroll:timesheets:read");
  requirePermission(principal, clubId, "payroll:write");
  await assertPostingAllowed(principal, clubId, "payroll.time-entry.create", ENTITY, input.employeeId);

  await assertEmployeeBelongsToClub(clubId, input.employeeId);
  const workDate = toCivilMidnight(input.workDate);
  const { departmentId } = await assertAssignmentValid(
    clubId, input.employeeId, input.employmentAssignmentId ?? null, workDate,
  );
  const hours = validateHours(input.hours);
  const cls = input.earningClassification
    ? validateClassification(input.earningClassification)
    : "REGULAR";

  const row = await prisma.payrollApprovedTimeEntry.create({
    data: {
      clubId,
      employeeId: input.employeeId,
      employmentAssignmentId: input.employmentAssignmentId ?? null,
      workDate,
      hours,
      earningClassification: cls,
      approvalState: "DRAFT",
      notes: input.notes?.trim() || null,
    },
  });
  await audit(principal, {
    action: "payroll.time-entry.create",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    after: {
      employeeId: row.employeeId,
      employmentAssignmentId: row.employmentAssignmentId,
      workDate: row.workDate.toISOString(),
      hours: row.hours.toString(),
      earningClassification: row.earningClassification,
    },
  });
  return { entry: projectRow(row), departmentId };
}

export interface UpdateTimeEntryInput {
  workDate?: Date;
  hours?: number | string;
  earningClassification?: EarningClassification;
  employmentAssignmentId?: string | null;
  notes?: string | null;
}

/**
 * Update a time entry. Refuses any mutation once the row is
 * `consumedByBatchId` — payroll correction is the only path.
 * Refuses mutation of an APPROVED row unless the caller has already
 * reset its department approval (out of scope for a single-row edit).
 */
export async function updateTimeEntry(
  principal: Principal,
  clubId: string,
  id: string,
  input: UpdateTimeEntryInput,
): Promise<{ entry: TimeEntryView; departmentId: string | null }> {
  requirePermission(principal, clubId, "payroll:write");
  await assertPostingAllowed(principal, clubId, "payroll.time-entry.update", ENTITY, id);

  const row = await prisma.payrollApprovedTimeEntry.findFirst({ where: { id, clubId } });
  if (!row) throw new NotFoundError(ENTITY, id);
  await assertNotConsumed(row);
  if (row.approvalState === "APPROVED") {
    throw new ValidationError([
      {
        path: "approvalState",
        message: "This entry has already been approved. Reopen the department's approval before editing.",
      },
    ]);
  }

  const patch: {
    workDate?: Date;
    hours?: string;
    earningClassification?: string;
    employmentAssignmentId?: string | null;
    notes?: string | null;
  } = {};
  const nextWorkDate = input.workDate ? toCivilMidnight(input.workDate) : row.workDate;
  const nextAssignmentId = input.employmentAssignmentId !== undefined
    ? input.employmentAssignmentId
    : row.employmentAssignmentId;
  if (input.workDate !== undefined || input.employmentAssignmentId !== undefined) {
    await assertAssignmentValid(clubId, row.employeeId, nextAssignmentId, nextWorkDate);
  }
  if (input.workDate !== undefined) patch.workDate = nextWorkDate;
  if (input.employmentAssignmentId !== undefined) patch.employmentAssignmentId = nextAssignmentId;
  if (input.hours !== undefined) patch.hours = validateHours(input.hours);
  if (input.earningClassification !== undefined) patch.earningClassification = validateClassification(input.earningClassification);
  if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;

  const updated = await prisma.payrollApprovedTimeEntry.update({
    where: { id: row.id },
    data: patch,
  });
  await audit(principal, {
    action: "payroll.time-entry.update",
    entityType: ENTITY,
    entityId: updated.id,
    clubId,
    before: {
      hours: row.hours.toString(),
      earningClassification: row.earningClassification,
      workDate: row.workDate.toISOString(),
      employmentAssignmentId: row.employmentAssignmentId,
    },
    after: {
      hours: updated.hours.toString(),
      earningClassification: updated.earningClassification,
      workDate: updated.workDate.toISOString(),
      employmentAssignmentId: updated.employmentAssignmentId,
    },
  });
  const departmentId = updated.employmentAssignmentId
    ? (await prisma.employeeEmploymentAssignment.findUnique({
        where: { id: updated.employmentAssignmentId },
        select: { departmentId: true },
      }))?.departmentId ?? null
    : null;
  return { entry: projectRow(updated), departmentId };
}

export async function deleteTimeEntry(
  principal: Principal,
  clubId: string,
  id: string,
): Promise<{ departmentId: string | null; workDate: Date }> {
  requirePermission(principal, clubId, "payroll:write");
  await assertPostingAllowed(principal, clubId, "payroll.time-entry.delete", ENTITY, id);

  const row = await prisma.payrollApprovedTimeEntry.findFirst({ where: { id, clubId } });
  if (!row) throw new NotFoundError(ENTITY, id);
  await assertNotConsumed(row);
  if (row.approvalState === "APPROVED") {
    throw new ValidationError([
      {
        path: "approvalState",
        message: "This entry has already been approved. Reopen the department's approval before deleting.",
      },
    ]);
  }
  await prisma.payrollApprovedTimeEntry.delete({ where: { id: row.id } });
  await audit(principal, {
    action: "payroll.time-entry.delete",
    entityType: ENTITY,
    entityId: id,
    clubId,
    before: {
      employeeId: row.employeeId,
      workDate: row.workDate.toISOString(),
      hours: row.hours.toString(),
      earningClassification: row.earningClassification,
    },
  });
  const departmentId = row.employmentAssignmentId
    ? (await prisma.employeeEmploymentAssignment.findUnique({
        where: { id: row.employmentAssignmentId },
        select: { departmentId: true },
      }))?.departmentId ?? null
    : null;
  return { departmentId, workDate: row.workDate };
}

/**
 * INTERNAL — used by the department-approval service to flip a set
 * of DRAFT entries to APPROVED. Never call this from routes/UI
 * directly; go through `approveDepartmentTime` so the Work Intake
 * task and department approval row transition together.
 */
export async function _bulkMarkApproved(
  clubId: string,
  entryIds: string[],
  approvedByUserId: string,
): Promise<number> {
  if (entryIds.length === 0) return 0;
  const now = new Date();
  const res = await prisma.payrollApprovedTimeEntry.updateMany({
    where: {
      clubId,
      id: { in: entryIds },
      approvalState: "DRAFT",
      consumedByBatchId: null,
    },
    data: { approvalState: "APPROVED", approvedAt: now, approvedByUserId },
  });
  return res.count;
}

/** INTERNAL — used by department-approval reopen. */
export async function _bulkMarkDraft(clubId: string, entryIds: string[]): Promise<number> {
  if (entryIds.length === 0) return 0;
  const res = await prisma.payrollApprovedTimeEntry.updateMany({
    where: {
      clubId,
      id: { in: entryIds },
      approvalState: "APPROVED",
      consumedByBatchId: null,
    },
    data: { approvalState: "DRAFT", approvedAt: null, approvedByUserId: null },
  });
  return res.count;
}
