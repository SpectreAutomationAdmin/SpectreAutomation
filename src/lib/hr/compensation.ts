// HR-1 (2026-08-16) — EmployeeCompensation effective-dated history.
//
// Canonical source of compensation is EmployeeCompensation. Every
// hire / raise / demotion opens a new half-open row `[from, to)` and
// closes the currently-open row in the SAME transaction. The legacy
// `Employee.payRate` column is shadow-written in that same
// transaction — this service is the ONLY writer of `Employee.payRate`
// in the codebase (the admin-workflows Employee updater deliberately
// refuses a `payRate` argument).
//
// Discipline: half-open intervals `[effectiveFrom, effectiveTo)`.
//   - A row is CURRENT at time `t` when
//     `effectiveFrom <= t AND (effectiveTo IS NULL OR effectiveTo > t)`.
//   - The boundary belongs to the NEW row. At `t == B.effectiveFrom`,
//     `getCompensationAt(t)` MUST return B (not A).
//   - Zero `-1ms` arithmetic anywhere. All boundary comparisons use
//     strict `<` / `>=`.
//
// Money discipline: rate is a Prisma.Decimal end-to-end. The audit
// payload emits `amount: string` (Decimal.toString()) to preserve
// precision through JSON.
//
// Guards:
//   - `changeCompensation` — `hr:compensation:write` +
//     `assertPostingAllowed` (training-mode + support-readonly).
//     Action `hr.compensation.update` — contains WRITE_INDICATOR
//     `update`.
//   - Reads (`getCompensationAt`, `listCompensationHistory`,
//     `getCurrentCompensation`) — `hr:compensation:read`, not audited.

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertPostingAllowed } from "../posting-guard";

const COMPENSATION_ENTITY = "EmployeeCompensation";

// Must line up with Employee.compensationType — the two live on
// separate rows but a payroll consumer will use both.
const CADENCES = ["HOURLY", "SALARY", "COMMISSION", "PIECE_RATE"] as const;

// ISO-4217. Nullable falls back to ClubProfile.defaultCurrency
// downstream, but callers should be explicit. We accept null and
// canonicalise upper-case.
function normaliseCurrency(input: string | null | undefined): string | null {
  if (input == null) return null;
  const s = input.trim().toUpperCase();
  if (s.length === 0) return null;
  if (!/^[A-Z]{3}$/.test(s)) {
    throw new ValidationError([{ path: "currency", message: "currency must be a 3-letter ISO-4217 code" }]);
  }
  return s;
}

function normaliseDate(input: Date | string, field: string): Date {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError([{ path: field, message: `${field} is not a valid date` }]);
  }
  return d;
}

function normaliseAmount(input: number | string | Prisma.Decimal, field: string): Prisma.Decimal {
  // Prisma.Decimal constructor accepts number | string | Decimal.
  // Reject NaN / Infinity / negative up front; the caller can always
  // model a negative correction as a reversal + new row.
  let d: Prisma.Decimal;
  try {
    d = new Prisma.Decimal(input as Prisma.Decimal.Value);
  } catch {
    throw new ValidationError([{ path: field, message: `${field} must be a decimal amount` }]);
  }
  if (!d.isFinite()) {
    throw new ValidationError([{ path: field, message: `${field} must be a finite decimal` }]);
  }
  if (d.isNegative()) {
    throw new ValidationError([{ path: field, message: `${field} must be zero or positive` }]);
  }
  return d;
}

async function loadEmployee(principal: Principal, employeeId: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new NotFoundError("Employee", employeeId);
  assertTenantOwned(employee, principal);
  return employee;
}

// ---------------------------------------------------------------------------
// Write: change compensation (close currently-open row + insert new).
// ---------------------------------------------------------------------------
export interface ChangeCompensationInput {
  effectiveFrom: Date | string;
  amount: number | string | Prisma.Decimal;
  cadence: string; // HOURLY | SALARY | COMMISSION | PIECE_RATE
  currency?: string | null;
  notes?: string | null;
}

/**
 * Open a new EmployeeCompensation row starting at `effectiveFrom`.
 *
 * Contract:
 *   1. Close any currently-open row (`effectiveTo IS NULL`) by setting
 *      its `effectiveTo` to the new row's `effectiveFrom` — no `-1ms`
 *      gap.
 *   2. Insert the new row with `effectiveTo: null`.
 *   3. Shadow-write `Employee.payRate` to the new amount so legacy
 *      `PayrollLine.grossPay` consumers stay in step.
 *
 * All three writes happen inside a single `prisma.$transaction` so a
 * crash between any two steps rolls back cleanly — the exclusive-
 * writer invariant on `Employee.payRate` cannot be broken.
 *
 * Overlap invariant: after this returns, AT MOST ONE row per
 * `employeeId` has `effectiveTo === null`. Enforced by close-then-
 * insert inside the transaction (the DB does not carry a partial
 * unique index for this — deliberately, because we DO want historical
 * rows to coexist).
 */
