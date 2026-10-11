// MBR-FIX-2M (2026-10-11) — Chapter II Operating + Capital
// Stewardship Scorecard integration.
//
// Directive scope (user-facing label "MBR-FIX-2L" — renamed MBR-FIX-2M
// internally to avoid collision with the AR Aging import page slice
// already landed as MBR-FIX-2L earlier the same day).
//
// Permitted corrections (no founder approval needed — committed data
// already available, directive explicitly authorizes):
//
//   §A  Period-aware section band on both scorecards. Pre-fix:
//       hardcoded "LIVE JANUARY FINANCIAL ROWS" even for Feb / Mar
//       packages. Fix: use the period's narrative label.
//   §B  NOI Variance row structure. Pre-fix: row label said
//       "Variance" but Actual column held NOI dollars + Budget
//       column held Budget-NOI dollars + the "variance" was in the
//       Variance/Target column — three different numbers under a
//       Variance-labelled row. Fix: rename row to "NOI vs Budget"
//       so Actual / Budget / Variance remain unambiguous.
//   §C  F&B Subsidy as % of Dues — wire from Section X Departmental
//       P&L (F&B Net Operating Loss) ÷ Operating Dues YTD × 100.
//   §D  Total Capital Income vs Budget — wire from FS-Group
//       projection's capitalRevenue totals (same source Section V
//       Capital Fund consumes).
//   §E  Initiation-Fee Operating Subsidy — explicit N/A for tenants
//       whose COA tags entrance fees to Capital Fund (Coulee).
//
// Dependency contract: no new resolvers, no new formulas, no COA
// mapping changes. All ancillary values are threaded by the caller
// (monthly-package.ts) from existing shared resolvers.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO    = path.resolve(__dirname, "..");
const BUILDER = path.join(REPO, "src/lib/reporting/scorecard-live-builder.ts");
const PACKAGE = path.join(REPO, "src/lib/reporting/monthly-package.ts");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("MBR-FIX-2M §A — period-aware section band (no stale 'LIVE JANUARY')", () => {
  const src = readFileSync(BUILDER, "utf8");
  const code = stripComments(src);

  it("pre-fix 'LIVE JANUARY' string literal is removed from the module", () => {
    expect(code).not.toMatch(/"LIVE JANUARY FINANCIAL ROWS/);
    expect(code).not.toMatch(/"LIVE BALANCE-SHEET ROWS/);
  });

  it("Operating section band is composed from period.label (upper-cased)", () => {
    const idx = code.indexOf("function buildOperatingScorecardLive");
    expect(idx).toBeGreaterThan(0);
    const body = code.slice(idx, idx + 8000);
    expect(body).toMatch(/sectionBand:\s*`LIVE \$\{period\.label\.toUpperCase\(\)\} FINANCIAL ROWS/);
  });

  it("Capital section band is composed from period.label (upper-cased)", () => {
    const idx = code.indexOf("function buildCapitalScorecardLive");
    expect(idx).toBeGreaterThan(0);
    const body = code.slice(idx, idx + 8000);
    expect(body).toMatch(/sectionBand:\s*`LIVE \$\{period\.label\.toUpperCase\(\)\} BALANCE-SHEET ROWS/);
  });
});

describe("MBR-FIX-2M §B — NOI vs Budget row has distinguishable Actual / Budget / Variance", () => {
  const src = readFileSync(BUILDER, "utf8");

  it("row key renamed from 'noi-variance-to-budget' to 'noi-vs-budget'", () => {
    expect(src).toMatch(/key:\s*"noi-vs-budget"/);
    expect(src).toMatch(/metric:\s*"NOI vs Budget"/);
  });

  it("Actual = NOI dollars; Budget = Budget NOI dollars; benchmark = $ variance", () => {
    const idx = src.indexOf('key: "noi-vs-budget"');
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 800);
    expect(body).toMatch(/actual:\s*fmtMillions\(actualNoi\)/);
    expect(body).toMatch(/budget:\s*fmtMillions\(budgetNoi\)/);
    expect(body).toMatch(/benchmark:\s*fmtDollarVariance\(actualNoi,\s*budgetNoi\)/);
  });
});

describe("MBR-FIX-2M §C — F&B Subsidy wired from Section X", () => {
  const src = readFileSync(BUILDER, "utf8");

  it("ScorecardLiveAncillary declares fbNetOperatingLoss + operatingDuesYtd", () => {
    expect(src).toMatch(/fbNetOperatingLoss\?:\s*number\s*\|\s*null/);
    expect(src).toMatch(/operatingDuesYtd\?:\s*number\s*\|\s*null/);
  });

  it("buildFbSubsidyRow guards against null inputs + zero dues", () => {
    const idx = src.indexOf("function buildFbSubsidyRow");
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 1500);
    expect(body).toMatch(/if\s*\(loss\s*==\s*null\s*\|\|\s*dues\s*==\s*null\s*\|\|\s*dues\s*<=\s*0\)/);
  });

  it("subsidy formula = max(0, loss) / dues * 100", () => {
    const idx = src.indexOf("function buildFbSubsidyRow");
    const body = src.slice(idx, idx + 1500);
    expect(body).toMatch(/\(Math\.max\(0,\s*loss\)\s*\/\s*dues\)\s*\*\s*100/);
  });

  it("row is wired into the operating scorecard assembly", () => {
    expect(src).toMatch(/buildFbSubsidyRow\(ancillary\.fbNetOperatingLoss,\s*ancillary\.operatingDuesYtd,\s*dsLive\)/);
  });
});

