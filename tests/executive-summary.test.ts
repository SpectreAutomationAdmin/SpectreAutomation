// Executive Summary service — tests that the cover-page At-a-Glance
// KPIs and headline narrative react to changed inputs.
//
// Per the Jonas-readiness audit (Tier 1, item 1), these 6 KPIs +
// headline were the HIGHEST-RISK Jonas-readiness item in the
// package. The tests below prove:
//
//   1. Two different mocked accounting-backed datasets produce
//      different KPI values + a different headline narrative.
//   2. The output shape matches the legacy `pkg.executiveSummary`
//      shape exactly (KpiCard[] + headline + consideration), so
//      page.tsx renders unchanged.
//   3. Tone classification cascades correctly (any red → board
//      decision-class consideration; any amber → monitor; all
//      green → no-action).
//   4. The headline branches when KPIs flip from favorable to
//      unfavorable.
//   5. dataSource rollup is correct (every input live → "live";
//      any input demo → "demo").
//   6. The demo input factory preserves the historical Silver
//      Springs seed values (the package output is unchanged for
//      the existing render-time consumers).

import { describe, it, expect } from "vitest";

import { buildReportingPeriod } from "@/lib/reporting/reporting-period";
import {
  buildExecutiveSummary,
  buildDemoExecutiveSummary,
  buildDemoExecutiveSummaryInput,
  type ExecutiveSummaryInput,
} from "@/lib/reporting/executive-summary";

const PERIOD = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31, 23, 59, 59)));
const CLUB_NAME = "Silver Springs Golf & Country Club";

// ---------------------------------------------------------------------------
// Helpers — two contrasting fully-mocked accounting-backed datasets
// ---------------------------------------------------------------------------

/** Dataset A — strong period. Revenue, NOI, capital income all
 *  above budget; reserve coverage healthy; working capital with
 *  cushion; AR healthy. Every input tagged `accounting` (the
 *  shape Phase 1 wiring services will produce). */
function makeStrongDataset(): ExecutiveSummaryInput {
  return {
    period: PERIOD,
    clubName: CLUB_NAME,
    ytdRevenue:               { actual: 14_620_000, comparator: 14_100_000, dataSource: "accounting" },
    ytdNoiBeforeDepreciation: { actual:  3_180_000, comparator:  2_840_000, dataSource: "accounting" },
    ytdCapitalIncome:         { actual:  2_040_000, comparator:  1_950_000, dataSource: "accounting" },
    reserveCoverage:          { actual:        1.42, comparator:        1.25, dataSource: "accounting" },
    workingCapital:           { actual:  4_710_000, comparator:  3_500_000, dataSource: "accounting" },
    arAging: {
      actual: 0.832, comparator: 0.018,
      watchThreshold: 0.05,
      dataSource: "operational",
    },
    fbSubsidy: { actual: 0.051, ceiling: 0.08, trend: "improving", dataSource: "accounting" },
  };
}

/** Dataset B — weak period. Revenue, NOI, capital income all
 *  below budget; reserve coverage below floor; working capital
 *  thin; AR has crossed the watch threshold. Same input shape;
 *  every numeric is different from Dataset A. */
function makeWeakDataset(): ExecutiveSummaryInput {
  return {
    period: PERIOD,
    clubName: CLUB_NAME,
    ytdRevenue:               { actual: 12_800_000, comparator: 14_100_000, dataSource: "accounting" },
    ytdNoiBeforeDepreciation: { actual:  1_900_000, comparator:  2_840_000, dataSource: "accounting" },
    ytdCapitalIncome:         { actual:  1_650_000, comparator:  1_950_000, dataSource: "accounting" },
    reserveCoverage:          { actual:        1.05, comparator:        1.25, dataSource: "accounting" },
    workingCapital:           { actual:  3_200_000, comparator:  3_500_000, dataSource: "accounting" },
    arAging: {
      actual: 0.690, comparator: 0.082,
      watchThreshold: 0.05,
      dataSource: "operational",
    },
    fbSubsidy: { actual: 0.093, ceiling: 0.08, trend: "worsening", dataSource: "accounting" },
  };
}

// ---------------------------------------------------------------------------
// KPI VALUES — two datasets produce different cover output
// ---------------------------------------------------------------------------

