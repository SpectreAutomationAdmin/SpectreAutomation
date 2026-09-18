// Slice B (2026-09-18) — pre-batch scheduled one-time earning service.
//
// Founder-facing life cycle (Employee → Payroll → One-Time Earnings):
//
//   schedule    → status = SCHEDULED
//   edit        → mutate amount / reason / notes while SCHEDULED (or CANCELLED
//                 → resurrected). CANCELLED rows are never mutated silently.
//   cancel      → status = CANCELLED; snapshotter must skip.
//
// Prepare-time behaviour (see components-snapshot.ts):
//
//   snapshotter finds SCHEDULED rows for (clubId, employeeId, payPeriodId),
//   freezes each into a PayrollBatchComponentSnapshot with provenance
//   ONE_TIME_PAYROLL_ADJUSTMENT + sourceScheduledEarning link, then flips
//   this row's status to APPLIED with appliedAt / appliedToBatchId /
//   appliedSnapshotId set. Idempotent: retrying Prepare finds the same row
//   is already APPLIED (in which case the snapshotter will find its existing
//   snapshot via appliedSnapshotId and update-in-place rather than duplicate).
//
// Void → re-Prepare: `resetAppliedForVoidedBatch` flips APPLIED back to
// SCHEDULED so the next Prepare re-picks them up. Never touches POSTED.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { assertTenantOwned } from "../services/tenant";
import { NotFoundError, ValidationError, ConflictError } from "../errors";
import { Prisma } from "@prisma/client";

const ENTITY = "PayrollScheduledOneTimeEarning";

export type ScheduledStatus = "SCHEDULED" | "APPLIED" | "CANCELLED";

