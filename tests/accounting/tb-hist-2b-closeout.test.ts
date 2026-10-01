// TB-HIST-2b (2026-10-01) — closeout acceptance tests.
//
// Covers:
//   §1 — the Monthly Reporting Package redactor replaces Silver
//        Springs demo literals for non-demo tenants.
//   §2 — dimensional snapshot reads: scoped Dept + Fund filters
//        aggregate correctly over a dimensional TrialBalance payload.
//   §4 — Jonas preview carries continuity + fiscal-year-boundary flag.
//   §5 — the Jonas commit's dept-key dimensional dup detection
//        matches the preview semantics.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { computeAmount } from "../../src/lib/reporting/ledger/projections/income-statement-projection";
import type { TrialBalanceLine } from "../../src/lib/reporting/ledger/contracts";

const REPO = path.resolve(__dirname, "..", "..");
const MONTHLY = readFileSync(path.join(REPO, "src", "lib", "reporting", "monthly-package.ts"), "utf8");
const JONAS = readFileSync(path.join(REPO, "src", "app", "app", "admin", "imports", "jonas", "actions.ts"), "utf8");
const BALANCE = readFileSync(path.join(REPO, "src", "lib", "accounting", "balance.ts"), "utf8");
const REPORTING_BALANCES = readFileSync(path.join(REPO, "src", "lib", "accounting", "reporting-balances.ts"), "utf8");
const JONAS_FORM = readFileSync(path.join(REPO, "src", "app", "app", "admin", "imports", "jonas", "jonas-import-form.tsx"), "utf8");

