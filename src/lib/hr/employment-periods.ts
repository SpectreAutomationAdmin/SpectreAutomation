// HR-1 (2026-08-16) — EmploymentPeriod effective-dated history.
//
// Discipline: half-open intervals `[effectiveFrom, effectiveTo)`.
//   - A period is ACTIVE at time `t` when
//     `effectiveFrom <= t AND (effectiveTo IS NULL OR effectiveTo > t)`.
//   - The boundary belongs to the NEW period: at `t == periodB.effectiveFrom`,
//     `getEmploymentAt(t)` MUST return periodB (not periodA).
//   - There is NEVER `-1ms` arithmetic anywhere. All boundary logic
//     is done with strict `<` / `>=` comparisons.
//
// Only one open period per employee at a time — enforced in-service:
// `openEmploymentPeriod` closes the currently-open period (sets
// `effectiveTo = new.effectiveFrom`) before inserting the new row.
//
// Writes: `hr:employment:write` + sensitive-action guard.
// Reads:  `hr:employment:read`.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { assertSensitiveActionAllowed } from "../posting-guard";

const PERIOD_ENTITY = "EmploymentPeriod";

const EMPLOYMENT_TYPES = ["FULL_TIME", "PART_TIME", "SEASONAL", "CONTRACT"] as const;
const REASONS = [
  "HIRE",
  "REHIRE",
  "TRANSFER",
  "PROMOTION",
  "DEMOTION",
  "LEAVE_START",
  "LEAVE_END",
  "TERMINATION_VOLUNTARY",
  "TERMINATION_INVOLUNTARY",
] as const;

async function loadEmployee(principal: Principal, employeeId: string) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new NotFoundError("Employee", employeeId);
  assertTenantOwned(employee, principal);
  return employee;
}

function normDate(v: Date | string, field: string): Date {
  const d = v instanceof Date ? v : new Date(v);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError([{ path: field, message: `${field} is not a valid date` }]);
  }
  return d;
}

// ---------------------------------------------------------------------------
// Open a new period (half-open interval; closes any prior open row).
// ---------------------------------------------------------------------------
export interface OpenEmploymentPeriodInput {
  effectiveFrom: Date | string;
  employmentType: string;
  reason: string;
  positionId?: string | null;
  departmentId?: string | null;
  managerEmployeeId?: string | null;
  notes?: string | null;
}

/**
 * Insert a new EmploymentPeriod for `employeeId` starting at
 * `effectiveFrom`. Any currently-open period (`effectiveTo IS NULL`)
 * is closed by setting its `effectiveTo` to the new period's
 * `effectiveFrom` — no `-1ms` gap.
 */
export async function openEmploymentPeriod(
  principal: Principal,
  employeeId: string,
  input: OpenEmploymentPeriodInput,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:employment:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.employment.write.update",
    PERIOD_ENTITY,
    employeeId,
  );

  const effectiveFrom = normDate(input.effectiveFrom, "effectiveFrom");
  if (!(EMPLOYMENT_TYPES as readonly string[]).includes(input.employmentType)) {
    throw new ValidationError([{ path: "employmentType", message: `must be one of ${EMPLOYMENT_TYPES.join(", ")}` }]);
  }
  if (!(REASONS as readonly string[]).includes(input.reason)) {
    throw new ValidationError([{ path: "reason", message: `must be one of ${REASONS.join(", ")}` }]);
  }

  // Close any currently-open period.
  const open = await prisma.employmentPeriod.findFirst({
    where: { employeeId, effectiveTo: null },
    orderBy: { effectiveFrom: "desc" },
  });
  if (open) {
    // Guard against retrospective inserts before the currently-open
    // period started — an admin can still open a period BEFORE the
    // active one, but that requires an explicit "close everything
    // then rebuild" workflow that we don't model here.
    if (effectiveFrom.getTime() < open.effectiveFrom.getTime()) {
      throw new ConflictError(
        `New effectiveFrom (${effectiveFrom.toISOString()}) is before the currently-open period's start (${open.effectiveFrom.toISOString()})`,
      );
    }
    if (effectiveFrom.getTime() === open.effectiveFrom.getTime()) {
      throw new ConflictError(
        `New period starts at the same instant as the currently-open period — supersedeCurrent() instead`,
      );
    }
    await prisma.employmentPeriod.update({
      where: { id: open.id },
      data: { effectiveTo: effectiveFrom },
    });
  }

  const created = await prisma.employmentPeriod.create({
    data: {
      clubId: employee.clubId,
      employeeId,
      effectiveFrom,
      effectiveTo: null,
      employmentType: input.employmentType,
      reason: input.reason,
      positionId: input.positionId ?? null,
      departmentId: input.departmentId ?? null,
      managerEmployeeId: input.managerEmployeeId ?? null,
      actorUserId: principal.id,
      notes: input.notes ?? null,
    },
  });

  await audit(principal, {
    action: "hr.employment.write.update",
    entityType: PERIOD_ENTITY,
    entityId: created.id,
    clubId: employee.clubId,
    before: open
      ? {
          openPeriodId: open.id,
          openEffectiveFrom: open.effectiveFrom,
          openEffectiveTo: null,
        }
      : null,
    after: {
      id: created.id,
      effectiveFrom: created.effectiveFrom,
      employmentType: created.employmentType,
      reason: created.reason,
      priorClosedTo: open ? effectiveFrom : null,
    },
  });

  return created;
}

