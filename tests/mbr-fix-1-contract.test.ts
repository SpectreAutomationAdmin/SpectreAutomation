// MBR-FIX-1 (2026-10-09) — reporting period correctness contract.
//
// MBR-AUDIT-1 identified five defects on the February 2026 Monthly
// Board Reporting Package:
//
//   DEF-1  — hardcoded "Jan 2026 Jonas Trial Balance" sourceLabel
//   DEF-2  — hardcoded "January Jonas Trial Balance" note sentence
//   DEF-3  — hardcoded "January 31, 2026 trial-balance snapshot"
//            Stewardship Tiles footer
//   DEF-4  — YTD-slice period mismatch: `reportingPeriod.periodStart`
//            (= Feb 1) does not match `snapshot.periodStart`
//            (= Jan 1, fiscal YTD start).  Every IS KPI falls to
//            Unavailable on Feb+ periods.
//   DEF-5  — Reserve Coverage renders "0.00x" when the reserve is
//            not classified (should be "Unavailable").
//
// This slice's remediation is pinned by these source contracts:
//
//   §A  monthly-package.ts resolves the fiscal-year start from the
//       reporting period and passes it (not the current-month
//       start) to `resolveJanuaryMetricSet`.
//   §B  monthly-package.ts builds the Section II source label +
//       note + Stewardship footer from `reportingPeriod` fields.
//   §C  ratio-registry.ts accepts a `sourceLabel` option and
//       interpolates it into every "AVAILABLE" provenance string.
//   §D  fs-group-projection.ts derives CM activity from
//       `ytdActual − priorYtdActual` instead of a direct
//       `{ from: periodStart, to: periodEnd }` query.  First
//       fiscal month ⇒ CM === YTD.
//   §E  executive-summary.ts renders Reserve Coverage as
//       "Unavailable" when `input.dataSource === "demo"` (which
//       is the signal that the live reserve was null).
//   §F  No hardcoded "Jan 2026" / "January 31, 2026" strings
//       remain in the reporting package service files.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO     = path.resolve(__dirname, "..");
const PACKAGE  = path.join(REPO, "src/lib/reporting/monthly-package.ts");
const REGISTRY = path.join(REPO, "src/lib/reporting/ratio-registry.ts");
const FSPROJ   = path.join(REPO, "src/lib/reporting/fs-group-projection.ts");
const EXECSUM  = path.join(REPO, "src/lib/reporting/executive-summary.ts");

describe("MBR-FIX-1 §A — monthly-package passes fiscal-year start to ratio-registry", () => {
  const src = readFileSync(PACKAGE, "utf8");

  it("derives `fiscalYearStart` from the reporting-period year", () => {
    expect(src).toMatch(
      /const fiscalYearStart = new Date\(Date\.UTC\(\s*reportingPeriod\.periodEnd\.getUTCFullYear\(\), 0, 1,?\s*\)\);/,
    );
  });

  it("passes `fiscalYearStart` (not `reportingPeriod.periodStart`) as the registry's periodStart", () => {
    // The call site must mention fiscalYearStart in the periodStart slot.
    const callIdx = src.indexOf("resolveJanuaryMetricSet({");
    expect(callIdx).toBeGreaterThan(0);
    const block = src.slice(callIdx, callIdx + 400);
    expect(block).toMatch(/periodStart: fiscalYearStart,/);
    // Belt-and-braces: the pre-fix literal must not come back.
    expect(block).not.toMatch(/periodStart: reportingPeriod\.periodStart,/);
  });

  it("threads a `periodSourceLabel` (sourceLabel) into the registry call", () => {
    const callIdx = src.indexOf("resolveJanuaryMetricSet({");
    const block = src.slice(callIdx, callIdx + 400);
    expect(block).toMatch(/sourceLabel: periodSourceLabel,/);
    expect(src).toMatch(
      /const periodSourceLabel =\s*`\$\{reportingPeriod\.monthShort\} \$\{reportingPeriod\.year\} Jonas Trial Balance`;/,
    );
  });
});