describe("executive-summary — two datasets produce different KPIs", () => {
  it("the 6 KPI VALUES differ between Strong and Weak datasets", () => {
    const strong = buildExecutiveSummary(makeStrongDataset());
    const weak = buildExecutiveSummary(makeWeakDataset());

    // Same number of KPIs, same keys, same order — only values differ.
    expect(strong.kpis.map((k) => k.key)).toEqual(weak.kpis.map((k) => k.key));
    expect(strong.kpis).toHaveLength(6);
    for (let i = 0; i < strong.kpis.length; i++) {
      expect(
        strong.kpis[i].value,
        `KPI ${strong.kpis[i].key} VALUE must differ between datasets`,
      ).not.toBe(weak.kpis[i].value);
    }
  });

  it("the data-derived KPI comparison VARIANCES differ between Strong and Weak", () => {
    const strong = buildExecutiveSummary(makeStrongDataset());
    const weak = buildExecutiveSummary(makeWeakDataset());
    // Skip the AR card: its variance string is intentionally a
    // static reference to the watch threshold (e.g. "Watch
    // threshold 5.0%") — a threshold reminder, not a data-derived
    // figure. The AR comparison's `value` field (the over-90 %)
    // IS data-derived and is asserted below.
    for (let i = 0; i < strong.kpis.length; i++) {
      const key = strong.kpis[i].key;
      if (key === "ar-current") continue;
      expect(
        strong.kpis[i].comparison?.variance,
        `KPI ${key} variance must differ between datasets`,
      ).not.toBe(weak.kpis[i].comparison?.variance);
    }
    // AR's `value` (current %) and `comparison.value` (over-90 %)
    // are data-derived — assert THOSE differ instead.
    const strongAr = strong.kpis.find((k) => k.key === "ar-current")!;
    const weakAr = weak.kpis.find((k) => k.key === "ar-current")!;
    expect(strongAr.value).not.toBe(weakAr.value);
    expect(strongAr.comparison?.value).not.toBe(weakAr.comparison?.value);
  });

  it("Strong dataset puts all 6 KPIs on tone=green; Weak dataset has at least one red", () => {
    const strong = buildExecutiveSummary(makeStrongDataset());
    const weak = buildExecutiveSummary(makeWeakDataset());
    for (const k of strong.kpis) expect(k.tone).toBe("green");
    expect(weak.kpis.map((k) => k.tone)).toContain("red");
  });

  it("Strong dataset → consideration=no-action; Weak dataset → committee-review (red present)", () => {
    expect(buildExecutiveSummary(makeStrongDataset()).consideration).toBe("no-action");
    expect(buildExecutiveSummary(makeWeakDataset()).consideration).toBe("committee-review");
  });
});

// ---------------------------------------------------------------------------
// HEADLINE NARRATIVE — branches on the dataset
// ---------------------------------------------------------------------------

describe("executive-summary — headline narrative reacts to inputs", () => {
  it("the headline string DIFFERS between Strong and Weak datasets", () => {
    const strong = buildExecutiveSummary(makeStrongDataset());
    const weak = buildExecutiveSummary(makeWeakDataset());
    expect(strong.headline).not.toBe(weak.headline);
  });

  it("Strong (favourable) headline — names per-metric variances + reserve above floor + no Board action", () => {
    const out = buildExecutiveSummary(makeStrongDataset());
    // Conservative opener (no all-caps).
    expect(out.headline).toMatch(/operating in line with plan/);
    // Per-metric clauses — each named individually.
    expect(out.headline).toMatch(/Operating revenue closed at /);
    expect(out.headline).toMatch(/NOI before depreciation closed at /);
    expect(out.headline).toMatch(/Capital income closed at /);
    expect(out.headline).toMatch(/favorable to the /);
    // Reserve clause.
    expect(out.headline).toMatch(/Capital reserve coverage holds at 1\.42x, above the 1\.25x policy floor/);
    // Largest-favourable callout (NOI is the biggest favourable
    // variance at +12 %).
    expect(out.headline).toMatch(/largest favourable variance is NOI before depreciation/);
    // Action line.
    expect(out.headline).toMatch(/No Board action is required this period/);
  });

  it("Weak (unfavourable) headline — names below-plan variances + reserve below floor + Board attention required", () => {
    const out = buildExecutiveSummary(makeWeakDataset());
    // Conservative opener (no all-caps drama).
    expect(out.headline).toMatch(/operating below plan/);
    expect(out.headline).not.toMatch(/OFF PLAN/);
    // Per-metric clauses note the unfavourable direction.
    expect(out.headline).toMatch(/unfavorable to the/);
    // "Materially" only when |variance| >= 10 %. The weak NOI
    // variance is (1.9 − 2.84) / 2.84 = −33.1 % — materially below.
    expect(out.headline).toMatch(/materially unfavorable/);
    // Reserve clause — below the floor, plainly stated.
    expect(out.headline).toMatch(/declined to 1\.05x, below the 1\.25x policy floor/);
    expect(out.headline).not.toMatch(/BELOW the 1\.25x policy floor/);
    // Largest-unfavourable callout.
    expect(out.headline).toMatch(/largest unfavourable variance is NOI before depreciation/);
    // Action line.
    expect(out.headline).toMatch(/Board attention is required this period/);
  });

  it("the headline names the selected reporting period (period-driven)", () => {
    const out = buildExecutiveSummary(makeStrongDataset());
    expect(out.headline).toContain(PERIOD.periodLabel);
  });
});

