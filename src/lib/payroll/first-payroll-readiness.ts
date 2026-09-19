// Slice E (2026-09-19) — first-payroll readiness DTO.
// Compact summary answering §24: does the Club have the major
// prerequisites required to start payroll for a given tax year?
//
// EMPLOYEE PAYMENT is explicitly shown as "External/manual — Spectre
// payment transmission not configured" per §25. This surface must NOT
// invent a "Ready to pay" state.

import { prisma } from "../prisma";
import { requirePermission, type Principal } from "../rbac";

export interface ReadinessRow {
  key:
    | "STATUTORY_PACKAGE"
    | "IMPLEMENTATION_DECLARATION"
    | "GL_PROFILE"
    | "PAY_GROUP_CALENDAR"
    | "DEPARTMENT_APPROVAL_CONFIG"
    | "PAYROLL_COMPONENTS"
    | "EMPLOYEE_PAYMENT";
  label: string;
  state: "READY" | "ACTION_REQUIRED" | "EXTERNAL";
  detail: string;
  actionHref?: string;
  actionLabel?: string;
}

export interface FirstPayrollReadinessV1 {
  clubId: string;
  taxYear: number;
  rows: ReadinessRow[];
  overallReady: boolean;
}

export async function buildFirstPayrollReadiness(
  principal: Principal,
  clubId: string,
  taxYear: number,
): Promise<FirstPayrollReadinessV1> {
  requirePermission(principal, clubId, "payroll:read");

  const rows: ReadinessRow[] = [];

  // 1. Statutory package covering a date in the tax year.
  const anyPkg = await prisma.payrollStatutoryPackage.findFirst({
    where: {
      jurisdictionCountry: "CA",
      effectiveFrom: { lte: new Date(Date.UTC(taxYear, 11, 31)) },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: new Date(Date.UTC(taxYear, 0, 1)) } }],
    },
    select: { id: true },
  });
  rows.push({
    key: "STATUTORY_PACKAGE",
    label: "Statutory calculation package",
    state: anyPkg ? "READY" : "ACTION_REQUIRED",
    detail: anyPkg
      ? "CA/AB statutory rules installed and effective."
      : "No statutory package covers the tax year. Contact Spectre support to install.",
  });

  // 2. Implementation declaration confirmed for taxYear.
  const decl = await prisma.payrollImplementationDeclaration.findFirst({
    where: { clubId, taxYear },
  });
  rows.push({
    key: "IMPLEMENTATION_DECLARATION",
    label: "Payroll implementation declaration",
    state: decl?.confirmedAt ? "READY" : "ACTION_REQUIRED",
    detail: decl?.confirmedAt
      ? `Confirmed ${decl.mode.replace(/_/g, " ").toLowerCase()} for ${taxYear}.`
      : `Not confirmed for ${taxYear}. Choose ZERO OPENING YTD or MID-YEAR MIGRATION.`,
    actionHref: decl?.confirmedAt ? undefined : "/app/admin/payroll/setup#payroll-implementation",
    actionLabel: decl?.confirmedAt ? undefined : "Confirm implementation",
  });

  // 3. GL profile with all 8 statutory accounts.
  const glProfile = await prisma.payrollGlAccountingProfile.findUnique({ where: { clubId } });
  const glReady = glProfile != null
    && glProfile.salaryExpenseAccountId != null
    && glProfile.employerCppExpenseAccountId != null
    && glProfile.employerEiExpenseAccountId != null
    && glProfile.netPayPayableAccountId != null
    && glProfile.cppPayableAccountId != null
    && glProfile.eiPayableAccountId != null
    && glProfile.federalTaxPayableAccountId != null
    && glProfile.provincialTaxPayableAccountId != null;
  rows.push({
    key: "GL_PROFILE",
    label: "Payroll GL profile",
    state: glReady ? "READY" : "ACTION_REQUIRED",
    detail: glReady
      ? "All 8 statutory accounts assigned."
      : "One or more statutory accounts are unassigned.",
    actionHref: glReady ? undefined : "/app/admin/payroll/setup",
    actionLabel: glReady ? undefined : "Configure GL profile",
  });

  // 4. Pay Group with generated calendar for the year.
  const anyGroup = await prisma.payrollPayGroup.findFirst({ where: { clubId, active: true } });
  const anyPeriod = anyGroup
    ? await prisma.payrollPayPeriod.findFirst({ where: { clubId, payGroupId: anyGroup.id, taxYear } })
    : null;
  rows.push({
    key: "PAY_GROUP_CALENDAR",
    label: "Pay group + calendar",
    state: anyGroup && anyPeriod ? "READY" : "ACTION_REQUIRED",
    detail: !anyGroup
      ? "No active pay group. Add at least one (e.g. Salary Semi-Monthly)."
      : !anyPeriod
        ? `No pay periods generated for ${taxYear}. Generate the calendar.`
        : "Pay group + calendar in place.",
    actionHref: (!anyGroup || !anyPeriod) ? "/app/admin/payroll/setup" : undefined,
    actionLabel: (!anyGroup || !anyPeriod) ? "Open Payroll setup" : undefined,
  });

  // 5. Department approval configuration — cheap heuristic:
  //    a department exists that has active employees.
  const anyDept = await prisma.department.findFirst({ where: { clubId } });
  rows.push({
    key: "DEPARTMENT_APPROVAL_CONFIG",
    label: "Department approval configuration",
    state: anyDept ? "READY" : "ACTION_REQUIRED",
    detail: anyDept
      ? "At least one department exists."
      : "No departments configured. Departments are required for time approval routing.",
  });

  // 6. Payroll components — soft check.
  const anyComp = await prisma.payrollComponent.findFirst({ where: { clubId, active: true } });
  rows.push({
    key: "PAYROLL_COMPONENTS",
    label: "Payroll components",
    state: anyComp ? "READY" : "ACTION_REQUIRED",
    detail: anyComp
      ? "Component catalogue populated."
      : "No active payroll components. Employee recurring earnings / deductions cannot yet be attached.",
    actionHref: anyComp ? undefined : "/app/admin/payroll/setup/components",
    actionLabel: anyComp ? undefined : "Configure components",
  });

  // 7. Employee payment — deliberately NOT ready.
  rows.push({
    key: "EMPLOYEE_PAYMENT",
    label: "Employee payment",
    state: "EXTERNAL",
    detail: "External / manual — Spectre payment transmission is not configured. Employees are paid outside Spectre until a payment slice ships.",
  });

  const overallReady = rows.every((r) => r.state === "READY" || r.state === "EXTERNAL");
  return { clubId, taxYear, rows, overallReady };
}