export async function changeCompensation(
  principal: Principal,
  employeeId: string,
  input: ChangeCompensationInput,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:compensation:write");
  await assertPostingAllowed(
    principal,
    employee.clubId,
    "hr.compensation.update",
    COMPENSATION_ENTITY,
    employeeId,
  );

  const effectiveFrom = normaliseDate(input.effectiveFrom, "effectiveFrom");
  if (!(CADENCES as readonly string[]).includes(input.cadence)) {
    throw new ValidationError([{ path: "cadence", message: `must be one of ${CADENCES.join(", ")}` }]);
  }
  const amount = normaliseAmount(input.amount, "amount");
  const currency = normaliseCurrency(input.currency ?? null);

  // Load the currently-open row (if any) OUTSIDE the transaction to
  // capture the `before` audit snapshot; re-check inside the tx to
  // avoid a torn read.
  const priorOpen = await prisma.employeeCompensation.findFirst({
    where: { employeeId, effectiveTo: null },
    orderBy: { effectiveFrom: "desc" },
  });
  if (priorOpen) {
    if (effectiveFrom.getTime() < priorOpen.effectiveFrom.getTime()) {
      throw new ConflictError(
        `New effectiveFrom (${effectiveFrom.toISOString()}) is before the currently-open row's start (${priorOpen.effectiveFrom.toISOString()})`,
      );
    }
    if (effectiveFrom.getTime() === priorOpen.effectiveFrom.getTime()) {
      throw new ConflictError(
        `New row starts at the same instant as the currently-open row — refusing to create a zero-width period`,
      );
    }
  }

  const created = await prisma.$transaction(async (tx) => {
    // Step 1 — close whatever is currently open. `updateMany` is safe:
    // if the prior read saw nothing but a concurrent writer landed a
    // row after, this still closes it correctly. Guarantees the
    // "at most one open row" invariant.
    await tx.employeeCompensation.updateMany({
      where: { employeeId, effectiveTo: null },
      data: { effectiveTo: effectiveFrom },
    });

    // Step 2 — insert the new row.
    const row = await tx.employeeCompensation.create({
      data: {
        clubId: employee.clubId,
        employeeId,
        effectiveFrom,
        effectiveTo: null,
        cadence: input.cadence,
        rate: amount,
        currency,
        notes: input.notes ?? null,
        actorUserId: principal.id,
      },
    });

    // Step 3 — legacy shadow-write. This is the ONLY writer of
    // `Employee.payRate` in the codebase. See employees.ts's
    // `updateEmployee` — it deliberately refuses a payRate arg.
    await tx.employee.update({
      where: { id: employeeId },
      data: { payRate: amount },
    });

    return row;
  });

  await audit(principal, {
    action: "hr.compensation.update",
    entityType: COMPENSATION_ENTITY,
    entityId: created.id,
    clubId: employee.clubId,
    before: priorOpen
      ? {
          id: priorOpen.id,
          amount: priorOpen.rate.toString(),
          cadence: priorOpen.cadence,
          effectiveFrom: priorOpen.effectiveFrom,
          effectiveTo: effectiveFrom, // now closed at the new row's start
        }
      : null,
    after: {
      id: created.id,
      amount: created.rate.toString(),
      cadence: created.cadence,
      effectiveFrom: created.effectiveFrom,
      effectiveTo: null,
      currency: created.currency,
    },
  });

  return created;
}

// ---------------------------------------------------------------------------
// Point-in-time read.
// ---------------------------------------------------------------------------
/**
 * Return the single EmployeeCompensation row active at time `t`, or
 * `null` if the employee has no compensation configured at that
 * instant.
 *
 * Half-open interval semantics — `t == row.effectiveFrom` resolves to
 * that row (never the prior one). No `-1ms` arithmetic anywhere.
 */
export async function getCompensationAt(
  principal: Principal,
  employeeId: string,
  t: Date,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:compensation:read");

  // Half-open `[effectiveFrom, effectiveTo)`:
  //   effectiveFrom <= t AND (effectiveTo IS NULL OR effectiveTo > t)
  const row = await prisma.employeeCompensation.findFirst({
    where: {
      employeeId,
      effectiveFrom: { lte: t },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: t } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });
  return row;
}

/**
 * Return the currently-open EmployeeCompensation row (`effectiveTo IS
 * NULL`), or `null` if the employee has no active compensation.
 */
export async function getCurrentCompensation(
  principal: Principal,
  employeeId: string,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:compensation:read");

  return prisma.employeeCompensation.findFirst({
    where: { employeeId, effectiveTo: null },
    orderBy: { effectiveFrom: "desc" },
  });
}

/**
 * Return every EmployeeCompensation row for the employee, oldest-
 * first. Bounded by the caller's read scope.
 */
export async function listCompensationHistory(
  principal: Principal,
  employeeId: string,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:compensation:read");

  return prisma.employeeCompensation.findMany({
    where: { employeeId },
    orderBy: { effectiveFrom: "asc" },
  });
}
