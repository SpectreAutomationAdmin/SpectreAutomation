// REPORT-LIVE-3 (2026-10-04) — source-contract pins for the January
// Actual vs Budget wiring across Operating Results, Department
// Performance, Payroll Department.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const OPRES = path.join(REPO, "src/lib/reporting/operating-results.ts");
const DEPT = path.join(REPO, "src/lib/reporting/department-net-performance.ts");
const PAYROLL = path.join(REPO, "src/lib/reporting/payroll-analysis.ts");
const DEPTPL = path.join(REPO, "src/lib/accounting/dept-pl-from-snapshot.ts");
const RESOLVER = path.join(REPO, "src/lib/reporting/budget-resolver.ts");
const PACKAGE = path.join(REPO, "src/lib/reporting/monthly-package.ts");

describe("REPORT-LIVE-3 §6-8 — Operating Results Budget wiring", () => {
  it("snapshot-fallback branch pulls Budget per month via resolveBudgetMonthlyIncomeStatement", () => {
    const src = readFileSync(OPRES, "utf8");
    expect(src).toMatch(/resolveBudgetMonthlyIncomeStatement/);
    expect(src).toMatch(/monthIndex = m\.endDate\.getUTCMonth\(\)/);
    expect(src).toMatch(/budgetNoi: monthlyBudgetNoi\[monthIndex\]/);
  });

  it("snapshot-fallback branch pins Budget NOI into ytdBudgetNoi (not hardcoded 0)", () => {
    const src = readFileSync(OPRES, "utf8");
    const branch = src.match(/if \(!hasPlottableFpData\)[\s\S]*?\n  \}/)?.[0] ?? "";
    expect(branch).toMatch(/sYtdBudgetNoi = sum\(enriched\.map/);
    expect(branch).not.toMatch(/ytdBudgetNoi: 0,/);
  });
});

