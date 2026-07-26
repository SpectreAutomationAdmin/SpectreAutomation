// Founder rule 2026-07-13 v15.13.2 — coverage safeguard for the
// shared viewport-triggered chart reveal.
//
// Root cause of the pre-v15.13.2 miss: charts landed in the Monthly
// Reporting Package that either
//
//   (a) consumed the shared editorial chart primitives
//       (`EditorialBarChart`, `EditorialGroupedBarChart`,
//       `EditorialLineChart`, `EditorialDonut`) but forgot to wrap
//       their call site in `<EditorialChartReveal>` — the CSS gate
//       is inert without an ancestor `data-editorial-chart-revealed`
//       attribute, so the chart-anim-* classes never fire; OR
//
//   (b) rendered through a BESPOKE primitive (`DuesSubsidyDonut`,
//       `EditorialInteractiveBarChart`) that didn't emit any of the
//       shared `chart-anim-*` classes at all — wrapping the call
//       site would still leave the chart un-animated because the
//       CSS gate has nothing to activate.
//
// This suite prevents both failure modes from returning:
//
//   1. Every chart-primitive JSX opening tag in
//      `src/app/app/admin/reporting/monthly/**` must be inside an
//      open `<EditorialChartReveal>` at the same file scope.
//   2. Any BESPOKE primitive that a reporting file renders must emit
//      the shared `chart-anim-*` classes in its own source so the
//      reveal wrapper actually animates it.
//   3. No reporting file may import a raw external chart library
//      (`recharts`, `chart.js`, `victory`, `d3`, etc.) — every
//      chart must flow through a shared editorial primitive.

import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

// -----------------------------------------------------------------
// The set of source files that host chart JSX in the Monthly
// Reporting Package. This list is walked exhaustively; a new file in
// the same directory tree will fail the "chart primitives inside a
// reveal wrapper" assertion below the moment it introduces a bare
// primitive.
// -----------------------------------------------------------------
const REPORTING_MONTHLY_ROOT = path.resolve(
  process.cwd(),
  "src/app/app/admin/reporting/monthly",
);

/** Recursively list every `.tsx` file under a directory. */
function walkTsx(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkTsx(abs));
    } else if (entry.isFile() && abs.endsWith(".tsx")) {
      out.push(abs);
    }
  }
  return out;
}

// The seven primitives every editorial chart is allowed to consume.
// Anything else in the reporting tree is either a helper wrapper
// (StewardshipCard, FpChartCard) — which does NOT need to be
// reveal-wrapped because it's chrome, not a chart — or a bespoke
// primitive we've already taught to emit the shared reveal classes.
const CHART_PRIMITIVES = [
  "EditorialBarChart",
  "EditorialGroupedBarChart",
  "EditorialLineChart",
  "EditorialDonut",
  "EditorialInteractiveBarChart",
  "DuesSubsidyDonut",
] as const;

// Bespoke primitives — must emit the shared reveal classes so a
// wrapping `<EditorialChartReveal>` actually animates them. Shared
// primitives (EditorialBarChart etc.) already do this by design and
// are covered by tests/editorial-chart-reveal.test.ts.
const BESPOKE_PRIMITIVES: ReadonlyArray<{
  label: string;
  relPath: string;
  requiredClass: string;
}> = [
  {
    label: "DuesSubsidyDonut (Dues Subsidy Analysis card)",
    relPath: "src/components/reporting/DuesSubsidyDonut.tsx",
    requiredClass: "chart-anim-donut",
  },
  {
    label: "EditorialInteractiveBarChart (Weather vs. Golf Rounds card)",
    relPath: "src/components/reporting/EditorialInteractiveBarChart.tsx",
    requiredClass: "chart-anim-bar-up",
  },
];

/** For each `<Primitive` opening tag in `source`, walk backward
 *  counting unclosed `<EditorialChartReveal` opening tags. Returns
 *  every occurrence whose depth === 0 (i.e. the primitive renders
 *  OUTSIDE a reveal wrapper). */
