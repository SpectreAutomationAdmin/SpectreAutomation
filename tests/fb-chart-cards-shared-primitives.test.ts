// Founder rule 2026-07-05 v15.10 — F&B Statistics charts must
// consume the SAME editorial chart primitives + tokens as
// Payroll Analysis (v15.8), Operating Results, and Equity Value
// Over Time.
//
// This suite locks the shape of `FoodBeverageChartCards.tsx` at
// the source-contract level: what it imports, what it renders,
// what it does NOT contain (bespoke SVG, inline hex chart
// palette, hand-rolled tooltip, per-chapter typography, per-
// chapter donut geometry, per-chapter formatter).

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { buildSilverSpringsFoodBeverageStatistics } from "@/lib/reporting/food-beverage-statistics";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

const fbCards = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/reporting/monthly/FoodBeverageChartCards.tsx",
  ),
  "utf8",
);

describe("v15.10 FoodBeverageChartCards imports the SHARED editorial primitives", () => {
  it("imports EditorialGroupedBarChart (used for Monthly Revenue vs Cost + Monthly Cover Counts)", () => {
    expect(fbCards).toMatch(
      /import \{ EditorialGroupedBarChart \} from "@\/components\/reporting\/EditorialGroupedBarChart"/,
    );
  });

  it("imports EditorialLineChart (used for Food Cost % by Month)", () => {
    expect(fbCards).toMatch(
      /import \{ EditorialLineChart \} from "@\/components\/reporting\/EditorialLineChart"/,
    );
  });

  it("imports EditorialDonut (used for Revenue by Category)", () => {
    expect(fbCards).toMatch(
      /import \{ EditorialDonut(, [^}]+)? \} from "@\/components\/reporting\/EditorialDonut"/,
    );
  });
});

