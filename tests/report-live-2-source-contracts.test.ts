// REPORT-LIVE-2 (2026-10-04) — source-contract pins for the Section II
// live wiring + precise unavailable reasons:
//   • Department Performance now has a live builder reading from
//     incomeStatementByDepartmentFromSnapshot (Priority 1).
//   • DepartmentRowInput.ytdBudget widened to number | null, so Actual
//     renders without a fabricated $0 budget.
//   • FormattedDepartmentRow fields derived from Budget are nullable.
//   • The redactor preserves the live sub-chapters and emits precise
//     per-card reasons for the still-demo-sourced sub-chapters, instead
//     of the generic "Data not available for this reporting period"
//     placeholder.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const DEPT = path.join(REPO, "src/lib/reporting/department-net-performance.ts");
const PKG  = path.join(REPO, "src/lib/reporting/monthly-package.ts");

describe("REPORT-LIVE-2 §6-8 — Department Performance live wiring", () => {
  it("DepartmentRowInput.ytdBudget widened to number | null", () => {
    const src = readFileSync(DEPT, "utf8");
    expect(src).toMatch(/export type DepartmentRowInput[\s\S]*?ytdBudget:\s*number\s*\|\s*null/);
  });

  it("FormattedDepartmentRow has nullable budget / variance / isFavorable / trendBarPct", () => {
    const src = readFileSync(DEPT, "utf8");
    const t = src.match(/export type FormattedDepartmentRow[\s\S]*?^\};/m)?.[0] ?? "";
    expect(t).toMatch(/budgetLabel:\s*string\s*\|\s*null/);
    expect(t).toMatch(/varianceLabel:\s*string\s*\|\s*null/);
    expect(t).toMatch(/variance:\s*number\s*\|\s*null/);
    expect(t).toMatch(/isFavorable:\s*boolean\s*\|\s*null/);
    expect(t).toMatch(/trendBarPct:\s*number\s*\|\s*null/);
  });

  it("buildDepartmentNetPerformanceLive is exported and reads from incomeStatementByDepartmentFromSnapshot", () => {
    const src = readFileSync(DEPT, "utf8");
    expect(src).toMatch(/export async function buildDepartmentNetPerformanceLive/);
    expect(src).toMatch(/incomeStatementByDepartmentFromSnapshot/);
  });

  it("live builder NEVER sets ytdBudget: 0 — directive §8 (REPORT-LIVE-3 now sources real Budget via resolveBudget; null fallback is still the explicit missing-source sentinel)", () => {
    const src = readFileSync(DEPT, "utf8");
    const fn = src.match(/export async function buildDepartmentNetPerformanceLive[\s\S]*?^\}/m)?.[0] ?? "";
    // No ytdBudget: 0 literal anywhere — directive §32 (null vs 0).
    expect(fn).not.toMatch(/ytdBudget:\s*0\b/);
    // The null fallback remains present for departments not in the
    // Budget map (missing from CSV).
    expect(fn).toMatch(/ytdBudget[\s\S]{0,200}:\s*null/);
  });

  it("live builder emits dataSource: 'live'", () => {
    const src = readFileSync(DEPT, "utf8");
    const fn = src.match(/export async function buildDepartmentNetPerformanceLive[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toMatch(/dataSource:\s*"live"/);
  });

  it("monthly-package wires buildDepartmentNetPerformanceLive on hasRealData branch", () => {
    const src = readFileSync(PKG, "utf8");
    expect(src).toMatch(/departmentPerformance:\s*hasRealData[\s\S]*?buildDepartmentNetPerformanceLive\(clubId,\s*periodEnd\)/);
  });
});

describe("REPORT-LIVE-2 §19-21 — redactor preserves live sub-chapters", () => {
  it("redactor preserves pkg.stewardshipDashboard.departmentPerformance verbatim", () => {
    const src = readFileSync(PKG, "utf8");
    expect(src).toMatch(/departmentPerformance:\s*pkg\.stewardshipDashboard\.departmentPerformance/);
  });

  it("redactor still preserves equity + operating (REPORT-CHART-1 guard)", () => {
    const src = readFileSync(PKG, "utf8");
    expect(src).toMatch(/equity:\s*pkg\.stewardshipDashboard\.equity/);
    expect(src).toMatch(/operating:\s*pkg\.stewardshipDashboard\.operating/);
  });
});

describe("REPORT-LIVE-2 §20 — precise per-card unavailable reasons", () => {
  it("per-card UNAVAIL_* constants are declared", () => {
    const src = readFileSync(PKG, "utf8");
    expect(src).toMatch(/UNAVAIL_SCORECARDS\s*=/);
    expect(src).toMatch(/UNAVAIL_DUES_SUBSIDY\s*=/);
    expect(src).toMatch(/UNAVAIL_PAYROLL_DEPT\s*=/);
    expect(src).toMatch(/UNAVAIL_PAYROLL_TREND\s*=/);
  });

  it("per-card reasons name the missing source precisely (never the generic placeholder)", () => {
    const src = readFileSync(PKG, "utf8");
    const extract = (name: string) =>
      src.match(new RegExp(`${name}\\s*=\\s*"([^"]+)"`))?.[1] ?? "";
    expect(extract("UNAVAIL_SCORECARDS")).toMatch(/target|policy|benchmark/i);
    expect(extract("UNAVAIL_DUES_SUBSIDY")).toMatch(/allocation|classifier|ambiguous/i);
    expect(extract("UNAVAIL_PAYROLL_DEPT")).toMatch(/payroll|department|resolver/i);
    expect(extract("UNAVAIL_PAYROLL_TREND")).toMatch(/multi-month|history|committed|one point/i);
    // None of them is the generic placeholder.
    for (const name of ["UNAVAIL_SCORECARDS", "UNAVAIL_DUES_SUBSIDY", "UNAVAIL_PAYROLL_DEPT", "UNAVAIL_PAYROLL_TREND"]) {
      expect(extract(name)).not.toBe("Data not available for this reporting period.");
    }
  });

  it("redactor applies per-card reasons to still-redacted sub-chapters (SCORECARD-PARTIAL-1 moved scorecards + REPORT-LIVE-3 moved payrollDepartment to the preserved group)", () => {
    const src = readFileSync(PKG, "utf8");
    // scorecards now preserved verbatim (live metric-level nullable rows).
    expect(src).toMatch(/scorecards:\s*pkg\.stewardshipDashboard\.scorecards/);
    expect(src).toMatch(/duesSubsidy:\s*makeUnavailable\(pkg\.stewardshipDashboard\.duesSubsidy,\s*UNAVAIL_DUES_SUBSIDY\)/);
    expect(src).toMatch(/payrollRatioTrend:\s*makeUnavailable\(pkg\.stewardshipDashboard\.payrollRatioTrend,\s*UNAVAIL_PAYROLL_TREND\)/);
  });
});

describe("REPORT-LIVE-2 §22 — no demo data on live tenants", () => {
  it("live builder does not import Silver Springs seed constants", () => {
    const src = readFileSync(DEPT, "utf8");
    const fn = src.match(/export async function buildDepartmentNetPerformanceLive[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).not.toMatch(/SILVER_SPRINGS/);
  });
});

describe("REPORT-LIVE-2 §22 — read-only (no prisma writes)", () => {
  it("live builder never writes", () => {
    const src = readFileSync(DEPT, "utf8");
    const fn = src.match(/export async function buildDepartmentNetPerformanceLive[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete)/);
  });
});
