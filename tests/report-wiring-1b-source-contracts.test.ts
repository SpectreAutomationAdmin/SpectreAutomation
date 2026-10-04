// REPORT-WIRING-1B (2026-10-04) — source-contract pins.
//
// Three architectural invariants:
//   1. Payroll Department roster comes from the Payroll module
//      (Employee → Department), NOT from the financial-reporting
//      department set.
//   2. Depreciation is carved out of opex in EVERY NOI resolver
//      so "NOI before depreciation" has exactly one definition.
//   3. The canonical NOI-before-dep resolvers return a separate
//      `depreciation` field alongside the operating-only revenue /
//      cogs / opex / noi.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const PAYROLL_RESOLVER = path.join(REPO, "src/lib/reporting/payroll-departments-resolver.ts");
const PAYROLL_ANALYSIS = path.join(REPO, "src/lib/reporting/payroll-analysis.ts");
const RATIO = path.join(REPO, "src/lib/reporting/ratio-registry.ts");
const BUDGET = path.join(REPO, "src/lib/reporting/budget-resolver.ts");
const OPRES = path.join(REPO, "src/lib/reporting/operating-results.ts");
const DEPTPL = path.join(REPO, "src/lib/accounting/dept-pl-from-snapshot.ts");
const CONTRACT = path.join(REPO, "src/lib/reporting/monthly-financial-contract.ts");

describe("REPORT-WIRING-1B §2-10 — Payroll Department roster from the Payroll module", () => {
  it("resolvePayrollDepartments exists + reads from prisma.employee (not financial-reporting)", () => {
    const src = readFileSync(PAYROLL_RESOLVER, "utf8");
    expect(src).toMatch(/export async function resolvePayrollDepartments/);
    expect(src).toMatch(/prisma\.employee\.findMany/);
    expect(src).toMatch(/departmentCodes:\s*new Set/);
    expect(src).toMatch(/hasEmployeeRecords/);
  });

  it("resolvePayrollDepartments remains available as the OPERATIONAL roster (PAYROLL-HIST-1 moved the historical chart off it)", () => {
    const src = readFileSync(PAYROLL_RESOLVER, "utf8");
    expect(src).toMatch(/export async function resolvePayrollDepartments/);
    // Still backed by prisma.employee — operational-roster purpose unchanged.
    expect(src).toMatch(/prisma\.employee\.findMany/);
  });

  it("the HISTORICAL payroll chart no longer uses the operational roster as a filter (PAYROLL-HIST-1 §1)", () => {
    const src = readFileSync(PAYROLL_ANALYSIS, "utf8");
    const live = src.match(/export async function buildPayrollDepartmentLive[\s\S]*?return buildPayrollDepartmentData/)?.[0] ?? "";
    // Operational roster must NOT drive the chart filter.
    expect(live).not.toMatch(/payrollDeptFilter/);
    expect(live).not.toMatch(/if \(!payrollDepts\.hasEmployeeRecords\) return false/);
    // Historical resolver IS used.
    expect(live).toMatch(/resolveHistoricalPayrollByDepartment/);
  });

  it("no name-based special-case for Corporate Income & Expenses in the Payroll filter path", () => {
    const src = readFileSync(PAYROLL_ANALYSIS, "utf8");
    // The filter must not reject rows by matching the CORPORATE
    // literal in CODE (not comments). Easiest signal: no string
    // literal "CORPORATE" anywhere.
    expect(src).not.toMatch(/"CORPORATE"/);
    expect(src).not.toMatch(/'CORPORATE'/);
    // The filter must not reject by name-string includes.
    expect(src).not.toMatch(/departmentName.*includes\(/i);
  });
});

describe("REPORT-WIRING-1B §20-25 — canonical NOI before depreciation", () => {
  it("ratio-registry carves IS_DEPRECIATION out of opex", () => {
    const src = readFileSync(RATIO, "utf8");
    expect(src).toMatch(/let depreciation = ZERO/);
    expect(src).toMatch(/const isDepreciation = b\.fsGroupKey === "IS_DEPRECIATION"/);
    expect(src).toMatch(/else if \(isDepreciation\) depreciation = depreciation\.plus/);
  });

  it("resolveBudgetMonthlyIncomeStatement surfaces monthlyDepreciation + opex excludes depreciation", () => {
    const src = readFileSync(BUDGET, "utf8");
    expect(src).toMatch(/monthlyDepreciation:\s*number\[\]/);
    expect(src).toMatch(/else if \(key === "IS_DEPRECIATION"\) depreciation\[m\] \+= v/);
    // NOI formula = rev - cogs - opex (NOT - depreciation again).
    expect(src).toMatch(/monthlyNoi = monthlyRevenue\.map\(\(rv, i\) => rv - cogs\[i\] - opex\[i\]\)/);
  });

  it("resolveBudgetIncomeStatement surfaces depreciation + noi = revenue - cogs - opex (ex-dep)", () => {
    const src = readFileSync(BUDGET, "utf8");
    expect(src).toMatch(/depreciation:\s*number/);
    expect(src).toMatch(/else if \(key === "IS_DEPRECIATION"\) depreciation \+= ytd/);
    expect(src).toMatch(/displayNoi = displayRevenue - cogs - opex/);
  });

  it("getOperatingResults snapshot path skips IS_DEPRECIATION", () => {
    const src = readFileSync(OPRES, "utf8");
    expect(src).toMatch(/const isDepreciation = b\.fsGroupKey === "IS_DEPRECIATION"/);
    expect(src).toMatch(/if \(isDepreciation\) continue/);
  });

  it("incomeStatementByDepartmentFromSnapshot skips IS_DEPRECIATION in BOTH per-dept AND consolidated loops", () => {
    const src = readFileSync(DEPTPL, "utf8");
    const guards = src.match(/if \(b\.fsGroupKey === "IS_DEPRECIATION"\) continue/g) ?? [];
    expect(guards.length).toBeGreaterThanOrEqual(2);
  });

  it("docstring at operating-results.ts snapshot resolver now accurately describes the formula", () => {
    const src = readFileSync(OPRES, "utf8");
    expect(src).toMatch(/OpEx-excluding-\s*\*  depreciation/);
  });

  it("monthly-financial-contract SoA rollup consumes monthlyOpex directly (no re-subtraction)", () => {
    const src = readFileSync(CONTRACT, "utf8");
    expect(src).toMatch(/bMonthly\.monthlyOpex now EXCLUDES/);
    expect(src).toMatch(/bMonthly\.monthlyDepreciation\[currentIdx\]/);
    // No stale "- deprMonthly" subtraction left in totalOperatingExpense.
    const block = src.match(/totalOperatingExpense:\s*\{[\s\S]*?\},/)?.[0] ?? "";
    expect(block).not.toMatch(/-\s*deprMonthly/);
    expect(block).not.toMatch(/-\s*sumThrough\(deprMonthly\)/);
  });
});
