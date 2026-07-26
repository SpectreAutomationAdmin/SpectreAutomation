// Founder rule 2026-07-13 v15.13 → v15.13.1 — viewport-triggered
// chart reveal, refined for later trigger + slower duration + reset-
// on-leave replay.
//
// This suite locks the shared "chart draws itself into place when it
// enters the viewport" behaviour at the source-contract level:
//
//   1. The primitive itself (`EditorialChartReveal`) exists as a
//      Client Component, wires an IntersectionObserver with dual
//      thresholds (enter ~0.65 / reset ~0.12), respects
//      `prefers-reduced-motion`, and accepts a serialisable
//      `EditorialChartRevealConfig` prop (no functions cross the
//      RSC boundary).
//
//   2. The shared CSS reveal animation duration is DATA — every
//      keyframe reads `var(--editorial-chart-reveal-duration,
//      1600ms)` so per-instance duration overrides work without
//      touching CSS.
//
//   3. Every chart primitive emits `chart-anim-*` classes on its
//      animated SVG elements; the CSS gate on the wrapper's
//      `data-editorial-chart-revealed` attribute activates them.
//
//   4. Each founder-named chart is wrapped in `<EditorialChartReveal>`
//      at its call site.
//
//   5. Reduced-motion users never trigger the observer AND the CSS
//      media-query defence-in-depth collapses every animation to a
//      no-op even if the attribute somehow flips.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

const revealSource = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/reporting/EditorialChartReveal.tsx"),
  "utf8",
);
const globalsCss = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/globals.css"),
  "utf8",
);
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
const donut = fs.readFileSync(
  path.resolve(process.cwd(), "src/components/reporting/EditorialDonut.tsx"),
  "utf8",
);

