// REPORT-LIVE-1 (2026-10-03) — source-contract regression guards.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const AR = path.join(REPO, "src/lib/reporting/accounts-receivable-aging.ts");
const PKG = path.join(REPO, "src/lib/reporting/monthly-package.ts");
const BODY = path.join(REPO, "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx");

// --------------------------------------------------------------
// §3-6 — Section VIII Coulee AR Aging builder
// --------------------------------------------------------------
describe("REPORT-LIVE-1 §3-6 — Coulee AR Aging builder from AR snapshot", () => {
  it("buildCouleeAccountsReceivableAging is exported and emits dataSource='live'", () => {
    const src = readFileSync(AR, "utf8");
    expect(src).toMatch(/export function buildCouleeAccountsReceivableAging/);
    // Pin the live dataSource + Jonas-bucket collapse at file level
    // (the function body uses several nested object literals that
    // break naive end-brace matching).
    expect(src).toMatch(/dataSource:\s*"live"\s+as\s+ReportingDataSource/);
    expect(src).toMatch(/over90\s*=\s*snapshot\.threeMonths\s*\+\s*snapshot\.overFourMonths/);
  });

  it("Coulee builder emits the four §4 KPI cards (total-ar, current-pct, non-current, non-current-accounts)", () => {
    const src = readFileSync(AR, "utf8");
    for (const key of ["total-ar", "current-pct", "non-current", "non-current-accounts"]) {
      expect(src).toMatch(new RegExp(`key:\\s*"${key}"`));
    }
  });

  it("Coulee builder preserves source Member AR row (Jonas account 1200)", () => {
    const src = readFileSync(AR, "utf8");
    expect(src).toMatch(/Member Receivables \(Jonas account 1200\)/);
  });

  it("§7 collection notes stay honest about unavailability", () => {
    const src = readFileSync(AR, "utf8");
    expect(src).toMatch(/Collection notes and member-level commentary are not sourced/);
  });

  it("§8 narrative is factual (no evaluative verdict without policy target)", () => {
    const src = readFileSync(AR, "utf8");
    const fn = src.match(/export function buildCouleeAccountsReceivableAging[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).not.toMatch(/\bhealthy\b/i);
    expect(fn).not.toMatch(/\bstrong\b/i);
    expect(fn).not.toMatch(/\bconcerning\b/i);
    expect(fn).not.toMatch(/\bexcellent\b/i);
  });
});

// --------------------------------------------------------------
// §3 — monthly-package wiring (Coulee AR path + redactor skip)
// --------------------------------------------------------------
describe("REPORT-LIVE-1 §3 — monthly-package wires Chapter VIII to the AR snapshot on live tenants", () => {
  it("monthly-package.ts imports buildCouleeAccountsReceivableAging", () => {
    const src = readFileSync(PKG, "utf8");
    expect(src).toMatch(/buildCouleeAccountsReceivableAging/);
  });

  it("Chapter VIII resolution branches on hasRealData and resolves resolveArAgingAsOf", () => {
    const src = readFileSync(PKG, "utf8");
    expect(src).toMatch(/if \(hasRealData\)\s*\{[\s\S]{0,400}resolveArAgingAsOf\(\s*\{\s*clubId:\s*club\.id,\s*asOf:\s*reportingPeriod\.periodEnd/);
    expect(src).toMatch(/buildCouleeAccountsReceivableAging\(\{[\s\S]{0,100}snapshot:/);
  });

  it("pkg literal consumes the pre-computed accountsReceivableAging variable", () => {
    const src = readFileSync(PKG, "utf8");
    expect(src).toMatch(/accountsReceivableAging:\s*accountsReceivableAging/);
  });

  it("redactor skips Chapter VIII when dataSource === 'live'", () => {
    const src = readFileSync(PKG, "utf8");
    expect(src).toMatch(/pkg\.accountsReceivableAging\.dataSource === "live"[\s\S]{0,200}pkg\.accountsReceivableAging[\s\S]{0,200}makeUnavailable\(pkg\.accountsReceivableAging/);
  });
});

// --------------------------------------------------------------
// §9-19 — Section II authoritative source panel
// --------------------------------------------------------------
describe("REPORT-LIVE-1 §9-19 — Section II authoritative source panel", () => {
  it("MonthlyReportingPackage exposes financialPerformanceAuthoritative with per-series availability", () => {
    const src = readFileSync(PKG, "utf8");
    expect(src).toMatch(/financialPerformanceAuthoritative\?:/);
    expect(src).toMatch(/availability:\s*\{[\s\S]{0,300}actual:\s*"AVAILABLE"\s*\|\s*"UNAVAILABLE"[\s\S]{0,100}budget:\s*"SOURCE_NOT_CONNECTED"[\s\S]{0,100}priorYear:\s*"SOURCE_NOT_LOADED"/);
  });

  it("pkg literal populates financialPerformanceAuthoritative from JanuaryMetricSet (not fabricated)", () => {
    const src = readFileSync(PKG, "utf8");
    expect(src).toMatch(/financialPerformanceAuthoritative:\s*hasRealData && januaryMetricSet[\s\S]{0,2000}revenueDisplay:\s*januaryMetricSet\.revenue\.metric\.display/);
    expect(src).toMatch(/budget:\s*"SOURCE_NOT_CONNECTED"/);
    expect(src).toMatch(/priorYear:\s*"SOURCE_NOT_LOADED"/);
  });

  it("ChairsDashboard renders the Section II source panel with scoped data-testids", () => {
    const src = readFileSync(BODY, "utf8");
    expect(src).toMatch(/data-testid="financial-performance-source-panel"/);
    expect(src).toMatch(/data-testid="fp-source-revenue"/);
    expect(src).toMatch(/data-testid="fp-source-cogs"/);
    expect(src).toMatch(/data-testid="fp-source-opex"/);
    expect(src).toMatch(/data-testid="fp-source-net-income"/);
    expect(src).toMatch(/data-testid="fp-source-actual"/);
    expect(src).toMatch(/data-testid="fp-source-budget"/);
    expect(src).toMatch(/data-testid="fp-source-prior-year"/);
  });
});

// --------------------------------------------------------------
// §15-16 — No fabrication of Budget / Prior Year
// --------------------------------------------------------------
describe("REPORT-LIVE-1 §15-16 — no fabrication of Budget / Prior Year", () => {
  it("Section II panel never emits Budget = 0 or a fabricated Prior Year value", () => {
    const src = readFileSync(BODY, "utf8");
    const panel = src.match(/data-testid="financial-performance-source-panel"[\s\S]*?<\/section>/)?.[0] ?? "";
    expect(panel).not.toMatch(/Budget:\s*0/);
    expect(panel).not.toMatch(/Budget:\s*\$0/);
    expect(panel).not.toMatch(/Prior Year:\s*0/);
    // No ad-hoc "trend" fabrication helpers imported into the panel block.
    expect(panel).not.toMatch(/fakeTrend|monthlySeries\(/);
  });
});

// --------------------------------------------------------------
// §18 — No demo values on the live Coulee AR path
// --------------------------------------------------------------
describe("REPORT-LIVE-1 §18 — no demo AR data on live Coulee", () => {
  it("Coulee AR builder has no DEMO / sample / placeholder tokens in its source", () => {
    const src = readFileSync(AR, "utf8");
    const fn = src.match(/export function buildCouleeAccountsReceivableAging[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).not.toMatch(/\bDEMO\b/i);
    expect(fn).not.toMatch(/\bsample\b/i);
    expect(fn).not.toMatch(/\bplaceholder\b/i);
    expect(fn).not.toMatch(/\bmock\b/i);
    expect(fn).not.toMatch(/\bhardcoded\b/i);
  });
});
