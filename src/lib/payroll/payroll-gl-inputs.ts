// Phase 3 (2026-09-15) — DB-backed input assembler for the payroll
// GL resolver.
//
// Loads a batch's PayrollBatchEmployee rows, its PayrollBatchComponentSnapshot
// rows, the club's PayrollGlAccountingProfile, and the club's
// PayrollGlDepartmentOverride rows into the pure shapes the resolver
// consumes. Callers (preview + posting) MUST go through this so both
// paths see identical inputs.
//
// This module NEVER reads live HR (`Employee.departmentId` /
// `EmployeeEmploymentAssignment`) — the frozen department is
// extracted from the batch employee's `sourceFactsJson` blob written
// at Prepare time.

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { parseSourceFactsV1 } from "./source-facts-schema";
import type {
  BatchEmployeeAmounts,
  ComponentSnapshotForResolver,
  GlDepartmentOverrideSnapshot,
  GlProfileSnapshot,
} from "./payroll-gl-resolver";

/** Extract the frozen primary department id from a source-facts blob.
 *  Uses the same rule as overview-view.ts (role === "PRIMARY" first,
 *  else first assignment). Returns null when the blob is missing or
 *  no assignment carries a departmentId. */
export function frozenPrimaryDepartmentId(sourceFactsJson: string | null | undefined): string | null {
  if (!sourceFactsJson) return null;
  try {
    const facts = parseSourceFactsV1(sourceFactsJson);
    if (!facts) return null;
    const primary = facts.assignments.find((a) => a.role === "PRIMARY") ?? facts.assignments[0] ?? null;
    return primary?.departmentId ?? null;
  } catch {
    // Malformed source facts must never silently corrupt journal
    // resolution; treat as unknown department so it falls through to
    // the global default and the ordinary Prepare-time schema-guard
    // catches the corruption on the next re-prepare.
    return null;
  }
}

const ZERO = new Prisma.Decimal(0);
const d = (v: Prisma.Decimal | null | undefined): Prisma.Decimal => v ?? ZERO;

/** Load the resolver's input shape for a specific batch. */
export async function loadPayrollGlInputs(
  clubId: string,
  batchId: string,
): Promise<{
  profile: GlProfileSnapshot | null;
  departmentOverrides: GlDepartmentOverrideSnapshot[];
  employees: BatchEmployeeAmounts[];
  components: ComponentSnapshotForResolver[];
}> {
  const [config, overrides, emps, snaps] = await Promise.all([
    prisma.payrollClubConfig.findUnique({
      where: { clubId },
      include: { glAccountingProfile: true },
    }),
    prisma.payrollGlDepartmentOverride.findMany({
      where: { clubId },
      select: {
        departmentId: true,
        salaryExpenseAccountId: true,
        employerCppExpenseAccountId: true,
        employerEiExpenseAccountId: true,
      },
    }),
    prisma.payrollBatchEmployee.findMany({
      where: { batchId, clubId },
      select: {
        id: true, employeeId: true,
        sourceFactsJson: true,
        grossPay: true, netPay: true,
        deductionCppEeCombined: true, deductionCpp2Ee: true,
        deductionEiEe: true,
        deductionFederalTax: true, deductionProvincialTax: true,
        employerCppCombined: true, employerCpp2: true,
        employerEi: true,
        employee: { select: { firstName: true, lastName: true } },
      },
    }),
    prisma.payrollBatchComponentSnapshot.findMany({
      where: { batchId, clubId },
      select: {
        batchEmployeeId: true,
        componentCode: true, displayName: true,
        side: true, cashEffect: true, category: true, provenance: true,
        resolvedAmount: true,
        expenseAccountIdSnapshot: true, liabilityAccountIdSnapshot: true,
      },
    }),
  ]);

  const profile = config?.glAccountingProfile
    ? {
        salaryExpenseAccountId:        config.glAccountingProfile.salaryExpenseAccountId,
        employerCppExpenseAccountId:   config.glAccountingProfile.employerCppExpenseAccountId,
        employerEiExpenseAccountId:    config.glAccountingProfile.employerEiExpenseAccountId,
        netPayPayableAccountId:        config.glAccountingProfile.netPayPayableAccountId,
        cppPayableAccountId:           config.glAccountingProfile.cppPayableAccountId,
        eiPayableAccountId:            config.glAccountingProfile.eiPayableAccountId,
        federalTaxPayableAccountId:    config.glAccountingProfile.federalTaxPayableAccountId,
        provincialTaxPayableAccountId: config.glAccountingProfile.provincialTaxPayableAccountId,
      }
    : null;

  // Pre-compute per-batch-employee `componentCashInGross` (sum of
  // EMPLOYEE-side INCREASES_NET_PAY component amounts attributed to
  // this employee).
  const cashByBatchEmployee = new Map<string, Prisma.Decimal>();
  for (const s of snaps) {
    if (!s.batchEmployeeId) continue;
    if (s.resolvedAmount == null || (s.resolvedAmount as Prisma.Decimal).isZero()) continue;
    if (s.side !== "EMPLOYEE" || s.cashEffect !== "INCREASES_NET_PAY") continue;
    const acc = cashByBatchEmployee.get(s.batchEmployeeId) ?? ZERO;
    cashByBatchEmployee.set(s.batchEmployeeId, acc.plus(s.resolvedAmount as Prisma.Decimal));
  }

  const employees: BatchEmployeeAmounts[] = emps.map((e) => ({
    batchEmployeeId: e.id,
    employeeId: e.employeeId,
    displayName: `${e.employee.firstName ?? ""} ${e.employee.lastName ?? ""}`.trim() || e.employeeId,
    frozenDepartmentId: frozenPrimaryDepartmentId(e.sourceFactsJson),
    grossPay:                d(e.grossPay),
    netPay:                  d(e.netPay),
    deductionCppEeCombined:  d(e.deductionCppEeCombined),
    deductionCpp2Ee:         d(e.deductionCpp2Ee),
    deductionEiEe:           d(e.deductionEiEe),
    deductionFederalTax:     d(e.deductionFederalTax),
    deductionProvincialTax:  d(e.deductionProvincialTax),
    employerCppCombined:     d(e.employerCppCombined),
    employerCpp2:            d(e.employerCpp2),
    employerEi:              d(e.employerEi),
    componentCashInGross:    cashByBatchEmployee.get(e.id) ?? ZERO,
  }));

  const components: ComponentSnapshotForResolver[] = snaps.map((s) => ({
    componentCode: s.componentCode,
    displayName: s.displayName,
    side: s.side,
    cashEffect: s.cashEffect,
    category: s.category,
    provenance: s.provenance,
    resolvedAmount: s.resolvedAmount as Prisma.Decimal | null,
    expenseAccountIdSnapshot: s.expenseAccountIdSnapshot,
    liabilityAccountIdSnapshot: s.liabilityAccountIdSnapshot,
  }));

  return {
    profile,
    departmentOverrides: overrides.map((o) => ({
      departmentId: o.departmentId,
      salaryExpenseAccountId: o.salaryExpenseAccountId,
      employerCppExpenseAccountId: o.employerCppExpenseAccountId,
      employerEiExpenseAccountId: o.employerEiExpenseAccountId,
    })),
    employees,
    components,
  };
}