// ---------------------------------------------------------------------------
// MIXED scenario — one metric materially favourable, another
// materially unfavourable. Tests that the largest-variance callout
// names BOTH the top favourable and top unfavourable.
// ---------------------------------------------------------------------------

describe("executive-summary — mixed-results narrative", () => {
  function makeMixedDataset(): ExecutiveSummaryInput {
    return {
      period: PERIOD,
      clubName: CLUB_NAME,
      // Revenue strongly favourable: +14 % above plan.
      ytdRevenue:               { actual: 16_000_000, comparator: 14_000_000, dataSource: "accounting" },
      // NOI strongly unfavourable: −20 % below plan.
      ytdNoiBeforeDepreciation: { actual:  2_400_000, comparator:  3_000_000, dataSource: "accounting" },
      // Capital income roughly on plan: +0.5 %.
      ytdCapitalIncome:         { actual:  1_960_000, comparator:  1_950_000, dataSource: "accounting" },
      reserveCoverage:          { actual:        1.30, comparator:        1.25, dataSource: "accounting" },
      workingCapital:           { actual:  4_100_000, comparator:  3_500_000, dataSource: "accounting" },
      arAging: {
        actual: 0.810, comparator: 0.040,
        watchThreshold: 0.05,
        dataSource: "operational",
      },
      fbSubsidy: null,
    };
  }

  it("opener notes mixed signals (operating below plan because NOI is red, despite revenue beat)", () => {
    const out = buildExecutiveSummary(makeMixedDataset());
    // NOI at −20% → red tone → opener says "operating below plan".
    expect(out.headline).toMatch(/operating below plan/);
  });

  it("largest-variance callout names BOTH the top favourable AND top unfavourable", () => {
    const out = buildExecutiveSummary(makeMixedDataset());
    expect(out.headline).toMatch(/largest favourable variance is operating revenue/);
    expect(out.headline).toMatch(/largest unfavourable variance is NOI before depreciation/);
  });

  it("revenue clause names the +14 % favourable; NOI clause names the −20 % unfavourable", () => {
    const out = buildExecutiveSummary(makeMixedDataset());
    expect(out.headline).toMatch(/Operating revenue closed at .* favorable to the /);
    expect(out.headline).toMatch(/NOI before depreciation closed at .* materially unfavorable to the /);
  });

  it("capital income (within ±1 % of plan) renders as 'essentially at plan' (no overclaim)", () => {
    const out = buildExecutiveSummary(makeMixedDataset());
    expect(out.headline).toMatch(/Capital income closed at .* essentially at the /);
  });
});

// ---------------------------------------------------------------------------
// INCOMPLETE-DATA scenarios — null comparators trigger fallbacks
// ---------------------------------------------------------------------------