describe("v15.10 F&B cards drop the pre-v15.10 bespoke SVG / tooltip / typography surfaces", () => {
  it("does NOT render its own <svg> tag (all SVGs delegated to the shared primitives)", () => {
    // Pre-v15.10 the file rendered four `viewBox={\`0 0 520 260\`}`
    // SVG roots + a hand-rolled 220×220 donut. v15.10 delegates
    // every SVG to the shared primitives.
    expect(fbCards).not.toMatch(/<svg\b/);
  });

  it("does NOT declare bespoke donut geometry constants (radius / stroke sourced from DONUT_GEOMETRY)", () => {
    expect(fbCards).not.toMatch(/const radius\s*=\s*80/);
    expect(fbCards).not.toMatch(/const restStroke\s*=\s*36/);
    expect(fbCards).not.toMatch(/const activeStroke\s*=\s*44/);
  });

  it("does NOT carry bespoke tooltip Tailwind classes (uses shared ChartTooltip via EditorialDonut)", () => {
    // The old file had its own `ChartTooltip` component with
    // these exact classes. v15.10 removes the entire component
    // and delegates hover to the shared primitives.
    expect(fbCards).not.toMatch(/bg-club-green-900\/85/);
    expect(fbCards).not.toMatch(/tracking-\[0\.18em\]/);
    expect(fbCards).not.toMatch(/function ChartTooltip\(/);
  });

  it("does NOT hardcode axis-label font sizes on any SVG text", () => {
    expect(fbCards).not.toMatch(/fontSize="9"/);
    expect(fbCards).not.toMatch(/fontSize="9\.5"/);
    expect(fbCards).not.toMatch(/fontSize="10"/);
  });

  it("does NOT contain the pre-v15.10 inline hex chart palette", () => {
    // The bespoke bar / stroke / gridline colors (#5b8c5f,
    // #d4a99a, #d8c39a, #a6c39a, #e6dcc4, #6b5028, #3a4b3a,
    // #5b6c5a) are gone. The donut's per-slice fillHex still
    // arrives from the service — the reporting service owns the
    // brand palette; the component itself no longer bakes chart
    // colors inline.
    expect(fbCards).not.toMatch(/#5b8c5f/);
    expect(fbCards).not.toMatch(/#d4a99a/);
    expect(fbCards).not.toMatch(/#d8c39a/);
    expect(fbCards).not.toMatch(/#a6c39a/);
    expect(fbCards).not.toMatch(/#e6dcc4/);
    expect(fbCards).not.toMatch(/#6b5028/);
  });

  it("carries NO local `applyFormatY` / bespoke tick formatter (uses shared editorial formatter)", () => {
    // Per the founder's Editorial Reporting Design System rule
    // (CLAUDE.md): every reporting chart consumes the shared
    // formatter. Pre-v15.10 F&B had `formatMoneyThousands`,
    // `formatMoneyMillions`, and `formatInteger`.
    expect(fbCards).not.toMatch(/function formatMoneyThousands/);
    expect(fbCards).not.toMatch(/function formatMoneyMillions/);
    expect(fbCards).not.toMatch(/function applyFormatY/);
  });
});

describe("v15.10 every F&B chart card renders the dark-green Stewardship-style editorial header", () => {
  it("all four F&B chart cards render a ChartHeader with dark-green slab", () => {
    // Same treatment as Payroll v15.8: `bg-club-green-900`,
    // 76 px height, 12/18 padding, cream serif title, uppercase
    // cream/70 subtitle, gold pill on the right.
    expect(fbCards).toMatch(/bg-club-green-900/);
    expect(fbCards).toMatch(/height:\s*76/);
    expect(fbCards).toMatch(/paddingLeft:\s*18/);
    expect(fbCards).toMatch(/paddingRight:\s*18/);
    expect(fbCards).toMatch(/font-serif text-club-cream/);
    expect(fbCards).toMatch(/uppercase text-club-cream\/70/);
    expect(fbCards).toMatch(/border-club-gold\/30/);
  });

  it("subtitle typography matches Stewardship byte-for-byte (10.5 px + 0.7 letter-spacing)", () => {
    expect(fbCards).toMatch(/fontSize:\s*"10\.5px"/);
    expect(fbCards).toMatch(/letterSpacing:\s*"0\.7px"/);
  });

  it("title typography matches Stewardship byte-for-byte (17 px 600 serif)", () => {
    expect(fbCards).toMatch(/fontSize:\s*"17px"/);
    expect(fbCards).toMatch(/fontWeight:\s*600/);
  });
});

describe("v15.10 every F&B chart card renders an executive commentary panel", () => {
  it("Four callout testids — one per chart", () => {
    expect(fbCards).toMatch(/data-testid="fb-monthly-callout"/);
    expect(fbCards).toMatch(/data-testid="fb-category-callout"/);
    expect(fbCards).toMatch(/data-testid="fb-covers-callout"/);
    expect(fbCards).toMatch(/data-testid="fb-food-cost-callout"/);
  });

  it("Each commentary reads from `charts.callouts.{chart}.text` — the reporting service owns the narrative", () => {
    expect(fbCards).toMatch(/charts\.callouts\.monthlyRevenueCost\.text/);
    expect(fbCards).toMatch(/charts\.callouts\.revenueByCategory\.text/);
    expect(fbCards).toMatch(/charts\.callouts\.monthlyCoverCounts\.text/);
    expect(fbCards).toMatch(/charts\.callouts\.foodCostTrend\.text/);
  });

  it("Commentary block matches the Stewardship green-wash + 3-px accent border byte-for-byte", () => {
    // Same three keys the Payroll v15.8 + Stewardship inset
    // commentary sets. Any drift here means F&B commentary is
    // visually different from the rest of the report.
    expect(fbCards).toMatch(/padding:\s*"10px 14px"/);
    expect(fbCards).toMatch(
      /backgroundColor:\s*"rgba\(63,\s*112,\s*66,\s*0\.10\)"/,
    );
    expect(fbCards).toMatch(
      /borderLeft:\s*"3px solid rgba\(63,\s*112,\s*66,\s*0\.55\)"/,
    );
  });
});

describe("v15.10 F&B charts consume the shared editorial palette + compact formatter", () => {
  it("Monthly Revenue vs Cost + Monthly Covers use the canonical `fill-club-green-500` primary tone", () => {
    // Same primary green Operating Results + Payroll use. Guards
    // against the previous inline `#5b8c5f` regression.
    expect(fbCards).toMatch(/color:\s*"fill-club-green-500"/);
  });

  it("Budget / secondary series use the canonical `fill-club-gold` editorial tone", () => {
    expect(fbCards).toMatch(/color:\s*"fill-club-gold"/);
  });

  it("Monthly Revenue vs Cost uses `formatY=\"dollars-compact\"` (raw dollars in → $NK / $X.YM out)", () => {
    // Same shared formatter Payroll flipped to in v15.9 so no
    // "900000K" duplicated-suffix regression.
    expect(fbCards).toMatch(/formatY="dollars-compact"/);
  });

  it("Food Cost % by Month uses the shared `EditorialLineChart` with `formatY=\"percent\"` + dashed gold budget line", () => {
    expect(fbCards).toMatch(/<EditorialLineChart\b/);
    expect(fbCards).toMatch(/formatY="percent"/);
    // Dashed benchmark line + solid primary line — Equity Value
    // Over Time convention.
    expect(fbCards).toMatch(/dasharray:\s*"6 4"/);
  });

  it("padLeft / padRight match the Equity + Operating alignment invariants (44 / 14)", () => {
    // Locked geometry from docs/equity-value-over-time-card-spec.md.
    expect(fbCards).toMatch(/padLeft=\{44\}/);
    expect(fbCards).toMatch(/padRight=\{14\}/);
  });

  it("Chart canvas height 245 matches the chart-dominant band shared with Equity + Operating + Payroll", () => {
    const matches = fbCards.match(/height=\{245\}/g);
    expect(matches, "expected 4 F&B charts at height=245").not.toBeNull();
    // Three grouped/line bar charts + one donut (donut uses its
    // own viewBox from DONUT_GEOMETRY and does NOT carry height).
    // So we expect at least 3 explicit height={245} bindings.
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// v15.10 reporting service — every chart's commentary + chip is emitted.
// ---------------------------------------------------------------------------
describe("v15.10 F&B reporting service — every chart has a callout + chip label", () => {
  const MAY_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));
  const fbs = buildSilverSpringsFoodBeverageStatistics({
    clubName: "Silver Springs",
    period: MAY_2026,
  });

  it("charts.callouts has one non-trivial entry per chart", () => {
    const c = fbs.charts.callouts;
    expect(c.monthlyRevenueCost.text.length).toBeGreaterThan(80);
    expect(c.revenueByCategory.text.length).toBeGreaterThan(80);
    expect(c.monthlyCoverCounts.text.length).toBeGreaterThan(80);
    expect(c.foodCostTrend.text.length).toBeGreaterThan(80);
  });

  it("Monthly Revenue vs Cost callout summarises revenue trend + operating margin + profitability direction", () => {
    const c = fbs.charts.callouts.monthlyRevenueCost.text;
    expect(c).toMatch(/revenue/i);
    expect(c).toMatch(/margin/i);
    expect(c).toMatch(/profitability/i);
  });

  it("Revenue by Category callout names the LARGEST category + top-2 concentration", () => {
    const c = fbs.charts.callouts.revenueByCategory.text;
    expect(c).toMatch(/largest F&B revenue category/i);
    expect(c).toMatch(/top two categories/i);
  });

  it("charts.chipLabels emits a non-empty chip label per chart", () => {
    const ch = fbs.charts.chipLabels;
    expect(ch.monthlyRevenueCost.length).toBeGreaterThan(0);
    expect(ch.revenueByCategory.length).toBeGreaterThan(0);
    expect(ch.monthlyCoverCounts.length).toBeGreaterThan(0);
    expect(ch.foodCostTrend.length).toBeGreaterThan(0);
  });
});
