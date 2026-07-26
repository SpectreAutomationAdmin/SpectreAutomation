// Founder rule 2026-07-05 v15.12 — every Spectre line chart must
// inherit the SAME interaction model (nearest-x snap, vertical guide,
// active-marker emphasis, editorial ChartTooltip) from a single
// shared primitive (`EditorialLineChart`). Per-chart custom hover
// code is prohibited.
//
// This suite locks the shape at the source-contract level:
//   1. The primitive owns the interaction (imports ChartTooltip,
//      exposes `tooltip` in its prop type, and renders a
//      `data-testid="editorial-line-chart-guide"` guide line).
//   2. Every founder-named call site opts in via the `tooltip` prop
//      instead of hand-rolling its own tooltip / marker / guide.
//
// The call sites the founder named:
//   - Equity Value Over Time
//   - Payroll Ratio Monthly Trend
//   - Food Cost % by Month
//   - F&B Inventory Balances — Monthly

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const lineChart = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/reporting/EditorialLineChart.tsx"),
  "utf8",
);
const monthlyBody = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx",
  ),
  "utf8",
);
const fbCards = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/reporting/monthly/FoodBeverageChartCards.tsx",
  ),
  "utf8",
);
const invCards = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/reporting/monthly/InventoryChartCards.tsx",
  ),
  "utf8",
);

// ---------------------------------------------------------------------------
// EditorialLineChart — the shared primitive owns the interaction.
// ---------------------------------------------------------------------------
describe("v15.12 EditorialLineChart owns the shared interaction model", () => {
  it("imports the shared ChartTooltip (no per-chart tooltip re-implementation)", () => {
    expect(lineChart).toMatch(
      /import \{ ChartTooltip \} from "@\/components\/reporting\/ChartTooltip"/,
    );
  });

  it("exposes a `tooltip?: LineChartTooltipSpec` prop with xHeaders + lineLabels + serialisable valueFormat descriptor", () => {
    expect(lineChart).toMatch(/export type LineChartTooltipSpec/);
    expect(lineChart).toMatch(/xHeaders:\s*string\[\]/);
    expect(lineChart).toMatch(/lineLabels:\s*\(string \| null\)\[\]/);
    // v15.12.1 — must be the JSON-serialisable FormatYSpec union,
    // NOT a `(value: number, lineIndex: number) => string` closure.
    // Passing a function across the RSC boundary throws
    // "Functions cannot be passed directly to Client Components…"
    // at runtime.
    expect(lineChart).toMatch(/valueFormat\?:\s*FormatYSpec/);
    expect(lineChart).toMatch(/tooltip\?:\s*LineChartTooltipSpec/);
  });

  it("captures pointer events on the SVG (onPointerMove + onPointerLeave)", () => {
    expect(lineChart).toMatch(/onPointerMove=\{handlePointerMove\}/);
    expect(lineChart).toMatch(/onPointerLeave=\{handlePointerLeave\}/);
  });

  it("renders a subtle vertical guide line at the active x-slot", () => {
    expect(lineChart).toMatch(/data-testid="editorial-line-chart-guide"/);
    // Spectre neutral palette — no bright cursor colours.
    expect(lineChart).toMatch(/stroke-club-green-900/);
  });

  it("enlarges the active marker (r=5) while inactive markers stay at r=3", () => {
    expect(lineChart).toMatch(/hover\?\.index === i \? 5 : 3/);
  });

  it("mounts the shared ChartTooltip with the editorial testid prefix", () => {
    expect(lineChart).toMatch(
      /<ChartTooltip tooltip=\{tooltipModel\} testidPrefix="editorial-line-chart"/,
    );
  });

  it("emits two rows per surfaced series (label above value) so the tooltip reads as the founder's Bank-of-Canada-inspired stack", () => {
    expect(lineChart).toMatch(/key:\s*`label-\$\{i\}`/);
    expect(lineChart).toMatch(/key:\s*`value-\$\{i\}`/);
  });

  it("skips lines whose lineLabels[i] === null (benchmark / budget / prior-year overlays stay out of the callout)", () => {
    expect(lineChart).toMatch(/if \(label == null\) continue/);
  });
});

// ---------------------------------------------------------------------------
// Call sites — every named chart opts in via the `tooltip` prop.
// ---------------------------------------------------------------------------

/** Extract the first EditorialLineChart JSX block that contains
 *  `anchor` — a short substring proprietary to the chart in question
 *  (e.g. "Club Equity" for the Equity card). Returns the raw text of
 *  the block including its closing `/>`.
 *
 *  Used to lock per-chart tooltip wiring without accidentally
 *  matching a different chart's tooltip on the same page. */
function extractChartBlock(source: string, anchor: string): string {
  const opens: number[] = [];
  const openRe = /<EditorialLineChart\b/g;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(source)) !== null) opens.push(m.index);
  for (const openIdx of opens) {
    // Naive close: find the matching `/>` closer that terminates the JSX opening
    // tag. Because these charts render as self-closing tags, this is sufficient.
    const closeIdx = source.indexOf("/>", openIdx);
    if (closeIdx < 0) continue;
    const block = source.slice(openIdx, closeIdx + 2);
    if (block.includes(anchor)) return block;
  }
  return "";
}