// ---------------------------------------------------------------------------
// Explicitly close the currently-open period (e.g. termination).
// ---------------------------------------------------------------------------
export async function closeCurrentEmploymentPeriod(
  principal: Principal,
  employeeId: string,
  effectiveTo: Date | string,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:employment:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.employment.write.update",
    PERIOD_ENTITY,
    employeeId,
  );

  const to = normDate(effectiveTo, "effectiveTo");
  const open = await prisma.employmentPeriod.findFirst({
    where: { employeeId, effectiveTo: null },
    orderBy: { effectiveFrom: "desc" },
  });
  if (!open) throw new NotFoundError(PERIOD_ENTITY, `${employeeId}:open`);
  if (to.getTime() <= open.effectiveFrom.getTime()) {
    throw new ConflictError(
      `effectiveTo (${to.toISOString()}) must be strictly after effectiveFrom (${open.effectiveFrom.toISOString()})`,
    );
  }

  const updated = await prisma.employmentPeriod.update({
    where: { id: open.id },
    data: { effectiveTo: to },
  });

  await audit(principal, {
    action: "hr.employment.write.update",
    entityType: PERIOD_ENTITY,
    entityId: open.id,
    clubId: employee.clubId,
    before: { effectiveTo: null },
    after: { effectiveTo: updated.effectiveTo },
  });

  return updated;
}

// ---------------------------------------------------------------------------
// Reads.
// ---------------------------------------------------------------------------
/**
 * Return the single EmploymentPeriod row active at time `t`.
 * Half-open interval semantics — `t == period.effectiveFrom` resolves
 * to that period (not the prior one).
 */
export async function getEmploymentAt(
  principal: Principal,
  employeeId: string,
  t: Date,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:employment:read");

  // Half-open [effectiveFrom, effectiveTo):
  //   effectiveFrom <= t AND (effectiveTo IS NULL OR effectiveTo > t)
  const row = await prisma.employmentPeriod.findFirst({
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
 * Return every EmploymentPeriod that overlaps the half-open range
 * `[from, to)`. If `to` is null it means "no upper bound".
 */
export async function getEmploymentPeriodsForRange(
  principal: Principal,
  employeeId: string,
  from: Date,
  to: Date | null,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:employment:read");

  // A period overlaps [from, to) when:
  //   effectiveFrom < to  (period starts before the range ends)
  //   AND (effectiveTo IS NULL OR effectiveTo > from)  (period ends
  //   after the range starts)
  const where: Record<string, unknown> = {
    employeeId,
    OR: [{ effectiveTo: null }, { effectiveTo: { gt: from } }],
  };
  if (to != null) {
    where.effectiveFrom = { lt: to };
  }
  return prisma.employmentPeriod.findMany({
    where,
    orderBy: { effectiveFrom: "asc" },
  });
}

/**
 * Return every EmploymentPeriod for the employee, oldest-first.
 * Bounded by the caller's read scope.
 */
export async function listEmploymentPeriods(
  principal: Principal,
  employeeId: string,
) {
  const employee = await loadEmployee(principal, employeeId);
  requirePermission(principal, employee.clubId, "hr:employment:read");
  return prisma.employmentPeriod.findMany({
    where: { employeeId },
    orderBy: { effectiveFrom: "asc" },
  });
}
