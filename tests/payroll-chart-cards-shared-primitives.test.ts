// Founder rule 2026-07-05 v15.6 — Payroll Analysis charts must
// consume the SAME editorial chart primitives + tokens as Equity
// Value Over Time + Operating Results, so the four Payroll cards
// read as part of one editorial reporting package.
//
// This suite locks the shape of `PayrollChartCards.tsx` at the
// source-contract level: what it imports, what it renders, what
// it does NOT contain (bespoke SVG constants, inline hex colors,
// hand-rolled tooltips, per-chapter typography).

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const payrollCards = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/reporting/monthly/PayrollChartCards.tsx",
  ),
  "utf8",
);

describe("v15.6 PayrollChartCards imports the SHARED editorial primitives", () => {
  it("imports EditorialGroupedBarChart (used for Chart 1 + Chart 4)", () => {
    expect(payrollCards).toMatch(
      /import \{ EditorialGroupedBarChart \} from "@\/components\/reporting\/EditorialGroupedBarChart"/,
    );
  });

  it("imports EditorialBarChart (used for Chart 2 — diverging variance, same primitive as Operating Results)", () => {
    expect(payrollCards).toMatch(
      /import \{ EditorialBarChart \} from "@\/components\/reporting\/EditorialBarChart"/,
    );
  });

  it("imports EditorialDonut (used for Chart 3, same primitive as Financial Performance)", () => {
    expect(payrollCards).toMatch(
      /import \{ EditorialDonut(, [^}]+)? \} from "@\/components\/reporting\/EditorialDonut"/,
    );
  });

  // v15.8 — CHART_COLORS import retired because the bar palette
  // now uses canonical Tailwind classes (`fill-club-green-500` +
  // `fill-club-gold`) that Tailwind's JIT scanner can compile.
  // Interpolated `fill-[${CHART_COLORS.actual}]` strings produced
  // black bars because JIT couldn't reach them.
});