describe("MBR-FIX-1 §B — monthly-package builds Section II strings from the period", () => {
  const src = readFileSync(PACKAGE, "utf8");

  it("sourceLabel is derived from reportingPeriod.monthShort + year, not a hardcoded month", () => {
    expect(src).toMatch(
      /sourceLabel: `\$\{reportingPeriod\.monthShort\} \$\{reportingPeriod\.year\} Jonas Trial Balance`,/,
    );
  });

  it("Section II note interpolates reportingPeriod.monthLong", () => {
    expect(src).toMatch(
      /Actual values derive from the committed \$\{reportingPeriod\.monthLong\} Jonas Trial Balance/,
    );
    // Prior-year reference also goes through priorYearLabel, not a hardcoded "January 2025".
    expect(src).toMatch(/\$\{reportingPeriod\.priorYearLabel\} operating snapshot/);
  });

  it("Stewardship tiles footer takes a `snapshotDateLabel` argument and interpolates it", () => {
    expect(src).toMatch(/snapshotDateLabel\?: string,/);
    expect(src).toMatch(/const dateLabel = snapshotDateLabel \?\? "trial-balance snapshot";/);
    expect(src).toMatch(
      /`Each tile resolves independently from the \$\{dateLabel\} trial-balance snapshot\./,
    );
  });

  it("buildStewardshipTiles call site passes reportingPeriod.periodEndShortLabel", () => {
    expect(src).toMatch(
      /buildStewardshipTiles\(januaryMetricSet, reportingPeriod\.periodEndShortLabel\)/,
    );
  });
});

describe("MBR-FIX-1 §C — ratio-registry accepts a period-derived sourceLabel", () => {
  const src = readFileSync(REGISTRY, "utf8");

  it("resolveJanuaryMetricSet options include `sourceLabel?: string`", () => {
    expect(src).toMatch(/sourceLabel\?: string;/);
  });

  it("defaults sourceLabel to the period-neutral literal", () => {
    expect(src).toMatch(/const srcLabel = opts\.sourceLabel \?\? "Jonas Trial Balance";/);
  });

  it("every AVAILABLE provenance string interpolates `${srcLabel}`, not 'Jan Jonas TB'", () => {
    expect(src).not.toMatch(/"Jan Jonas TB/);
    expect(src).toMatch(/`\$\{srcLabel\} · sum\(REVENUE naturalBalance\)`/);
    expect(src).toMatch(/`\$\{srcLabel\} · IS_COGS classification`/);
    expect(src).toMatch(/`\$\{srcLabel\} · EXPENSE accounts classified non-COGS`/);
    expect(src).toMatch(/`\$\{srcLabel\} · DUES_AND_CHARGES dimensional ÷ total REVENUE`/);
    expect(src).toMatch(/`\$\{srcLabel\} · IS_PAYROLL ÷ total REVENUE`/);
  });
});

describe("MBR-FIX-1 §D — FsGroupProjection CM derived from YTD − priorYTD", () => {
  const src = readFileSync(FSPROJ, "utf8");

  it("the direct CM query `{ from: period.periodStart, to: periodEnd }` is removed", () => {
    // The old query was the exact source of the Feb drop-to-empty.
    // It must not come back verbatim.
    expect(src).not.toMatch(
      /reportingAccountBalances\(clubId, \{ from: period\.periodStart, to: periodEnd \}\)/,
    );
  });

  it("loads ytd + prior-month-ytd actuals in parallel", () => {
    expect(src).toMatch(/const \[ytdActualResult, priorYtdActualResult\] = await Promise\.all\(/);
    expect(src).toMatch(
      /reportingAccountBalances\(clubId, \{ from: fiscalYearStart, to: periodEnd \}\),/,
    );
    expect(src).toMatch(
      /reportingAccountBalances\(clubId, \{ from: fiscalYearStart, to: priorMonthEnd \}\),/,
    );
  });

  it("computes priorMonthEnd as last day of the month BEFORE periodEnd at EOD UTC", () => {
    expect(src).toMatch(
      /const priorMonthEnd = new Date\(Date\.UTC\(\s*periodEnd\.getUTCFullYear\(\), periodEnd\.getUTCMonth\(\), 0,\s*23, 59, 59, 999,?\s*\)\);/,
    );
  });

  it("firstFiscalMonth gate short-circuits priorYTD query", () => {
    expect(src).toMatch(/const isFirstFiscalMonth = periodEnd\.getUTCMonth\(\) === 0;/);
    expect(src).toMatch(/isFirstFiscalMonth\s*\?\s*Promise\.resolve\(null\)/);
  });

  it("derives cmActual = ytdActual − priorYtdActual (or YTD for January)", () => {
    expect(src).toMatch(/a\.cmActual = isFirstFiscalMonth\s*\?\s*a\.ytdActual\s*:\s*a\.ytdActual - a\.priorYtdActual;/);
  });

  it("AcctAgg carries a transient priorYtdActual accumulator", () => {
    expect(src).toMatch(/priorYtdActual: number;/);
    expect(src).toMatch(/priorYtdActual: 0,/);
  });
});

describe("MBR-FIX-1 §E — Reserve Coverage renders Unavailable when live reserve is null", () => {
  const src = readFileSync(EXECSUM, "utf8");

  it("buildReserveCoverageCard uses !Number.isFinite(actual) as the unavailable signal", () => {
    // NaN sentinel (set by `buildExecutiveSummaryInputFromSnapshots`
    // when aux.reserveCoverage.actual is null) separates the
    // live-no-reserve case from the demo-seed-with-1.42 case.
    expect(src).toMatch(/if \(!Number\.isFinite\(input\.actual\)\) \{/);
  });

  it("the unavailable branch renders value: \"Unavailable\" (not 0.00x)", () => {
    // Normalise CRLF→LF so the branch-boundary slice works on
    // Windows checkouts (where the file is loaded with CRLF).
    const normalised = src.replace(/\r\n/g, "\n");
    const idx = normalised.indexOf("if (!Number.isFinite(input.actual)) {");
    expect(idx).toBeGreaterThan(0);
    const close = normalised.indexOf("\n  }\n", idx);
    expect(close).toBeGreaterThan(idx);
    const block = normalised.slice(idx, close);
    expect(block).toMatch(/value: "Unavailable",/);
    expect(block).toMatch(/variance: "reserve classification \+ policy not configured",/);
    expect(block).not.toMatch(/value: formatRatio\(input\.actual\)/);
  });

  it("buildExecutiveSummaryInputFromSnapshots emits NaN when aux.reserveCoverage.actual is null", () => {
    expect(src).toMatch(/actual: aux\.reserveCoverage\.actual \?\? Number\.NaN,/);
  });
});

describe("MBR-FIX-1 §F — no hardcoded January source strings remain in CODE", () => {
  // Strip single-line comments so MBR-FIX-1 explanatory comments
  // ("hardcoded 'January 31, 2026 trial-balance snapshot' footer
  //  that appeared on every reporting month…") don't trip the
  // ban.  The ban is on live code strings, not documentation.
  const stripComments = (s: string): string =>
    s
      .split("\n")
      .map((line) => {
        const i = line.indexOf("//");
        return i >= 0 ? line.slice(0, i) : line;
      })
      .join("\n");

  const PACKAGE_SRC  = stripComments(readFileSync(PACKAGE,  "utf8"));
  const REGISTRY_SRC = stripComments(readFileSync(REGISTRY, "utf8"));

  // These are the exact literals MBR-AUDIT-1 flagged.  Pinning
  // them here makes future-you's edit tripwire visible.
  for (const banned of [
    `"Jan 2026 Jonas Trial Balance"`,
    `"committed January Jonas Trial Balance"`,
    `"January 31, 2026 trial-balance snapshot"`,
    `"Jan Jonas TB`,
  ]) {
    it(`banned literal in reporting services: ${banned}`, () => {
      expect(PACKAGE_SRC).not.toContain(banned);
      expect(REGISTRY_SRC).not.toContain(banned);
    });
  }
});
