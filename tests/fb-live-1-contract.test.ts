// FB-LIVE-1 (2026-10-06) — Section XIII contract regressions.
//
//   §A  Live-tenant Section XIII does not consume the Silver Springs
//       seed numerics on the live branch.
//   §B  Section XIII Actuals come from the SAME resolver Section X
//       uses (`incomeStatementByDepartmentFromSnapshot`) — no parallel
//       income-statement calculation, no account-name regex.
//   §C  Section XIII Budget comes from the canonical `BudgetLine`
//       table filtered by F&B department + fsGroupKey. Same semantic
//       as `resolveBudgetPayrollByDepartment`.
//   §D  POS-dependent metrics remain UNAVAILABLE on the live branch
//       and emit the directive-named source-not-connected copy.
//   §E  Zero ≠ Unavailable preserved — monthly chart arrays become
//       `[]` on unavailability, not zero-value rows.
//   §F  monthly-package wires live tenants to the canonical builder
//       and preserves live Section XIII through the redactor.
//   §G  Reconciliation shape — classification MUST use `AccountType`
//       + `fsGroupKey` only (never account-name/number regex).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const MONTHLY         = path.join(REPO, "src/lib/reporting/monthly-package.ts");
const SECTION_XIII    = path.join(REPO, "src/lib/reporting/food-beverage-statistics.ts");
const FB_RESOLVER     = path.join(REPO, "src/lib/reporting/fb-financial-resolver.ts");
const SECTION_X_RSV   = path.join(REPO, "src/lib/accounting/dept-pl-from-snapshot.ts");

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/[ \t]+\/\/.*$/gm, "");
}

