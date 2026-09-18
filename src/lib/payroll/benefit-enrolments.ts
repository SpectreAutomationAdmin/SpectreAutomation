// Slice C (2026-09-18) — EmployeeBenefitPlanEnrolment service.
//
// Half-open [effectiveFrom, effectiveTo). Overlap prevention mirrors
// the recurring-component `assertNoOverlap` pattern in
// `components-catalogue.ts:436-474`. History preserved via ENDED rows
// (never edited in place). Change closes predecessor + opens successor.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertPostingAllowed } from "../posting-guard";
import { NotFoundError, ValidationError, ConflictError } from "../errors";
import { Prisma } from "@prisma/client";
import type { ElectionKind } from "./benefit-plans";

const ENTITY = "EmployeeBenefitPlanEnrolment";

export type EnrolmentStatus = "ACTIVE" | "ENDED";

export interface EnrolmentView {
  id: string;
  clubId: string;
  employeeId: string;
  planId: string;
  planCode: string;
  planName: string;
  planKind: string;
  status: EnrolmentStatus;
  effectiveFromIso: string;
  effectiveToIso: string | null;
  electionKind: ElectionKind;
  amount: string | null;
  percentBps: number | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

type EnrolmentWithPlan = Prisma.EmployeeBenefitPlanEnrolmentGetPayload<{
  include: { plan: { select: { code: true; name: true; kind: true } } };
}>;

function toView(row: EnrolmentWithPlan): EnrolmentView {
  return {
    id: row.id,
    clubId: row.clubId,
    employeeId: row.employeeId,
    planId: row.planId,
    planCode: row.plan.code,
    planName: row.plan.name,
    planKind: row.plan.kind,
    status: row.status as EnrolmentStatus,
    effectiveFromIso: row.effectiveFrom.toISOString(),
    effectiveToIso: row.effectiveTo?.toISOString() ?? null,
    electionKind: row.electionKind as ElectionKind,
    amount: row.amount?.toString() ?? null,
    percentBps: row.percentBps,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toDate(v: Date | string): Date {
  if (v instanceof Date) return v;
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T00:00:00.000Z`);
  return new Date(v);
}

/**
 * Half-open overlap check for enrolments on (clubId, employeeId, planId).
 * Fail-closed at the write path — Prepare-time uses a matching read-side
 * guard in the snapshotter.
 */
async function assertNoOverlap(
  tx: Prisma.TransactionClient,
  clubId: string,
  employeeId: string,
  planId: string,
  effectiveFrom: Date,
  effectiveTo: Date | null,
  excludeId?: string,
) {
  // Existing row overlaps this window when:
  //   existing.effectiveFrom < newEffectiveTo (or newEffectiveTo is null)
  //   AND (existing.effectiveTo IS NULL OR existing.effectiveTo > newEffectiveFrom)
  const rows = await tx.employeeBenefitPlanEnrolment.findMany({
    where: {
      clubId, employeeId, planId, status: "ACTIVE",
      ...(excludeId ? { NOT: { id: excludeId } } : {}),
    },
  });
  for (const r of rows) {
    const otherEnd = r.effectiveTo ?? new Date(8640000000000000);
    const thisEnd = effectiveTo ?? new Date(8640000000000000);
    if (r.effectiveFrom < thisEnd && otherEnd > effectiveFrom) {
      throw new ConflictError(
        `Overlapping ACTIVE enrolment on plan ${planId} for employee ${employeeId} — existing enrolment ${r.id} covers ${r.effectiveFrom.toISOString().slice(0, 10)} to ${r.effectiveTo?.toISOString().slice(0, 10) ?? "open"}.`,
      );
    }
  }
}

async function loadPlanOrThrow(clubId: string, planId: string) {
  const p = await prisma.payrollBenefitPlan.findFirst({
    where: { id: planId, clubId },
  });
  if (!p) throw new NotFoundError("PayrollBenefitPlan", planId);
  return p;
}

function validateElection(
  planDefault: ElectionKind,
  input: { electionKind?: ElectionKind; amount?: string | number | null; percentBps?: number | null },
): { electionKind: ElectionKind; amount: Prisma.Decimal | null; percentBps: number | null } {
  const kind = (input.electionKind ?? planDefault) as ElectionKind;
  if (kind === "FIXED_AMOUNT") {
    if (input.amount == null || String(input.amount).trim() === "") {
      throw new ValidationError([{ path: "amount", message: "amount required for FIXED_AMOUNT election." }]);
    }
    const s = typeof input.amount === "number" ? input.amount.toString() : input.amount.trim();
    if (!/^-?\d+(\.\d+)?$/.test(s)) {
      throw new ValidationError([{ path: "amount", message: `Invalid decimal: ${input.amount}` }]);
    }
    const d = new Prisma.Decimal(s);
    if (d.lte(0)) throw new ValidationError([{ path: "amount", message: "amount must be > 0." }]);
    return { electionKind: kind, amount: d, percentBps: null };
  }
  // PERCENT_OF_ELIGIBLE_EARNINGS
  if (input.percentBps == null || !Number.isInteger(input.percentBps)) {
    throw new ValidationError([{ path: "percentBps", message: "Integer percentBps required for PERCENT_OF_ELIGIBLE_EARNINGS election." }]);
  }
  if (input.percentBps <= 0 || input.percentBps > 100_00) {
    throw new ValidationError([{ path: "percentBps", message: "percentBps must be between 1 and 10000 (0.01% .. 100%)." }]);
  }
  return { electionKind: kind, amount: null, percentBps: input.percentBps };
}

export interface EnrolInput {
  employeeId: string;
  planId: string;
  effectiveFrom: Date | string;
  effectiveTo?: Date | string | null;
  electionKind?: ElectionKind;
  amount?: string | number | null;
  percentBps?: number | null;
  notes?: string | null;
}

export async function enrolEmployeeInBenefitPlan(
  principal: Principal,
  clubId: string,
  input: EnrolInput,
): Promise<EnrolmentView> {
  requirePermission(principal, clubId, "payroll:benefit_enrolment:write");
  await assertPostingAllowed(principal, clubId, "payroll.benefit_enrolment.enrol", ENTITY, input.employeeId);

  const plan = await loadPlanOrThrow(clubId, input.planId);
  if (!plan.active) throw new ValidationError([{ path: "planId", message: `Plan ${plan.code} is inactive.` }]);

  const emp = await prisma.employee.findFirst({ where: { id: input.employeeId, clubId }, select: { id: true } });
  if (!emp) throw new NotFoundError("Employee", input.employeeId);

  const effectiveFrom = toDate(input.effectiveFrom);
  const effectiveTo = input.effectiveTo ? toDate(input.effectiveTo) : null;
  if (effectiveTo && effectiveTo <= effectiveFrom) {
    throw new ValidationError([{ path: "effectiveTo", message: "effectiveTo must be after effectiveFrom." }]);
  }
  const election = validateElection(plan.defaultElectionKind as ElectionKind, {
    electionKind: input.electionKind, amount: input.amount, percentBps: input.percentBps,
  });

  const created = await prisma.$transaction(async (tx) => {
    await assertNoOverlap(tx, clubId, input.employeeId, input.planId, effectiveFrom, effectiveTo);
    return tx.employeeBenefitPlanEnrolment.create({
      data: {
        clubId,
        employeeId: input.employeeId,
        planId: input.planId,
        status: "ACTIVE",
        effectiveFrom,
        effectiveTo,
        electionKind: election.electionKind,
        amount: election.amount,
        percentBps: election.percentBps,
        notes: input.notes ?? null,
        enteredByUserId: principal.id,
      },
      include: { plan: { select: { code: true, name: true, kind: true } } },
    });
  });

  await audit(principal, {
    action: "payroll.benefit_enrolment.enrol",
    entityType: ENTITY, entityId: created.id, clubId,
    after: {
      employeeId: created.employeeId, planId: created.planId, planCode: created.plan.code,
      electionKind: created.electionKind,
      amount: created.amount?.toString() ?? null,
      percentBps: created.percentBps,
      effectiveFrom: created.effectiveFrom.toISOString(),
    },
  });
  return toView(created);
}

export async function endEnrolment(
  principal: Principal,
  clubId: string,
  enrolmentId: string,
  input: { effectiveTo: Date | string; endReason?: string | null },
): Promise<EnrolmentView> {
  requirePermission(principal, clubId, "payroll:benefit_enrolment:write");
  const row = await prisma.employeeBenefitPlanEnrolment.findFirst({
    where: { id: enrolmentId, clubId },
    include: { plan: { select: { code: true, name: true, kind: true } } },
  });
  if (!row) throw new NotFoundError(ENTITY, enrolmentId);
  if (row.status === "ENDED") return toView(row);

  const effectiveTo = toDate(input.effectiveTo);
  if (effectiveTo <= row.effectiveFrom) {
    throw new ValidationError([{ path: "effectiveTo", message: "effectiveTo must be after effectiveFrom." }]);
  }

  const updated = await prisma.employeeBenefitPlanEnrolment.update({
    where: { id: enrolmentId },
    data: {
      status: "ENDED",
      effectiveTo,
      endedByUserId: principal.id,
      endReason: input.endReason ?? null,
    },
    include: { plan: { select: { code: true, name: true, kind: true } } },
  });

  await audit(principal, {
    action: "payroll.benefit_enrolment.end",
    entityType: ENTITY, entityId: updated.id, clubId,
    before: { status: "ACTIVE", effectiveTo: row.effectiveTo?.toISOString() ?? null },
    after: { status: "ENDED", effectiveTo: effectiveTo.toISOString(), endReason: input.endReason ?? null },
  });
  return toView(updated);
}

export interface ChangeEnrolmentInput {
  enrolmentId: string;
  effectiveFrom: Date | string;      // start of successor
  electionKind?: ElectionKind;
  amount?: string | number | null;
  percentBps?: number | null;
  notes?: string | null;
}

/** Half-open Change: closes predecessor at `effectiveFrom` and opens a new
 *  ACTIVE successor at that same date with the new election. */
export async function changeEnrolment(
  principal: Principal,
  clubId: string,
  input: ChangeEnrolmentInput,
): Promise<EnrolmentView> {
  requirePermission(principal, clubId, "payroll:benefit_enrolment:write");
  const existing = await prisma.employeeBenefitPlanEnrolment.findFirst({
    where: { id: input.enrolmentId, clubId },
    include: { plan: true },
  });
  if (!existing) throw new NotFoundError(ENTITY, input.enrolmentId);
  if (existing.status !== "ACTIVE") {
    throw new ConflictError(`Cannot change a ${existing.status} enrolment.`);
  }
  const cutover = toDate(input.effectiveFrom);
  if (cutover <= existing.effectiveFrom) {
    throw new ValidationError([{ path: "effectiveFrom", message: "Change effectiveFrom must be after the existing enrolment's start." }]);
  }
  const election = validateElection(existing.plan.defaultElectionKind as ElectionKind, {
    electionKind: input.electionKind, amount: input.amount, percentBps: input.percentBps,
  });

  const created = await prisma.$transaction(async (tx) => {
    // Close predecessor at the cutover instant.
    await tx.employeeBenefitPlanEnrolment.update({
      where: { id: existing.id },
      data: {
        status: "ENDED",
        effectiveTo: cutover,
        changedByUserId: principal.id,
      },
    });
    // Open successor at the cutover instant.
    await assertNoOverlap(tx, clubId, existing.employeeId, existing.planId, cutover, null, existing.id);
    return tx.employeeBenefitPlanEnrolment.create({
      data: {
        clubId,
        employeeId: existing.employeeId,
        planId: existing.planId,
        status: "ACTIVE",
        effectiveFrom: cutover,
        effectiveTo: null,
        electionKind: election.electionKind,
        amount: election.amount,
        percentBps: election.percentBps,
        notes: input.notes ?? existing.notes,
        enteredByUserId: principal.id,
        changedByUserId: principal.id,
      },
      include: { plan: { select: { code: true, name: true, kind: true } } },
    });
  });

  await audit(principal, {
    action: "payroll.benefit_enrolment.change",
    entityType: ENTITY, entityId: created.id, clubId,
    before: {
      enrolmentId: existing.id,
      electionKind: existing.electionKind,
      amount: existing.amount?.toString() ?? null,
      percentBps: existing.percentBps,
    },
    after: {
      enrolmentId: created.id,
      effectiveFrom: created.effectiveFrom.toISOString(),
      electionKind: created.electionKind,
      amount: created.amount?.toString() ?? null,
      percentBps: created.percentBps,
    },
  });
  return toView(created);
}

export async function listEnrolmentsForEmployee(
  principal: Principal,
  clubId: string,
  employeeId: string,
): Promise<EnrolmentView[]> {
  requirePermission(principal, clubId, "payroll:read");
  const rows = await prisma.employeeBenefitPlanEnrolment.findMany({
    where: { clubId, employeeId },
    include: { plan: { select: { code: true, name: true, kind: true } } },
    orderBy: [{ effectiveFrom: "desc" }],
  });
  return rows.map(toView);
}

/**
 * Prepare-time read: return every ENROLMENT applicable at `asOf` for the
 * employee. Applicable = status=ACTIVE AND effectiveFrom <= asOf AND
 * (effectiveTo IS NULL OR effectiveTo > asOf). Fail-closed on multiple
 * ACTIVE applicable rows for the same (employee, plan).
 */
export async function resolveApplicableEnrolmentsAtPrepare(
  clubId: string,
  employeeId: string,
  asOf: Date,
  tx?: Prisma.TransactionClient,
) {
  const c = tx ?? prisma;
  const rows = await c.employeeBenefitPlanEnrolment.findMany({
    where: {
      clubId, employeeId, status: "ACTIVE",
      effectiveFrom: { lte: asOf },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: asOf } }],
    },
    include: { plan: true },
  });
  // Fail-closed guard — at most one applicable enrolment per (employee, plan).
  const byPlan = new Map<string, typeof rows>();
  for (const r of rows) {
    const prior = byPlan.get(r.planId) ?? [];
    prior.push(r);
    byPlan.set(r.planId, prior);
  }
  for (const [planId, list] of byPlan.entries()) {
    if (list.length > 1) {
      throw new ConflictError(
        `Ambiguous ACTIVE benefit enrolments for employee ${employeeId} on plan ${planId}: ` +
          `${list.map((l) => l.id).join(", ")}. Resolve via End before Prepare.`,
      );
    }
  }
  return rows;
}
