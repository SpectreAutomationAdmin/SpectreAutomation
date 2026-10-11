// MBR-FIX-2O (2026-10-11) — Operating Scorecard Actual cells blank.
//
// Root cause (same DEF-4 bug that MBR-FIX-1 / 2A / 2B / 2C / 2D /
// 2E / 2G / 2H / 2J / payroll-ratio-trend-live fixed on their
// respective paths):
//
//   `scorecard-live-builder.ts` passed `period.periodStart` directly
//   to `resolveJanuaryMetricSet`. `period.periodStart` is the
//   current-MONTH start (e.g. Mar 1 for a Mar package). The ratio-
//   registry forwards it to `reportingAccountBalances({from, to})`,
//   which requires `from = fiscal-year start` to serve the YTD slice
//   from the Jonas TB snapshot. On Feb+ periods the `sameDay`
//   match fails → zero balances → `isAvailable = false` on every
//   IS metric → scorecard Actual cells blank.
//
// The budget path works because `resolveBudget` /
// `resolveBudgetIncomeStatement` derive fiscal-year start internally
// from the `fiscalYear` arg; only the Actual path was broken.
//
// Fix: both `buildOperatingScorecardLive` and
// `buildCapitalScorecardLive` compute `fiscalYearStart` from
// `period.periodEnd.getUTCFullYear()` and pass that to
// `resolveJanuaryMetricSet`.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO    = path.resolve(__dirname, "..");
const BUILDER = path.join(REPO, "src/lib/reporting/scorecard-live-builder.ts");

describe("MBR-FIX-2O §A — Operating builder uses fiscal-year start, not period.periodStart", () => {
  const src = readFileSync(BUILDER, "utf8");

  it("fiscalYearStart derived from period.periodEnd year inside the Operating builder", () => {
    const idx = src.indexOf("function buildOperatingScorecardLive");
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 2500);
    expect(body).toMatch(/const\s+fiscalYearStart\s*=\s*new Date\(Date\.UTC\(fiscalYear,\s*0,\s*1\)\);/);
  });

  it("resolveJanuaryMetricSet is called with periodStart: fiscalYearStart (not period.periodStart)", () => {
    const idx = src.indexOf("function buildOperatingScorecardLive");
    const body = src.slice(idx, idx + 2500);
    expect(body).toMatch(/resolveJanuaryMetricSet\(\s*\{[\s\S]{0,300}periodStart:\s*fiscalYearStart,/);
    expect(body).not.toMatch(/resolveJanuaryMetricSet\(\s*\{[\s\S]{0,300}periodStart:\s*period\.periodStart/);
  });
});

describe("MBR-FIX-2O §B — Capital builder uses fiscal-year start too", () => {
  const src = readFileSync(BUILDER, "utf8");

  it("fiscalYearStart derived from period.periodEnd year inside the Capital builder", () => {
    const idx = src.indexOf("function buildCapitalScorecardLive");
    expect(idx).toBeGreaterThan(0);
    const body = src.slice(idx, idx + 2500);
    expect(body).toMatch(/const\s+fiscalYearStart\s*=\s*new Date\(Date\.UTC\(period\.periodEnd\.getUTCFullYear\(\),\s*0,\s*1\)\);/);
  });

  it("resolveJanuaryMetricSet is called with periodStart: fiscalYearStart inside the Capital builder", () => {
    const idx = src.indexOf("function buildCapitalScorecardLive");
    const body = src.slice(idx, idx + 2500);
    expect(body).toMatch(/resolveJanuaryMetricSet\(\s*\{[\s\S]{0,300}periodStart:\s*fiscalYearStart,/);
    expect(body).not.toMatch(/resolveJanuaryMetricSet\(\s*\{[\s\S]{0,300}periodStart:\s*period\.periodStart/);
  });
});

describe("MBR-FIX-2O §C — no `period.periodStart` directly handed to resolveJanuaryMetricSet anywhere", () => {
  const src = readFileSync(BUILDER, "utf8");

  it("`periodStart: period.periodStart` is absent from the module", () => {
    expect(src).not.toMatch(/periodStart:\s*period\.periodStart/);
  });
});
