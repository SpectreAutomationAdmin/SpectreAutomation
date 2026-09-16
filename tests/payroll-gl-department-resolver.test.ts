// Phase 3 follow-up (2026-09-16) — pure resolver tests for Departmental
// Payroll Accounting under the corrected natural-account + department-
// dimension model.
//
// Proves the resolver emits one journal line per (accountId, departmentId)
// pair, aggregates within (accountId, departmentId) buckets, and keeps
// centralized liabilities on departmentId=null.

import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import {
  resolvePayrollJournal,
  type BatchEmployeeAmounts,
  type GlProfileSnapshot,
} from "@/lib/payroll/payroll-gl-resolver";
import { frozenPrimaryDepartmentId } from "@/lib/payroll/payroll-gl-inputs";

const D = (v: string | number): Prisma.Decimal => new Prisma.Decimal(v);
const ZERO = D(0);

const PROFILE: GlProfileSnapshot = {
  salaryExpenseAccountId:        "acc-global-salary",
  employerCppExpenseAccountId:   "acc-global-erCpp",
  employerEiExpenseAccountId:    "acc-global-erEi",
  netPayPayableAccountId:        "acc-liab-netpay",
  cppPayableAccountId:           "acc-liab-cpp",
  eiPayableAccountId:            "acc-liab-ei",
  federalTaxPayableAccountId:    "acc-liab-fed",
  provincialTaxPayableAccountId: "acc-liab-prov",
};

function emp(overrides: Partial<BatchEmployeeAmounts>): BatchEmployeeAmounts {
  return {
    batchEmployeeId: "be-x",
    employeeId: "emp-x",
    displayName: "Test Employee",
    frozenDepartmentId: null,
    grossPay: ZERO,
    netPay: ZERO,
    deductionCppEeCombined: ZERO,
    deductionCpp2Ee: ZERO,
    deductionEiEe: ZERO,
    deductionFederalTax: ZERO,
    deductionProvincialTax: ZERO,
    employerCppCombined: ZERO,
    employerCpp2: ZERO,
    employerEi: ZERO,
    componentCashInGross: ZERO,
    ...overrides,
  };
}

describe("Phase 3 follow-up · frozenPrimaryDepartmentId (source-facts extractor)", () => {
  const makeFacts = (deptId: string | null): string => JSON.stringify({
    schemaVersion: 1,
    coverage: {
      membershipEffectiveFrom: "2026-09-13T00:00:00.000Z",
      membershipEffectiveTo: null,
      coverageStart: "2026-09-13T00:00:00.000Z",
      coverageEnd: "2026-09-27T00:00:00.000Z",
      coverageDays: 14, periodDays: 14, isFullPeriod: true,
    },
    identity: { dateOfBirth: "1980-01-01T00:00:00.000Z" },
    assignments: [{
      id: "asn-1",
      role: "PRIMARY",
      departmentId: deptId,
      positionId: null,
      employmentType: "FULL_TIME",
      effectiveFrom: "2020-01-01T00:00:00.000Z",
      effectiveTo: null,
    }],
    compensations: [],
    allowances: [],
  });

  it("extracts the PRIMARY assignment's departmentId from the frozen blob", () => {
    expect(frozenPrimaryDepartmentId(makeFacts("dept-admin"))).toBe("dept-admin");
  });

  it("returns null when the blob has no department", () => {
    expect(frozenPrimaryDepartmentId(makeFacts(null))).toBeNull();
  });

  it("returns null for a null / empty blob (no crash)", () => {
    expect(frozenPrimaryDepartmentId(null)).toBeNull();
    expect(frozenPrimaryDepartmentId("")).toBeNull();
    expect(frozenPrimaryDepartmentId(undefined)).toBeNull();
  });

  it("returns null for malformed JSON without throwing", () => {
    expect(frozenPrimaryDepartmentId("{ this is not json")).toBeNull();
  });
});