describe("FB-LIVE-1 §A — live tenant Section XIII has no demo numerics", () => {
  const src = readFileSync(SECTION_XIII, "utf8");

  it("buildCouleeFoodBeverageStatistics exists + emits dataSource: 'live'", () => {
    expect(src).toMatch(/export function buildCouleeFoodBeverageStatistics\(opts: \{/);
    const idx = src.indexOf("export function buildCouleeFoodBeverageStatistics");
    const body = src.slice(idx);
    expect(body).toMatch(/dataSource: "live"/);
  });

  it("live Coulee body does not contain Silver Springs demo revenue numerics", () => {
    const idx = src.indexOf("export function buildCouleeFoodBeverageStatistics");
    const body = stripComments(src.slice(idx));
    // Silver Springs baseline numbers that must not leak:
    //   January revenue=380_000 · cost=153_000
    //   December revenue=470_000
    //   Food share 0.598 · Wine 0.200 · Liquor 0.124 · Beer 0.038
    for (const forbidden of [/380_000/, /153_000/, /470_000/, /0\.598/, /0\.200/, /0\.124/, /0\.038/, /BUDGET_COST_PCT = 38\.4/, /PRIOR_YEAR_COST_PCT/, /MONTHLY_BASELINE/, /avgServerFtes = 6\.4/, /memberSatScore = 87/]) {
      expect(body, `live builder must not contain ${forbidden.source}`).not.toMatch(forbidden);
    }
  });
});

describe("FB-LIVE-1 §B — Actuals share Section X's resolver", () => {
  const src = readFileSync(FB_RESOLVER, "utf8");

  it("fb-financial-resolver imports incomeStatementByDepartmentFromSnapshot", () => {
    expect(src).toMatch(/import \{ incomeStatementByDepartmentFromSnapshot \} from "@\/lib\/accounting\/dept-pl-from-snapshot"/);
  });

  it("fb-financial-resolver calls incomeStatementByDepartmentFromSnapshot(clubId, ytdStart, ytdEnd)", () => {
    expect(stripComments(src)).toMatch(/incomeStatementByDepartmentFromSnapshot\(clubId, ytdStart, ytdEnd\)/);
  });

  it("fb-financial-resolver finds the F&B row by department NAME (not by regex / id guess)", () => {
    expect(src).toMatch(/departmentName\.toLowerCase\(\) === FB_DEPARTMENT_NAME_LOWER/);
    expect(src).toMatch(/export const FB_DEPARTMENT_NAME_LOWER = "food & beverage"/);
  });
});

describe("FB-LIVE-1 §C — Budget comes from canonical BudgetLine query", () => {
  const src = stripComments(readFileSync(FB_RESOLVER, "utf8"));

  it("budget side queries BudgetLine filtered by departmentId", () => {
    expect(src).toMatch(/prisma\.budgetLine\.findMany/);
    expect(src).toMatch(/departmentId: input\.departmentId/);
  });

  it("classification uses fsGroupKey / accountType (never account-name regex)", () => {
    expect(src).toMatch(/fsGroupKey\.startsWith\("IS_COGS_"\) \|\| fsGroupKey === "IS_COGS"/);
    expect(src).toMatch(/fsGroupKey === "IS_PAYROLL"/);
    expect(src).toMatch(/l\.account\.type === "REVENUE"/);
    expect(src).toMatch(/l\.account\.type === "EXPENSE"/);
    // No account-name substring matching.
    expect(src).not.toMatch(/\.includes\(/);
    expect(src).not.toMatch(/\.toLowerCase\(\)\.indexOf/);
  });

  it("budget side respects fundApplicability (operating only)", () => {
    expect(src).toMatch(/isOperatingFundTag\(l\.account\.fundApplicability\)/);
  });

  it("budget side skips IS_DEPRECIATION", () => {
    expect(src).toMatch(/if \(fsGroupKey === "IS_DEPRECIATION"\) continue/);
  });
});

describe("FB-LIVE-1 §D — POS-dependent metrics UNAVAILABLE on live branch", () => {
  const src = readFileSync(SECTION_XIII, "utf8");

  it("Primary row Total Covers tile is held at '—' + source-not-connected sub", () => {
    const idx = src.indexOf("export function buildCouleeFoodBeverageStatistics");
    const body = src.slice(idx);
    expect(body).toMatch(/key: "total-covers",[\s\S]{0,200}valueLabel: "—",[\s\S]{0,120}F&B POS covers source not connected/);
  });

  it("Secondary row Revenue per Server / Member Satisfaction / Average Check / Monthly Gratuities all UNAVAILABLE", () => {
    const idx = src.indexOf("export function buildCouleeFoodBeverageStatistics");
    const body = src.slice(idx);
    expect(body).toMatch(/key: "revenue-per-server"[\s\S]{0,120}valueLabel: "—"/);
    expect(body).toMatch(/Server-FTE source not connected/);
    expect(body).toMatch(/key: "member-satisfaction"[\s\S]{0,120}valueLabel: "—"/);
    expect(body).toMatch(/Member-survey source not connected/);
    expect(body).toMatch(/key: "average-check"[\s\S]{0,120}valueLabel: "—"/);
    expect(body).toMatch(/key: "monthly-gratuities"[\s\S]{0,120}valueLabel: "—"/);
    expect(body).toMatch(/F&B POS gratuity source not connected/);
  });
});

describe("FB-LIVE-1 §E — Zero ≠ Unavailable for charts", () => {
  const src = readFileSync(SECTION_XIII, "utf8");

  it("live builder emits monthlyCoverCounts = [] (NOT 12 zero-value entries)", () => {
    const idx = src.indexOf("export function buildCouleeFoodBeverageStatistics");
    const body = src.slice(idx);
    expect(body).toMatch(/monthlyCoverCounts: ReadonlyArray<FbMonthlyPoint> = \[\]/);
  });

  it("live builder emits revenueByCategory = [] (NOT seeded shares)", () => {
    const idx = src.indexOf("export function buildCouleeFoodBeverageStatistics");
    const body = src.slice(idx);
    expect(body).toMatch(/revenueByCategory: ReadonlyArray<FbCategorySlice> = \[\]/);
  });

  it("live builder emits foodCostTrend.points = [] (NOT 12 zero-value entries)", () => {
    const idx = src.indexOf("export function buildCouleeFoodBeverageStatistics");
    const body = src.slice(idx);
    expect(body).toMatch(/points: \[\] as ReadonlyArray/);
  });
});

describe("FB-LIVE-1 §F — monthly-package wiring + redactor preservation", () => {
  const src = readFileSync(MONTHLY, "utf8");

  it("monthly-package imports buildCouleeFoodBeverageStatistics + resolveFbFinancialYtd", () => {
    expect(src).toMatch(/import \{[\s\S]*?buildCouleeFoodBeverageStatistics[\s\S]*?\} from "@\/lib\/reporting\/food-beverage-statistics"/);
    expect(src).toMatch(/import \{ resolveFbFinancialYtd \} from "@\/lib\/reporting\/fb-financial-resolver"/);
  });

  it("Section XIII branches on hasRealData", () => {
    expect(src).toMatch(/foodBeverageStatistics: hasRealData/);
    expect(src).toMatch(/await resolveFbFinancialYtd/);
    expect(src).toMatch(/buildCouleeFoodBeverageStatistics\(\{[\s\S]*?fbYtd,/);
  });

  it("redactor preserves live Section XIII", () => {
    expect(src).toMatch(/foodBeverageStatistics:\s*\n\s*pkg\.foodBeverageStatistics\.dataSource === "live"/);
  });
});

describe("FB-LIVE-1 §G — No account-name regex in F&B financial path", () => {
  const resolverSrc = stripComments(readFileSync(FB_RESOLVER, "utf8"));
  const sxiiiSrc    = stripComments(readFileSync(SECTION_XIII, "utf8"));

  it("resolver uses no .includes('food') / .indexOf('food') / regex on account names", () => {
    expect(resolverSrc).not.toMatch(/accountName\.(toLowerCase|includes|indexOf)/i);
    expect(resolverSrc).not.toMatch(/\/food\/i/);
    expect(resolverSrc).not.toMatch(/\/beverage\/i/);
  });

  it("Section X resolver already enforced the no-regex rule — regression check", () => {
    const src = stripComments(readFileSync(SECTION_X_RSV, "utf8"));
    expect(src).toMatch(/fsGroupKey/);
    expect(src).not.toMatch(/accountName\.toLowerCase\(\)\.includes/);
  });
});
