// SCORECARD-PARTIAL-1 (2026-10-04) — source-contract pins.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const PACKAGE = path.join(REPO, "src/lib/reporting/monthly-package.ts");
const OPRES = path.join(REPO, "src/lib/reporting/operating-results.ts");
const LIVE = path.join(REPO, "src/lib/reporting/scorecard-live-builder.ts");
const BODY = path.join(REPO, "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx");

describe("SCORECARD-PARTIAL-1 §2 — Prior Year nullable (no fabricated $0)", () => {
  it("OperatingResults.priorYearNoi + ytdBudgetNoi are nullable", () => {
    const src = readFileSync(OPRES, "utf8");
    expect(src).toMatch(/ytdBudgetNoi:\s*number\s*\|\s*null/);
    expect(src).toMatch(/priorYearNoi:\s*number\s*\|\s*null/);
  });

  it("snapshot-fallback branch sets priorYearNoi: null (never 0)", () => {
    const src = readFileSync(OPRES, "utf8");
    const branch = src.match(/if \(!hasPlottableFpData\)[\s\S]*?^  \}/m)?.[0] ?? "";
    expect(branch).toMatch(/priorYearNoi:\s*null/);
    expect(branch).not.toMatch(/priorYearNoi:\s*0,/);
  });

  it("formatOperatingDashboard renders '—' when ytdBudgetNoi / priorYearNoi is null", () => {
    const src = readFileSync(PACKAGE, "utf8");
    expect(src).toMatch(/budgetGoalLabel\s*=\s*r\.ytdBudgetNoi == null \? "—"/);
    expect(src).toMatch(/priorYearLabel\s*=\s*r\.priorYearNoi == null \? "—"/);
  });
});

describe("SCORECARD-PARTIAL-1 §3 — period-aware narrative label", () => {
  it("call site derives periodLabel from periodEnd (never hardcoded 'Year-end')", () => {
    const src = readFileSync(PACKAGE, "utf8");
    // Find the formatOperatingDashboard call site and confirm its
    // periodLabel is derived, not literal.
    const call = src.match(/formatOperatingDashboard\(operatingResults,[\s\S]*?\}\);/)?.[0] ?? "";
    expect(call).toMatch(/periodLabel:\s*periodLabelForNarrative/);
    expect(call).not.toMatch(/periodLabel:\s*"Year-end"/);
  });

  it("periodLabelForNarrative derives the month name from periodEnd.getUTCMonth()", () => {
    const src = readFileSync(PACKAGE, "utf8");
    expect(src).toMatch(/PERIOD_MONTH_NAMES\[periodEnd\.getUTCMonth\(\)\]/);
    expect(src).toMatch(/PERIOD_MONTH_NAMES[\s\S]{0,500}"January"/);
  });
});

describe("SCORECARD-PARTIAL-1 §6-8 — StewardshipScorecardRow nullable", () => {
  it("row fields actual + budget + benchmark + status are nullable", () => {
    const src = readFileSync(PACKAGE, "utf8");
    const row = src.match(/export type StewardshipScorecardRow[\s\S]*?^\};/m)?.[0] ?? "";
    expect(row).toMatch(/actual:\s*string\s*\|\s*null/);
    expect(row).toMatch(/budget:\s*string\s*\|\s*null/);
    expect(row).toMatch(/benchmark:\s*string\s*\|\s*null/);
    expect(row).toMatch(/status:\s*ScorecardStatus\s*\|\s*null/);
  });

  it("React scorecard table renders '—' for null actual / budget, 'Not configured' for null benchmark", () => {
    const src = readFileSync(BODY, "utf8");
    expect(src).toMatch(/row\.actual\s*\?\?\s*"—"/);
    expect(src).toMatch(/row\.budget\s*\?\?\s*"—"/);
    expect(src).toMatch(/row\.benchmark\s*\?\?\s*"Not configured"/);
  });

  it("React scorecard renders no glyph when status + trend both null", () => {
    const src = readFileSync(BODY, "utf8");
    expect(src).toMatch(/const glyph = scorecardStatusGlyph\(row\)/);
    expect(src).toMatch(/\{glyph\s*\?\?\s*""\}/);
  });

  it("scorecardStatusGlyph returns null when status + trend both null", () => {
    const src = readFileSync(BODY, "utf8");
    expect(src).toMatch(/function scorecardStatusGlyph\([^)]+\):\s*string\s*\|\s*null/);
  });
});

