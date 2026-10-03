// TB-HIST-12B (2026-10-03) — source-contract regression guards.
//
// Pins:
//   §2  never-invent-classifications rule: Capital Program consumes
//       only existing fsGroupKey / categoryKey classifications
//   §3  Capital Program renders financial-position tiles when
//       classified; project-execution stays Unavailable per-KPI
//   §4  Stewardship Dashboard tile-level (every tile independent)
//   §5  centralized ratio registry with the five availability states
//   §6  chart-partial-availability helpers emit null (not 0) for
//       missing series
//   §12 single calculation source — chapters consume `JanuaryMetricSet`
//   §13 no evaluative labels

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const MONTHLY_PKG = readFileSync(path.join(REPO, "src/lib/reporting/monthly-package.ts"), "utf8");
const RATIO_REG = readFileSync(path.join(REPO, "src/lib/reporting/ratio-registry.ts"), "utf8");
const CHART_HELPERS = readFileSync(path.join(REPO, "src/lib/reporting/chart-partial-availability.ts"), "utf8");
const BODY = readFileSync(path.join(REPO, "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx"), "utf8");

// --------------------------------------------------------------
// §5 — Ratio registry primitives
// --------------------------------------------------------------
describe("TB-HIST-12B §5 — centralized ratio registry with 5 availability states", () => {
  it("exports MetricAvailability with the five documented states", () => {
    expect(RATIO_REG).toMatch(/export type MetricAvailability\s*=\s*\|\s*"AVAILABLE"\s*\|\s*"INPUT_MISSING"\s*\|\s*"DENOMINATOR_ZERO"\s*\|\s*"TARGET_NOT_CONFIGURED"\s*\|\s*"SOURCE_NOT_CONNECTED"/);
  });

  it("exports a ResolvedMetric type with metric + target + numerator/denominator", () => {
    expect(RATIO_REG).toMatch(/export type ResolvedMetric\s*=\s*\{[\s\S]{0,500}key:\s*string;[\s\S]{0,500}formula:\s*string;[\s\S]{0,500}metric:\s*MetricValue;[\s\S]{0,500}target:\s*MetricTarget;/);
    expect(RATIO_REG).toMatch(/numerator\?:/);
    expect(RATIO_REG).toMatch(/denominator\?:/);
  });

  it("resolveJanuaryMetricSet exposes every documented metric key", () => {
    const required = [
      "revenue", "cogs", "opex", "noi", "grossMargin",
      "duesToRevenuePct", "payrollRatio",
      "currentAssets", "currentLiabilities", "workingCapital", "currentRatio",
      "totalAssets", "totalLiabilities", "membersEquity",
      "netPpe", "longTermDebt", "capitalReserve", "capitalAssessmentsYtd",
      "deferredCapitalContributions", "longTermDebtToEquity",
      "arCurrentPct", "reserveCoverage",
    ];
    for (const k of required) {
      expect(RATIO_REG).toMatch(new RegExp(`${k}:\\s*(ResolvedMetric|metric\\()`));
    }
  });

  it("denominator-zero and source-not-connected states are distinct from input-missing", () => {
    // The three distinct code paths must exist in the resolver.
    expect(RATIO_REG).toMatch(/denominatorZero\(/);
    expect(RATIO_REG).toMatch(/sourceNotConnected\(/);
    expect(RATIO_REG).toMatch(/inputMissing\(/);
  });

  it("target provenance defaults to TARGET_NOT_CONFIGURED on every metric", () => {
    expect(RATIO_REG).toMatch(/function metric\(opts:[\s\S]{0,500}target:\s*targetNotConfigured\(opts\.name\)/);
    expect(RATIO_REG).toMatch(/targetNotConfigured\s*=\s*\(name:[\s\S]{0,200}availability:\s*"TARGET_NOT_CONFIGURED"/);
  });
});

// --------------------------------------------------------------
// §2 — Never-invent-classifications
// --------------------------------------------------------------
describe("TB-HIST-12B §2 — Capital Program uses existing fsGroupKey classifications only", () => {
  it("ratio-registry only reads existing fsGroupKey values (no invented classifications)", () => {
    // Must reference only the canonical fsGroupKeys from COA template.
    expect(RATIO_REG).toMatch(/"BS_CAPITAL_ASSETS"/);
    expect(RATIO_REG).toMatch(/"BS_LONG_TERM_DEBT"/);
    expect(RATIO_REG).toMatch(/"BS_CAPITAL_RESERVE"/);
    expect(RATIO_REG).toMatch(/"BS_DEFERRED_CAPITAL_CONTRIBUTIONS"/);
    expect(RATIO_REG).toMatch(/"IS_CAPITAL_ASSESSMENTS"/);
    // Must NOT invent IS_CAPITAL_INCOME, IS_CAPEX, or similar
    // classifications that are not first-class in the Coulee COA.
    expect(RATIO_REG).not.toMatch(/"IS_CAPITAL_INCOME"/);
    expect(RATIO_REG).not.toMatch(/"IS_CAPEX"/);
  });

  it("missing fsGroupKey → sourceNotConnected (never silently inferred from account name)", () => {
    expect(RATIO_REG).toMatch(/sourceNotConnected\("No account mapped to fsGroupKey BS_CAPITAL_RESERVE"\)/);
    expect(RATIO_REG).toMatch(/sourceNotConnected\("No account mapped to fsGroupKey BS_LONG_TERM_DEBT"\)/);
  });
});

// --------------------------------------------------------------
// §3 — Capital Program partial availability
// --------------------------------------------------------------
describe("TB-HIST-12B §3 — Capital Program financial-position vs project-execution split", () => {
  it("buildCapitalProgramBriefing accepts the metric set and switches on hasRealData", () => {
    expect(MONTHLY_PKG).toMatch(/function buildCapitalProgramBriefing\(\s*hasRealData:\s*boolean,\s*metrics\?:\s*import\("\.\/ratio-registry"\)\.JanuaryMetricSet/);
  });

  it("live branch renders Capital financial position when any metric is AVAILABLE", () => {
    expect(MONTHLY_PKG).toMatch(/statusLabel:\s*anyDerived\s*\?\s*"Capital financial position"\s*:\s*"Unavailable"/);
  });

  it("project-execution chip remains Unavailable regardless of financial metrics", () => {
    expect(MONTHLY_PKG).toMatch(/key:\s*"project-execution",[\s\S]{0,120}value:\s*"Unavailable"/);
  });

  it("no evaluative Capital Program verdict labels in the live branch", () => {
    const fn = MONTHLY_PKG.match(/function buildCapitalProgramBriefing[\s\S]*?\n\}/)?.[0] ?? "";
    const liveBranch = fn.split(/if\s*\(hasRealData\)/)[1] ?? "";
    const beforeDemo = liveBranch.split(/return\s*\{\s*\n\s*status:\s*"green"/)[0] ?? liveBranch;
    expect(beforeDemo).not.toMatch(/"Executing"/);
    expect(beforeDemo).not.toMatch(/"On Plan"/);
    expect(beforeDemo).not.toMatch(/"Monitor"/);
  });

  it("pkg literal threads januaryMetricSet into the capital-program builder", () => {
    expect(MONTHLY_PKG).toMatch(/capitalProgram:\s*buildCapitalProgramBriefing\(hasRealData,\s*januaryMetricSet\)/);
  });
});

// --------------------------------------------------------------
// §4 — Stewardship tile-level
// --------------------------------------------------------------
describe("TB-HIST-12B §4 — Stewardship Dashboard tile-level availability", () => {
  it("MonthlyReportingPackage exposes stewardshipTiles", () => {
    expect(MONTHLY_PKG).toMatch(/stewardshipTiles\?:\s*\{[\s\S]{0,200}tiles:\s*Array</);
  });

  it("buildStewardshipTiles emits every independent tile", () => {
    expect(MONTHLY_PKG).toMatch(/function buildStewardshipTiles\(/);
    const fn = MONTHLY_PKG.match(/function buildStewardshipTiles[\s\S]*?\n\}/)?.[0] ?? "";
    for (const name of [
      "workingCapital", "currentRatio", "duesToRevenuePct", "payrollRatio",
      "grossMargin", "netPpe", "longTermDebt", "capitalReserve",
      "longTermDebtToEquity", "arCurrentPct", "reserveCoverage",
    ]) {
      expect(fn).toContain(`metrics.${name}`);
    }
  });

  it("ChairsDashboard renders stewardshipTiles with data-testids", () => {
    expect(BODY).toMatch(/data-testid="stewardship-tiles"/);
    expect(BODY).toMatch(/data-testid=\{`stewardship-tile-\$\{t\.key\}`\}/);
    expect(BODY).toMatch(/data-availability=\{t\.metricAvailability\}/);
  });
});

// --------------------------------------------------------------
// §6 — Chart partial-availability helpers
// --------------------------------------------------------------
describe("TB-HIST-12B §6 — chart partial-availability helpers (missing series never zero)", () => {
  it("exports the required helpers", () => {
    expect(CHART_HELPERS).toMatch(/export function buildActualOnlySeries/);
    expect(CHART_HELPERS).toMatch(/export function buildUnavailableSeries/);
    expect(CHART_HELPERS).toMatch(/export function seriesIsRenderable/);
    expect(CHART_HELPERS).toMatch(/export function auditNoZeroFillForUnavailable/);
    expect(CHART_HELPERS).toMatch(/export function filterDonutCategories/);
    expect(CHART_HELPERS).toMatch(/export function buildPartialTrend/);
  });

  it("buildActualOnlySeries fills missing slots with null, never 0", async () => {
    const mod = await import("../src/lib/reporting/chart-partial-availability");
    const s = mod.buildActualOnlySeries({ values: [100, 200, 300], period: 12 });
    expect(s).toHaveLength(12);
    expect(s[0]).toBe(100);
    expect(s[1]).toBe(200);
    expect(s[2]).toBe(300);
    for (let i = 3; i < 12; i++) {
      expect(s[i]).toBeNull();
      // Explicit guard: must NOT be 0.
      expect(s[i]).not.toBe(0);
    }
  });

  it("buildUnavailableSeries never fills 0 for missing data", async () => {
    const mod = await import("../src/lib/reporting/chart-partial-availability");
    const s = mod.buildUnavailableSeries(12);
    expect(s).toHaveLength(12);
    for (const v of s) {
      expect(v).toBeNull();
      expect(v).not.toBe(0);
    }
  });

  it("auditNoZeroFillForUnavailable surfaces a zero fill as a violation", async () => {
    const mod = await import("../src/lib/reporting/chart-partial-availability");
    const bad = mod.auditNoZeroFillForUnavailable({
      sourceAvailable: false,
      values: [null, null, 0, null], // index 2 is a 0 for unavailable source
    });
    expect(bad.ok).toBe(false);
    expect(bad.firstViolationIndex).toBe(2);

    const good = mod.auditNoZeroFillForUnavailable({
      sourceAvailable: false,
      values: [null, null, null, null],
    });
    expect(good.ok).toBe(true);
    expect(good.firstViolationIndex).toBeNull();
  });

  it("filterDonutCategories drops missing categories (does not render them as 0% slices)", async () => {
    const mod = await import("../src/lib/reporting/chart-partial-availability");
    const kept = mod.filterDonutCategories([
      { key: "a", label: "A", value: 100 },
      null,
      undefined,
      { key: "b", label: "B", value: 25 },
    ]);
    expect(kept).toHaveLength(2);
    expect(kept.map((c) => c.key)).toEqual(["a", "b"]);
  });
});

// --------------------------------------------------------------
// §12 — Single calculation source
// --------------------------------------------------------------
describe("TB-HIST-12B §12 — single calculation source", () => {
  it("getMonthlyReportingPackage resolves one JanuaryMetricSet and threads it to downstream chapters", () => {
    expect(MONTHLY_PKG).toMatch(/let\s+januaryMetricSet:\s*\|?\s*import\("\.\/ratio-registry"\)\.JanuaryMetricSet/);
    expect(MONTHLY_PKG).toMatch(/registryMod\.resolveJanuaryMetricSet\(/);
    // Capital Program must consume the same object.
    expect(MONTHLY_PKG).toMatch(/buildCapitalProgramBriefing\(hasRealData,\s*januaryMetricSet\)/);
    // Stewardship tiles must consume the same object.
    expect(MONTHLY_PKG).toMatch(/buildStewardshipTiles\(januaryMetricSet\)/);
  });
});

// --------------------------------------------------------------
// §13 — Narrative behavior
// --------------------------------------------------------------
describe("TB-HIST-12B §13 — no evaluative labels in live-tenant narratives", () => {
  it("stewardship footer note is factual (no evaluative conclusions)", () => {
    const fn = MONTHLY_PKG.match(/function buildStewardshipTiles[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).not.toMatch(/"Healthy"/);
    expect(fn).not.toMatch(/"Strong"/);
    expect(fn).not.toMatch(/"Weak"/);
    expect(fn).not.toMatch(/"Well funded"/);
    expect(fn).not.toMatch(/"Executing"/);
  });

  it("ratio-registry metric names never carry evaluative modifiers", () => {
    // Names like "Healthy Working Capital" would be a violation.
    const metricNames = Array.from(RATIO_REG.matchAll(/name:\s*"([^"]+)"/g)).map((m) => m[1]);
    for (const n of metricNames) {
      expect(n.toLowerCase()).not.toContain("healthy");
      expect(n.toLowerCase()).not.toContain("strong");
      expect(n.toLowerCase()).not.toContain("weak");
      expect(n.toLowerCase()).not.toContain("on plan");
    }
  });
});

// --------------------------------------------------------------
// §15 — Residual-unavailable + supportability doc
// --------------------------------------------------------------
describe("TB-HIST-12B §15 — supportability matrix references the ratio registry", () => {
  it("docs/tb-hist-12a-partial-availability-matrix.md still exists (regression hold)", () => {
    expect(existsSync(path.join(REPO, "docs/tb-hist-12a-partial-availability-matrix.md"))).toBe(true);
  });
});
