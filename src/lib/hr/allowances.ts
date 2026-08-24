// HR-2C Employment (2026-08-24) — Recurring employee allowance service.
//
// Effective-dated. Frequency PER_PAY_PERIOD | MONTHLY | ANNUAL.
// `assignmentId` is optional (employee-wide when null). `taxable` is
// admin-controlled classification for Payroll consumption — the
// service NEVER infers CRA treatment, it only stores what the admin
// declared.

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertTenantOwned } from "../services/tenant";
import { assertPostingAllowed } from "../posting-guard";
import { ConflictError, NotFoundError, ValidationError } from "../errors";

const ENTITY = "EmployeeAllowance";

/** Suggested canonical allowance types. Stored as free-form string so
 *  a Club can extend, but the picker surfaces these five first. */
export const ALLOWANCE_TYPES = [
  "CELL_PHONE",
  "UNIFORM",
  "VEHICLE",
  "PROFESSIONAL_DUES",
  "OTHER",
] as const;
export type AllowanceType = (typeof ALLOWANCE_TYPES)[number];

export const ALLOWANCE_FREQUENCIES = ["PER_PAY_PERIOD", "MONTHLY", "ANNUAL"] as const;
export type AllowanceFrequency = (typeof ALLOWANCE_FREQUENCIES)[number];

export interface AllowanceView {
  id: string;
  employeeId: string;
  assignmentId: string | null;
  allowanceType: string;
  description: string | null;
  amount: string; // Decimal serialised
  currency: string | null;
  frequency: AllowanceFrequency | string;
  taxable: boolean;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  isCurrent: boolean;
  notes: string | null;
}

function normaliseDate(input: Date | string, field: string): Date {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) {
    throw new ValidationError([{ path: field, message: `${field} is not a valid date` }]);
  }
  return d;
}

function normaliseAmount(input: number | string | Prisma.Decimal): Prisma.Decimal {
  let d: Prisma.Decimal;
  try { d = new Prisma.Decimal(input as Prisma.Decimal.Value); }
  catch { throw new ValidationError([{ path: "amount", message: "amount must be a decimal amount" }]); }
  if (!d.isFinite()) throw new ValidationError([{ path: "amount", message: "amount must be finite" }]);
  if (d.isNegative()) throw new ValidationError([{ path: "amount", message: "amount must be zero or positive" }]);
  return d;
}

function normaliseType(input: string): string {
  const s = input.trim().toUpperCase();
  if (s.length === 0 || s.length > 64) {
    throw new ValidationError([{ path: "allowanceType", message: "allowanceType must be 1-64 characters" }]);
  }
  return s;
}

function normaliseFrequency(input: string): AllowanceFrequency {
  const s = input.trim().toUpperCase();
  if (!(ALLOWANCE_FREQUENCIES as readonly string[]).includes(s)) {
    throw new ValidationError([{
      path: "frequency",
      message: `frequency must be one of ${ALLOWANCE_FREQUENCIES.join(", ")}`,
    }]);
  }
  return s as AllowanceFrequency;
}

async function loadEmployee(principal: Principal, employeeId: string) {
  const emp = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, clubId: true },
  });
  if (!emp) throw new NotFoundError("Employee", employeeId);
  assertTenantOwned(emp, principal);
  return emp;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

function toView(r: {
  id: string; employeeId: string; assignmentId: string | null;
  allowanceType: string; description: string | null;
  amount: Prisma.Decimal; currency: string | null;
  frequency: string; taxable: boolean;
  effectiveFrom: Date; effectiveTo: Date | null;
  notes: string | null;
}, now: Date): AllowanceView {
  return {
    id: r.id,
    employeeId: r.employeeId,
    assignmentId: r.assignmentId,
    allowanceType: r.allowanceType,
    description: r.description,
    amount: r.amount.toString(),
    currency: r.currency,
    frequency: r.frequency,
    taxable: r.taxable,
    effectiveFrom: r.effectiveFrom,
    effectiveTo: r.effectiveTo,
    isCurrent: r.effectiveFrom <= now && (r.effectiveTo === null || r.effectiveTo > now),
    notes: r.notes,
  };
}

export async function listAllowances(
  principal: Principal,
  employeeId: string,
): Promise<AllowanceView[]> {
  const emp = await loadEmployee(principal, employeeId);
  requirePermission(principal, emp.clubId, "hr:allowance:read");
  const rows = await prisma.employeeAllowance.findMany({
    where: { employeeId, clubId: emp.clubId },
    orderBy: [{ effectiveFrom: "desc" }],
  });
  const now = new Date();
  return rows.map((r) => toView(r, now));
}

