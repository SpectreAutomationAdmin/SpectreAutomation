// Canonical chart system — source-contract tests for the shared
// chart primitives (`chart-theme.ts`, `ChartTooltip`,
// `EditorialDonut`, `EditorialInteractiveBarChart`).
//
// This suite pins the values that the founder approved 2026-06-19
// (Financial Performance chart system as the canonical standard).
// Future chapters that adopt the primitives inherit these guarantees;
// any chapter that wants to deviate must do so by extending the
// primitives, not by hand-rolling a one-off chart.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const THEME = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/reporting/chart-theme.ts"),
  "utf8",
);
const TOOLTIP = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/reporting/ChartTooltip.tsx"),
  "utf8",
);
const DONUT = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/reporting/EditorialDonut.tsx"),
  "utf8",
);
const BARS = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/reporting/EditorialInteractiveBarChart.tsx"),
  "utf8",
);

describe("chart-theme.ts — canonical token values (Financial Performance system)", () => {
  it("CHART_COLORS exports the FP palette exactly", () => {
    // The FP `actual` green is club-green-500 = #3f7042.
    expect(THEME).toMatch(/actual:\s*"#3f7042"/);
    // Budget / target = muted gold #b08a4a.
    expect(THEME).toMatch(/budget:\s*"#b08a4a"/);
    // Negative / cost = clay #8b3520 (same as FP `OperatingResultsCard` negative bars).
    expect(THEME).toMatch(/negative:\s*"#8b3520"/);
    expect(THEME).toMatch(/costLine:\s*"#8b3520"/);
    // Prior-year = muted sage #9aa697.
    expect(THEME).toMatch(/priorYear:\s*"#9aa697"/);
  });

  it("CHART_STROKES exports the per-bar / per-slice hover strokes", () => {
    expect(THEME).toMatch(/rest:\s*"#6b5028"/);
    expect(THEME).toMatch(/active:\s*"#1c2f1c"/);
  });

  it("DONUT_GEOMETRY exports the FP-canonical donut geometry", () => {
    // FP `DuesSubsidyDonut`: viewBox 200, center 100, radius 80,
    // restStroke 36, activeStroke 44, gap 0.8°. All locked.
    expect(THEME).toMatch(/viewBox:\s*200/);
    expect(THEME).toMatch(/center:\s*100/);
    expect(THEME).toMatch(/radius:\s*80/);
    expect(THEME).toMatch(/restStrokeWidth:\s*36/);
    expect(THEME).toMatch(/activeStrokeWidth:\s*44/);
    // 2026-06-20: bumped 0.8 → 1.5 so the cream separators read as
    // deliberate dividers at boardroom distance. FP DuesSubsidyDonut
    // and the shared EditorialDonut now both consume this value.
    expect(THEME).toMatch(/gapDeg:\s*1\.5/);
  });

  it("BAR_GEOMETRY exports the FP-canonical bar geometry + hover stroke widths", () => {
    expect(THEME).toMatch(/primaryWidthRatio:\s*0\.55/);
    expect(THEME).toMatch(/secondaryWidthRatio:\s*0\.3/);
    expect(THEME).toMatch(/groupedTwoWidthRatio:\s*0\.32/);
    expect(THEME).toMatch(/groupedThreeWidthRatio:\s*0\.22/);
    expect(THEME).toMatch(/restStrokeWidth:\s*0\.5/);
    expect(THEME).toMatch(/activeStrokeWidth:\s*2\.4/);
  });

  it("CHART_AXES exports the Equity-Value-Over-Time canonical axis-label styling (founder rule 2026-07-05 v15.5)", () => {
    expect(THEME).toMatch(/gridlineColor:\s*"#e6dcc4"/);
    expect(THEME).toMatch(/axisLabelColor:\s*"#5b6c5a"/);
    expect(THEME).toMatch(/xLabelColor:\s*"#3a4b3a"/);
    // v15.5 — the Equity Value Over Time card is now the CANONICAL
    // editorial-chart axis standard. Prior 2026-06-22 values (12 y,
    // 13 x, medium weight) created a visible mismatch between the
    // Equity line chart and the Operating Results bar chart AND
    // clipped y-axis tick labels on Operating Results where
    // parenthesized negatives ("($200K)") overflowed padLeft=44.
    // v15.5 collapses the split by re-canonicalising every axis
    // token to the Equity line chart's byte-for-byte values.
    expect(THEME).toMatch(/axisLabelFontSize:\s*9/);
    expect(THEME).toMatch(/xLabelFontSize:\s*9/);
    expect(THEME).toMatch(/xLabelFontWeight:\s*400/);
    expect(THEME).toMatch(/legendFontSize:\s*9\.5/);
  });

  it("TOOLTIP_STYLE specifies the dark-green-glass overlay (85% bg, NO backdrop-blur)", () => {
    // TOOLTIP_STYLE.backgroundClass is the source of truth; the
    // ChartTooltip component just consumes it.
    expect(THEME).toMatch(/backgroundClass:\s*"bg-club-green-900\/85"/);
    expect(THEME).toMatch(/ringClass:\s*"ring-1 ring-club-green-900\/40"/);
    expect(THEME).toMatch(/bodyColorClass:\s*"text-club-cream"/);
    // Neither the theme tokens nor the ChartTooltip component may
    // introduce backdrop-blur — would defeat the "chart visible
    // beneath the tooltip" directive.
    // TOOLTIP_STYLE is the source of truth for the className tokens
    // ChartTooltip emits. If `backdrop-blur` doesn't appear in
    // TOOLTIP_STYLE, the tooltip cannot render it. The ChartTooltip
    // component file may still REFERENCE the phrase in a code
    // comment ("NO backdrop-blur — blurring defeats…"); that's
    // documentation, not a rendered class.
    expect(THEME, "TOOLTIP_STYLE MUST NOT include backdrop-blur").not.toMatch(/backdrop-blur/);
  });
});