describe("MBR-FIX-2M §D — Total Capital Income vs Budget wired from projection", () => {
  const src = readFileSync(BUILDER, "utf8");

  it("ScorecardLiveAncillary declares capitalIncomeActual + capitalIncomeBudget", () => {
    expect(src).toMatch(/capitalIncomeActual\?:\s*number\s*\|\s*null/);
    expect(src).toMatch(/capitalIncomeBudget\?:\s*number\s*\|\s*null/);
  });

  it("buildCapitalIncomeVsBudgetRow emits three-value shape (actual, budget, variance)", () => {
    const idx = src.indexOf("function buildCapitalIncomeVsBudgetRow");
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 1800);
    expect(body).toMatch(/actual:\s*fmtMillions\(a\)/);
    expect(body).toMatch(/budget:\s*fmtMillions\(b\)/);
    expect(body).toMatch(/benchmark:\s*variance\s*!=\s*null\s*\?\s*fmtDollarVariance\(a,\s*b\)/);
  });

  it("row is wired into the capital scorecard assembly", () => {
    expect(src).toMatch(/buildCapitalIncomeVsBudgetRow\(\s*ancillary\.capitalIncomeActual,\s*ancillary\.capitalIncomeBudget,\s*dsLive,?\s*\)/);
  });
});

describe("MBR-FIX-2M §E — Initiation-Fee Operating Subsidy is explicit N/A (not null-only)", () => {
  const src = readFileSync(BUILDER, "utf8");

  it("row renders actual: 'N/A' with a classification-explaining description", () => {
    const idx = src.indexOf('key: "initiation-fee-subsidy"');
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 500);
    expect(body).toMatch(/actual:\s*"N\/A"/);
    expect(body).toMatch(/entrance fees classified to Capital Fund/i);
  });
});

describe("MBR-FIX-2M §F — monthly-package threads ancillary from existing resolvers", () => {
  const src = readFileSync(PACKAGE, "utf8");

  it("call site builds a shared scorecardAncillary object with four fields", () => {
    expect(src).toMatch(/const\s+scorecardAncillary\s*=\s*\{/);
    expect(src).toMatch(/fbNetOperatingLoss,/);
    expect(src).toMatch(/operatingDuesYtd,/);
    expect(src).toMatch(/capitalIncomeActual,/);
    expect(src).toMatch(/capitalIncomeBudget,/);
  });

  it("F&B loss sourced from the committed Section X dept-P&L (FOOD_AND_BEVERAGE)", () => {
    const idx = src.indexOf("scorecardAncillary");
    const nearby = src.slice(Math.max(0, idx - 2500), idx + 200);
    expect(nearby).toMatch(/departmentCode\s*===\s*"FOOD_AND_BEVERAGE"/);
    expect(nearby).toMatch(/fbNetOperatingLoss\s*=\s*netResult\s*<\s*0\s*\?\s*Math\.abs\(netResult\)\s*:\s*0/);
  });

  it("Operating Dues YTD sourced from fsGroupProjection IS_MEMBERSHIP_DUES", () => {
    const idx = src.indexOf("scorecardAncillary");
    const nearby = src.slice(Math.max(0, idx - 2500), idx + 200);
    expect(nearby).toMatch(/fsGroupProjection\.operatingRevenue\.find\(/);
    expect(nearby).toMatch(/fsGroupKey\s*===\s*"IS_MEMBERSHIP_DUES"/);
  });

  it("Capital Income Actual + Budget sourced from projection totals.capitalRevenue", () => {
    expect(src).toMatch(/fsGroupProjection\.totals\.capitalRevenue\.ytdActual/);
    expect(src).toMatch(/fsGroupProjection\.totals\.capitalRevenue\.ytdBudget/);
  });

  it("ancillary is threaded into BOTH scorecard builders", () => {
    // Both buildOperatingScorecardLive and buildCapitalScorecardLive
    // receive the SAME scorecardAncillary object as the third arg.
    const idx = src.indexOf("scorecardAncillary");
    const nearby = src.slice(idx, idx + 2000);
    // Two uses of the identifier downstream of the declaration.
    const uses = (nearby.match(/scorecardAncillary/g) || []).length;
    expect(uses).toBeGreaterThanOrEqual(2);
  });
});
