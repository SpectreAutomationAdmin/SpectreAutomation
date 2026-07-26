// Founder rule 2026-07-05 v15.11 — Inventory Analysis charts must
// consume the SAME editorial chart primitives + tokens as Payroll
// Analysis (v15.8), F&B Statistics (v15.10), Operating Results,
// and Equity Value Over Time.
//
// This suite locks the shape of `InventoryChartCards.tsx` at the
// source-contract level: what it imports, what it renders, what it
// does NOT contain (bespoke SVG, inline hex chart palette, hand-
// rolled tooltip, per-chapter typography, per-chapter formatter).

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { buildSilverSpringsInventoryAnalysis } from "@/lib/reporting/inventory-analysis";
import { buildReportingPeriod } from "@/lib/reporting/reporting-period";

const invCards = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/reporting/monthly/InventoryChartCards.tsx",
  ),
  "utf8",
);

describe("v15.11 InventoryChartCards imports the SHARED editorial primitives", () => {
  it("imports EditorialGroupedBarChart (used for Inventory Turnover by Category)", () => {
    expect(invCards).toMatch(
      /import \{ EditorialGroupedBarChart \} from "@\/components\/reporting\/EditorialGroupedBarChart"/,
    );
  });

  it("imports EditorialLineChart (used for F&B Monthly Inventory Balances)", () => {
    expect(invCards).toMatch(
      /import \{ EditorialLineChart \} from "@\/components\/reporting\/EditorialLineChart"/,
    );
  });
});