describe("executive-summary — incomplete-data fallbacks", () => {
  function makeAllPrimariesMissingDataset(): ExecutiveSummaryInput {
    // Every primary metric has a null comparator — simulates Jonas
    // import in flight where actuals have posted but the budget
    // snapshot hasn't landed yet.
    return {
      period: PERIOD,
      clubName: CLUB_NAME,
      ytdRevenue:               { actual: 14_620_000, comparator: null, dataSource: "accounting" },
      ytdNoiBeforeDepreciation: { actual:  3_180_000, comparator: null, dataSource: "accounting" },
      ytdCapitalIncome:         { actual:  2_040_000, comparator: null, dataSource: "accounting" },
      reserveCoverage:          { actual:        1.42, comparator: null, dataSource: "accounting" },
      workingCapital:           { actual:  4_710_000, comparator: null, dataSource: "accounting" },
      arAging: {
        actual: 0.784, comparator: null,
        watchThreshold: 0.05,
        dataSource: "operational",
      },
      fbSubsidy: null,
    };
  }

  function makePartialMissingDataset(): ExecutiveSummaryInput {
    // Revenue + NOI live; capital income comparator is pending.
    return {
      period: PERIOD,
      clubName: CLUB_NAME,
      ytdRevenue:               { actual: 14_620_000, comparator: 14_100_000, dataSource: "accounting" },
      ytdNoiBeforeDepreciation: { actual:  3_180_000, comparator:  2_840_000, dataSource: "accounting" },
      ytdCapitalIncome:         { actual:  2_040_000, comparator: null,        dataSource: "accounting" },
      reserveCoverage:          { actual:        1.42, comparator:        1.25, dataSource: "accounting" },
      workingCapital:           { actual:  4_710_000, comparator:  3_500_000, dataSource: "accounting" },
      arAging: {
        actual: 0.784, comparator: 0.037,
        watchThreshold: 0.05,
        dataSource: "operational",
      },
      fbSubsidy: null,
    };
  }

  it("all-primaries-missing → emits short fallback paragraph; does NOT invent verdicts", () => {
    const out = buildExecutiveSummary(makeAllPrimariesMissingDataset());
    expect(out.headline).toMatch(/cover summary not yet available/);
    expect(out.headline).toMatch(/Budget comparators are pending for operating revenue, NOI before depreciation, and capital income/);
    expect(out.headline).toMatch(/narrative will populate once full data flows/);
    // CRITICAL: the fallback does NOT claim "operating in line",
    // "above plan", "below plan", or any verdict.
    expect(out.headline).not.toMatch(/operating in line/);
    expect(out.headline).not.toMatch(/operating below/);
    expect(out.headline).not.toMatch(/operating above/);
    expect(out.headline).not.toMatch(/favorable/);
    expect(out.headline).not.toMatch(/unfavorable/);
  });

  it("all-primaries-missing → KPI cards render with 'Pending' comparator and neutral tone", () => {
    const out = buildExecutiveSummary(makeAllPrimariesMissingDataset());
    for (const k of out.kpis) {
      expect(
        k.comparison?.value,
        `KPI ${k.key} should render Pending comparator`,
      ).toBe("Pending");
      expect(
        k.tone,
        `KPI ${k.key} should be tone=neutral when comparator missing`,
      ).toBe("neutral");
    }
    // Consideration falls to no-action when nothing is red/amber.
    expect(out.consideration).toBe("no-action");
  });

  it("partial-missing → omits the missing clause + adds a 'comparators pending for: ...' aside", () => {
    const out = buildExecutiveSummary(makePartialMissingDataset());
    // Revenue + NOI clauses are present.
    expect(out.headline).toMatch(/Operating revenue closed at /);
    expect(out.headline).toMatch(/NOI before depreciation closed at /);
    // Capital income clause is omitted (its comparator is null).
    expect(out.headline).not.toMatch(/Capital income closed at /);
    // Partial-data aside names the missing metric.
    expect(out.headline).toMatch(/Comparators are not yet posted for: capital income/);
  });

  it("partial-missing → does NOT name capital income in largest-variance callout (skipped)", () => {
    const out = buildExecutiveSummary(makePartialMissingDataset());
    // The callout can only consider revenue + NOI in this scenario.
    // Capital income must not appear in the largest-variance line.
    const calloutMatch = out.headline.match(/largest favourable variance is .+?\./);
    if (calloutMatch) {
      expect(calloutMatch[0]).not.toMatch(/capital income/);
    }
  });

  it("partial-missing → KPI card for missing metric renders Pending + neutral tone", () => {
    const out = buildExecutiveSummary(makePartialMissingDataset());
    const cap = out.kpis.find((k) => k.key === "capital-income");
    expect(cap?.comparison?.value).toBe("Pending");
    expect(cap?.tone).toBe("neutral");
    // Other metrics still classified normally.
    const rev = out.kpis.find((k) => k.key === "ytd-revenue");
    expect(rev?.tone).toBe("green");
  });

  it("reserve-coverage-only missing → its KPI card uses 'Pending' + 'policy target not configured'", () => {
    const input = makePartialMissingDataset();
    input.reserveCoverage = { actual: 1.42, comparator: null, dataSource: "accounting" };
    const out = buildExecutiveSummary(input);
    const res = out.kpis.find((k) => k.key === "reserve-coverage");
    expect(res?.comparison?.value).toBe("Pending");
    expect(res?.comparison?.variance).toMatch(/policy target not configured/);
    expect(res?.tone).toBe("neutral");
    // Headline mentions reserve but without a verdict.
    expect(out.headline).toMatch(/policy floor is not yet configured in the reporting service/);
  });
});