describe("v15.6 PayrollChartCards drops the pre-v15.6 bespoke SVG / tooltip / typography surfaces", () => {
  it("does NOT render its own <svg viewBox=\"…\"> tag (SVGs live inside shared primitives now)", () => {
    // Pre-v15.6 had four `viewBox={\`0 0 520 240\`}` SVG roots.
    // v15.6 delegates every SVG to the shared primitives — the
    // Payroll file itself carries none.
    expect(payrollCards).not.toMatch(/<svg\b/);
  });

  it("does NOT declare bespoke donut geometry constants (radius / stroke sourced from DONUT_GEOMETRY)", () => {
    expect(payrollCards).not.toMatch(/const radius\s*=\s*80/);
    expect(payrollCards).not.toMatch(/const restStroke\s*=\s*36/);
    expect(payrollCards).not.toMatch(/const activeStroke\s*=\s*44/);
  });

  it("does NOT carry bespoke tooltip Tailwind classes (uses shared ChartTooltip via EditorialDonut)", () => {
    // Pre-v15.6 had a local ChartTooltip component with these
    // exact classes. v15.6 delegates to the shared component.
    expect(payrollCards).not.toMatch(/bg-club-green-900\/85/);
    expect(payrollCards).not.toMatch(/tracking-\[0\.18em\]/);
  });

  it("does NOT hardcode axis-label font sizes on any SVG text (typography flows from CHART_AXES via primitives)", () => {
    // The pre-v15.6 charts used e.g. `fontSize="9"` inline on
    // hand-rolled SVG. Everything now flows through the shared
    // primitives' CHART_AXES consumption.
    expect(payrollCards).not.toMatch(/fontSize="9"/);
    expect(payrollCards).not.toMatch(/fontSize="9\.5"/);
    expect(payrollCards).not.toMatch(/fontSize="10"/);
  });

  it("does NOT contain inline hex colors on chart glyphs (only card commentary background uses inline rgba, which is preserved)", () => {
    // The palette hex constants (`#5b8c5f`, `#d8c39a`, `#3a4b3a`,
    // `#5b6c5a`, `#6b5028`, `#e6dcc4`) that decorated the
    // pre-v15.6 SVGs are gone. The donut's slice fills still
    // arrive as fillHex from the service — that's expected because
    // the service owns the brand palette per department. The
    // Payroll component itself carries none of the axis / gridline /
    // stroke hex bytes.
    expect(payrollCards).not.toMatch(/#5b8c5f/);
    expect(payrollCards).not.toMatch(/#d8c39a/);
    expect(payrollCards).not.toMatch(/#e6dcc4/);
    expect(payrollCards).not.toMatch(/#6b5028/);
    // The clay negative accent `#8b3520` is preserved because it
    // matches the Operating Results negative fill exactly (both
    // charts must diverge to the SAME red). Left in the source
    // as a deliberate mirror of Operating Results' negativeFill.
  });
});

describe("v15.6 PayrollChartCards binds the four cards to the correct shared primitive with editorial padding", () => {
  it("Chart 1 + Chart 4 use EditorialGroupedBarChart with padLeft=44 + padRight=14 (Equity + Operating alignment)", () => {
    expect(payrollCards).toMatch(/<EditorialGroupedBarChart\b/);
    expect(payrollCards).toMatch(/padLeft=\{44\}/);
    expect(payrollCards).toMatch(/padRight=\{14\}/);
  });

  it("Chart 2 uses EditorialBarChart with diverging positiveFill/negativeFill (mirrors Operating Results byte-for-byte)", () => {
    expect(payrollCards).toMatch(/<EditorialBarChart\b/);
    expect(payrollCards).toMatch(/positiveFill:\s*"fill-club-green-500"/);
    expect(payrollCards).toMatch(/negativeFill:\s*"fill-\[#8b3520\]"/);
  });

  it("Chart 3 delegates to EditorialDonut with a testidPrefix", () => {
    expect(payrollCards).toMatch(/<EditorialDonut\b/);
    expect(payrollCards).toMatch(/testidPrefix="payroll-distribution-donut"/);
    expect(payrollCards).toMatch(/buildTooltip=/);
  });

  it("every bar chart uses the canonical chart-band height 245 (matches Equity chart-dominant band)", () => {
    // Three bar charts (Chart 1 + Chart 2 + Chart 4) each ship
    // height={245}. The donut (Chart 3) has its own 200×200
    // viewBox owned by DONUT_GEOMETRY and does not carry a
    // height={245} prop. Regex counts occurrences.
    const matches = payrollCards.match(/height=\{245\}/g);
    expect(matches, "expected at least 3 bar charts at height=245").not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(3);
  });
});

describe("v15.6/v15.8 PayrollChartCards card chrome + commentary match Stewardship treatment", () => {
  it("v15.8 — every card carries the Stewardship-style dark green header slab (bg-club-green-900, 76 px, 12/18/12/18 padding)", () => {
    // Prior (v15.6) the header sat on a cream body. v15.8 replaces
    // it with the dark green editorial header identical to the
    // Stewardship card's title slab (Chapter II reference).
    expect(payrollCards).toMatch(/bg-club-green-900/);
    expect(payrollCards).toMatch(/height:\s*76/);
    expect(payrollCards).toMatch(/paddingLeft:\s*18/);
    expect(payrollCards).toMatch(/paddingRight:\s*18/);
  });

  it("v15.8 — header title uses the Stewardship 17 px serif cream treatment", () => {
    expect(payrollCards).toMatch(/fontSize:\s*"17px"/);
    expect(payrollCards).toMatch(/font-serif text-club-cream/);
  });

  it("v15.8 — header subtitle uses uppercase 10.5 px + 0.7 letter-spacing on cream/70 (matches Stewardship subtitle byte-for-byte)", () => {
    expect(payrollCards).toMatch(/fontSize:\s*"10\.5px"/);
    expect(payrollCards).toMatch(/letterSpacing:\s*"0\.7px"/);
    expect(payrollCards).toMatch(/uppercase text-club-cream\/70/);
  });

  it("v15.8 — header carries the gold-pill chapter badge on the right (matches Stewardship chip)", () => {
    // border-club-gold/30 + text-club-gold + rounded-full is the
    // Stewardship chip treatment. Every card renders one.
    expect(payrollCards).toMatch(/border-club-gold\/30/);
    expect(payrollCards).toMatch(/rounded-full/);
    expect(payrollCards).toMatch(/text-club-gold/);
  });

  it("v15.8 — every chart card renders an executive commentary block beneath the visualization", () => {
    // Four callout testids — one per chart — so every chart has
    // an executive commentary panel as the founder requires.
    expect(payrollCards).toMatch(/data-testid="payroll-grouped-callout"/);
    expect(payrollCards).toMatch(/data-testid="payroll-variance-callout"/);
    expect(payrollCards).toMatch(/data-testid="payroll-distribution-callout"/);
    expect(payrollCards).toMatch(/data-testid="payroll-stacked-callout"/);
    // Each commentary references its data-source callout — the
    // reporting service owns the narrative, React renders the
    // pre-formatted string.
    expect(payrollCards).toMatch(/charts\.callouts\.breakdown\.text/);
    expect(payrollCards).toMatch(/charts\.callouts\.variance\.text/);
    expect(payrollCards).toMatch(/charts\.callouts\.distribution\.text/);
    expect(payrollCards).toMatch(/charts\.callouts\.wagesVsTaxes\.text/);
  });

  it("commentary block reproduces the Stewardship green-wash + 3-px accent border byte-for-byte", () => {
    // Same three keys the Stewardship card sets on its inset
    // commentary block. Any drift here means Payroll callouts are
    // visually different from the Stewardship commentary card.
    expect(payrollCards).toMatch(/padding:\s*"10px 14px"/);
    expect(payrollCards).toMatch(
      /backgroundColor:\s*"rgba\(63,\s*112,\s*66,\s*0\.10\)"/,
    );
    expect(payrollCards).toMatch(
      /borderLeft:\s*"3px solid rgba\(63,\s*112,\s*66,\s*0\.55\)"/,
    );
  });

  it("v15.8 — grouped bar chart uses the canonical `fill-club-green-500` + `fill-club-gold` palette (no interpolated `fill-[…]` strings that Tailwind's JIT scanner can't compile)", () => {
    // The founder's specific complaint: the YTD Actual vs Budget
    // chart was rendering both series in black. Root cause was
    // `color: \`fill-[${CHART_COLORS.actual}]\`` — Tailwind's JIT
    // scanner reads source files at build time and can't resolve
    // an interpolated template literal to a class name. Both
    // grouped bar charts (Chart 1 + Chart 4) now use literal
    // Tailwind classes that JIT can compile.
    expect(payrollCards).toMatch(/color:\s*"fill-club-green-500"/);
    expect(payrollCards).toMatch(/color:\s*"fill-club-gold"/);
    // Guard against regression to the interpolated form. The bar
    // `color:` prop must be a literal string — never a template
    // literal that references CHART_COLORS.
    expect(payrollCards).not.toMatch(/color:\s*`fill-\[/);
  });
});
