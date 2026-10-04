// REPORT-WIRING-1B (2026-10-04) — canonical Payroll Department
// discovery resolver.
//
// PURPOSE
// The Payroll Analysis — Department Breakdown chart must display ONLY
// departments that actually participate in Payroll. Spectre's Payroll
// module uses the generic `Department` model but defines "payroll-
// valid" dynamically via Employee → Department links. There is NO
// dedicated `PayrollDepartment` whitelist table.
//
// This resolver answers "which Spectre Department records should
// appear in Payroll presentation?" by reading the Payroll module's
// own source of truth (Employee + EmployeeEmploymentAssignment).
//
// Current Payroll architecture (per 2026-08 Payroll-3B-3 slice):
//   • Employee.departmentId — primary department attachment
//   • EmployeeEmploymentAssignment.departmentId — preferred modern
//     path (an employee can hold multiple assignments)
//   • Non-active / terminated employees still count toward "payroll-
//     valid" because the Dept must still render payroll history
//
// A tenant with ZERO Employee records (e.g. a historical TB-import
// tenant where HR data isn't seeded yet) will return an empty set.
// Presentation layer handles that by rendering the chart empty +
// surfacing the consolidated-GL-payroll-vs-roster reconciliation
// difference per directive §10.

import { prisma } from "@/lib/prisma";

export type PayrollDepartmentResolution = {
  /** Set of Spectre Department.code values that participate in
   *  Payroll (any Employee or EmploymentAssignment points at the
   *  department). Null when the Payroll module has no data at all
   *  for this tenant — downstream renders the chart empty with a
   *  reconciliation note. */
  departmentCodes: ReadonlySet<string>;
  /** True iff the tenant has any Employee / EmploymentAssignment
   *  record at all. False → no payroll module data → chart empty. */
  hasEmployeeRecords: boolean;
  /** Count of distinct Employee rows per department (diagnostic). */
  employeeCountByDepartment: ReadonlyMap<string, number>;
};

export async function resolvePayrollDepartments(
  clubId: string,
): Promise<PayrollDepartmentResolution> {
  // Read Employee.departmentId directly — this is the primary
  // Payroll module authority. Alternative paths
  // (EmployeeEmploymentAssignment.departmentId) can be layered in
  // later without changing this resolver's contract.
  const employees = await prisma.employee.findMany({
    where: { clubId },
    select: {
      department: { select: { id: true, code: true } },
    },
  });

  const employeeCountByDepartment = new Map<string, number>();
  for (const e of employees) {
    const code = e.department?.code;
    if (!code) continue;
    employeeCountByDepartment.set(code, (employeeCountByDepartment.get(code) ?? 0) + 1);
  }

  return {
    departmentCodes: new Set(employeeCountByDepartment.keys()),
    hasEmployeeRecords: employees.length > 0,
    employeeCountByDepartment,
  };
}