describe("Phase 3 follow-up · resolvePayrollJournal — natural + department dimension", () => {
  it("emits one line per (accountId, departmentId) pair — same natural account, two departments", () => {
    // Two employees, both post to the SAME global salary expense
    // account, but each carries a different frozen department. The
    // resolver must emit TWO lines: same accountId, differing
    // departmentIds. This is the founder-mandated §9 rule.
    const result = resolvePayrollJournal({
      label: "TEST",
      profile: PROFILE,
      employees: [
        emp({ frozenDepartmentId: "dept-admin",   grossPay: D(5000), netPay: D(5000) }),
        emp({ frozenDepartmentId: "dept-grounds", grossPay: D(3000), netPay: D(3000) }),
      ],
      components: [],
    });

    const salaryDebits = result.lines.filter((l) => l.accountId === PROFILE.salaryExpenseAccountId && l.debit != null);
    expect(salaryDebits).toHaveLength(2);
    const admin   = salaryDebits.find((l) => l.departmentId === "dept-admin");
    const grounds = salaryDebits.find((l) => l.departmentId === "dept-grounds");
    expect(admin?.debit?.toFixed(2)).toBe("5000.00");
    expect(grounds?.debit?.toFixed(2)).toBe("3000.00");
    expect(result.balanced).toBe(true);
    expect(result.totalDebits.toFixed(2)).toBe("8000.00");
    expect(result.totalCredits.toFixed(2)).toBe("8000.00");
  });

  it("aggregates two employees in the SAME (account, department) into ONE line", () => {
    const result = resolvePayrollJournal({
      label: "TEST",
      profile: PROFILE,
      employees: [
        emp({ frozenDepartmentId: "dept-admin", grossPay: D("4230.77"), netPay: D("4230.77") }),
        emp({ frozenDepartmentId: "dept-admin", grossPay: D("3269.23"), netPay: D("3269.23") }),
      ],
      components: [],
    });

    const salaryDebits = result.lines.filter((l) => l.accountId === PROFILE.salaryExpenseAccountId && l.debit != null);
    expect(salaryDebits).toHaveLength(1);
    expect(salaryDebits[0].debit?.toFixed(2)).toBe("7500.00");
    expect(salaryDebits[0].departmentId).toBe("dept-admin");
    expect(result.balanced).toBe(true);
  });

  it("keeps liabilities centralized with departmentId=null regardless of employees' departments", () => {
    const result = resolvePayrollJournal({
      label: "TEST",
      profile: PROFILE,
      employees: [
        emp({
          frozenDepartmentId: "dept-admin",
          grossPay: D(1000), netPay: D(800),
          deductionCppEeCombined: D(60),
          deductionEiEe: D(20),
          deductionFederalTax: D(80),
          deductionProvincialTax: D(40),
          employerCppCombined: D(60),
          employerEi: D(28),
        }),
      ],
      components: [],
    });

    const netPay = result.lines.find((l) => l.accountId === PROFILE.netPayPayableAccountId);
    const cppPayable = result.lines.find((l) => l.accountId === PROFILE.cppPayableAccountId);
    expect(netPay?.credit?.toFixed(2)).toBe("800.00");
    expect(netPay?.departmentId).toBeNull();
    expect(cppPayable?.credit?.toFixed(2)).toBe("120.00");
    expect(cppPayable?.departmentId).toBeNull();
    expect(result.balanced).toBe(true);
  });

  it("attaches the frozen department to employer CPP + employer EI expense lines", () => {
    const result = resolvePayrollJournal({
      label: "TEST",
      profile: PROFILE,
      employees: [
        emp({
          frozenDepartmentId: "dept-grounds",
          grossPay: D(1000), netPay: D(800),
          deductionCppEeCombined: D(60),
          deductionEiEe: D(20),
          deductionFederalTax: D(80),
          deductionProvincialTax: D(40),
          employerCppCombined: D(60),
          employerEi: D(28),
        }),
      ],
      components: [],
    });

    const erCpp = result.lines.find((l) => l.accountId === PROFILE.employerCppExpenseAccountId);
    const erEi  = result.lines.find((l) => l.accountId === PROFILE.employerEiExpenseAccountId);
    expect(erCpp?.departmentId).toBe("dept-grounds");
    expect(erEi?.departmentId).toBe("dept-grounds");
    expect(erCpp?.debit?.toFixed(2)).toBe("60.00");
    expect(erEi?.debit?.toFixed(2)).toBe("28.00");
  });

  it("subtracts INCREASES_NET_PAY component amounts from residual salary expense", () => {
    const result = resolvePayrollJournal({
      label: "TEST",
      profile: PROFILE,
      employees: [
        emp({
          batchEmployeeId: "be-A",
          frozenDepartmentId: "dept-admin",
          grossPay: D(5000), netPay: D(5000),
          componentCashInGross: D(75),
        }),
      ],
      components: [
        {
          batchEmployeeId: "be-A",
          componentCode: "CELL_PHONE",
          displayName: "Cell Phone Allowance",
          side: "EMPLOYEE",
          cashEffect: "INCREASES_NET_PAY",
          category: "ALLOWANCE",
          provenance: "RECURRING",
          resolvedAmount: D(75),
          expenseAccountIdSnapshot: "acc-comp-cell",
          liabilityAccountIdSnapshot: null,
        },
      ],
    });

    const residual = result.lines.find((l) => l.accountId === PROFILE.salaryExpenseAccountId);
    const cellExp  = result.lines.find((l) => l.accountId === "acc-comp-cell");
    expect(residual?.debit?.toFixed(2)).toBe("4925.00");
    expect(residual?.departmentId).toBe("dept-admin");
    expect(cellExp?.debit?.toFixed(2)).toBe("75.00");
    // Component expense lines carry the frozen department too — the
    // founder-mandated §3 rule (Cell Phone Allowance for two employees
    // in different departments must remain distinguishable).
    expect(cellExp?.departmentId).toBe("dept-admin");
    expect(result.balanced).toBe(true);
  });

  it("preserves component department attribution across two employees in different departments", () => {
    // Two employees in different departments, both receiving the SAME
    // component (Cell Phone Allowance). Same natural account for the
    // component's expense; but the resolver MUST emit two lines
    // differing only in departmentId — the founder-mandated §3 rule.
    const result = resolvePayrollJournal({
      label: "TEST",
      profile: PROFILE,
      employees: [
        emp({
          batchEmployeeId: "be-admin",
          frozenDepartmentId: "dept-admin",
          grossPay: D(5000), netPay: D(5000), componentCashInGross: D(75),
        }),
        emp({
          batchEmployeeId: "be-grounds",
          frozenDepartmentId: "dept-grounds",
          grossPay: D(4000), netPay: D(4000), componentCashInGross: D(75),
        }),
      ],
      components: [
        {
          batchEmployeeId: "be-admin",
          componentCode: "CELL_PHONE", displayName: "Cell Phone Allowance",
          side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
          category: "ALLOWANCE", provenance: "RECURRING",
          resolvedAmount: D(75),
          expenseAccountIdSnapshot: "acc-comp-cell", liabilityAccountIdSnapshot: null,
        },
        {
          batchEmployeeId: "be-grounds",
          componentCode: "CELL_PHONE", displayName: "Cell Phone Allowance",
          side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
          category: "ALLOWANCE", provenance: "RECURRING",
          resolvedAmount: D(75),
          expenseAccountIdSnapshot: "acc-comp-cell", liabilityAccountIdSnapshot: null,
        },
      ],
    });

    const cellLines = result.lines.filter((l) => l.accountId === "acc-comp-cell");
    expect(cellLines).toHaveLength(2);
    const admin   = cellLines.find((l) => l.departmentId === "dept-admin");
    const grounds = cellLines.find((l) => l.departmentId === "dept-grounds");
    expect(admin?.debit?.toFixed(2)).toBe("75.00");
    expect(grounds?.debit?.toFixed(2)).toBe("75.00");
    expect(result.balanced).toBe(true);
  });
});
