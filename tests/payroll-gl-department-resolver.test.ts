// Phase 3 (2026-09-15) — pure resolver tests for Departmental Payroll
// Accounting. No DB, no Prisma access — proves the account-resolution
// precedence and journal-aggregation contract in isolation.

import { describe, it, expect } from "vitest";
import { Prisma } from "@prisma/client";
import {
  resolvePayrollJournal,
  resolveDepartmentExpenseAccount,
  type BatchEmployeeAmounts,
  type ComponentSnapshotForResolver,
  type GlDepartmentOverrideSnapshot,
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

describe("Phase 3 · frozenPrimaryDepartmentId (source-facts extractor)", () => {
  // Founder invariant: the frozen department must come from the
  // batch's `sourceFactsJson`, NEVER a live HR lookup. Once written
  // at Prepare, changing Employee.departmentId AFTER cannot alter
  // the journal outcome. This unit test proves the extractor picks
  // the department from the frozen blob.
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

describe("Phase 3 · resolveDepartmentExpenseAccount", () => {
  const overrides: GlDepartmentOverrideSnapshot[] = [
    {
      departmentId: "dept-admin",
      salaryExpenseAccountId: "acc-admin-salary",
      employerCppExpenseAccountId: "acc-admin-erCpp",
      employerEiExpenseAccountId: null, // deliberately unset → falls back to global
    },
  ];

  it("uses override account when configured for that dept + field", () => {
    const r = resolveDepartmentExpenseAccount(PROFILE, overrides, "dept-admin", "salaryExpenseAccountId");
    expect(r.accountId).toBe("acc-admin-salary");
    expect(r.source).toBe("OVERRIDE");
  });

  it("falls back to global when the override field is null", () => {
    const r = resolveDepartmentExpenseAccount(PROFILE, overrides, "dept-admin", "employerEiExpenseAccountId");
    expect(r.accountId).toBe("acc-global-erEi");
    expect(r.source).toBe("GLOBAL");
  });

  it("falls back to global for a department with no override row", () => {
    const r = resolveDepartmentExpenseAccount(PROFILE, overrides, "dept-grounds", "salaryExpenseAccountId");
    expect(r.accountId).toBe("acc-global-salary");
    expect(r.source).toBe("GLOBAL");
  });

  it("falls back to global when the frozen department id is null", () => {
    const r = resolveDepartmentExpenseAccount(PROFILE, overrides, null, "salaryExpenseAccountId");
    expect(r.accountId).toBe("acc-global-salary");
    expect(r.source).toBe("GLOBAL");
  });
});

describe("Phase 3 · resolvePayrollJournal", () => {
  it("routes two departments' salaries to two distinct account lines", () => {
    // Setup: dept-admin has an override to acc-admin-salary; dept-grounds
    // has NO override. Employee A ($5,000 gross, Administration) and
    // Employee B ($3,000 gross, Grounds) — both zero statutory for
    // simplicity so the balance is easy to reason about.
    const result = resolvePayrollJournal({
      label: "TEST",
      profile: PROFILE,
      departmentOverrides: [
        {
          departmentId: "dept-admin",
          salaryExpenseAccountId: "acc-admin-salary",
          employerCppExpenseAccountId: null,
          employerEiExpenseAccountId: null,
        },
      ],
      employees: [
        emp({ frozenDepartmentId: "dept-admin",   grossPay: D(5000), netPay: D(5000) }),
        emp({ frozenDepartmentId: "dept-grounds", grossPay: D(3000), netPay: D(3000) }),
      ],
      components: [],
    });

    // Two salary-expense debits: admin-salary $5000 + global-salary $3000.
    // Aggregated by account id (they don't share an account, so they stay separate).
    const salaryDebits = result.lines.filter((l) => l.debit != null && l.accountId.includes("salary"));
    expect(salaryDebits).toHaveLength(2);
    expect(salaryDebits.find((l) => l.accountId === "acc-admin-salary")?.debit?.toFixed(2)).toBe("5000.00");
    expect(salaryDebits.find((l) => l.accountId === "acc-global-salary")?.debit?.toFixed(2)).toBe("3000.00");

    // Journal balances (gross debits vs net-pay credits, no statutory).
    expect(result.balanced).toBe(true);
    expect(result.totalDebits.toFixed(2)).toBe("8000.00");
    expect(result.totalCredits.toFixed(2)).toBe("8000.00");
  });

  it("aggregates two employees in the SAME department into ONE salary debit line", () => {
    const result = resolvePayrollJournal({
      label: "TEST",
      profile: PROFILE,
      departmentOverrides: [
        {
          departmentId: "dept-admin",
          salaryExpenseAccountId: "acc-admin-salary",
          employerCppExpenseAccountId: null,
          employerEiExpenseAccountId: null,
        },
      ],
      employees: [
        emp({ frozenDepartmentId: "dept-admin", grossPay: D("4230.77"), netPay: D("4230.77") }),
        emp({ frozenDepartmentId: "dept-admin", grossPay: D("3269.23"), netPay: D("3269.23") }),
      ],
      components: [],
    });

    const adminSalary = result.lines.find((l) => l.accountId === "acc-admin-salary");
    expect(adminSalary).toBeDefined();
    expect(adminSalary!.debit?.toFixed(2)).toBe("7500.00");
    expect(adminSalary!.departmentIds).toEqual(["dept-admin"]);
    expect(result.balanced).toBe(true);
  });

  it("keeps liabilities centralized regardless of dept overrides", () => {
    const result = resolvePayrollJournal({
      label: "TEST",
      profile: PROFILE,
      departmentOverrides: [
        {
          departmentId: "dept-admin",
          salaryExpenseAccountId: "acc-admin-salary",
          employerCppExpenseAccountId: "acc-admin-erCpp",
          employerEiExpenseAccountId: "acc-admin-erEi",
        },
      ],
      employees: [
        emp({
          frozenDepartmentId: "dept-admin",
          grossPay: D(1000), netPay: D("800"),
          deductionCppEeCombined: D("60"),
          deductionEiEe: D("20"),
          deductionFederalTax: D("80"),
          deductionProvincialTax: D("40"),
          employerCppCombined: D("60"),
          employerEi: D("28"),
        }),
      ],
      components: [],
    });

    const netPay = result.lines.find((l) => l.accountId === PROFILE.netPayPayableAccountId);
    const cppPayable = result.lines.find((l) => l.accountId === PROFILE.cppPayableAccountId);
    const eiPayable  = result.lines.find((l) => l.accountId === PROFILE.eiPayableAccountId);
    const fedPayable = result.lines.find((l) => l.accountId === PROFILE.federalTaxPayableAccountId);

    expect(netPay?.credit?.toFixed(2)).toBe("800.00");
    expect(cppPayable?.credit?.toFixed(2)).toBe("120.00"); // ee + er
    expect(eiPayable?.credit?.toFixed(2)).toBe("48.00");   // ee + er
    expect(fedPayable?.credit?.toFixed(2)).toBe("80.00");
    // Central liabilities always carry NO departmentIds tag — they are
    // Club-wide, not attributable to a single department.
    expect(cppPayable?.departmentIds).toEqual([]);
    expect(netPay?.departmentIds).toEqual([]);

    // Journal balances.
    expect(result.balanced).toBe(true);
  });

  it("routes employer CPP + employer EI expense to the department override when set", () => {
    const result = resolvePayrollJournal({
      label: "TEST",
      profile: PROFILE,
      departmentOverrides: [
        {
          departmentId: "dept-grounds",
          salaryExpenseAccountId: null,
          employerCppExpenseAccountId: "acc-grounds-erCpp",
          employerEiExpenseAccountId: "acc-grounds-erEi",
        },
      ],
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

    // Salary falls through to GLOBAL (no override for salary here).
    expect(result.lines.find((l) => l.accountId === "acc-global-salary")?.debit?.toFixed(2)).toBe("1000.00");
    // Employer CPP + EI route to the DEPT override accounts.
    expect(result.lines.find((l) => l.accountId === "acc-grounds-erCpp")?.debit?.toFixed(2)).toBe("60.00");
    expect(result.lines.find((l) => l.accountId === "acc-grounds-erEi")?.debit?.toFixed(2)).toBe("28.00");
    expect(result.balanced).toBe(true);
  });

  it("subtracts INCREASES_NET_PAY component amounts from residual salary expense (no double-post)", () => {
    // Employee has $5,000 gross, of which $75 came from a Cell Phone
    // allowance already booked to its own expense account via the
    // component snapshot. Residual salary expense = $5000 - $75 = $4,925.
    const result = resolvePayrollJournal({
      label: "TEST",
      profile: PROFILE,
      departmentOverrides: [],
      employees: [
        emp({
          frozenDepartmentId: null,
          grossPay: D(5000), netPay: D(5000),
          componentCashInGross: D(75),
        }),
      ],
      components: [
        {
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

    const residual = result.lines.find((l) => l.accountId === "acc-global-salary");
    const cellExp  = result.lines.find((l) => l.accountId === "acc-comp-cell");
    expect(residual?.debit?.toFixed(2)).toBe("4925.00");
    expect(cellExp?.debit?.toFixed(2)).toBe("75.00");
    expect(result.balanced).toBe(true);
    expect(result.totalDebits.toFixed(2)).toBe("5000.00");
    expect(result.totalCredits.toFixed(2)).toBe("5000.00");
  });
});