// ---------------------------------------------------------------------------
// DATA SOURCE ROLLUP — accounting/operational → live, any demo → demo
// ---------------------------------------------------------------------------

describe("executive-summary — dataSource rollup", () => {
  it("All inputs accounting/operational → block dataSource = 'live'", () => {
    const out = buildExecutiveSummary(makeStrongDataset());
    expect(out.dataSource).toBe("live");
  });

  it("Mark one input demo → block dataSource = 'demo'", () => {
    const input = makeStrongDataset();
    input.ytdRevenue = { ...input.ytdRevenue, dataSource: "demo" };
    expect(buildExecutiveSummary(input).dataSource).toBe("demo");
  });

  it("Demo input factory + builder → block dataSource = 'demo' (preserves audit truthfulness)", () => {
    const out = buildDemoExecutiveSummary({ period: PERIOD, clubName: CLUB_NAME });
    expect(out.dataSource).toBe("demo");
  });
});

// ---------------------------------------------------------------------------
// LEGACY SHAPE — output matches what page.tsx renders today
// ---------------------------------------------------------------------------

describe("executive-summary — output shape matches legacy executiveSummary block", () => {
  it("returns exactly 6 KPIs in the fixed order page.tsx expects", () => {
    const out = buildExecutiveSummary(makeStrongDataset());
    expect(out.kpis.map((k) => k.key)).toEqual([
      "ytd-revenue",
      "noi",
      "capital-income",
      "reserve-coverage",
      "working-capital",
      "ar-current",
    ]);
  });

  it("every KPI has the four React-render fields (key, label, value, tone) and a comparison subobject", () => {
    const out = buildExecutiveSummary(makeStrongDataset());
    for (const k of out.kpis) {
      expect(k.key).toBeTruthy();
      expect(k.label).toBeTruthy();
      expect(k.value).toBeTruthy();
      expect(k.tone).toBeTruthy();
      expect(k.context).toBeTruthy();
      expect(k.comparison).toBeTruthy();
      expect(k.comparison?.label).toBeTruthy();
      expect(k.comparison?.value).toBeTruthy();
      expect(k.comparison?.variance).toBeTruthy();
    }
  });

  it("returns headline as a non-empty string and consideration as a BoardConsideration value", () => {
    const out = buildExecutiveSummary(makeStrongDataset());
    expect(typeof out.headline).toBe("string");
    expect(out.headline.length).toBeGreaterThan(50);
    expect([
      "no-action",
      "monitor",
      "committee-review",
      "board-decision",
    ]).toContain(out.consideration);
  });
});

// ---------------------------------------------------------------------------
// DEMO INPUT — preserves the historical Silver Springs seed values
// ---------------------------------------------------------------------------

describe("executive-summary — demo input preserves historical cover-page seed values", () => {
  it("YTD Revenue still renders the canonical $14.62M / $14.10M / +3.7% above plan", () => {
    const out = buildDemoExecutiveSummary({ period: PERIOD, clubName: CLUB_NAME });
    const rev = out.kpis.find((k) => k.key === "ytd-revenue");
    expect(rev?.value).toBe("$14.62M");
    expect(rev?.comparison?.value).toBe("$14.10M");
    expect(rev?.comparison?.variance).toMatch(/above plan/);
    expect(rev?.tone).toBe("green");
  });

  it("NOI Before Depreciation renders the canonical $3.18M / $2.84M", () => {
    const out = buildDemoExecutiveSummary({ period: PERIOD, clubName: CLUB_NAME });
    const noi = out.kpis.find((k) => k.key === "noi");
    expect(noi?.value).toBe("$3.18M");
    expect(noi?.comparison?.value).toBe("$2.84M");
  });

  it("Reserve Coverage renders 1.42x / Policy target 1.25x", () => {
    const out = buildDemoExecutiveSummary({ period: PERIOD, clubName: CLUB_NAME });
    const r = out.kpis.find((k) => k.key === "reserve-coverage");
    expect(r?.value).toBe("1.42x");
    expect(r?.comparison?.value).toBe("1.25x");
    expect(r?.tone).toBe("green");
  });

  it("AR Current % renders 78.4% / Over-90 3.7% / Watch 5.0%", () => {
    const out = buildDemoExecutiveSummary({ period: PERIOD, clubName: CLUB_NAME });
    const ar = out.kpis.find((k) => k.key === "ar-current");
    expect(ar?.value).toBe("78.4%");
    expect(ar?.comparison?.value).toBe("3.7%");
    expect(ar?.comparison?.variance).toContain("5.0%");
  });
});