// ---------------------------------------------------------------------------
// 1) Shared wrapper — behavioural contract.
// ---------------------------------------------------------------------------
describe("v15.13.1 EditorialChartReveal — shared wrapper contract", () => {
  it("is a Client Component (\"use client\" directive on the first line)", () => {
    // The observer + context must run on the client; server-side
    // execution would break IntersectionObserver + hydration.
    expect(revealSource.split("\n")[0]).toMatch(/^"use client"/);
  });

  it("exports the shared context hook `useEditorialChartRevealState`", () => {
    expect(revealSource).toMatch(
      /export function useEditorialChartRevealState\(\)/,
    );
  });

  it("exports the serialisable `EditorialChartRevealConfig` type — every field a primitive", () => {
    // The config MUST carry only JSON-safe fields so it can be
    // handed across the RSC boundary. Guards against a future edit
    // that adds `onEnter?: () => void` or similar.
    const configMatch = revealSource.match(
      /export type EditorialChartRevealConfig = \{[\s\S]+?\n\};/,
    );
    expect(configMatch, "EditorialChartRevealConfig type must be exported").toBeTruthy();
    const configBlock = configMatch![0];
    expect(configBlock).toMatch(/enterThreshold\?:\s*number/);
    expect(configBlock).toMatch(/resetThreshold\?:\s*number/);
    expect(configBlock).toMatch(/durationMs\?:\s*number/);
    expect(configBlock).toMatch(/replayOnReenter\?:\s*boolean/);
    expect(configBlock).toMatch(/rootMargin\?:\s*string/);
    // No arrow / Function typing.
    expect(configBlock).not.toMatch(/=>/);
    expect(configBlock).not.toMatch(/\bFunction\b/);
  });

  it("provides a context defaulting to `revealed: true` so unwrapped charts stay visually identical to pre-v15.13", () => {
    expect(revealSource).toMatch(/createContext<EditorialChartRevealState>\(\{\s*revealed:\s*true\s*\}\)/);
  });

  it("consults `matchMedia('(prefers-reduced-motion: reduce)')` on mount", () => {
    expect(revealSource).toMatch(
      /matchMedia\("\(prefers-reduced-motion: reduce\)"\)/,
    );
  });

  it("skips the observer + reveals immediately when reduced-motion is preferred — reset behaviour is suppressed for reduced-motion users", () => {
    expect(revealSource).toMatch(/readsReducedMotion\(\)/);
    // The reduced-motion branch must call setRevealed(true) and
    // return WITHOUT installing an observer.
    expect(revealSource).toMatch(
      /if \(readsReducedMotion\(\)\) \{\s*setRevealed\(true\);\s*return;\s*\}/,
    );
  });

  it("installs an IntersectionObserver with BOTH thresholds so callbacks fire on either boundary crossing", () => {
    expect(revealSource).toMatch(/new IntersectionObserver/);
    // Threshold argument is an array built from resetThreshold +
    // enterThreshold — the array shape is what gives the observer
    // its dual-crossing behaviour.
    expect(revealSource).toMatch(
      /threshold:\s*thresholds/,
    );
    // The threshold set must include both bounds.
    expect(revealSource).toMatch(/Math\.max\(0,\s*Math\.min\(1,\s*resetThreshold\)\)/);
    expect(revealSource).toMatch(/Math\.max\(0,\s*Math\.min\(1,\s*enterThreshold\)\)/);
  });

  it("routes threshold crossings by CURRENT intersectionRatio (enter, reset, hold) — hysteresis is the founder's flicker guard", () => {
    // Enter — ratio >= enterThreshold → revealed = true.
    expect(revealSource).toMatch(
      /if \(ratio >= enterThreshold\)/,
    );
    // Reset — ratio <= resetThreshold AND replay allowed → revealed
    // = false. The && replayOnReenter guard is what makes replay
    // opt-out possible.
    expect(revealSource).toMatch(
      /else if \(replayOnReenter && ratio <= resetThreshold\)/,
    );
    // Exactly 4 setRevealed(...) call-sites are permitted:
    //   1. reduced-motion branch → true
    //   2. observer-unavailable branch → true
    //   3. enter branch → true
    //   4. reset branch → false
    // Any fifth call would suggest a bespoke third branch that
    // breaks the hysteresis band (which must PRESERVE current state).
    const setCalls = revealSource.match(/setRevealed\(/g) ?? [];
    expect(setCalls.length).toBe(4);
  });

  it("disconnects the observer on unmount so route transitions do not leak listeners", () => {
    expect(revealSource).toMatch(/return \(\) => \{[\s\S]+?observer\.disconnect\(\);\s*\};/);
  });

  it("default enter threshold is 0.65 (founder v15.13.1 — most of the chart visible before animating)", () => {
    expect(revealSource).toMatch(/DEFAULT_ENTER_THRESHOLD\s*=\s*0\.65/);
  });

  it("default reset threshold is 0.12 (founder v15.13.1 — hysteresis lower bound)", () => {
    expect(revealSource).toMatch(/DEFAULT_RESET_THRESHOLD\s*=\s*0\.12/);
  });

  it("default duration is 1600 ms (founder v15.13.1 — clearly observable, still restrained)", () => {
    expect(revealSource).toMatch(/DEFAULT_DURATION_MS\s*=\s*1600/);
  });

  it("default replay-on-reenter is TRUE (founder v15.13.1 — replay by default, opt-out available)", () => {
    expect(revealSource).toMatch(/DEFAULT_REPLAY_ON_REENTER\s*=\s*true/);
  });

  it("default rootMargin insulates the sticky report header via a negative top margin", () => {
    expect(revealSource).toMatch(/DEFAULT_ROOT_MARGIN\s*=\s*"-\d+px 0px 0px 0px"/);
  });

  it("threads `--editorial-chart-reveal-duration` inline on the root <div> so the CSS keyframes pick up the config", () => {
    // The custom property must be inline-styled onto the root — the
    // CSS keyframes read it via var(). If this regresses the CSS
    // falls back to its hardcoded default and the config override
    // silently no-ops.
    expect(revealSource).toMatch(/"--editorial-chart-reveal-duration"/);
    expect(revealSource).toMatch(/\$\{durationMs\}ms/);
  });

  it("stamps `data-editorial-chart-revealed` on the root <div> so the CSS gate can activate", () => {
    expect(revealSource).toMatch(/data-editorial-chart-revealed=\{revealed \? "true" : "false"\}/);
  });

  it("PROP TYPE carries no function fields (RSC serialisation guard from v15.12.1 continues to apply)", () => {
    const propsMatch = revealSource.match(/EditorialChartReveal\(\{\s*([\s\S]+?)\}\s*:\s*\{([\s\S]+?)\}\)/);
    expect(propsMatch, "EditorialChartReveal must destructure props").toBeTruthy();
    const propsBlock = propsMatch![2];
    // The only allowed prop types are `ReactNode`, the
    // EditorialChartRevealConfig object, and `string` — no `=>`
    // signatures anywhere.
    expect(propsBlock).not.toMatch(/=>/);
    expect(propsBlock).not.toMatch(/\bFunction\b/);
    // Explicit sanity checks on the allowed prop shape.
    expect(propsBlock).toMatch(/children:\s*ReactNode/);
    expect(propsBlock).toMatch(/config\?:\s*EditorialChartRevealConfig/);
    expect(propsBlock).toMatch(/testid\?:\s*string/);
  });
});

// ---------------------------------------------------------------------------
// 2) globals.css — keyframes + reveal gate + reduced-motion override.
// ---------------------------------------------------------------------------
describe("v15.13 globals.css chart-reveal block", () => {
  it("defines the four editorial reveal keyframes families", () => {
    expect(globalsCss).toMatch(/@keyframes editorial-chart-bar-grow-up/);
    expect(globalsCss).toMatch(/@keyframes editorial-chart-bar-grow-down/);
    expect(globalsCss).toMatch(/@keyframes editorial-chart-line-draw/);
    expect(globalsCss).toMatch(/@keyframes editorial-chart-marker-in/);
    expect(globalsCss).toMatch(/@keyframes editorial-chart-area-in/);
    expect(globalsCss).toMatch(/@keyframes editorial-chart-donut-sweep/);
  });

  it("gates each animation on `data-editorial-chart-revealed=\"true\"` (revealed state) and pins the pending state under `\"false\"`", () => {
    // Revealed gate — one selector per animation family.
    expect(globalsCss).toMatch(
      /\[data-editorial-chart-revealed="true"\][^{]*\.chart-anim-bar-up/,
    );
    expect(globalsCss).toMatch(
      /\[data-editorial-chart-revealed="true"\][^{]*\.chart-anim-bar-down/,
    );
    expect(globalsCss).toMatch(
      /\[data-editorial-chart-revealed="true"\][^{]*\.chart-anim-line/,
    );
    expect(globalsCss).toMatch(
      /\[data-editorial-chart-revealed="true"\][^{]*\.chart-anim-donut/,
    );
    // Pending gate — must exist so bars/lines are hidden before
    // the reveal fires.
    expect(globalsCss).toMatch(
      /\[data-editorial-chart-revealed="false"\][^{]*\.chart-anim-bar-up/,
    );
  });

  it("positive bars grow from transform-origin: bottom (upward), negative bars from transform-origin: top (downward)", () => {
    // Extract each bar-anim rule's origin.
    const upBlock = globalsCss.match(
      /\.chart-anim-bar-up\s*\{[\s\S]+?transform-origin:\s*bottom;[\s\S]+?\}/,
    );
    expect(upBlock, "chart-anim-bar-up must anchor at transform-origin: bottom").toBeTruthy();
    const downBlock = globalsCss.match(
      /\.chart-anim-bar-down\s*\{[\s\S]+?transform-origin:\s*top;[\s\S]+?\}/,
    );
    expect(downBlock, "chart-anim-bar-down must anchor at transform-origin: top").toBeTruthy();
  });

  it("line-draw uses stroke-dashoffset seeded via CSS var so any path length can animate L→R", () => {
    expect(globalsCss).toMatch(
      /stroke-dashoffset:\s*var\(--editorial-line-length,\s*1000\)/,
    );
  });

  it("every animation duration flows from `var(--editorial-chart-reveal-duration, 1600ms)` — configurable per-instance via the wrapper's inline style", () => {
    // Founder rule v15.13.1 — one source of truth for the duration.
    // Every hero animation (bars / line / area / donut) must read
    // the shared CSS variable so a wrapper config override actually
    // reaches them. Guards against a future edit that hardcodes a
    // number back into a specific keyframe rule.
    const heroFamilies = [
      "editorial-chart-bar-grow-up",
      "editorial-chart-bar-grow-down",
      "editorial-chart-line-draw",
      "editorial-chart-area-in",
    ];
    for (const family of heroFamilies) {
      const re = new RegExp(
        `animation:\\s*${family}\\s+var\\(--editorial-chart-reveal-duration,\\s*1600ms\\)`,
      );
      expect(globalsCss, `${family} must consume the shared duration variable`).toMatch(re);
    }
    // Marker + donut use a fractional derived value via `calc()`
    // — same variable, scaled to fit their reveal window.
    expect(globalsCss).toMatch(
      /editorial-chart-marker-in calc\(var\(--editorial-chart-reveal-duration,\s*1600ms\)\s*\*\s*0\.4\)/,
    );
    expect(globalsCss).toMatch(
      /editorial-chart-donut-sweep calc\(var\(--editorial-chart-reveal-duration,\s*1600ms\)\s*\*\s*0\.85\)/,
    );
  });

  it("default reveal duration in the CSS var fallback is 1600 ms (founder v15.13.1)", () => {
    // Even if the wrapper regresses and stops setting the property,
    // the CSS var fallback must land at the founder-approved
    // duration — never dropping back to the pre-v15.13.1 timing.
    expect(globalsCss).toMatch(/var\(--editorial-chart-reveal-duration,\s*1600ms\)/);
  });

  it("uses a standard ease-out cubic-bezier curve, not an elastic/overshoot curve", () => {
    expect(globalsCss).toMatch(/cubic-bezier\(0\.22,\s*1,\s*0\.36,\s*1\)/);
    // No back/elastic curves that the founder ruled out.
    expect(globalsCss).not.toMatch(/cubic-bezier\(0\.68,\s*-0\.55/);
  });

  it("uses `animation-fill-mode: both` (via the shorthand `both`) so the reveal holds its final frame while visible", () => {
    // The `both` fill-mode holds the ending frame after the animation
    // completes. When the wrapper later resets the attribute back to
    // `false` (v15.13.1 replay), the pending CSS rule takes over and
    // snaps the element back to the pre-draw state.
    expect(globalsCss).toMatch(
      /animation:[^;]+cubic-bezier\([^)]+\)\s+both;/,
    );
  });

  it("collapses to a no-op under `@media (prefers-reduced-motion: reduce)`", () => {
    // Must scope reduced-motion overrides so animation drops out AND
    // every chart element becomes immediately visible in its final
    // frame.
    const rm = globalsCss.match(
      /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[\s\S]+?\}\s*\}/,
    );
    expect(rm, "reduced-motion media block must exist").toBeTruthy();
    const block = rm![0];
    expect(block).toMatch(/animation:\s*none/);
    // Bars, lines, markers, areas, donut all get their neutralised
    // final state.
    expect(block).toMatch(/transform:\s*none/);
    expect(block).toMatch(/stroke-dashoffset:\s*0/);
    expect(block).toMatch(/opacity:\s*1/);
  });
});

// ---------------------------------------------------------------------------
// 3) Chart primitives — emit the shared animation classes.
// ---------------------------------------------------------------------------
describe("v15.13 EditorialLineChart emits reveal classes on its animated SVG elements", () => {
  it("tags solid line paths with `chart-anim-line` (draws L→R via stroke-dashoffset)", () => {
    expect(lineChart).toMatch(/chart-anim-line/);
    // Dashed reference lines opt out of the L→R draw and instead
    // fade in via `chart-anim-area` so the dash pattern stays crisp.
    expect(lineChart).toMatch(/chart-anim-area/);
  });

  it("tags markers with `chart-anim-marker` and staggers them across the reveal window", () => {
    expect(lineChart).toMatch(/chart-anim-marker/);
    // Per-marker `animationDelay` is what produces the "markers
    // appear as the line reaches each point" effect the founder
    // spec calls out.
    expect(lineChart).toMatch(/animationDelay:\s*`\$\{delayMs\}ms`/);
  });

  it("tags area fills with `chart-anim-area` (opacity fade coordinated with the line draw)", () => {
    // The area fill class is applied to the <path> that emits the
    // area beneath the line — visible via the concatenated class
    // string containing the areaFill Tailwind class + the anim class.
    expect(lineChart).toMatch(/line\.areaFill\} chart-anim-area/);
  });

  it("seeds `--editorial-line-length` inline on solid line paths from the exact plotted geometry", () => {
    // The primitive computes path length from segment geometry
    // (Euclidean distance sum) and threads it into the CSS var.
    expect(lineChart).toMatch(/const lineLength = /);
    expect(lineChart).toMatch(/"--editorial-line-length"/);
  });

  it("does NOT re-render or gate on any JS-level `revealed` state (the CSS attribute gate is the single source of truth)", () => {
    // Guard: the primitive must NOT consume the reveal context hook.
    // If it did, hidden hydration mismatches become possible when
    // the client toggles `revealed` at a different frame than the
    // parent wrapper.
    expect(lineChart).not.toMatch(/useEditorialChartRevealState/);
  });
});

describe("v15.13 EditorialBarChart emits reveal classes on positive + negative bars", () => {
  it("positive bars grow upward via `chart-anim-bar-up`, negative bars grow downward via `chart-anim-bar-down`", () => {
    expect(barChart).toMatch(/chart-anim-bar-up/);
    expect(barChart).toMatch(/chart-anim-bar-down/);
    // The sign-of-value decision must produce distinct classes.
    expect(barChart).toMatch(/v >= 0 \? "chart-anim-bar-up" : "chart-anim-bar-down"/);
  });

  it("secondary (budget) bars inherit the same growth direction as their sign", () => {
    expect(barChart).toMatch(/secondary[\s\S]+?chart-anim-bar-up/);
  });

  it("dashed overlay line fades in via `chart-anim-area` (no stroke-dashoffset draw over an existing dash pattern)", () => {
    expect(barChart).toMatch(/overlay\.stroke\} chart-anim-area/);
  });
});

describe("v15.13 EditorialGroupedBarChart emits sign-aware reveal classes with per-series stagger", () => {
  it("uses `chart-anim-bar-up` / `chart-anim-bar-down` by sign", () => {
    expect(groupedBarChart).toMatch(
      /v >= 0 \? "chart-anim-bar-up" : "chart-anim-bar-down"/,
    );
  });

  it("staggers series by a per-series delay inside the founder's 75–125 ms editorial window", () => {
    // Per-series delay based on sIdx. v15.13.1 raised the stagger
    // to 100 ms (up from the initial 55 ms) so the founder's
    // "75–125 ms" window is honoured. Guard: any value outside the
    // window is a regression.
    const staggerMatch = groupedBarChart.match(/const delayMs = sIdx \* (\d+)/);
    expect(staggerMatch, "grouped bar chart must set a numeric per-series stagger").toBeTruthy();
    const stagger = Number(staggerMatch![1]);
    expect(
      stagger >= 75 && stagger <= 125,
      `grouped bar stagger ${stagger} ms must sit in the founder's 75–125 ms window`,
    ).toBe(true);
    expect(groupedBarChart).toMatch(/animationDelay:\s*`\$\{delayMs\}ms`/);
  });
});

describe("v15.13 EditorialDonut sweeps its segments into place from a consistent starting angle", () => {
  it("wraps BOTH render modes in a single `<g className=\"chart-anim-donut\">` so per-slice + arcAngles behave identically", () => {
    expect(donut).toMatch(/<g className="chart-anim-donut">/);
  });
});

// ---------------------------------------------------------------------------
// 4) Call sites — every founder-named chart is wrapped in
//    `<EditorialChartReveal>`.
// ---------------------------------------------------------------------------
type CallSite = {
  label: string;
  relPath: string;
  /** Substring inside the wrapped chart's JSX (near the opening tag
   *  of the chart primitive) — used to grep for the wrapping
   *  `EditorialChartReveal` in the same block. */
  anchor: string;
  /** Optional testid on the reveal wrapper itself. */
  revealTestid?: string;
};

const CHARTS: ReadonlyArray<CallSite> = [
  {
    label: "Equity Value Over Time",
    relPath: "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx",
    anchor: "Club Equity",
    revealTestid: "stewardship-equity-reveal",
  },
  {
    label: "Operating Results — 12-Month Rolling Trend",
    relPath: "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx",
    anchor: "stewardship-operating-reveal",
    revealTestid: "stewardship-operating-reveal",
  },
  {
    label: "YTD Payroll by Department",
    relPath: "src/app/app/admin/reporting/monthly/PayrollChartCards.tsx",
    anchor: "payroll-grouped-bar-chart-reveal",
    revealTestid: "payroll-grouped-bar-chart-reveal",
  },
  {
    label: "YTD Variance by Department",
    relPath: "src/app/app/admin/reporting/monthly/PayrollChartCards.tsx",
    anchor: "payroll-variance-bar-chart-reveal",
    revealTestid: "payroll-variance-bar-chart-reveal",
  },
  {
    label: "Payroll Distribution — Where Does the Dollar Go?",
    relPath: "src/app/app/admin/reporting/monthly/PayrollChartCards.tsx",
    anchor: "payroll-distribution-donut-reveal",
    revealTestid: "payroll-distribution-donut-reveal",
  },
  {
    label: "Monthly F&B Revenue vs. Cost",
    relPath: "src/app/app/admin/reporting/monthly/FoodBeverageChartCards.tsx",
    anchor: "fb-monthly-revenue-cost-chart-reveal",
    revealTestid: "fb-monthly-revenue-cost-chart-reveal",
  },
  {
    label: "Food Cost % by Month",
    relPath: "src/app/app/admin/reporting/monthly/FoodBeverageChartCards.tsx",
    anchor: "fb-food-cost-line-chart-reveal",
    revealTestid: "fb-food-cost-line-chart-reveal",
  },
  {
    label: "Revenue by Category",
    relPath: "src/app/app/admin/reporting/monthly/FoodBeverageChartCards.tsx",
    anchor: "fb-category-donut-reveal",
    revealTestid: "fb-category-donut-reveal",
  },
  {
    label: "Inventory Turnover by Category",
    relPath: "src/app/app/admin/reporting/monthly/InventoryChartCards.tsx",
    anchor: "inv-turnover-chart-reveal",
    revealTestid: "inv-turnover-chart-reveal",
  },
  {
    label: "F&B Inventory Balances — Monthly",
    relPath: "src/app/app/admin/reporting/monthly/InventoryChartCards.tsx",
    anchor: "inv-balances-chart-reveal",
    revealTestid: "inv-balances-chart-reveal",
  },
];

describe("v15.13 every founder-named chart is wrapped in <EditorialChartReveal>", () => {
  for (const chart of CHARTS) {
    it(chart.label, () => {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), chart.relPath),
        "utf8",
      );
      expect(source).toContain(chart.anchor);
      if (chart.revealTestid) {
        // Each wrapper carries a distinct testid so Playwright / DOM
        // queries can select the exact chart under test.
        expect(source).toMatch(
          new RegExp(
            `<EditorialChartReveal[^>]*testid="${chart.revealTestid.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}"`,
          ),
        );
      }
    });
  }

  it("all three chart-card modules import the shared EditorialChartReveal wrapper", () => {
    for (const relPath of [
      "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx",
      "src/app/app/admin/reporting/monthly/FoodBeverageChartCards.tsx",
      "src/app/app/admin/reporting/monthly/InventoryChartCards.tsx",
      "src/app/app/admin/reporting/monthly/PayrollChartCards.tsx",
    ]) {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), relPath),
        "utf8",
      );
      expect(source).toMatch(
        /import \{ EditorialChartReveal \} from "@\/components\/reporting\/EditorialChartReveal"/,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 5) No functions crossing the RSC boundary — the v15.12.1 guard
//    stays in force. The reveal wrapper is a Client Component so the
//    primitive itself must NEVER emit a function child spec / callback
//    that would require a serialisable-descriptor override.
// ---------------------------------------------------------------------------
describe("v15.13 EditorialChartReveal does not carry any callback / render-prop children API", () => {
  it("children are typed as `ReactNode` — no `(state) => ReactNode` render-prop shape", () => {
    // A render-prop children API would forcibly cross the RSC
    // boundary since the callback is a function. The wrapper API is
    // deliberately children-as-ReactNode + context-based reveal
    // dispatch so nothing beyond primitive React node types is ever
    // handed across.
    expect(revealSource).not.toMatch(/children:\s*\([^)]*\)\s*=>/);
    expect(revealSource).not.toMatch(/render:\s*\(/);
  });
});

// ---------------------------------------------------------------------------
// 6) v15.13.1 acceptance criteria — direction-agnostic replay,
//    hysteresis, and reduced-motion never-resets. Each acceptance
//    line from the founder's message has an explicit assertion so a
//    future regression fires with a clear "acceptance criterion X
//    broke" error.
// ---------------------------------------------------------------------------
describe("v15.13.1 acceptance criteria — replay + hysteresis + reduced-motion contract", () => {
  it("AC: animation does not begin until MOST of the chart is visible (default enter ≥ 0.60)", () => {
    // Founder message: "Trigger when the chart is substantially
    // inside the viewport" and "Prefer approximately 65% visible
    // as the shared default."
    expect(revealSource).toMatch(/DEFAULT_ENTER_THRESHOLD\s*=\s*0\.(6\d|70)/);
  });

  it("AC: scrolling completely away resets the chart, returning replays it (replayOnReenter default TRUE)", () => {
    // The replay behaviour is opt-out, not opt-in — every wrapped
    // chart gets replay by default.
    expect(revealSource).toMatch(/DEFAULT_REPLAY_ON_REENTER\s*=\s*true/);
    // Reset branch executes only when the threshold is below the
    // reset value AND replay is enabled. The block body may carry
    // comments; only the setRevealed(false) call matters.
    expect(revealSource).toMatch(
      /else if \(replayOnReenter && ratio <= resetThreshold\) \{[\s\S]*?setRevealed\(false\);/,
    );
  });

  it("AC: small scroll movements near the trigger point do not restart the animation — hysteresis is enforced", () => {
    // Enter and reset thresholds MUST be different (hysteresis).
    expect(revealSource).toMatch(/DEFAULT_ENTER_THRESHOLD\s*=\s*0\.65/);
    expect(revealSource).toMatch(/DEFAULT_RESET_THRESHOLD\s*=\s*0\.12/);
    // The gap between them is where the state HOLDS. No third
    // setRevealed(...) call inside the hysteresis band — the observer
    // callback preserves the current state when the ratio lands
    // between the two thresholds.
    const inCallback = revealSource.match(
      /new IntersectionObserver\(\s*\(entries\) => \{[\s\S]+?\},\s*\{ threshold:/,
    );
    expect(inCallback, "IntersectionObserver callback body must be findable").toBeTruthy();
    const body = inCallback![0];
    // Exactly two setRevealed calls in the callback: one for enter,
    // one for reset. The hold path takes neither.
    const setInCallback = body.match(/setRevealed\(/g) ?? [];
    expect(setInCallback.length).toBe(2);
  });

  it("AC: reduced-motion users never see the chart reset — the observer is not installed", () => {
    // The reduced-motion early return happens BEFORE
    // `new IntersectionObserver(...)`, which means those users
    // never have a reset path to trip. Guard: the observer creation
    // must live AFTER the reduced-motion / no-IntersectionObserver
    // early-return branches.
    const readsIndex = revealSource.indexOf("readsReducedMotion()");
    const observerIndex = revealSource.indexOf("new IntersectionObserver");
    expect(readsIndex).toBeGreaterThan(-1);
    expect(observerIndex).toBeGreaterThan(-1);
    expect(readsIndex).toBeLessThan(observerIndex);
  });

  it("AC: reset returns the chart to the unplotted starting state (CSS pending rule pins the pre-draw frame)", () => {
    // The pending state selector must set transform-origin +
    // scale=0 on bars, seed the line stroke-dashoffset, and
    // opacity=0 on markers / area / donut. This is what the reset
    // path snaps back to.
    expect(globalsCss).toMatch(
      /data-editorial-chart-revealed="false"[^{]*\.chart-anim-bar-up\s*\{[\s\S]+?transform:\s*scaleY\(0\);/,
    );
    expect(globalsCss).toMatch(
      /data-editorial-chart-revealed="false"[^{]*\.chart-anim-line\s*\{[\s\S]+?stroke-dashoffset:\s*var\(--editorial-line-length/,
    );
  });

  it("AC: sticky report header is accounted for via a negative top rootMargin default", () => {
    expect(revealSource).toMatch(/DEFAULT_ROOT_MARGIN\s*=\s*"-\d+px 0px 0px 0px"/);
  });

  it("AC: the shared config type accepts serialisable configuration only", () => {
    // Guard against the founder's explicit example:
    //   { enterThreshold, resetThreshold, durationMs, replayOnReenter }
    // Every field must be a bare primitive.
    const configMatch = revealSource.match(
      /export type EditorialChartRevealConfig = \{[\s\S]+?\n\};/,
    );
    expect(configMatch).toBeTruthy();
    const configBlock = configMatch![0];
    // Extract each field's declared type.
    const fieldTypes = [...configBlock.matchAll(/\s(\w+)\?:\s*([^;]+);/g)];
    expect(fieldTypes.length).toBeGreaterThanOrEqual(5);
    for (const [, name, type] of fieldTypes) {
      const t = type.trim();
      const primitive = /^(number|string|boolean)$/.test(t);
      expect(
        primitive,
        `EditorialChartRevealConfig.${name} must be a JSON-serialisable primitive; got "${t}"`,
      ).toBe(true);
    }
  });
});
