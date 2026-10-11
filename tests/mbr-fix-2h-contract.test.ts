// MBR-FIX-2H (2026-10-10) — Payroll Ratio Monthly Trend + Operating
// Cost Coverage (Dues Subsidy) live wiring contract.
//
// Pre-fix defects:
//   §A  Dues Subsidy donut: the live-tenant branch at
//       monthly-package.ts invoked `buildDuesSubsidyData(0, 0, [])`,
//       emitting a zero-dues / zero-member / zero-category donut.
//       Every live tenant rendered the card as "Unavailable" even
//       though the committed TB carried IS_MEMBERSHIP_DUES +
//       IS_PAYROLL / IS_UTILITIES / IS_SUPPLIES / IS_PROFESSIONAL_FEES
//       / IS_INSURANCE / IS_REPAIRS_MAINT / IS_OTHER_OPEX / IS_COGS
//       rows that could compose a mathematically valid Operating
//       Cost Coverage donut.
//
//   §B  Payroll Ratio Monthly Trend: the live-tenant branch invoked
//       `buildPayrollRatioTrendData({ monthlyActual: [], monthlyBudget:
//       [], monthlyPriorYear: [], benchmarkPct: 0, duesRatioPct: 0,
//       golfRoundsActual: 0, golfRoundsPriorYear: 0, ... })`, so the
//       chart's actual / budget / benchmark lines all collapsed to
//       zero.  Every live tenant rendered the card as "0.0 %".
//
// Fix pins:
//   §A1 monthly-package.ts wires `buildOperatingCostCoverageLive`
//       on the live branch.
//   §A2 Live service composes `resolveFsGroupProjection` for the
//       authoritative source → operatingRevenue[IS_MEMBERSHIP_DUES]
//       + operatingExpense[*] rows.
//   §A3 Builder emits an explicit surplus / shortfall slice so the
//       whole sums to 100 % and the semantic is Coverage, not
//       Allocation (per founder authorization 2026-10-10).
//   §A4 Builder overrides title → "Operating Cost Coverage by
//       Membership Dues" so the React chart renders the correct
//       semantic label.
//
//   §B1 monthly-package.ts wires `buildPayrollRatioTrendLive`
//       on the live branch.
//   §B2 Live service calls `resolveFsGroupProjection` per committed
//       month (1..reportingMonth), reading `cmActual` on each row
//       (= MTD derived via YTD subtraction internally).
//   §B3 Live service uses the config benchmark (57 %) and threads
//       `dataSource: "live"` through the builder.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const COVERAGE = path.join(REPO, "src/lib/reporting/operating-cost-coverage-live.ts");
const TREND    = path.join(REPO, "src/lib/reporting/payroll-ratio-trend-live.ts");
const PKG      = path.join(REPO, "src/lib/reporting/monthly-package.ts");
const PAYANAL  = path.join(REPO, "src/lib/reporting/payroll-analysis.ts");