describe("v15.12 Equity Value Over Time chart opts in to the shared tooltip", () => {
  const block = extractChartBlock(monthlyBody, "Club Equity");
  it("passes a `tooltip` prop", () => {
    expect(block).not.toBe("");
    expect(block).toMatch(/tooltip=\{/);
  });
  it("only surfaces the Club Equity row — benchmarks stay silent", () => {
    // [null, null, "Club Equity"] means benchmarks at indexes 0/1 are
    // omitted and only the actual line reports.
    expect(block).toMatch(/lineLabels:\s*\[null,\s*null,\s*"Club Equity"\]/);
  });
  it("formats values as $X.XM via the shared `dollars-millions-1d` descriptor", () => {
    expect(block).toMatch(/valueFormat:\s*"dollars-millions-1d"/);
  });
});

describe("v15.12 Payroll Ratio Monthly Trend chart opts in to the shared tooltip", () => {
  const block = extractChartBlock(monthlyBody, "Payroll Ratio");
  it("passes a `tooltip` prop", () => {
    expect(block).not.toBe("");
    expect(block).toMatch(/tooltip=\{/);
  });
  it("only surfaces the Payroll Ratio row — benchmarks / budget / prior-year stay silent", () => {
    expect(block).toMatch(
      /lineLabels:\s*\[null,\s*null,\s*null,\s*"Payroll Ratio"\]/,
    );
  });
  it("formats values as X.X% via the shared `percent` descriptor", () => {
    expect(block).toMatch(/valueFormat:\s*"percent"/);
  });
  it("period header combines month + reporting year (`May 2026`)", () => {
    // Header spec derives the year from `actualSeriesLabel` (e.g.
    // "2026 Actual" → "2026") to avoid duplicating period state.
    expect(block).toMatch(/data\.months\.map/);
    expect(block).toMatch(/actualSeriesLabel\.split/);
  });
});

describe("v15.12 Food Cost % by Month chart opts in to the shared tooltip", () => {
  it("passes a `tooltip` prop to its EditorialLineChart", () => {
    expect(fbCards).toMatch(/tooltip=\{/);
  });
  it("surfaces ONLY the Food Cost row — the dashed budget target stays silent", () => {
    expect(fbCards).toMatch(/lineLabels:\s*\[null,\s*"Food Cost"\]/);
  });
  it("formats values as X.X% via the shared `percent` descriptor", () => {
    expect(fbCards).toMatch(/valueFormat:\s*"percent"/);
  });
  it("period header combines full month name + reporting year (`March 2026`)", () => {
    expect(fbCards).toMatch(/xHeaders:\s*trend\.points\.map/);
    expect(fbCards).toMatch(/\$\{p\.monthLabel\} \$\{periodYear\}/);
  });
  it("FoodBeverageChartCards extracts the period year from the service subtitle", () => {
    expect(fbCards).toMatch(/const periodYear\s*=/);
    expect(fbCards).toMatch(/subtitles\.monthlyRevenueCost\.match/);
  });
});

describe("v15.12 F&B Inventory Balances chart opts in to the shared tooltip (multi-series)", () => {
  it("passes a `tooltip` prop to its EditorialLineChart", () => {
    expect(invCards).toMatch(/tooltip=\{/);
  });
  it("surfaces ALL THREE series — Food / Wine / Liquor — for the selected month", () => {
    expect(invCards).toMatch(
      /lineLabels:\s*\["Food Inventory",\s*"Wine Inventory",\s*"Liquor Inventory"\]/,
    );
  });
  it("period header combines full month name + reporting year (`April 2026`)", () => {
    expect(invCards).toMatch(/xHeaders:\s*data\.map/);
    expect(invCards).toMatch(/\$\{d\.monthLabel\} \$\{periodYear\}/);
  });
  it("formats values as $X.XK via the shared `dollars-compact-1d` descriptor", () => {
    expect(invCards).toMatch(/valueFormat:\s*"dollars-compact-1d"/);
  });
  it("InventoryChartCards extracts the period year from the service subtitle", () => {
    expect(invCards).toMatch(/const periodYear\s*=/);
    expect(invCards).toMatch(/titles\.monthlyBalances\.subtitle\.match/);
  });
});

// ---------------------------------------------------------------------------
// No per-chart tooltip re-implementations — the shared primitive is
// the ONLY place ChartTooltip is instantiated for line-chart hover.
// ---------------------------------------------------------------------------
describe("v15.12 no line-chart call site re-implements its own tooltip / guide", () => {
  it("neither line chart card file constructs a ChartTooltip directly", () => {
    // Line charts must delegate to EditorialLineChart, which mounts
    // the shared ChartTooltip. If a call site starts constructing
    // its own ChartTooltip, the shared standard has been broken.
    expect(fbCards).not.toMatch(/<ChartTooltip\b/);
    expect(invCards).not.toMatch(/<ChartTooltip\b/);
  });

  it("neither line chart card file renders a bespoke vertical-guide line", () => {
    // Guard against a chapter re-inventing the guide inline. The
    // shared primitive draws the guide with the specific
    // "editorial-line-chart-guide" testid; nothing else should.
    expect(fbCards).not.toMatch(/editorial-line-chart-guide/);
    expect(invCards).not.toMatch(/editorial-line-chart-guide/);
  });
});