describe("v15.11 Inventory cards drop the pre-v15.11 bespoke SVG / tooltip / typography surfaces", () => {
  it("does NOT render its own <svg> tag (all SVGs delegated to the shared primitives)", () => {
    // Pre-v15.11 the file rendered two `viewBox={\`0 0 520 260\`}`
    // SVG roots + inline gridline / axis text. v15.11 delegates
    // every SVG to the shared primitives.
    expect(invCards).not.toMatch(/<svg\b/);
  });

  it("does NOT declare bespoke chart geometry constants (padL/padR/plotW/plotH)", () => {
    // The old file had literal `const width = 520, height = 260`
    // + `const padL = 50, padR = 12` in TWO chart components. The
    // shared primitives own these numbers now.
    expect(invCards).not.toMatch(/const width\s*=\s*520/);
    expect(invCards).not.toMatch(/const padL\s*=\s*50/);
    expect(invCards).not.toMatch(/const plotW\s*=\s*width\s*-\s*padL/);
    expect(invCards).not.toMatch(/const plotH\s*=\s*height\s*-\s*padT/);
  });

  it("does NOT carry bespoke tooltip Tailwind classes (uses shared ChartTooltip via primitives)", () => {
    // The old file had its own `ChartTooltip` component with these
    // exact classes. v15.11 removes the entire component and
    // delegates hover to the shared primitives.
    expect(invCards).not.toMatch(/bg-club-green-900\/85/);
    expect(invCards).not.toMatch(/tracking-\[0\.18em\]/);
    expect(invCards).not.toMatch(/function ChartTooltip\(/);
  });

  it("does NOT hardcode axis-label font sizes on any SVG text", () => {
    expect(invCards).not.toMatch(/fontSize="9"/);
    expect(invCards).not.toMatch(/fontSize="9\.5"/);
    expect(invCards).not.toMatch(/fontSize="10"/);
  });

  it("does NOT contain the pre-v15.11 inline hex chart palette", () => {
    // The bespoke bar / gridline / axis text colors (#5b8c5f,
    // #d8c39a, #e6dcc4, #6b5028, #3a4b3a, #5b6c5a) are gone. The
    // shared primitives own these tokens now. Line-series brand
    // strokes flow through Tailwind classes (stroke-club-green-500,
    // stroke-club-gold) plus a single arbitrary token for the
    // slate-blue Liquor series.
    expect(invCards).not.toMatch(/#5b8c5f/);
    expect(invCards).not.toMatch(/#d8c39a/);
    expect(invCards).not.toMatch(/#e6dcc4/);
    expect(invCards).not.toMatch(/#6b5028/);
    expect(invCards).not.toMatch(/#3a4b3a/);
    expect(invCards).not.toMatch(/#5b6c5a/);
  });

  it("carries NO local formatter helpers (uses shared editorial formatter)", () => {
    // Per the founder's Editorial Reporting Design System rule
    // (CLAUDE.md): every reporting chart consumes the shared
    // formatter. Pre-v15.11 Inventory had `formatTurnover` +
    // `formatMoneyThousands`.
    expect(invCards).not.toMatch(/function formatTurnover/);
    expect(invCards).not.toMatch(/function formatMoneyThousands/);
    expect(invCards).not.toMatch(/function applyFormatY/);
  });
});

describe("v15.11 every Inventory chart card renders the dark-green Stewardship-style editorial header", () => {
  it("both Inventory chart cards render a ChartHeader with dark-green slab", () => {
    // Same treatment as Payroll v15.8 + F&B v15.10: `bg-club-green-900`,
    // 76 px height, 12/18 padding, cream serif title, uppercase
    // cream/70 subtitle, gold pill on the right.
    expect(invCards).toMatch(/bg-club-green-900/);
    expect(invCards).toMatch(/height:\s*76/);
    expect(invCards).toMatch(/paddingLeft:\s*18/);
    expect(invCards).toMatch(/paddingRight:\s*18/);
    expect(invCards).toMatch(/font-serif text-club-cream/);
    expect(invCards).toMatch(/uppercase text-club-cream\/70/);
    expect(invCards).toMatch(/border-club-gold\/30/);
  });

  it("subtitle typography matches Stewardship byte-for-byte (10.5 px + 0.7 letter-spacing)", () => {
    expect(invCards).toMatch(/fontSize:\s*"10\.5px"/);
    expect(invCards).toMatch(/letterSpacing:\s*"0\.7px"/);
  });

  it("title typography matches Stewardship byte-for-byte (17 px 600 serif)", () => {
    expect(invCards).toMatch(/fontSize:\s*"17px"/);
    expect(invCards).toMatch(/fontWeight:\s*600/);
  });

  it("card chrome uses the cream body + overflow-hidden shell so the dark header can go edge-to-edge", () => {
    expect(invCards).toMatch(/overflow-hidden/);
    expect(invCards).toMatch(/border-club-green-800\/10/);
    expect(invCards).toMatch(/bg-club-cream/);
  });
});

describe("v15.11 every Inventory chart card renders an executive commentary panel", () => {
  it("Two callout testids — one per chart", () => {
    expect(invCards).toMatch(/data-testid="inv-turnover-callout"/);
    expect(invCards).toMatch(/data-testid="inv-balances-callout"/);
  });

  it("Each commentary reads from `charts.callouts.{chart}.text` — the reporting service owns the narrative", () => {
    expect(invCards).toMatch(/charts\.callouts\.turnoverByCategory\.text/);
    expect(invCards).toMatch(/charts\.callouts\.monthlyBalances\.text/);
  });

  it("Commentary block matches the Stewardship green-wash + 3-px accent border byte-for-byte", () => {
    // Same three keys the Payroll v15.8 + F&B v15.10 + Stewardship
    // inset commentary sets. Any drift here means Inventory
    // commentary is visually different from the rest of the report.
    expect(invCards).toMatch(/padding:\s*"10px 14px"/);
    expect(invCards).toMatch(
      /backgroundColor:\s*"rgba\(63,\s*112,\s*66,\s*0\.10\)"/,
    );
    expect(invCards).toMatch(
      /borderLeft:\s*"3px solid rgba\(63,\s*112,\s*66,\s*0\.55\)"/,
    );
  });
});

describe("v15.11 Inventory charts consume the shared editorial palette + turnover / compact formatters", () => {
  it("Turnover by Category uses the canonical `fill-club-green-500` primary tone", () => {
    // Same primary green Operating Results + Payroll + F&B use.
    // Guards against the previous inline `#5b8c5f` regression.
    expect(invCards).toMatch(/color:\s*"fill-club-green-500"/);
  });

  it("Prior Year / secondary series uses the canonical `fill-club-gold` editorial tone", () => {
    expect(invCards).toMatch(/color:\s*"fill-club-gold"/);
  });

  it("Turnover by Category uses `formatY=\"turnover-x\"` (integer ticks with `x` suffix)", () => {
    // v15.11 shared-primitive extension: turnover multiples ticks.
    expect(invCards).toMatch(/formatY="turnover-x"/);
  });

  it("Monthly Balances uses `formatY=\"dollars-compact\"` (raw dollars in → $NK / $X.YM out)", () => {
    // Same shared formatter Payroll flipped to in v15.9 so no
    // "45000K" duplicated-suffix regression.
    expect(invCards).toMatch(/formatY="dollars-compact"/);
  });

  it("Monthly Balances uses `EditorialLineChart` with Tailwind stroke classes for all three series", () => {
    expect(invCards).toMatch(/<EditorialLineChart\b/);
    // Food / Wine / Liquor branding — the same three category
    // colors the F&B chapter uses, expressed as literal Tailwind
    // classes so the JIT scanner compiles them.
    expect(invCards).toMatch(/stroke:\s*"stroke-club-green-500"/);
    expect(invCards).toMatch(/stroke:\s*"stroke-club-gold"/);
    expect(invCards).toMatch(/stroke:\s*"stroke-\[#7d96b0\]"/);
  });

  it("padLeft / padRight match the Equity + Operating alignment invariants (44 / 14)", () => {
    // Locked geometry from docs/equity-value-over-time-card-spec.md.
    expect(invCards).toMatch(/padLeft=\{44\}/);
    expect(invCards).toMatch(/padRight=\{14\}/);
  });

  it("Chart canvas height 245 matches the chart-dominant band shared with Equity + Operating + Payroll + F&B", () => {
    const matches = invCards.match(/height=\{245\}/g);
    expect(matches, "expected 2 Inventory charts at height=245").not.toBeNull();
    // Two charts — one grouped-bar + one multi-line — both at
    // height=245. Any regression that drops one below the shared
    // chart-dominant band breaks visual parity across the report.
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// v15.11 reporting service — every chart's commentary + chip is emitted.
// ---------------------------------------------------------------------------
describe("v15.11 Inventory reporting service — every chart has a callout + chip label", () => {
  const MAY_2026 = buildReportingPeriod(new Date(Date.UTC(2026, 4, 31)));
  const inv = buildSilverSpringsInventoryAnalysis({
    clubName: "Silver Springs",
    period: MAY_2026,
  });

  it("charts.callouts has one non-trivial entry per chart", () => {
    const c = inv.charts.callouts;
    expect(c.turnoverByCategory.text.length).toBeGreaterThan(80);
    expect(c.monthlyBalances.text.length).toBeGreaterThan(80);
  });

  it("Turnover callout names food / liquor + a directional verb (`improving` / `declining`)", () => {
    const c = inv.charts.callouts.turnoverByCategory.text;
    expect(c).toMatch(/Food turns improving/);
    expect(c).toMatch(/declining|tracking/);
  });

  it("Balances callout names each of the three series + a directional verb", () => {
    const c = inv.charts.callouts.monthlyBalances.text;
    expect(c).toMatch(/food/i);
    expect(c).toMatch(/wine/i);
    expect(c).toMatch(/liquor/i);
    expect(c).toMatch(/built up|drew down|held flat/);
  });

  it("charts.chipLabels emits a non-empty chip label per chart", () => {
    const ch = inv.charts.chipLabels;
    expect(ch.turnoverByCategory.length).toBeGreaterThan(0);
    expect(ch.monthlyBalances.length).toBeGreaterThan(0);
  });
});
