// MBR-FIX-2E (2026-10-10) — Section X Departmental P&L Summary.
//
// Root cause of "Nondepartmental $0" output on Feb 2026:
//   `incomeStatementByDepartmentFromSnapshot` was called with
//   `reportingPeriod.periodStart = Feb 1` which hits the same
//   DEF-4 YTD-slice sameDay gate every other resolver hit — the
//   Jonas TB snapshot's `periodStart = Jan 1`, so Feb 1 fails,
//   `reportingAccountBalances` returns empty, and the dept
//   resolver sees no balances → cards collapse to a single
//   Nondepartmental $0 placeholder.
//
// Fix pins:
//   §A  monthly-package passes fiscal-year start to the dept
//       resolver (matches MBR-FIX-1 / 2A / 2B / 2C / 2D).
//   §B  budget resolver output carries `byDepartmentOperatingNoi`
//       with the authoritative NOI definition (operating-fund,
//       ex-dep, ex-fin, display-sign).
//   §C  monthly-package builds a `budgetByDeptCode` map from the
//       canonical resolver and threads it into the chapter
//       builder.
//   §D  `buildCouleeDepartmentalPLSummary` renders Payroll row
//       and Budget YTD + Variance when the map is populated.
//   §E  Stale "budget importer not landed" copy is swapped for a
//       committed-budget sentence when a budget exists.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO    = path.resolve(__dirname, "..");
const PACKAGE = path.join(REPO, "src/lib/reporting/monthly-package.ts");
const BUDGET  = path.join(REPO, "src/lib/reporting/budget-resolver.ts");
const DEPT    = path.join(REPO, "src/lib/reporting/departmental-pl-summary.ts");

describe("MBR-FIX-2E §A — fiscal-year start passed to the dept resolver", () => {
  const src = readFileSync(PACKAGE, "utf8");

  it("deptFiscalYearStart derived from reportingPeriod.periodEnd.year", () => {
    expect(src).toMatch(
      /const deptFiscalYearStart = new Date\(Date\.UTC\(\s*reportingPeriod\.periodEnd\.getUTCFullYear\(\), 0, 1,?\s*\)\);/,
    );
  });

  it("resolver call passes deptFiscalYearStart (not reportingPeriod.periodStart)", () => {
    const idx = src.indexOf("incomeStatementByDepartmentFromSnapshot(");
    expect(idx).toBeGreaterThan(0);
    // Find the FIRST call site (the Section X one, not the comment
    // references).  Scan forward for the arg list.
    const block = src.slice(idx, idx + 500);
    expect(block).toMatch(/deptFiscalYearStart,/);
  });
});

describe("MBR-FIX-2E §B — budget resolver exposes byDepartmentOperatingNoi", () => {
  const src = readFileSync(BUDGET, "utf8");

  it("ResolveBudgetResult.byDepartmentOperatingNoi field exists on the type", () => {
    expect(src).toMatch(/byDepartmentOperatingNoi: Array<\{/);
    expect(src).toMatch(/ytdNoi: number;/);
    expect(src).toMatch(/annualNoi: number;/);
    expect(src).toMatch(/monthlyPayroll: number\[\];/);
  });

  it("builder iterates parsed lines + applies operating-fund filter + fsGroup carve-outs", () => {
    // The byDepartmentOperatingNoi block sits anywhere in the file;
    // match on each pin individually (sliding window varies).
    expect(src).toMatch(/if \(!isOperatingFundTag\(l\.fundApplicability\)\) continue;/);
    expect(src).toMatch(/key2 === "IS_DEPRECIATION" \|\| key2 === "IS_INTEREST_EXPENSE"/);
    expect(src).toMatch(/if \(isDepOrFin\) continue;/);
    expect(src).toMatch(/agg\.monthlyNoi\[m\] \+= -l\.monthly\[m\];/);
  });

  it("empty-budget branch includes byDepartmentOperatingNoi: []", () => {
    expect(src).toMatch(/byDepartmentOperatingNoi: \[\],/);
  });

  it("the return threads byDepartmentOperatingNoi", () => {
    // Anchor on the final successful-return block (keyed by byFsGroup).
    const anchor = src.indexOf("byFsGroup,\n    byDepartmentOperatingNoi");
    expect(anchor).toBeGreaterThan(0);
  });
});

describe("MBR-FIX-2E §C — monthly-package threads budgetByDeptCode to the chapter builder", () => {
  const src = readFileSync(PACKAGE, "utf8");

  it("resolveBudget is called with throughMonth = periodEnd.month + 1", () => {
    expect(src).toMatch(/const throughMonth = reportingPeriod\.periodEnd\.getUTCMonth\(\) \+ 1;/);
    expect(src).toMatch(/resolveBudget\(\{/);
  });

  it("budgetByDeptCode map populated from byDepartmentOperatingNoi", () => {
    expect(src).toMatch(/for \(const row of b\.byDepartmentOperatingNoi\) \{/);
    expect(src).toMatch(/budgetByDeptCode\.set\(row\.departmentCode\.toUpperCase\(\), row\.ytdNoi\);/);
  });

  it("buildCouleeDepartmentalPLSummary receives budgetByDeptCode", () => {
    expect(src).toMatch(/buildCouleeDepartmentalPLSummary\(\{[\s\S]+?budgetByDeptCode,[\s\S]+?\}\);/);
  });
});

describe("MBR-FIX-2E §D — department card renders Payroll + Budget + Variance rows", () => {
  const src = readFileSync(DEPT, "utf8");

  it("DeptRow carries payroll alongside revenue/cogs/opex", () => {
    expect(src).toMatch(/payroll: \{ toString: \(\) => string \};/);
  });

  it("budgetByDeptCode arg wired into the builder", () => {
    expect(src).toMatch(/budgetByDeptCode\?: ReadonlyMap<string, number>;/);
    expect(src).toMatch(/const budgetByDeptCode = opts\.budgetByDeptCode \?\? new Map<string, number>\(\);/);
  });

  it("card rows[] now includes payroll, budget-ytd, variance-vs-budget", () => {
    expect(src).toMatch(/key: "payroll",\s*label: "Payroll & Benefits",/);
    expect(src).toMatch(/key: "budget-ytd"/);
    expect(src).toMatch(/key: "variance-vs-budget"/);
  });

  it("variance tone reflects favorable / risk based on sign", () => {
    expect(src).toMatch(/varianceVal >= 0 \? "favorable" : "risk"/);
  });
});

describe("MBR-FIX-2E §E — stale 'budget importer not landed' copy flips when budget is connected", () => {
  const src = readFileSync(DEPT, "utf8");

  it("introNote branches on budgetConnected", () => {
    expect(src).toMatch(/introNote: budgetConnected/);
    expect(src).toMatch(/budget comparisons use the committed FY budget/);
  });

  it("managementNotice.body branches on budgetConnected", () => {
    expect(src).toMatch(/body: budgetConnected/);
    expect(src).toMatch(/"This statement renders real department-level activity from the committed Jonas Trial Balance snapshot alongside the committed FY budget\./);
  });
});
