// Phase 3 (2026-09-15) — Payroll GL department-override service.
//
// Read + upsert + delete operations for `PayrollGlDepartmentOverride`.
// Every write is gated by the same permission (`payroll:config:write`)
// that guards the global `PayrollGlAccountingProfile`, and every write
// is audited.
//
// Overrides can be created against any active department the Club
// owns. Each of the three expense fields is optional; passing `null`
// unmaps that field and falls back to the global default at resolve
// time. An override row where all three fields are null is
// semantically identical to no override at all — the service DELETES
// such a row rather than storing an empty tombstone.

import { prisma } from "../prisma";
import { audit } from "../audit";
import { requirePermission, type Principal } from "../rbac";
import { ConflictError, NotFoundError, ValidationError } from "../errors";
import { tenantWhere } from "../services/tenant";
import { assertSensitiveActionAllowed } from "../posting-guard";

export interface DepartmentOverrideRow {
  id:                          string;
  departmentId:                string;
  departmentCode:              string;
  departmentName:              string;
  salaryExpenseAccountId:      string | null;
  employerCppExpenseAccountId: string | null;
  employerEiExpenseAccountId:  string | null;
  updatedAt:                   string;
}

/** List every stored override for a Club. */
export async function listDepartmentOverrides(
  principal: Principal, clubId: string,
): Promise<DepartmentOverrideRow[]> {
  requirePermission(principal, clubId, "payroll:read");
  const rows = await prisma.payrollGlDepartmentOverride.findMany({
    where: { ...tenantWhere(principal, clubId) },
    include: { department: { select: { code: true, name: true } } },
    orderBy: [{ department: { sortOrder: "asc" } }, { department: { name: "asc" } }],
  });
  return rows.map((r) => ({
    id: r.id,
    departmentId: r.departmentId,
    departmentCode: r.department.code,
    departmentName: r.department.name,
    salaryExpenseAccountId: r.salaryExpenseAccountId,
    employerCppExpenseAccountId: r.employerCppExpenseAccountId,
    employerEiExpenseAccountId: r.employerEiExpenseAccountId,
    updatedAt: r.updatedAt.toISOString(),
  }));
}

export interface UpsertDepartmentOverrideInput {
  departmentId:                string;
  salaryExpenseAccountId:      string | null;
  employerCppExpenseAccountId: string | null;
  employerEiExpenseAccountId:  string | null;
}

/** Upsert one (clubId, departmentId) override row. Passing null for
 *  every field DELETES the row (semantically identical to "no override
 *  configured", which falls back to the global default). */
export async function upsertDepartmentOverride(
  principal: Principal, clubId: string, input: UpsertDepartmentOverrideInput,
): Promise<DepartmentOverrideRow | null> {
  requirePermission(principal, clubId, "payroll:config:write");
  await assertSensitiveActionAllowed(principal, clubId, "payroll.gl.department-override.write");

  const dept = await prisma.department.findFirst({
    where: { id: input.departmentId, clubId },
    select: { id: true, code: true, name: true, isActive: true },
  });
  if (!dept) throw new NotFoundError("Department", input.departmentId);
  if (!dept.isActive) {
    throw new ConflictError(`Department ${dept.code} is inactive — reactivate it before adding a payroll override.`);
  }

  // Validate every non-null Account id belongs to this Club and has
  // the correct type + active status.
  const wantAccountIds = [
    input.salaryExpenseAccountId,
    input.employerCppExpenseAccountId,
    input.employerEiExpenseAccountId,
  ].filter((v): v is string => v != null);
  if (wantAccountIds.length > 0) {
    const accts = await prisma.account.findMany({
      where: { clubId, id: { in: wantAccountIds } },
      select: { id: true, accountNumber: true, name: true, type: true, isActive: true },
    });
    const acctById = new Map(accts.map((a) => [a.id, a]));
    for (const id of wantAccountIds) {
      const a = acctById.get(id);
      if (!a) throw new ValidationError([{ path: "accountId", message: `Account ${id} does not belong to this Club.` }]);
      if (!a.isActive) throw new ValidationError([{ path: "accountId", message: `Account ${a.accountNumber} — ${a.name} is inactive.` }]);
      if (a.type !== "EXPENSE") {
        throw new ValidationError([{ path: "accountId", message: `Account ${a.accountNumber} — ${a.name} is a ${a.type} account. Payroll department overrides accept EXPENSE accounts only.` }]);
      }
    }
  }

  const allNull =
    input.salaryExpenseAccountId == null &&
    input.employerCppExpenseAccountId == null &&
    input.employerEiExpenseAccountId == null;

  if (allNull) {
    // Delete instead of persisting an empty tombstone.
    const existing = await prisma.payrollGlDepartmentOverride.findUnique({
      where: { clubId_departmentId: { clubId, departmentId: input.departmentId } },
    });
    if (existing) {
      await prisma.payrollGlDepartmentOverride.delete({
        where: { id: existing.id },
      });
      await audit(principal, {
        clubId,
        action: "payroll.gl.department-override.delete",
        entityType: "PayrollGlDepartmentOverride",
        entityId: existing.id,
        before: {
          departmentId: existing.departmentId,
          salaryExpenseAccountId: existing.salaryExpenseAccountId,
          employerCppExpenseAccountId: existing.employerCppExpenseAccountId,
          employerEiExpenseAccountId: existing.employerEiExpenseAccountId,
        },
        after: null,
      });
    }
    return null;
  }

  const row = await prisma.payrollGlDepartmentOverride.upsert({
    where: { clubId_departmentId: { clubId, departmentId: input.departmentId } },
    create: {
      clubId,
      departmentId: input.departmentId,
      salaryExpenseAccountId: input.salaryExpenseAccountId,
      employerCppExpenseAccountId: input.employerCppExpenseAccountId,
      employerEiExpenseAccountId: input.employerEiExpenseAccountId,
    },
    update: {
      salaryExpenseAccountId: input.salaryExpenseAccountId,
      employerCppExpenseAccountId: input.employerCppExpenseAccountId,
      employerEiExpenseAccountId: input.employerEiExpenseAccountId,
    },
  });

  await audit(principal, {
    clubId,
    action: "payroll.gl.department-override.upsert",
    entityType: "PayrollGlDepartmentOverride",
    entityId: row.id,
    before: null,
    after: {
      departmentId: row.departmentId,
      salaryExpenseAccountId: row.salaryExpenseAccountId,
      employerCppExpenseAccountId: row.employerCppExpenseAccountId,
      employerEiExpenseAccountId: row.employerEiExpenseAccountId,
    },
  });

  return {
    id: row.id,
    departmentId: row.departmentId,
    departmentCode: dept.code,
    departmentName: dept.name,
    salaryExpenseAccountId: row.salaryExpenseAccountId,
    employerCppExpenseAccountId: row.employerCppExpenseAccountId,
    employerEiExpenseAccountId: row.employerEiExpenseAccountId,
    updatedAt: row.updatedAt.toISOString(),
  };
}