// ---------------------------------------------------------------------------
// INPUT FACTORY MUTABILITY — proves the demo input is a fresh object
// ---------------------------------------------------------------------------

describe("executive-summary — input factory returns a fresh object", () => {
  it("mutating one demo input does not affect the next factory call", () => {
    const a = buildDemoExecutiveSummaryInput({ period: PERIOD, clubName: CLUB_NAME });
    a.ytdRevenue.actual = 1;
    const b = buildDemoExecutiveSummaryInput({ period: PERIOD, clubName: CLUB_NAME });
    expect(b.ytdRevenue.actual).toBe(14_620_000);
  });
});

// ---------------------------------------------------------------------------
// NO HARDCODED REACT LITERALS — guard against regression
// ---------------------------------------------------------------------------

describe("executive-summary — no React-side numeric literals in the cover-page block", () => {
  it("the `executiveSummary:` block in monthly-package.ts is a single buildExecutiveSummary() call, not a literal object", () => {
    // Read monthly-package.ts and prove the cover-page block now
    // flows through buildExecutiveSummary() rather than carrying
    // the previous hardcoded literal object.
    //
    // SCOPE NOTE: this test is intentionally scoped to the cover-
    // page (`executiveSummary:`) block only. Some of the same
    // literal numbers (e.g. "$14.62M") legitimately appear later
    // in the file inside the boardBriefing chips, capital
    // scorecard rows, and pillar-narrative paragraphs — those are
    // separate Tier 2/3 audit items (per
    // docs/monthly-reporting-data-lineage-audit.md §3). This pass
    // only ratifies the cover-page Tier 1 fix.
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const src = fs.readFileSync(
      path.resolve(process.cwd(), "src/lib/reporting/monthly-package.ts"),
      "utf8",
    );

    // Find the `executiveSummary:` block. It must be immediately
    // followed by `buildExecutiveSummary(` (the service call). If
    // a regression re-introduces the literal-object form, this
    // assertion fails.
    expect(
      /executiveSummary:\s*buildExecutiveSummary\(/.test(src),
      "monthly-package.ts must wire the executiveSummary block via buildExecutiveSummary()",
    ).toBe(true);

    // And the literal-object form (which used inline `kpis: [...]`
    // and `headline: \`...\``) must be gone from the cover block.
    // Slice ~120 lines around the executiveSummary line and check
    // none of the legacy cover literals appear there.
    const lines = src.split("\n");
    const startIdx = lines.findIndex((l) => /executiveSummary:\s*buildExecutiveSummary/.test(l));
    expect(startIdx).toBeGreaterThan(-1);
    const blockSlice = lines.slice(Math.max(0, startIdx - 5), startIdx + 15).join("\n");
    // The legacy literals must NOT appear in this slice.
    const legacyLiterals = [
      `"$14.62M"`,
      `"$3.18M"`,
      `"$2.04M"`,
      `"1.42x"`,
      `"$4.71M"`,
      `"78.4%"`,
      `"+3.7% above plan"`,
      `"+12.0% above plan"`,
      `"+4.6% above plan"`,
      `"0.17x above floor"`,
      `"$1.21M cushion"`,
      `"YTD Revenue"`,
      `"NOI Before Depreciation"`,
      `tracking favorably to plan`,
    ];
    for (const lit of legacyLiterals) {
      expect(
        blockSlice.includes(lit),
        `Legacy cover-page literal ${lit} reappeared in the executiveSummary block — must flow through buildExecutiveSummary()`,
      ).toBe(false);
    }
  });
});
