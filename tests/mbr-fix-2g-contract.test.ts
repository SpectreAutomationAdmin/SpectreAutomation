// MBR-FIX-2G (2026-10-10) — Section XII Departmental Payroll Analysis.
//
// Root cause of "YTD Total Payroll unavailable" + "0.0% Payroll-to-
// Revenue" on Feb 2026:
//   `resolveHistoricalPayrollByDepartment` passes the caller's
//   `periodStart` (= Feb 1 for Feb package) directly to
//   `incomeStatementByDepartmentFromSnapshot`.  The Jonas TB
//   snapshot has `periodStart = Jan 1` (fiscal YTD), so the
//   YTD-slice `sameDay(snapshot.periodStart, filter.from)` gate
//   failed → `reportingAccountBalances` returned no balances →
//   per-dept payroll aggregated to zero → every KPI card and
//   chart on Section XII fell back to "Unavailable".
//
// Same DEF-4 pattern MBR-FIX-1 / 2A / 2B / 2C / 2D / 2E / 2F
// corrected everywhere else.
//
// Fix pins:
//   §A  historical resolver computes its own fiscal-year start
//       internally (ignores the caller's periodStart).
//   §B  builder loads a prior-month-end YTD payroll map +
//       prior-month Budget map to compute true current-month
//       (MTD) payroll via YTD − priorYTD.
//   §C  first fiscal month (January) short-circuits to MTD == YTD.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO       = path.resolve(__dirname, "..");
const HISTORICAL = path.join(REPO, "src/lib/reporting/historical-payroll-by-department.ts");
const PAYROLL    = path.join(REPO, "src/lib/reporting/departmental-payroll-analysis.ts");

describe("MBR-FIX-2G §A — historical resolver uses fiscal-year start", () => {
  const src = readFileSync(HISTORICAL, "utf8");

  it("derives fiscalYtdStart from periodEnd year", () => {
    expect(src).toMatch(/const fiscalYtdStart = new Date\(Date\.UTC\(fiscalYear, 0, 1\)\);/);
  });

  it("incomeStatementByDepartmentFromSnapshot is called with fiscalYtdStart (not periodStart)", () => {
    expect(src).toMatch(/incomeStatementByDepartmentFromSnapshot\(clubId, fiscalYtdStart, periodEnd\)/);
    expect(src).not.toMatch(/incomeStatementByDepartmentFromSnapshot\(clubId, periodStart, periodEnd\)/);
  });

  it("void periodStart; preserves the API shape without silently misusing the arg", () => {
    expect(src).toMatch(/void periodStart;/);
  });
});

describe("MBR-FIX-2G §B — Section XII builder computes MTD via YTD − priorYTD", () => {
  const src = readFileSync(PAYROLL, "utf8");

  it("isFirstFiscalMonth gate derived from periodEnd.getUTCMonth()", () => {
    expect(src).toMatch(/const monthIndex = period\.periodEnd\.getUTCMonth\(\);/);
    expect(src).toMatch(/const isFirstFiscalMonth = monthIndex === 0;/);
  });

  it("prior-month-end YTD payroll resolver called for Feb+ periods", () => {
    expect(src).toMatch(/const priorMonthEnd = new Date\(Date\.UTC\(/);
    // Two calls to the historical resolver (current YTD + prior-
    // month YTD).  Confirm both are present + the prior one uses
    // priorMonthEnd.
    const calls = (src.match(/await resolveHistoricalPayrollByDepartment\(/g) || []).length;
    expect(calls).toBeGreaterThanOrEqual(2);
    expect(src).toMatch(/priorMonthEnd,/);
  });

  it("prior-month Budget resolver called with throughMonth − 1", () => {
    expect(src).toMatch(/resolveBudgetPayrollByDepartment\(\{\s*clubId,\s*fiscalYear,\s*throughMonth: throughMonth - 1,\s*\}\)/);
  });

  it("MTD derivation: current-month = YTD − priorYTD (dept-level)", () => {
    expect(src).toMatch(/const mtdActual = isFirstFiscalMonth \? ytdActual : \(ytdActual - priorActual\);/);
    expect(src).toMatch(/const mtdBudget = isFirstFiscalMonth \? ytdBudget : \(ytdBudget - priorBudget\);/);
  });
});

describe("MBR-FIX-2G §C — first fiscal month short-circuits", () => {
  const src = readFileSync(PAYROLL, "utf8");

  it("priorYtdByDept lookup is skipped when isFirstFiscalMonth = true", () => {
    const idx = src.indexOf("let priorYtdByDept: Map<string | null, number> | null = null;");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 1200);
    expect(block).toMatch(/if \(!isFirstFiscalMonth\) \{/);
  });

  it("priorMonthBudgetByDept is skipped when isFirstFiscalMonth = true", () => {
    const idx = src.indexOf("let priorMonthBudgetByDept: Map<string | null, number> | null = null;");
    expect(idx).toBeGreaterThan(0);
    const block = src.slice(idx, idx + 600);
    expect(block).toMatch(/if \(!isFirstFiscalMonth\) \{/);
  });
});