// ---------------------------------------------------------------------------
// Add allowance
// ---------------------------------------------------------------------------

export interface AddAllowanceInput {
  allowanceType: string;
  description?: string | null;
  amount: number | string;
  currency?: string | null;
  frequency: string;
  taxable: boolean;
  effectiveFrom: Date | string;
  effectiveTo?: Date | string | null;
  assignmentId?: string | null;
  notes?: string | null;
}

export async function addAllowance(
  principal: Principal,
  employeeId: string,
  input: AddAllowanceInput,
): Promise<{ id: string }> {
  const emp = await loadEmployee(principal, employeeId);
  requirePermission(principal, emp.clubId, "hr:allowance:write");
  await assertPostingAllowed(principal, emp.clubId, "hr.allowance.add", ENTITY, employeeId);

  const allowanceType = normaliseType(input.allowanceType);
  const amount = normaliseAmount(input.amount);
  const frequency = normaliseFrequency(input.frequency);
  const effectiveFrom = normaliseDate(input.effectiveFrom, "effectiveFrom");
  const effectiveTo = input.effectiveTo ? normaliseDate(input.effectiveTo, "effectiveTo") : null;
  if (effectiveTo && effectiveTo <= effectiveFrom) {
    throw new ValidationError([{ path: "effectiveTo", message: "End date must be after start date." }]);
  }
  if (input.assignmentId) {
    const a = await prisma.employeeEmploymentAssignment.findUnique({
      where: { id: input.assignmentId },
      select: { id: true, clubId: true, employeeId: true },
    });
    if (!a || a.clubId !== emp.clubId || a.employeeId !== employeeId) {
      throw new ValidationError([{ path: "assignmentId", message: "Assignment not found for this employee." }]);
    }
  }

  const row = await prisma.employeeAllowance.create({
    data: {
      clubId: emp.clubId,
      employeeId,
      assignmentId: input.assignmentId ?? null,
      allowanceType,
      description: input.description?.trim() || null,
      amount,
      currency: input.currency?.trim().toUpperCase() || null,
      frequency,
      taxable: input.taxable,
      effectiveFrom,
      effectiveTo,
      notes: input.notes?.trim() || null,
      createdByUserId: principal.id,
    },
  });

  await audit(principal, {
    action: "hr.allowance.add",
    entityType: ENTITY,
    entityId: row.id,
    clubId: emp.clubId,
    after: {
      employeeIdTail: employeeId.slice(-8),
      allowanceType,
      frequency,
      taxable: input.taxable,
      effectiveFrom: effectiveFrom.toISOString(),
      assignmentScoped: input.assignmentId != null,
      // Amount value is admin-visible under hr:allowance:read; audit
      // records the string form to preserve precision but the amount
      // is not sensitive per current policy — it is by nature a
      // known recurring payment, not e.g. a SIN.
      amount: amount.toString(),
    },
  });
  return { id: row.id };
}

// ---------------------------------------------------------------------------
// End allowance
// ---------------------------------------------------------------------------

export async function endAllowance(
  principal: Principal,
  allowanceId: string,
  input: { effectiveTo: Date | string; notes?: string | null },
): Promise<void> {
  const row = await prisma.employeeAllowance.findUnique({
    where: { id: allowanceId },
    select: { id: true, clubId: true, employeeId: true, effectiveFrom: true, effectiveTo: true, allowanceType: true },
  });
  if (!row) throw new NotFoundError(ENTITY, allowanceId);
  assertTenantOwned({ clubId: row.clubId }, principal);
  requirePermission(principal, row.clubId, "hr:allowance:write");
  await assertPostingAllowed(principal, row.clubId, "hr.allowance.end", ENTITY, allowanceId);
  if (row.effectiveTo !== null) throw new ConflictError("Allowance already ended.");
  const effectiveTo = normaliseDate(input.effectiveTo, "effectiveTo");
  if (effectiveTo <= row.effectiveFrom) {
    throw new ValidationError([{ path: "effectiveTo", message: "End date must be after start date." }]);
  }
  await prisma.employeeAllowance.update({
    where: { id: allowanceId },
    data: { effectiveTo, notes: input.notes?.trim() || undefined },
  });
  await audit(principal, {
    action: "hr.allowance.end",
    entityType: ENTITY,
    entityId: allowanceId,
    clubId: row.clubId,
    after: {
      employeeIdTail: row.employeeId.slice(-8),
      allowanceType: row.allowanceType,
      effectiveTo: effectiveTo.toISOString(),
    },
  });
}
