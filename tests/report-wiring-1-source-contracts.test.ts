// REPORT-WIRING-1 (2026-10-04) — source-contract pins for the central
// Monthly Reporting Package financial contract.
//
// Pins the architectural invariants the founder asked for in directive
// §23 ("One financial truth") + §25 ("Report-wide Budget propagation
// audit"): a single `getMonthlyFinancialContract` resolves Budget
// ONCE per package build and threads real aux.budget.* into every
// Budget-aware adapter.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const CONTRACT = path.join(REPO, "src/lib/reporting/monthly-financial-contract.ts");
const PACKAGE = path.join(REPO, "src/lib/reporting/monthly-package.ts");
const OPRES = path.join(REPO, "src/lib/reporting/operating-results.ts");

describe("REPORT-WIRING-1 §5 — central financial contract exists", () => {
  it("exports getMonthlyFinancialContract", () => {
    const src = readFileSync(CONTRACT, "utf8");
    expect(src).toMatch(/export async function getMonthlyFinancialContract/);
  });

  it("resolves Budget via the three canonical budget-resolver functions in parallel", () => {
    const src = readFileSync(CONTRACT, "utf8");
    expect(src).toMatch(/resolveBudgetIncomeStatement/);
    expect(src).toMatch(/resolveBudget\(/);
    expect(src).toMatch(/resolveBudgetMonthlyIncomeStatement/);
    expect(src).toMatch(/Promise\.all\(\[/);
  });

  it("returns pre-shaped aux objects for the three Budget-aware adapters", () => {
    const src = readFileSync(CONTRACT, "utf8");
    expect(src).toMatch(/executiveSummaryAuxBudget/);
    expect(src).toMatch(/statementOfActivitiesAuxBudget/);
    expect(src).toMatch(/stewardshipAuxBudget/);
    expect(src).toMatch(/operatingMonthlyBudgetNoi/);
  });

  it("SOA byAccount sign-flips REVENUE accounts to display convention", () => {
    const src = readFileSync(CONTRACT, "utf8");
    expect(src).toMatch(/sign = a\.accountType === "REVENUE" \? -1 : 1/);
  });

  it("Executive Capital Income budget stays null on operating-only budgets", () => {
    const src = readFileSync(CONTRACT, "utf8");
    expect(src).toMatch(/ytdCapitalIncome:\s*null,\s*\/\/\s*operating budget doesn't cover capital/);
  });
});

describe("REPORT-WIRING-1 §9-10 + §17-21 + §25 — monthly-package.ts calls the central contract once + threads it", () => {
  it("package builder awaits getMonthlyFinancialContract on the hasRealData branch", () => {
    const src = readFileSync(PACKAGE, "utf8");
    expect(src).toMatch(/monthlyFinancialContract = hasRealData\s*\n\s*\?\s*await getMonthlyFinancialContract/);
  });

  it("SOA auxiliary input receives the central contract's byAccount + rollups", () => {
    const src = readFileSync(PACKAGE, "utf8");
    expect(src).toMatch(/budget:\s*monthlyFinancialContract!\.statementOfActivitiesAuxBudget/);
  });

  it("Stewardship adapter receives the central contract's budget block", () => {
    const src = readFileSync(PACKAGE, "utf8");
    expect(src).toMatch(/budget:\s*monthlyFinancialContract!\.stewardshipAuxBudget/);
  });

  it("Executive summary receives the central contract's budget block", () => {
    const src = readFileSync(PACKAGE, "utf8");
    expect(src).toMatch(/budget:\s*monthlyFinancialContract!\.executiveSummaryAuxBudget/);
  });

  it("no adapter still receives undefined / EMPTY_* on hasRealData branch", () => {
    const src = readFileSync(PACKAGE, "utf8");
    // All three adapters must take the real auxiliary input on live.
    const execLine = src.match(/const execAuxiliaryInputs = hasRealData[\s\S]{0,400}/)?.[0] ?? "";
    expect(execLine).not.toMatch(/hasRealData \? undefined/);
    const soaLine = src.match(/const soaAuxiliaryInputs = hasRealData[\s\S]{0,400}/)?.[0] ?? "";
    expect(soaLine).not.toMatch(/hasRealData \? undefined/);
  });
});

describe("REPORT-WIRING-1 §13-16 — Operating Results chart populates all 12 Budget months", () => {
  it("Operating resolver builds a 12-slot month skeleton (not just committed-snapshot months)", () => {
    const src = readFileSync(OPRES, "utf8");
    expect(src).toMatch(/for \(let monthIndex = 0; monthIndex < 12; monthIndex\+\+\)/);
  });

  it("Future months carry Budget overlay but Actual stays null (no fabricated $0 Actual)", () => {
    const src = readFileSync(OPRES, "utf8");
    expect(src).toMatch(/\/\/ Future \/ unloaded Actual — Budget still plots\./);
    const branch = src.match(/\/\/ Future \/ unloaded Actual[\s\S]*?\}\);/)?.[0] ?? "";
    expect(branch).toMatch(/noi:\s*null/);
    expect(branch).toMatch(/revenue:\s*null/);
    expect(branch).toMatch(/budgetNoi:\s*budgetForMonth/);
  });

  it("YTD Budget sums ONLY through the reporting month (not full year)", () => {
    const src = readFileSync(OPRES, "utf8");
    expect(src).toMatch(/\.slice\(0, throughMonth\)/);
  });
});

describe("REPORT-WIRING-1 §27 — null-vs-zero preserved everywhere", () => {
  it("central contract never fabricates $0 Budget for capital/operating when source is unavailable", () => {
    const src = readFileSync(CONTRACT, "utf8");
    // Capital Income stays null on operating-only budgets.
    expect(src).toMatch(/ytdCapitalIncome:\s*null/);
    // workingCapitalFloor is policy, not Budget — stays null.
    expect(src).toMatch(/workingCapitalFloor:\s*null/);
  });

  it("Operating resolver sets priorYearNoi: null (never 0) on live tenants", () => {
    const src = readFileSync(OPRES, "utf8");
    expect(src).toMatch(/priorYearNoi:\s*null/);
  });
});
