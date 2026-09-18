// Slice A closeout (2026-09-18) — dedicated service for correcting an
// employee's Original Hire Date (Employee.hireDate). Distinct from the
// generic `updateEmployee` service:
//
//   * Requires the narrow `hr:service-date:write` permission.
//   * Accepts ONLY the hireDate field. Silently ignores anything else
//     the caller happens to pass; the surface contract accepts only
//     `{ hireDate }`.
//   * NEVER writes activatedAt, departmentId, positionId, employmentType,
//     terminationReason, or any other Employee column. If a future
//     caller wants those, they must go through the appropriate service
//     with the appropriate broader permission.
//   * Emits a dedicated `hr.employee.hire_date.set` audit event with
//     explicit before/after values so a Controller-facing correction is
//     traceable independent of the generic `hr.employee.update` stream.
//
// Founder-directive §2 (Slice A closeout) — this is the authorized
// Controller-facing entry point for original-hire-date correction.
// Payroll Admin uses the same service; both roles hold
// `hr:service-date:write`.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { assertSensitiveActionAllowed } from "../posting-guard";
import { assertTenantOwned } from "../services/tenant";
import { NotFoundError, ValidationError } from "../errors";

const ENTITY = "Employee";

export interface UpdateHireDateInput {
  hireDate: Date | string | null;
}

export interface HireDateUpdateResult {
  employeeId: string;
  clubId: string;
  hireDate: Date | null;
  before: { hireDate: Date | null };
}

function toOptionalHireDate(v: Date | string | null | undefined): Date | null {
  if (v == null) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v === "string" && v.length > 0) {
    // Accept 'YYYY-MM-DD' or ISO string; store as UTC-midnight civil date.
    const trimmed = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      return new Date(`${trimmed}T00:00:00.000Z`);
    }
    const d = new Date(trimmed);
    if (isNaN(d.getTime())) {
      throw new ValidationError([{ path: "hireDate", message: `Invalid date: ${trimmed}` }]);
    }
    return d;
  }
  return null;
}

/**
 * Correct an employee's Original Hire Date. Narrow permission
 * enforcement: `hr:service-date:write`. Never mutates any other
 * Employee column.
 */
export async function updateEmployeeHireDate(
  principal: Principal,
  employeeId: string,
  input: UpdateHireDateInput,
): Promise<HireDateUpdateResult> {
  const employee = await prisma.employee.findUnique({
    where: { id: employeeId },
    select: { id: true, clubId: true, hireDate: true, activatedAt: true },
  });
  if (!employee) throw new NotFoundError(ENTITY, employeeId);
  assertTenantOwned(employee, principal);
  requirePermission(principal, employee.clubId, "hr:service-date:write");
  await assertSensitiveActionAllowed(
    principal,
    employee.clubId,
    "hr.employee.hire_date.set",
    ENTITY,
    employeeId,
  );

  const newHireDate = toOptionalHireDate(input.hireDate);
  const before = { hireDate: employee.hireDate };

  // Idempotent no-op if unchanged.
  if (
    (before.hireDate?.getTime() ?? null) === (newHireDate?.getTime() ?? null)
  ) {
    return {
      employeeId,
      clubId: employee.clubId,
      hireDate: before.hireDate,
      before,
    };
  }

  const updated = await prisma.employee.update({
    where: { id: employeeId },
    data: { hireDate: newHireDate },
    // Intentionally NO other columns; the service surface accepts only
    // hireDate. activatedAt is not read/written here; departmentId,
    // positionId, employmentType, terminationReason, etc. cannot be
    // touched through this path even if the caller sends them.
    select: { id: true, clubId: true, hireDate: true },
  });

  await audit(principal, {
    action: "hr.employee.hire_date.set",
    entityType: ENTITY,
    entityId: employeeId,
    clubId: employee.clubId,
    before: { hireDate: before.hireDate ? before.hireDate.toISOString() : null },
    after: { hireDate: updated.hireDate ? updated.hireDate.toISOString() : null },
  });

  return {
    employeeId: updated.id,
    clubId: updated.clubId,
    hireDate: updated.hireDate,
    before,
  };
}