/** Strip single-line + block comments so banned-pattern scans don't
 *  false-fire on the comment copy explaining what the fix did. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

describe("MBR-FIX-2H §A1 — monthly-package wires the live coverage builder", () => {
  const src = readFileSync(PKG, "utf8");
  const code = stripComments(src);

  it("imports buildOperatingCostCoverageLive from the live service", () => {
    expect(src).toMatch(/from "@\/lib\/reporting\/operating-cost-coverage-live"/);
    expect(code).toMatch(/import\s*\{\s*buildOperatingCostCoverageLive\s*\}/);
  });

  it("live branch calls the live builder (not buildDuesSubsidyData(0, 0, []))", () => {
    // Pre-fix pattern must be absent in code (comments preserved).
    expect(code).not.toMatch(/buildDuesSubsidyData\s*\(\s*0\s*,\s*0\s*,\s*\[\s*\]\s*\)/);
    expect(code).toMatch(/await\s+buildOperatingCostCoverageLive\(\s*clubId\s*,\s*periodEnd\s*\)/);
  });
});

describe("MBR-FIX-2H §A2 — Operating Cost Coverage composes the canonical FS-Group projection", () => {
  const src = readFileSync(COVERAGE, "utf8");

  it("imports resolveFsGroupProjection", () => {
    expect(src).toMatch(/from "\.\/fs-group-projection"/);
    expect(src).toMatch(/resolveFsGroupProjection/);
  });

  it("reads Operating Dues YTD from operatingRevenue[IS_MEMBERSHIP_DUES]", () => {
    expect(src).toMatch(/operatingRevenue\.find\(/);
    expect(src).toMatch(/fsGroupKey === "IS_MEMBERSHIP_DUES"/);
  });

  it("iterates operatingExpense rows for the OpEx slice set", () => {
    expect(src).toMatch(/operatingExpense/);
  });
});

describe("MBR-FIX-2H §A3 — surplus / shortfall slice is explicit so pcts sum to 100", () => {
  const src = readFileSync(COVERAGE, "utf8");

  it("emits a coverage-surplus slice when dues cover costs", () => {
    expect(src).toMatch(/coverage-surplus/);
    expect(src).toMatch(/Dues Coverage Surplus/);
  });

  it("emits a coverage-shortfall slice when costs exceed dues", () => {
    expect(src).toMatch(/coverage-shortfall/);
    expect(src).toMatch(/Operating Shortfall/);
  });

  it("renormalises pct totals to exactly 100", () => {
    expect(src).toMatch(/sumPct/);
    expect(src).toMatch(/100 \/ sumPct/);
  });
});

describe("MBR-FIX-2H §A4 — title / subtitle / pill carry the Coverage semantic", () => {
  const src = readFileSync(COVERAGE, "utf8");

  it("title overrides to 'Operating Cost Coverage by Membership Dues'", () => {
    expect(src).toMatch(/title:\s*"Operating Cost Coverage by Membership Dues"/);
  });

  it("subtitle names the period end + YTD framing", () => {
    expect(src).toMatch(/OPERATING EXPENSES AS A SHARE OF OPERATING DUES/);
    expect(src).toMatch(/periodEndShortLabel/);
  });

  it("pill label flipped from DUES BREAKDOWN to COVERAGE RATIO", () => {
    expect(src).toMatch(/pillLabel:\s*"COVERAGE RATIO"/);
  });

  it("dataSource flips to 'live'", () => {
    expect(src).toMatch(/dataSource:\s*"live"/);
  });
});

describe("MBR-FIX-2H §B1 — monthly-package wires the live Payroll Ratio Trend builder", () => {
  const src = readFileSync(PKG, "utf8");
  const code = stripComments(src);

  it("imports buildPayrollRatioTrendLive from the live service", () => {
    expect(src).toMatch(/from "@\/lib\/reporting\/payroll-ratio-trend-live"/);
    expect(code).toMatch(/import\s*\{\s*buildPayrollRatioTrendLive\s*\}/);
  });

  it("live branch calls the live builder (not zero-input buildPayrollRatioTrendData)", () => {
    // Pre-fix pattern: direct buildPayrollRatioTrendData with every
    // array / scalar set to [] or 0 must be absent from the live
    // branch.  The demo branch still calls the base builder with
    // Silver Springs seeds (allowed), so we don't ban the base
    // builder itself — only the live-side zero-input shape.
    expect(code).not.toMatch(
      /buildPayrollRatioTrendData\(\{[\s\S]{0,80}monthlyActual:\s*\[\],[\s\S]{0,80}monthlyBudget:\s*\[\],[\s\S]{0,120}benchmarkPct:\s*0,/,
    );
    expect(code).toMatch(/await\s+buildPayrollRatioTrendLive\(\s*clubId\s*,\s*periodEnd\s*\)/);
  });
});

describe("MBR-FIX-2H §B2 — live Trend builder composes per-committed-month projection", () => {
  const src = readFileSync(TREND, "utf8");

  it("imports resolveFsGroupProjection", () => {
    expect(src).toMatch(/from "\.\/fs-group-projection"/);
    expect(src).toMatch(/resolveFsGroupProjection/);
  });

  it("iterates one call per month 1..reportingMonth", () => {
    expect(src).toMatch(/reportingMonth/);
    expect(src).toMatch(/for\s*\(\s*let\s+m\s*=\s*1\s*;\s*m\s*<=\s*reportingMonth/);
  });

  it("reads YTD payroll via ytdActual on the IS_PAYROLL row", () => {
    // Semantic: YTD-at-month-end (not MTD subtraction) so the trend
    // doesn't spike into the triple-digit range in a dues-heavy
    // January club where Feb MTD revenue is near zero.  See the
    // in-file comment above `monthlyActual` for the full rationale.
    expect(src).toMatch(/fsGroupKey === "IS_PAYROLL"/);
    expect(src).toMatch(/ytdActual/);
  });

  it("reads YTD operating revenue via totals.operatingRevenue.ytdActual", () => {
    expect(src).toMatch(/totals\.operatingRevenue\.ytdActual/);
  });

  it("benchmark comes from a config constant (not a hardcoded chart arg)", () => {
    expect(src).toMatch(/BENCHMARK_PCT\s*=\s*57/);
    expect(src).toMatch(/benchmarkPct:\s*BENCHMARK_PCT/);
  });
});

describe("MBR-FIX-2H §B3 — live Trend builder flips dataSource to 'live'", () => {
  const src = readFileSync(TREND, "utf8");

  it("passes dataSource: 'live' to buildPayrollRatioTrendData", () => {
    expect(src).toMatch(/\{\s*dataSource:\s*"live"\s*\}/);
  });
});

describe("MBR-FIX-2H §B3b — buildPayrollRatioTrendData accepts a dataSource override", () => {
  const src = readFileSync(PAYANAL, "utf8");

  it("second parameter opts carries an optional dataSource", () => {
    expect(src).toMatch(/opts:\s*\{\s*dataSource\?:\s*ReportingDataSource\s*\}/);
  });

  it("return value threads opts.dataSource through (default 'demo')", () => {
    expect(src).toMatch(/dataSource:\s*opts\.dataSource\s*\?\?\s*"demo"/);
  });
});
