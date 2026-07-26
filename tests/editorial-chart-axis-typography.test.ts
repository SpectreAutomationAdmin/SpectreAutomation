// Founder rule 2026-07-05 v15.5 — Equity Value Over Time is the
// canonical editorial-chart axis standard. Every other editorial
// chart primitive (bar, grouped bar, interactive bar) must read
// the same CHART_AXES tokens so line + bar charts look like they
// were built from the same design system.
//
// This suite pins:
//   1. CHART_AXES canonical values (9 y, 9 x, 400 weight, 9.5 legend).
//   2. Every editorial chart primitive READS from CHART_AXES for
//      axis + legend typography — no hardcoded font sizes remain.
//   3. Every editorial chart primitive DOES NOT re-introduce the
//      pre-v15.5 bar-chart-only decorations (text-transform:
//      uppercase, letter-spacing) on x-axis labels — those broke
//      visual consistency with the Equity chart and are now
//      forbidden on axis labels.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { CHART_AXES } from "@/components/reporting/chart-theme";

const lineChart = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/reporting/EditorialLineChart.tsx"),
  "utf8",
);
const barChart = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/reporting/EditorialBarChart.tsx"),
  "utf8",
);
const groupedBarChart = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/reporting/EditorialGroupedBarChart.tsx"),
  "utf8",
);
const interactiveBarChart = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/reporting/EditorialInteractiveBarChart.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// 1. CHART_AXES canonical values — locked to the Equity chart standard.
// ---------------------------------------------------------------------------
describe("v15.5 CHART_AXES canonical values — Equity Value Over Time is the standard", () => {
  it("Y-axis tick label font size is 9 (Equity chart canonical value)", () => {
    expect(CHART_AXES.axisLabelFontSize).toBe(9);
  });

  it("X-axis category label font size is 9 (matches y-axis; single typographic system)", () => {
    expect(CHART_AXES.xLabelFontSize).toBe(9);
  });

  it("X-axis label font weight is NORMAL (400) — the 2026-06-22 medium-weight bump is retired", () => {
    expect(CHART_AXES.xLabelFontWeight).toBe(400);
  });

  it("Legend label font size is 9.5 — matches the Equity chart legend byte-for-byte", () => {
    expect(CHART_AXES.legendFontSize).toBe(9.5);
  });
});

// ---------------------------------------------------------------------------
// 2. Every editorial chart primitive READS from CHART_AXES for its axis and
//    legend fonts. No hardcoded font sizes on axis text.
// ---------------------------------------------------------------------------
describe("v15.5 EditorialLineChart consumes CHART_AXES tokens (no hardcoded font sizes)", () => {
  it("imports CHART_AXES from the shared chart-theme module", () => {
    expect(lineChart).toMatch(
      /import \{ CHART_AXES \} from "@\/components\/reporting\/chart-theme"/,
    );
  });

  it("Y-axis tick labels read `CHART_AXES.axisLabelFontSize`", () => {
    expect(lineChart).toMatch(
      /fontSize: `\$\{CHART_AXES\.axisLabelFontSize\}px`/,
    );
  });

  it("X-axis labels read `CHART_AXES.xLabelFontSize` + `CHART_AXES.xLabelFontWeight`", () => {
    expect(lineChart).toMatch(/fontSize: `\$\{CHART_AXES\.xLabelFontSize\}px`/);
    expect(lineChart).toMatch(/fontWeight: CHART_AXES\.xLabelFontWeight/);
  });

  it("Legend labels read `CHART_AXES.legendFontSize`", () => {
    expect(lineChart).toMatch(/const FONT_SIZE = CHART_AXES\.legendFontSize/);
  });

  it("Does NOT hardcode font-size:9px or font-size:9.5px on axis / legend text (would drift from CHART_AXES)", () => {
    expect(lineChart).not.toMatch(/fontSize:\s*"9px"/);
    expect(lineChart).not.toMatch(/FONT_SIZE = 9\.5;/);
  });
});

describe("v15.5 EditorialBarChart consumes CHART_AXES tokens + drops uppercase/tracking", () => {
  it("Y-axis tick labels read `CHART_AXES.axisLabelFontSize`", () => {
    expect(barChart).toMatch(
      /fontSize: `\$\{CHART_AXES\.axisLabelFontSize\}px`/,
    );
  });

  it("X-axis labels read `CHART_AXES.xLabelFontSize` + `CHART_AXES.xLabelFontWeight`", () => {
    expect(barChart).toMatch(/fontSize: `\$\{CHART_AXES\.xLabelFontSize\}px`/);
    expect(barChart).toMatch(/fontWeight: CHART_AXES\.xLabelFontWeight/);
  });

  it("X-axis labels do NOT apply uppercase or letter-spacing (bar-chart-only styling retired)", () => {
    // Guard: the pre-v15.5 bar-chart x-labels used
    //   textTransform: "uppercase"
    //   letterSpacing: "0.6px"
    // Those were the visible difference operators saw between the
    // Equity line chart and the Operating Results bar chart. Both
    // are now gone.
    expect(barChart).not.toMatch(/textTransform:\s*"uppercase"/);
    expect(barChart).not.toMatch(/letterSpacing:\s*"0\.[0-9]+px"/);
  });

  it("Legend labels read `CHART_AXES.legendFontSize` (no hardcoded 9.5)", () => {
    expect(barChart).toMatch(/const FONT_SIZE = CHART_AXES\.legendFontSize/);
    expect(barChart).not.toMatch(/const FONT_SIZE = 9\.5;/);
  });
});

describe("v15.5 EditorialGroupedBarChart drops letter-spacing + consumes legend token", () => {
  it("X-axis labels do NOT apply letter-spacing anymore", () => {
    expect(groupedBarChart).not.toMatch(/letterSpacing:\s*"0\.[0-9]+px"/);
  });

  it("Legend labels read `CHART_AXES.legendFontSize`", () => {
    expect(groupedBarChart).toMatch(
      /const FONT_SIZE = CHART_AXES\.legendFontSize/,
    );
    expect(groupedBarChart).not.toMatch(/const FONT_SIZE = 9\.5;/);
  });
});

describe("v15.5 EditorialInteractiveBarChart continues to read CHART_AXES (unchanged)", () => {
  it("Y + X axis labels still flow from CHART_AXES tokens", () => {
    // Existing behaviour — v15.5 lowered the token values but the
    // primitive already read them, so no code change was required.
    expect(interactiveBarChart).toMatch(
      /CHART_AXES\.axisLabelFontSize/,
    );
    expect(interactiveBarChart).toMatch(/CHART_AXES\.xLabelFontSize/);
    expect(interactiveBarChart).toMatch(/CHART_AXES\.xLabelFontWeight/);
  });

  it("Does NOT re-introduce uppercase or letter-spacing on axis labels", () => {
    expect(interactiveBarChart).not.toMatch(/textTransform:\s*"uppercase"/);
  });
});