describe("SCORECARD-PARTIAL-1 §10-15 — Operating Scorecard live builder", () => {
  it("live builder exports buildOperatingScorecardLive", () => {
    const src = readFileSync(LIVE, "utf8");
    expect(src).toMatch(/export async function buildOperatingScorecardLive/);
  });

  it("live builder reads canonical sources (ratio-registry + Budget resolvers)", () => {
    const src = readFileSync(LIVE, "utf8");
    expect(src).toMatch(/resolveJanuaryMetricSet/);
    expect(src).toMatch(/resolveBudgetIncomeStatement/);
    expect(src).toMatch(/resolveBudget\(/);
  });

  it("live builder emits NO classifier status (status: null for every row this slice)", () => {
    const src = readFileSync(LIVE, "utf8");
    const fn = src.match(/export async function buildOperatingScorecardLive[\s\S]*?^export async function/m)?.[0] ?? "";
    // Every row literal must set status: null — no evaluative verdict.
    const rowBlocks = fn.match(/key:\s*"[a-z-]+",[\s\S]*?dataSource:/g) ?? [];
    expect(rowBlocks.length).toBeGreaterThanOrEqual(8);
    for (const b of rowBlocks) {
      expect(b).toMatch(/status:\s*null/);
    }
  });

  it("live builder emits null (never '$0' / '0%') for unsupported Actual / Budget cells", () => {
    const src = readFileSync(LIVE, "utf8");
    const fn = src.match(/export async function buildOperatingScorecardLive[\s\S]*?^export async function/m)?.[0] ?? "";
    // Operational rows (initiation, F&B subsidy, golf, F&B covers)
    // must emit null for actual + budget — not $0 / 0%.
    for (const key of ["initiation-fee-subsidy", "fb-subsidy-pct-dues", "golf-rounds-vs-budget", "fb-covers-vs-budget"]) {
      const rowBlock = fn.match(new RegExp(`key:\\s*"${key}",[\\s\\S]*?dataSource:`))?.[0] ?? "";
      expect(rowBlock).toMatch(/actual:\s*null/);
      expect(rowBlock).toMatch(/budget:\s*null/);
    }
  });
});

describe("SCORECARD-PARTIAL-1 §18-21 — Capital Scorecard live builder", () => {
  it("live builder exports buildCapitalScorecardLive", () => {
    const src = readFileSync(LIVE, "utf8");
    expect(src).toMatch(/export async function buildCapitalScorecardLive/);
  });

  it("live builder reads canonical ratio registry for all BS metrics", () => {
    const src = readFileSync(LIVE, "utf8");
    const fn = src.match(/export async function buildCapitalScorecardLive[\s\S]*?^\}/m)?.[0] ?? "";
    expect(fn).toMatch(/metrics\.totalAssets/);
    expect(fn).toMatch(/metrics\.membersEquity/);
    expect(fn).toMatch(/metrics\.capitalReserve/);
    expect(fn).toMatch(/metrics\.longTermDebt/);
    expect(fn).toMatch(/metrics\.netPpe/);
  });

  it("Capital Scorecard never fabricates Capital Budget (operating budget only per BUDGET-HIST-1)", () => {
    const src = readFileSync(LIVE, "utf8");
    const fn = src.match(/export async function buildCapitalScorecardLive[\s\S]*?^\}/m)?.[0] ?? "";
    // Every row must set budget: null (no capital budget source).
    const rowBlocks = fn.match(/key:\s*"[a-z-]+",[\s\S]*?dataSource:/g) ?? [];
    expect(rowBlocks.length).toBeGreaterThanOrEqual(8);
    for (const b of rowBlocks) {
      expect(b).toMatch(/budget:\s*null/);
    }
  });
});

describe("SCORECARD-PARTIAL-1 §24 — redactor preserves scorecards on live tenants", () => {
  it("scorecards are passed verbatim through the redactor", () => {
    const src = readFileSync(PACKAGE, "utf8");
    expect(src).toMatch(/scorecards:\s*pkg\.stewardshipDashboard\.scorecards/);
  });

  it("the live-tenant branch calls buildOperatingScorecardLive + buildCapitalScorecardLive", () => {
    const src = readFileSync(PACKAGE, "utf8");
    expect(src).toMatch(/hasRealData[\s\S]{0,500}operating:\s*await buildOperatingScorecardLive/);
    expect(src).toMatch(/hasRealData[\s\S]{0,500}capital:\s*await buildCapitalScorecardLive/);
  });
});

describe("SCORECARD-PARTIAL-1 §25 — no demo values leak into live scorecards", () => {
  it("live builder never imports SILVER_SPRINGS seeds", () => {
    const src = readFileSync(LIVE, "utf8");
    expect(src).not.toMatch(/SILVER_SPRINGS/);
  });

  it("live builder never emits literal demo evaluative language in row descriptions", () => {
    const src = readFileSync(LIVE, "utf8");
    // No "favorable", "ahead of plan", "healthy", etc. baked into row literals.
    const forbidden = [/\bfavou?rable\b/i, /\bahead of (plan|policy|budget)\b/i, /\bhealthy\b/i, /\bconcerning\b/i, /\bon track\b/i];
    for (const re of forbidden) {
      expect(src).not.toMatch(re);
    }
  });
});