describe("ChartTooltip — single tooltip primitive every chart uses", () => {
  it("renders the eyebrow label + tabular-nums body rows (theme-driven classes)", () => {
    // The literal Tailwind classes live in chart-theme.ts
    // (TOOLTIP_STYLE.labelClass / .bodyClass). The ChartTooltip
    // component composes them via string interpolation.
    expect(THEME).toMatch(/labelClass:\s*\n?\s*"font-serif text-\[10px\] uppercase tracking-\[0\.18em\]"/);
    expect(THEME).toMatch(/bodyClass:\s*"font-serif text-\[12px\] tabular-nums whitespace-nowrap"/);
    // ChartTooltip wires both classes through.
    expect(TOOLTIP).toMatch(/TOOLTIP_STYLE\.labelClass/);
    expect(TOOLTIP).toMatch(/TOOLTIP_STYLE\.bodyClass/);
  });

  it("is pointer-events-none so the underlying chart hover handlers continue receiving events", () => {
    expect(TOOLTIP).toMatch(/pointer-events-none/);
  });

  it("supports per-chart testid prefixes (so each chapter's chart has its own scoped tooltip testid)", () => {
    expect(TOOLTIP).toMatch(/testidPrefix\?: string/);
    expect(TOOLTIP).toMatch(/data-testid=\{`\$\{testidPrefix\}-tooltip`\}/);
  });
});

describe("EditorialDonut — single donut primitive every chart uses", () => {
  it("imports DONUT_GEOMETRY + ACTIVE_SHADOW_FILTER_ID from the theme (no inline constants)", () => {
    expect(DONUT).toMatch(/from "@\/components\/reporting\/chart-theme"/);
    expect(DONUT).toMatch(/DONUT_GEOMETRY/);
    expect(DONUT).toMatch(/ACTIVE_SHADOW_FILTER_ID/);
    expect(DONUT, "EditorialDonut MUST NOT inline donut radius — read from DONUT_GEOMETRY").not.toMatch(/const RADIUS\s*=/);
  });

  it("renders the active-shadow filter via the shared filter id", () => {
    expect(DONUT).toMatch(/feDropShadow/);
    expect(DONUT).toMatch(/id=\{ACTIVE_SHADOW_FILTER_ID\}/);
  });

  it("supports two render modes: per-slice fractions OR explicit arc angles", () => {
    expect(DONUT).toMatch(/slices\?: ReadonlyArray<DonutSlice>/);
    expect(DONUT).toMatch(/arcAngles\?: ReadonlyArray<DonutArcAngles>/);
  });

  it("hover thickens the slice stroke and applies the shared drop-shadow filter", () => {
    // The Tailwind transition is applied for smooth visual change.
    expect(DONUT).toMatch(/transition-\[stroke-width\]/);
    // Active slice receives the filter.
    expect(DONUT).toMatch(/filter=\{isActive \? `url\(#\$\{ACTIVE_SHADOW_FILTER_ID\}\)` : undefined\}/);
  });

  it("uses the shared ChartTooltip for its tooltip surface", () => {
    expect(DONUT).toMatch(/from "@\/components\/reporting\/ChartTooltip"/);
    expect(DONUT).toMatch(/<ChartTooltip\b/);
  });
});

describe("EditorialInteractiveBarChart — single hover-bar primitive every chart uses", () => {
  it("imports BAR_GEOMETRY + CHART_AXES + CHART_STROKES from the theme", () => {
    expect(BARS).toMatch(/from "@\/components\/reporting\/chart-theme"/);
    expect(BARS).toMatch(/BAR_GEOMETRY/);
    expect(BARS).toMatch(/CHART_AXES/);
    expect(BARS).toMatch(/CHART_STROKES/);
  });

  it("hover strokes come from the theme (no inline 0.5 / 2.4 literals)", () => {
    expect(BARS).toMatch(/BAR_GEOMETRY\.restStrokeWidth/);
    expect(BARS).toMatch(/BAR_GEOMETRY\.activeStrokeWidth/);
    expect(BARS).toMatch(/CHART_STROKES\.rest/);
    expect(BARS).toMatch(/CHART_STROKES\.active/);
  });

  it("hover never changes the bar's y or height (no lift, no scale)", () => {
    // The bar's y + height are computed once from the value and the
    // hover state ONLY toggles stroke + fill — not geometry.
    expect(BARS).toMatch(/const y = padTop \+ plotH - h/);
    // No conditional y/height calculation based on hover state.
    expect(BARS, "bar y MUST NOT depend on hover state").not.toMatch(/y=\{isActive \?/);
    expect(BARS, "bar height MUST NOT depend on hover state").not.toMatch(/height=\{isActive \?/);
  });

  it("uses the shared ChartTooltip", () => {
    expect(BARS).toMatch(/from "@\/components\/reporting\/ChartTooltip"/);
    expect(BARS).toMatch(/<ChartTooltip\b/);
  });

  it("supports per-bar `fillHex` (per-bar coloring, not just positive/negative split)", () => {
    expect(BARS).toMatch(/fillHex: string/);
  });
});
