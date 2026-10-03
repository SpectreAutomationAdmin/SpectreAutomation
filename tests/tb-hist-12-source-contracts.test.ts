// TB-HIST-12 (2026-10-03) — source-contract regression guards.
//
// Locks in the primary wiring changes this slice ships:
//   1. Executive status (operations / financialHealth / capitalProgram)
//      renders UNAVAILABLE on live tenants (hasRealData === true) and
//      preserves the Silver Springs demo literals on demo tenants.
//   2. The Board package exposes `reportingDataAsOfIso` + the Chair's
//      Dashboard renders a `board-package-data-through` pill when the
//      field is populated.
//   3. Chapter II/III supplemental cards (departmentPerformance,
//      duesSubsidy, payrollDepartment, payrollRatioTrend) run with
//      empty seeds on live tenants — no Silver Springs numeric
//      computation on a live tenant's package build.
//
// End-to-end numeric reconciliation + dept-set parity on the real
// Coulee January 2026 snapshot lives at
// tests/e2e/tb-hist-12-chapter-x-dept-set.staging.spec.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const MONTHLY_PKG = readFileSync(path.join(REPO, "src/lib/reporting/monthly-package.ts"), "utf8");
const MONTHLY_PAGE_BODY = readFileSync(
  path.join(REPO, "src/app/app/admin/reporting/monthly/MonthlyReportingPackageBody.tsx"),
  "utf8",
);

// --------------------------------------------------------------
// §1 — Executive status provenance
// --------------------------------------------------------------
describe("TB-HIST-12 §1 — Executive status provenance (operations / financialHealth / capitalProgram)", () => {
  it("buildOperationsBriefing takes hasRealData and renders Unavailable on the live branch", () => {
    expect(MONTHLY_PKG).toMatch(/function buildOperationsBriefing\([\s\S]{0,400}hasRealData:\s*boolean/);
    expect(MONTHLY_PKG).toMatch(/function buildOperationsBriefing[\s\S]{0,2000}if\s*\(hasRealData\)\s*\{[\s\S]{0,400}statusLabel:\s*"Unavailable"/);
  });

  it("buildFinancialHealthBriefing exists, takes hasRealData, and renders Unavailable on live", () => {
    expect(MONTHLY_PKG).toMatch(/function buildFinancialHealthBriefing\(\s*hasRealData:\s*boolean/);
    expect(MONTHLY_PKG).toMatch(/function buildFinancialHealthBriefing[\s\S]{0,2000}if\s*\(hasRealData\)\s*\{[\s\S]{0,400}statusLabel:\s*"Unavailable"/);
  });

  it("buildCapitalProgramBriefing exists, takes hasRealData, and renders Unavailable on live", () => {
    expect(MONTHLY_PKG).toMatch(/function buildCapitalProgramBriefing\(\s*hasRealData:\s*boolean/);
    expect(MONTHLY_PKG).toMatch(/function buildCapitalProgramBriefing[\s\S]{0,2000}if\s*\(hasRealData\)\s*\{[\s\S]{0,400}statusLabel:\s*"Unavailable"/);
  });

  it("the pkg literal wires all three briefings through the hasRealData-aware builders", () => {
    expect(MONTHLY_PKG).toMatch(/operations:\s*buildOperationsBriefing\(executiveSummary,\s*hasRealData\)/);
    expect(MONTHLY_PKG).toMatch(/financialHealth:\s*buildFinancialHealthBriefing\(hasRealData\)/);
    expect(MONTHLY_PKG).toMatch(/capitalProgram:\s*buildCapitalProgramBriefing\(hasRealData\)/);
  });
});

// --------------------------------------------------------------
// §2 — Board package freshness provenance
// --------------------------------------------------------------
describe("TB-HIST-12 §2 — Board package reportingDataAsOfIso + freshness pill", () => {
  it("MonthlyReportingPackage type exposes `reportingDataAsOfIso?: string | null`", () => {
    expect(MONTHLY_PKG).toMatch(/reportingDataAsOfIso\?:\s*string\s*\|\s*null/);
  });

  it("getMonthlyReportingPackage resolves reportingDataAsOfIso from the latest committed TB snapshot", () => {
    expect(MONTHLY_PKG).toMatch(/let\s+reportingDataAsOfIso:\s*string\s*\|\s*null\s*=\s*null/);
    expect(MONTHLY_PKG).toMatch(/entityKind:\s*"trial-balance"[\s\S]{0,200}batchState:\s*"committed"[\s\S]{0,200}asOf:\s*\{\s*lte:\s*reportingPeriod\.periodEnd/);
  });

  it("the pkg literal emits reportingDataAsOfIso", () => {
    expect(MONTHLY_PKG).toMatch(/preparedAt:\s*periodEnd\.toISOString\(\)\.slice\(0,\s*10\)[\s\S]{0,400}reportingDataAsOfIso,/);
  });

  it("ChairsDashboard renders the board-package-data-through pill when the field is populated", () => {
    expect(MONTHLY_PAGE_BODY).toMatch(/data-testid="board-package-data-through"/);
    expect(MONTHLY_PAGE_BODY).toMatch(/pkg\.reportingDataAsOfIso/);
    expect(MONTHLY_PAGE_BODY).toMatch(/Financial data through/);
  });
});

// --------------------------------------------------------------
// §3 — Chapter II/III supplemental Silver Springs computation guards
// --------------------------------------------------------------
describe("TB-HIST-12 §3 — Chapter II/III supplemental cards do not consume Silver Springs seeds on live tenants", () => {
  it("departmentPerformance call-site branches on hasRealData with empty seeds on the live branch", () => {
    expect(MONTHLY_PKG).toMatch(/departmentPerformance:\s*hasRealData\s*\?\s*buildDepartmentNetPerformanceData\(\[\],\s*"Unavailable"\)\s*:\s*buildDepartmentNetPerformanceData\(\s*SILVER_SPRINGS_DEPARTMENT_INPUTS/);
  });

  it("duesSubsidy branches on hasRealData with zero seeds on the live branch", () => {
    expect(MONTHLY_PKG).toMatch(/duesSubsidy:\s*hasRealData\s*\?\s*buildDuesSubsidyData\(0,\s*0,\s*\[\]\)\s*:\s*buildDuesSubsidyData\(\s*SILVER_SPRINGS_DUES_TOTAL/);
  });

  it("payrollDepartment branches on hasRealData with empty seeds on the live branch", () => {
    expect(MONTHLY_PKG).toMatch(/payrollDepartment:\s*hasRealData\s*\?\s*buildPayrollDepartmentData\(\{\s*departments:\s*\[\]/);
  });

  it("payrollRatioTrend branches on hasRealData with empty seeds on the live branch", () => {
    expect(MONTHLY_PKG).toMatch(/payrollRatioTrend:\s*hasRealData\s*\?\s*buildPayrollRatioTrendData\(\{\s*monthlyActual:\s*\[\]/);
  });
});