export interface ScheduledOneTimeEarningView {
  id: string;
  clubId: string;
  employeeId: string;
  payPeriodId: string;
  componentId: string;
  componentCode: string;
  componentDisplayName: string;
  amount: string;
  currency: string | null;
  reason: string;
  notes: string | null;
  status: ScheduledStatus;
  appliedAt: string | null;
  appliedToBatchId: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

function toView(row: {
  id: string; clubId: string; employeeId: string; payPeriodId: string;
  componentId: string; amount: Prisma.Decimal; currency: string | null;
  reason: string; notes: string | null; status: string;
  appliedAt: Date | null; appliedToBatchId: string | null;
  cancelledAt: Date | null; createdAt: Date; updatedAt: Date;
  component: { code: string; displayName: string };
}): ScheduledOneTimeEarningView {
  return {
    id: row.id,
    clubId: row.clubId,
    employeeId: row.employeeId,
    payPeriodId: row.payPeriodId,
    componentId: row.componentId,
    componentCode: row.component.code,
    componentDisplayName: row.component.displayName,
    amount: row.amount.toString(),
    currency: row.currency,
    reason: row.reason,
    notes: row.notes,
    status: row.status as ScheduledStatus,
    appliedAt: row.appliedAt?.toISOString() ?? null,
    appliedToBatchId: row.appliedToBatchId,
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function parseAmount(v: string | number): Prisma.Decimal {
  const s = typeof v === "number" ? v.toString() : v.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) {
    throw new ValidationError([{ path: "amount", message: `Amount must be a decimal number; got ${JSON.stringify(v)}.` }]);
  }
  const d = new Prisma.Decimal(s);
  if (d.lte(0)) {
    throw new ValidationError([{ path: "amount", message: "Amount must be greater than zero." }]);
  }
  return d;
}

export interface ScheduleOneTimeEarningInput {
  employeeId: string;
  payPeriodId: string;
  componentId: string;
  amount: string | number;
  reason: string;
  notes?: string | null;
  currency?: string | null;
}

async function assertPayPeriodBelongsToClub(clubId: string, payPeriodId: string) {
  const p = await prisma.payrollPayPeriod.findFirst({
    where: { id: payPeriodId, clubId },
    select: { id: true, payDate: true, periodEnd: true, status: true, payGroupId: true },
  });
  if (!p) throw new NotFoundError("PayrollPayPeriod", payPeriodId);
  // Refuse a period that already has a POSTED batch — you cannot schedule a
  // bonus into an already-posted period.
  const posted = await prisma.payrollBatch.findFirst({
    where: { clubId, payPeriodId, status: "POSTED" },
    select: { id: true },
  });
  if (posted) {
    throw new ConflictError(
      "Cannot schedule a one-time earning for a pay period that has an already-POSTED payroll batch.",
    );
  }
  return p;
}

async function assertEmployeeInPayGroupForPeriod(
  clubId: string,
  employeeId: string,
  payGroupId: string,
  asOf: Date,
) {
  const membership = await prisma.payrollPayGroupMember.findFirst({
    where: {
      clubId,
      employeeId,
      payGroupId,
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
    },
    select: { id: true },
  });
  if (!membership) {
    throw new ValidationError([{
      path: "employeeId",
      message: "This employee does not belong to the pay group of the selected pay period at that period's pay date.",
    }]);
  }
}

async function assertComponentEligibleForOneTime(clubId: string, componentId: string) {
  const c = await prisma.payrollComponent.findFirst({
    where: { id: componentId, clubId },
    select: {
      id: true, code: true, displayName: true, active: true, side: true,
      cashEffect: true, calculationMethod: true, category: true, usage: true,
    },
  });
  if (!c) throw new NotFoundError("PayrollComponent", componentId);
  if (!c.active) {
    throw new ValidationError([{ path: "componentId", message: `Component ${c.code} is inactive.` }]);
  }
  if (c.usage !== "ONE_TIME" && c.usage !== "BOTH") {
    throw new ValidationError([{
      path: "componentId",
      message: `Component ${c.code} is not eligible for one-time scheduling (usage=${c.usage}).`,
    }]);
  }
  if (c.side !== "EMPLOYEE" || c.cashEffect !== "INCREASES_NET_PAY") {
    throw new ValidationError([{
      path: "componentId",
      message: `Component ${c.code} is not an employee cash earning (side=${c.side}, cashEffect=${c.cashEffect}).`,
    }]);
  }
  if (c.calculationMethod !== "FIXED_AMOUNT") {
    throw new ValidationError([{
      path: "componentId",
      message: `Only FIXED_AMOUNT components can be scheduled as one-time earnings in Slice B (got ${c.calculationMethod}).`,
    }]);
  }
  return c;
}

/** Schedule a new one-time earning for an employee against a future/open pay period. */
export async function scheduleOneTimeEarning(
  principal: Principal,
  clubId: string,
  input: ScheduleOneTimeEarningInput,
): Promise<ScheduledOneTimeEarningView> {
  requirePermission(principal, clubId, "payroll:edit");
  await assertPostingAllowed(principal, clubId, "payroll.scheduled_one_time_earning.schedule", ENTITY, input.employeeId);

  const period = await assertPayPeriodBelongsToClub(clubId, input.payPeriodId);
  await assertEmployeeInPayGroupForPeriod(clubId, input.employeeId, period.payGroupId, period.payDate);
  await assertComponentEligibleForOneTime(clubId, input.componentId);

  const amount = parseAmount(input.amount);
  const reason = (input.reason ?? "").trim();
  if (reason.length === 0) {
    throw new ValidationError([{ path: "reason", message: "A reason / description is required." }]);
  }

  // Idempotent conflict: refuse a duplicate SCHEDULED row for the same
  // (employee, period, component). If a CANCELLED row exists, resurrect
  // by editing that row instead of creating a new one.
  const existing = await prisma.payrollScheduledOneTimeEarning.findFirst({
    where: {
      clubId, employeeId: input.employeeId, payPeriodId: input.payPeriodId, componentId: input.componentId,
    },
  });
  let row;
  if (existing && (existing.status === "SCHEDULED" || existing.status === "APPLIED")) {
    throw new ConflictError(
      `A ${existing.status.toLowerCase()} one-time earning already exists for this employee, period, and component.`,
    );
  } else if (existing) {
    // CANCELLED — resurrect the row.
    row = await prisma.payrollScheduledOneTimeEarning.update({
      where: { id: existing.id },
      data: {
        amount, currency: input.currency ?? null, reason, notes: input.notes ?? null,
        status: "SCHEDULED", appliedAt: null, appliedToBatchId: null, appliedSnapshotId: null,
        cancelledAt: null, cancelledByUserId: null, cancelledReason: null,
        enteredByUserId: principal.id,
      },
      include: { component: { select: { code: true, displayName: true } } },
    });
  } else {
    row = await prisma.payrollScheduledOneTimeEarning.create({
      data: {
        clubId,
        employeeId: input.employeeId,
        payPeriodId: input.payPeriodId,
        componentId: input.componentId,
        amount, currency: input.currency ?? null,
        reason, notes: input.notes ?? null,
        status: "SCHEDULED",
        enteredByUserId: principal.id,
      },
      include: { component: { select: { code: true, displayName: true } } },
    });
  }

  await audit(principal, {
    action: "payroll.scheduled_one_time_earning.schedule",
    entityType: ENTITY,
    entityId: row.id,
    clubId,
    after: {
      employeeId: row.employeeId, payPeriodId: row.payPeriodId, componentCode: row.component.code,
      amount: row.amount.toString(), reason: row.reason, status: row.status,
    },
  });
  return toView(row);
}

export interface EditOneTimeEarningInput {
  amount?: string | number;
  reason?: string;
  notes?: string | null;
}

export async function editOneTimeEarning(
  principal: Principal,
  clubId: string,
  scheduledId: string,
  input: EditOneTimeEarningInput,
): Promise<ScheduledOneTimeEarningView> {
  requirePermission(principal, clubId, "payroll:edit");
  const row = await prisma.payrollScheduledOneTimeEarning.findFirst({
    where: { id: scheduledId, clubId },
    include: { component: { select: { code: true, displayName: true } } },
  });
  if (!row) throw new NotFoundError(ENTITY, scheduledId);
  if (row.status !== "SCHEDULED") {
    throw new ConflictError(
      `Cannot edit a ${row.status} one-time earning. Cancel and re-schedule instead.`,
    );
  }
  await assertPostingAllowed(principal, clubId, "payroll.scheduled_one_time_earning.edit", ENTITY, scheduledId);

  const before = { amount: row.amount.toString(), reason: row.reason, notes: row.notes };
  const data: Record<string, unknown> = {};
  if (input.amount !== undefined) data.amount = parseAmount(input.amount);
  if (input.reason !== undefined) {
    const r = input.reason.trim();
    if (r.length === 0) throw new ValidationError([{ path: "reason", message: "Reason cannot be empty." }]);
    data.reason = r;
  }
  if (input.notes !== undefined) data.notes = input.notes;

  const updated = await prisma.payrollScheduledOneTimeEarning.update({
    where: { id: scheduledId },
    data,
    include: { component: { select: { code: true, displayName: true } } },
  });

  await audit(principal, {
    action: "payroll.scheduled_one_time_earning.edit",
    entityType: ENTITY,
    entityId: scheduledId,
    clubId,
    before,
    after: { amount: updated.amount.toString(), reason: updated.reason, notes: updated.notes },
  });
  return toView(updated);
}

export async function cancelOneTimeEarning(
  principal: Principal,
  clubId: string,
  scheduledId: string,
  input: { reason?: string | null } = {},
): Promise<ScheduledOneTimeEarningView> {
  requirePermission(principal, clubId, "payroll:edit");
  const row = await prisma.payrollScheduledOneTimeEarning.findFirst({
    where: { id: scheduledId, clubId },
    include: { component: { select: { code: true, displayName: true } } },
  });
  if (!row) throw new NotFoundError(ENTITY, scheduledId);
  if (row.status === "APPLIED") {
    throw new ConflictError(
      "This one-time earning was already frozen into a payroll batch. Use the batch-side adjustment flow to correct it.",
    );
  }
  if (row.status === "CANCELLED") return toView(row); // idempotent
  await assertPostingAllowed(principal, clubId, "payroll.scheduled_one_time_earning.cancel", ENTITY, scheduledId);

  const updated = await prisma.payrollScheduledOneTimeEarning.update({
    where: { id: scheduledId },
    data: {
      status: "CANCELLED",
      cancelledAt: new Date(),
      cancelledByUserId: principal.id,
      cancelledReason: input.reason ?? null,
    },
    include: { component: { select: { code: true, displayName: true } } },
  });
  await audit(principal, {
    action: "payroll.scheduled_one_time_earning.cancel",
    entityType: ENTITY,
    entityId: scheduledId,
    clubId,
    before: { status: "SCHEDULED" },
    after: { status: "CANCELLED", cancelledReason: input.reason ?? null },
  });
  return toView(updated);
}

/** List every scheduled/applied/cancelled one-time earning for an employee. */
export async function listOneTimeEarningsForEmployee(
  principal: Principal,
  clubId: string,
  employeeId: string,
): Promise<ScheduledOneTimeEarningView[]> {
  requirePermission(principal, clubId, "payroll:read");
  const rows = await prisma.payrollScheduledOneTimeEarning.findMany({
    where: { clubId, employeeId },
    include: { component: { select: { code: true, displayName: true } } },
    orderBy: [{ createdAt: "desc" }],
  });
  assertTenantOwned(rows[0] ?? { clubId }, principal);
  return rows.map(toView);
}

/** Read all SCHEDULED rows for a pay period — used by the snapshotter. */
export async function listScheduledOneTimeEarningsForPeriod(
  clubId: string,
  employeeId: string,
  payPeriodId: string,
  tx?: Prisma.TransactionClient,
) {
  const c = tx ?? prisma;
  return c.payrollScheduledOneTimeEarning.findMany({
    where: { clubId, employeeId, payPeriodId, status: "SCHEDULED" },
    include: { component: true },
  });
}

/** Mark a scheduled row as APPLIED — called by the snapshotter after the
 *  batch snapshot has been created. */
export async function markScheduledOneTimeEarningApplied(
  scheduledId: string,
  batchId: string,
  snapshotId: string,
  tx?: Prisma.TransactionClient,
) {
  const c = tx ?? prisma;
  await c.payrollScheduledOneTimeEarning.update({
    where: { id: scheduledId },
    data: {
      status: "APPLIED",
      appliedAt: new Date(),
      appliedToBatchId: batchId,
      appliedSnapshotId: snapshotId,
    },
  });
}

/** VOID a batch → flip all APPLIED rows for that batch back to SCHEDULED. */
export async function resetAppliedForVoidedBatch(
  batchId: string,
  tx?: Prisma.TransactionClient,
) {
  const c = tx ?? prisma;
  await c.payrollScheduledOneTimeEarning.updateMany({
    where: { appliedToBatchId: batchId, status: "APPLIED" },
    data: {
      status: "SCHEDULED",
      appliedAt: null,
      appliedToBatchId: null,
      appliedSnapshotId: null,
    },
  });
}