function findBarePrimitiveCallSites(
  source: string,
  primitive: string,
): Array<{ index: number; line: number }> {
  const out: Array<{ index: number; line: number }> = [];
  const primRe = new RegExp(`<${primitive}(?:\\b|[\\s/>])`, "g");
  let m: RegExpExecArray | null;
  while ((m = primRe.exec(source)) !== null) {
    const primIndex = m.index;
    const upto = source.slice(0, primIndex);
    // Count `<EditorialChartReveal` opening tags that have not yet
    // been paired with a `</EditorialChartReveal>` closing tag. Both
    // patterns are self-explanatory JSX tokens; nothing else in the
    // reporting tree accidentally matches them.
    const opens = (upto.match(/<EditorialChartReveal\b/g) ?? []).length;
    const closes = (upto.match(/<\/EditorialChartReveal>/g) ?? []).length;
    const depth = opens - closes;
    if (depth <= 0) {
      const line = upto.split("\n").length;
      out.push({ index: primIndex, line });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 1) Every chart-primitive JSX opening tag lives inside an
//    <EditorialChartReveal> wrapper.
// ---------------------------------------------------------------------------
describe("v15.13.2 no bare chart-primitive call site in the Monthly Reporting Package", () => {
  const files = walkTsx(REPORTING_MONTHLY_ROOT);

  // Root cause of the founder's audit finding — enumerate the
  // charts we're actually protecting so a regression traces back to
  // a specific chart, not a mysterious file/line.
  const NAMED_TESTIDS = [
    // v15.13 initial set (10)
    "stewardship-equity-reveal",
    "stewardship-operating-reveal",
    "payroll-grouped-bar-chart-reveal",
    "payroll-variance-bar-chart-reveal",
    "payroll-distribution-donut-reveal",
    "fb-monthly-revenue-cost-chart-reveal",
    "fb-food-cost-line-chart-reveal",
    "fb-category-donut-reveal",
    "inv-turnover-chart-reveal",
    "inv-balances-chart-reveal",
    // v15.13.2 audit fix (7 additions)
    "dues-subsidy-analysis-reveal",
    "payroll-department-breakdown-reveal",
    "payroll-ratio-trend-reveal",
    "mws-pattern-reveal",
    "mws-rounds-reveal",
    "payroll-stacked-bar-chart-reveal",
    "fb-monthly-covers-chart-reveal",
  ] as const;

  it("scans every .tsx under the monthly reporting root — at least the founder's named 17 charts are present", () => {
    // Sanity check on the walker itself.
    expect(files.length).toBeGreaterThan(3);
  });

  for (const primitive of CHART_PRIMITIVES) {
    it(`no bare <${primitive}> — every occurrence must be inside <EditorialChartReveal>`, () => {
      const bare: string[] = [];
      for (const file of files) {
        const source = fs.readFileSync(file, "utf8");
        const rels = path.relative(process.cwd(), file);
        const sites = findBarePrimitiveCallSites(source, primitive);
        for (const s of sites) {
          bare.push(`${rels}:${s.line}`);
        }
      }
      expect(
        bare,
        `Bare <${primitive}> found — wrap each in <EditorialChartReveal testid="…">. ` +
          `The v15.13.2 audit added exactly this guard so the reveal system can't ` +
          `silently omit a chart again. Bare call sites:\n  ${bare.join("\n  ")}`,
      ).toEqual([]);
    });
  }

  it("every founder-named chart wrapper testid is present somewhere in the monthly reporting tree", () => {
    const missing: string[] = [];
    // Concatenate every file's source once — cheap for ~15 files —
    // then scan for each expected testid.
    const wholeTree = files
      .map((file) => fs.readFileSync(file, "utf8"))
      .join("\n");
    for (const id of NAMED_TESTIDS) {
      if (!wholeTree.includes(`testid="${id}"`)) missing.push(id);
    }
    expect(
      missing,
      `Missing reveal-wrapper testids for founder-named charts:\n  ${missing.join("\n  ")}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 2) BESPOKE primitives emit the shared reveal classes so wrapping
//    their call sites actually animates them.
// ---------------------------------------------------------------------------
describe("v15.13.2 bespoke chart primitives emit the shared reveal classes", () => {
  for (const b of BESPOKE_PRIMITIVES) {
    it(`${b.label} emits "${b.requiredClass}"`, () => {
      const source = fs.readFileSync(
        path.resolve(process.cwd(), b.relPath),
        "utf8",
      );
      expect(
        source,
        `${b.relPath} must include class "${b.requiredClass}" on its animated ` +
          `SVG element(s) so a wrapping <EditorialChartReveal> can activate the ` +
          `shared CSS keyframes.`,
      ).toMatch(new RegExp(`\\b${b.requiredClass}\\b`));
    });
  }
});

// ---------------------------------------------------------------------------
// 3) No reporting file imports a raw external chart library.
// ---------------------------------------------------------------------------
describe("v15.13.2 no raw external chart library used in the Monthly Reporting Package", () => {
  const files = walkTsx(REPORTING_MONTHLY_ROOT);
  const FORBIDDEN_MODULES = [
    "recharts",
    "chart.js",
    "react-chartjs-2",
    "victory",
    "d3",
    "d3-array",
    "d3-scale",
    "d3-shape",
    "@nivo",
    "apexcharts",
    "highcharts",
  ] as const;

  for (const mod of FORBIDDEN_MODULES) {
    it(`no reporting file imports "${mod}" — every chart must flow through a shared editorial primitive`, () => {
      const offenders: string[] = [];
      const re = new RegExp(
        `from\\s+["']${mod.replace(/[.*+?^$()|[\\\\]/g, "\\\\$&")}(?:/[^"']*)?["']`,
      );
      for (const file of files) {
        const source = fs.readFileSync(file, "utf8");
        if (re.test(source)) {
          offenders.push(path.relative(process.cwd(), file));
        }
      }
      expect(
        offenders,
        `Raw "${mod}" import found — replace with a shared editorial primitive:\n  ${offenders.join("\n  ")}`,
      ).toEqual([]);
    });
  }
});