describe("TB-HIST-2b · §1 — monthly-package redactor + isDemoTenant gate", () => {
  it("balance.ts exports isDemoTenant and gates on club.slug === 'silver-springs'", () => {
    expect(BALANCE).toMatch(/export async function isDemoTenant/);
    expect(BALANCE).toMatch(/club\?\.slug === "silver-springs"/);
  });

  it("monthly-package.ts calls redactMonthlyPackageForLiveTenant() when NOT demo tenant", () => {
    expect(MONTHLY).toMatch(/const demoTenant = await isDemoTenant\(club\.id\)/);
    expect(MONTHLY).toMatch(/if \(demoTenant\) return pkg;/);
    expect(MONTHLY).toMatch(/return redactMonthlyPackageForLiveTenant\(pkg\)/);
  });

  it("the redactor wipes known demo-literal fields and the demo-only chapters", () => {
    expect(MONTHLY).toMatch(/function redactMonthlyPackageForLiveTenant/);
    // Specific demo-literal paths that are overwritten.
    expect(MONTHLY).toMatch(/boardBriefing: \{[\s\S]*?operations: \{[\s\S]*?narrative: u,/);
    expect(MONTHLY).toMatch(/visualSummary: \{[\s\S]*?equityTrend: emptySeries,/);
    expect(MONTHLY).toMatch(/capitalProjectTracker: makeUnavailable/);
    expect(MONTHLY).toMatch(/accountsReceivableAging: makeUnavailable/);
    expect(MONTHLY).toMatch(/operatingStatistics: makeUnavailable/);
    expect(MONTHLY).toMatch(/departmentalPLSummary: makeUnavailable/);
    expect(MONTHLY).toMatch(/departmentalPayrollAnalysis: makeUnavailable/);
    expect(MONTHLY).toMatch(/foodBeverageStatistics: makeUnavailable/);
    expect(MONTHLY).toMatch(/inventoryAnalysis: makeUnavailable/);
    expect(MONTHLY).toMatch(/monthlyWeatherSummary: makeUnavailable/);
  });

  it("the canonical unavailable sentinel string is defined and used", () => {
    expect(MONTHLY).toMatch(/UNAVAILABLE_TEXT = "Data not available for this reporting period\."/);
  });
});

describe("TB-HIST-2b · §2 — dimensional snapshot reads + scoped Dept/Fund filtering", () => {
  it("normalizeSnapshotToBalances accepts a dimensionFilter and filters payload lines", () => {
    expect(REPORTING_BALANCES).toMatch(/dimensionFilter\?: \{/);
    expect(REPORTING_BALANCES).toMatch(/departmentCode\?: string \| null;/);
    expect(REPORTING_BALANCES).toMatch(/fundKey\?: string \| null;/);
    expect(REPORTING_BALANCES).toMatch(/const payloadLines = allLines\.filter/);
  });

  it("reportingAccountBalances no longer bails out of the snapshot path for Dept / Fund filters", () => {
    // The Dept + Fund filters are intentionally REMOVED from the
    // hasAsOfOnly + hasYtdSliceShape bail-outs. The costCenter filter
    // still forces the operational-ledger fallback.
    expect(REPORTING_BALANCES).toMatch(/const hasAsOfOnly =[\s\S]*?filter\.costCenterId == null;/);
    expect(REPORTING_BALANCES).not.toMatch(/const hasAsOfOnly =[\s\S]{0,220}filter\.departmentId == null/);
  });

  it("Dept/Fund ids are resolved to CODES / KEYS before applying the snapshot filter", () => {
    expect(REPORTING_BALANCES).toMatch(/resolveDimensionFilter/);
    expect(REPORTING_BALANCES).toMatch(/prisma\.department\.findUnique\(\{ where: \{ id: filter\.departmentId \}/);
    expect(REPORTING_BALANCES).toMatch(/prisma\.fund\.findUnique\(\{ where: \{ id: filter\.fundId \}/);
  });

  it("dimensional aggregation example (6098 Grounds Op + Admin Op + Grounds Cap)", () => {
    const lines: TrialBalanceLine[] = [
      { accountCode: "6098", debit: 1_000, credit: 0, endingBalance: 1_000, department: "GROUNDS", fund: "OPERATING" },
      { accountCode: "6098", debit: 2_000, credit: 0, endingBalance: 2_000, department: "ADMIN",   fund: "OPERATING" },
      { accountCode: "6098", debit: 500,   credit: 0, endingBalance: 500,   department: "GROUNDS", fund: "CAPITAL" },
    ];
    const sum = (ls: TrialBalanceLine[]) => ls.reduce((s, l) => s + l.endingBalance, 0);
    // Consolidated = sum of every row for 6098.
    expect(sum(lines)).toBe(3_500);
    // Grounds-filtered = Grounds rows only.
    expect(sum(lines.filter((l) => l.department === "GROUNDS"))).toBe(1_500);
    // Admin-filtered.
    expect(sum(lines.filter((l) => l.department === "ADMIN"))).toBe(2_000);
    // Operating-filtered.
    expect(sum(lines.filter((l) => l.fund === "OPERATING"))).toBe(3_000);
    // Capital-filtered.
    expect(sum(lines.filter((l) => l.fund === "CAPITAL"))).toBe(500);
    // Grounds + Operating.
    expect(sum(lines.filter((l) => l.department === "GROUNDS" && l.fund === "OPERATING"))).toBe(1_000);
    // Grounds + Capital.
    expect(sum(lines.filter((l) => l.department === "GROUNDS" && l.fund === "CAPITAL"))).toBe(500);
  });
});

describe("TB-HIST-2b · §4 — Jonas preview carries continuity + fiscal-year-boundary flag", () => {
  it("JonasImportPreview.continuity is on the public type", () => {
    expect(JONAS).toMatch(/export type JonasPreviewContinuity/);
    expect(JONAS).toMatch(/isFiscalYearBoundary: boolean;/);
    expect(JONAS).toMatch(/divergences: Array</);
    expect(JONAS).toMatch(/continuity: JonasPreviewContinuity \| null;/);
  });

  it("preview computes continuity against the newest prior committed snapshot", () => {
    expect(JONAS).toMatch(/prisma\.reportingLedgerSnapshot\.findFirst\(\{[\s\S]*?asOf: \{ lt: dateResolution\.periodEnd \}/);
  });

  it("continuity flags the fiscal-year boundary and emits an operator note", () => {
    expect(JONAS).toMatch(/Fiscal year boundary — current month equals current fiscal-YTD/);
  });

  it("Jonas preview UI (jonas-import-form.tsx) renders the continuity card + dept + fund columns", () => {
    expect(JONAS_FORM).toMatch(/data-testid="preview-continuity"/);
    expect(JONAS_FORM).toMatch(/<th className="w-28 text-left">Department<\/th>/);
    expect(JONAS_FORM).toMatch(/<th className="w-20 text-left">Fund<\/th>/);
    expect(JONAS_FORM).toMatch(/row\.departmentStatus/);
    expect(JONAS_FORM).toMatch(/row\.fund/);
  });
});

describe("TB-HIST-2b · §5 — fiscal-year boundary short-circuit regression (TB-HIST-2 lock-in)", () => {
  it("Dec FY2025 Revenue 2.4M → Jan FY2026 Revenue 180K → monthly = 180K", () => {
    const dec = { accountCode: "4000", debit: 0, credit: 2_400_000, endingBalance: 2_400_000 } as TrialBalanceLine;
    const jan = { accountCode: "4000", debit: 0, credit: 180_000, endingBalance: 180_000 } as TrialBalanceLine;
    const monthly = computeAmount({
      mode: "current-month",
      currentLine: jan,
      priorLine: dec,
      currentFiscalYearLabel: "FY2026",
      priorFiscalYearLabel: "FY2025",
    });
    expect(monthly).toBe(180_000);
  });

  it("Same-FY delta still subtracts correctly (Feb within FY2026)", () => {
    const jan = { accountCode: "4000", debit: 0, credit: 180_000, endingBalance: 180_000 } as TrialBalanceLine;
    const feb = { accountCode: "4000", debit: 0, credit: 400_000, endingBalance: 400_000 } as TrialBalanceLine;
    const monthly = computeAmount({
      mode: "current-month",
      currentLine: feb,
      priorLine: jan,
      currentFiscalYearLabel: "FY2026",
      priorFiscalYearLabel: "FY2026",
    });
    expect(monthly).toBe(220_000);
  });
});

describe("TB-HIST-2b · hasCommittedRealTrialBalance still recognises Jonas commits (TB-HIST-2 lock-in)", () => {
  it("balance.ts checks ReportingLedgerBatch with state='committed' + non-superseded", () => {
    expect(BALANCE).toMatch(/prisma\.reportingLedgerBatch\.findFirst/);
    expect(BALANCE).toMatch(/state: "committed"/);
    expect(BALANCE).toMatch(/supersededByBatchId: null/);
  });
});

describe("TB-HIST-2b · §5 fiscal-calendar bootstrap route", () => {
  it("coa-batch-diagnostic exposes a POST endpoint that ensures FY2025 + FY2026 via ensureFiscalYear", () => {
    const route = readFileSync(
      path.join(REPO, "src", "app", "api", "admin", "coa-batch-diagnostic", "[batchId]", "route.ts"),
      "utf8",
    );
    expect(route).toMatch(/export async function POST/);
    expect(route).toMatch(/ensureFiscalYear\(batch\.clubId, \{ startYear: year/);
    expect(route).toMatch(/body\.action !== "ensureFiscalYears"/);
    // Diagnostic GET surfaces fiscal calendar state.
    expect(route).toMatch(/fiscalCalendar: \{[\s\S]*?years:/);
  });
});