describe("REPORT-LIVE-3 §10-13 — Department Performance Budget wiring", () => {
  it("live builder fetches both Actual (incomeStatementByDepartmentFromSnapshot) + Budget (resolveBudget) in parallel", () => {
    const src = readFileSync(DEPT, "utf8");
    expect(src).toMatch(/incomeStatementByDepartmentFromSnapshot/);
    expect(src).toMatch(/resolveBudget\(\{/);
    expect(src).toMatch(/Promise\.all\(\[/);
  });

  it("live builder maps per-dept Budget via sign-flipped YTD aggregate (display sign)", () => {
    const src = readFileSync(DEPT, "utf8");
    expect(src).toMatch(/budgetByDeptCode\.set\(d\.departmentCode, -ytdRaw\)/);
  });

  it("live builder emits factual commentary (no favourable/unfavourable wording)", () => {
    const src = readFileSync(DEPT, "utf8");
    const live = src.match(/buildDepartmentNetPerformanceLive[\s\S]*?return buildDepartmentNetPerformanceData/)?.[0] ?? "";
    expect(live).toMatch(/no favourable\/unfavourable judgment applied/);
    expect(live).not.toMatch(/\b(ahead|behind|on track|off track)\b/i);
  });
});

describe("REPORT-LIVE-3 §21-24 — Payroll resolver + per-dept extension", () => {
  it("DepartmentPLSnapshotRow carries an additive payroll Decimal field", () => {
    const src = readFileSync(DEPTPL, "utf8");
    expect(src).toMatch(/payroll:\s*Prisma\.Decimal/);
  });

  it("dept-pl loop classifies payroll via fsGroupKey === 'IS_PAYROLL' (not account-name regex)", () => {
    const src = readFileSync(DEPTPL, "utf8");
    expect(src).toMatch(/isPayroll = b\.fsGroupKey === "IS_PAYROLL"/);
    expect(src).toMatch(/if \(isPayroll\) bucket\.payroll = bucket\.payroll\.plus\(amount\)/);
  });

  it("netIncome identity preserved: netIncome = revenue - cogs - opex (payroll stays inside opex)", () => {
    const src = readFileSync(DEPTPL, "utf8");
    expect(src).toMatch(/netIncome:\s*v\.revenue\.minus\(v\.cogs\)\.minus\(v\.opex\)/);
    // The payroll bucket is added via the opex branch — confirming
    // the additive subset relationship.
    expect(src).toMatch(/bucket\.opex = bucket\.opex\.plus\(amount\);\s*\n\s*if \(isPayroll\)/);
  });

  it("resolveBudgetPayrollByDepartment aggregates IS_PAYROLL budget lines by department", () => {
    const src = readFileSync(RESOLVER, "utf8");
    expect(src).toMatch(/export async function resolveBudgetPayrollByDepartment/);
    expect(src).toMatch(/fsGroup:\s*\{\s*key:\s*"IS_PAYROLL"\s*\}/);
  });
});

describe("REPORT-LIVE-3 §19/§25-26 — Payroll Department null-safe", () => {
  it("PayrollDeptRowInput widens budget + priorYear to number | null", () => {
    const src = readFileSync(PAYROLL, "utf8");
    const t = src.match(/export type PayrollDeptRowInput[\s\S]*?^\};/m)?.[0] ?? "";
    expect(t).toMatch(/budget:\s*number\s*\|\s*null/);
    expect(t).toMatch(/priorYear:\s*number\s*\|\s*null/);
  });

  it("buildPayrollDepartmentData null-reduces per-row inputs (never 0-fills a missing comparator)", () => {
    const src = readFileSync(PAYROLL, "utf8");
    expect(src).toMatch(/const anyBudget = inputs\.departments\.some\(\(d\) => d\.budget != null\)/);
    expect(src).toMatch(/const anyPriorYear = inputs\.departments\.some\(\(d\) => d\.priorYear != null\)/);
    expect(src).toMatch(/vsBudget = budgetDollars != null \? actualDollars - budgetDollars : null/);
  });

  it("buildPayrollDepartmentLive exists + uses the extended per-dept payroll resolver + Budget", () => {
    const src = readFileSync(PAYROLL, "utf8");
    expect(src).toMatch(/export async function buildPayrollDepartmentLive/);
    expect(src).toMatch(/incomeStatementByDepartmentFromSnapshot/);
    expect(src).toMatch(/resolveBudgetPayrollByDepartment/);
  });

  it("live Payroll builder leaves priorYear null — never fabricates $0 historical payroll", () => {
    const src = readFileSync(PAYROLL, "utf8");
    const live = src.match(/export async function buildPayrollDepartmentLive[\s\S]*?return buildPayrollDepartmentData/)?.[0] ?? "";
    expect(live).toMatch(/priorYear: null/);
    expect(live).not.toMatch(/priorYear:\s*0/);
  });
});

describe("REPORT-LIVE-3 §3/§31 — factual-only commentary on live tenants", () => {
  it("formatOperatingDashboard branches to factual narrative when corridor is the default placeholder", () => {
    const src = readFileSync(PACKAGE, "utf8");
    expect(src).toMatch(/const corridorIsDefault/);
    expect(src).toMatch(/corridorIsDefault\s*\?\s*buildFactualOperatingNarrative/);
  });

  it("buildFactualOperatingNarrative mentions favourable/unfavourable ONLY in the negated-judgment footer string", () => {
    const src = readFileSync(PACKAGE, "utf8");
    const start = src.indexOf("function buildFactualOperatingNarrative");
    expect(start).toBeGreaterThan(0);
    const slice = src.slice(start, start + 2000);
    // Count all occurrences of each word and verify they ALL sit
    // inside the single approved footer sentence
    // "no favourable/unfavourable judgment applied".
    // Use \b to prevent "favourable" from matching inside "unfavourable".
    const favCount = (slice.match(/\bfavou?rable\b/gi) ?? []).length;
    const unfavCount = (slice.match(/\bunfavou?rable\b/gi) ?? []).length;
    const approvedCount = (slice.match(/no favou?rable\/unfavou?rable judgment/gi) ?? []).length;
    // The approved footer contains ONE "favourable" + ONE "unfavourable",
    // so total approved occurrences = 2 × approvedCount. All other
    // occurrences are violations.
    expect(favCount + unfavCount).toBe(2 * approvedCount);
    // Also hard-reject other evaluative words entirely.
    const otherForbidden = [
      /\bahead of policy\b/i,
      /\bbehind budget\b/i,
      /\bon track\b/i,
      /\boff track\b/i,
      /\bhealthy\b/i,
      /\bconcerning\b/i,
    ];
    for (const re of otherForbidden) {
      expect(slice).not.toMatch(re);
    }
  });

  it("buildFactualOperatingNarrative emits mathematical-variance language", () => {
    const src = readFileSync(PACKAGE, "utf8");
    expect(src).toMatch(/mathematical variance/);
  });
});

describe("REPORT-LIVE-3 §28 — redactor preserves newly-live cards", () => {
  it("stewardshipDashboard block preserves payrollDepartment", () => {
    const src = readFileSync(PACKAGE, "utf8");
    expect(src).toMatch(/payrollDepartment:\s*pkg\.stewardshipDashboard\.payrollDepartment/);
  });

  it("REPORT-LIVE-2 preservations still intact (equity, operating, departmentPerformance)", () => {
    const src = readFileSync(PACKAGE, "utf8");
    expect(src).toMatch(/equity:\s*pkg\.stewardshipDashboard\.equity/);
    expect(src).toMatch(/operating:\s*pkg\.stewardshipDashboard\.operating/);
    expect(src).toMatch(/departmentPerformance:\s*pkg\.stewardshipDashboard\.departmentPerformance/);
  });

  it("duesSubsidy + payrollRatioTrend still carry precise unavailable reasons (SCORECARD-PARTIAL-1 moved scorecards to live preservation)", () => {
    const src = readFileSync(PACKAGE, "utf8");
    // SCORECARD-PARTIAL-1 §24 — scorecards are now preserved verbatim
    // on live tenants (buildOperatingScorecardLive/buildCapitalScorecardLive
    // already emit metric-level nullable rows).
    expect(src).toMatch(/scorecards:\s*pkg\.stewardshipDashboard\.scorecards/);
    expect(src).toMatch(/duesSubsidy:\s*makeUnavailable\([^,]+,\s*UNAVAIL_DUES_SUBSIDY\)/);
    expect(src).toMatch(/payrollRatioTrend:\s*makeUnavailable\([^,]+,\s*UNAVAIL_PAYROLL_TREND\)/);
  });
});
