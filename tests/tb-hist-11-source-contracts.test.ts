// TB-HIST-11 (2026-10-02) — source-contract regression guards.
//
// Locks in the three primary wiring changes this slice ships:
//   1. Chapter X (Departmental P&L) consumes the real
//      `incomeStatementByDepartmentFromSnapshot` resolver +
//      `buildCouleeDepartmentalPLSummary` for live tenants, falling
//      back to the Silver Springs factory for demo tenants only.
//   2. Capital Fund + Stewardship auxiliary leaks eliminated on
//      live tenants: live path consumes `undefined` /
//      `UNAVAILABLE_STEWARDSHIP_AUX` respectively.
//   3. Redactor sees `dataSource === "live"` on Chapter X and leaves
//      it alone (does not overwrite real data with
//      "Data not available").
//
// End-to-end numeric reconciliation on the real Coulee January 2026
// snapshot lives at tests/e2e/tb-hist-11-chapter-x.staging.spec.ts.

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const MONTHLY_PKG = readFileSync(path.join(REPO, "src/lib/reporting/monthly-package.ts"), "utf8");
const DEPT_SUMMARY = readFileSync(path.join(REPO, "src/lib/reporting/departmental-pl-summary.ts"), "utf8");
const STEWARDSHIP = readFileSync(path.join(REPO, "src/lib/reporting/stewardship-dashboard-adapter.ts"), "utf8");

// --------------------------------------------------------------
// §15.1-3 — Chapter X real-data wire
// --------------------------------------------------------------
describe("TB-HIST-11 §15.1-3 — Chapter X consumes the real snapshot-dimensional resolver", () => {
  it("monthly-package.ts imports the TB-HIST-10 resolver + the new Coulee Chapter X builder", () => {
    expect(MONTHLY_PKG).toMatch(/import\s*\{[^}]*incomeStatementByDepartmentFromSnapshot[^}]*\}\s*from\s*"@\/lib\/accounting\/dept-pl-from-snapshot"/);
    expect(MONTHLY_PKG).toMatch(/buildCouleeDepartmentalPLSummary[\s\S]{0,100}from\s*"@\/lib\/reporting\/departmental-pl-summary"/);
  });

  it("Chapter X computation branches on `hasRealData`", () => {
    expect(MONTHLY_PKG).toMatch(/let\s+departmentalPLSummary:[\s\S]{0,500}if\s*\(hasRealData\)\s*\{[\s\S]{0,500}incomeStatementByDepartmentFromSnapshot\(\s*club\.id,\s*reportingPeriod\.periodStart,\s*reportingPeriod\.periodEnd/);
    expect(MONTHLY_PKG).toMatch(/buildCouleeDepartmentalPLSummary\(\{[\s\S]{0,200}rows:\s*deptPL\.rows/);
  });

  it("the pkg literal references the pre-computed value — not an unconditional Silver Springs call", () => {
    // Within the pkg literal, Chapter X is now just a bare reference
    // to the resolved `departmentalPLSummary` variable.
    expect(MONTHLY_PKG).toMatch(/const\s+pkg:\s*MonthlyReportingPackage\s*=\s*\{[\s\S]{0,25000}departmentalPLSummary,/);
    // The old unconditional literal shape is gone.
    expect(MONTHLY_PKG).not.toMatch(/departmentalPLSummary:\s*buildSilverSpringsDepartmentalPLSummary\(/);
  });

  it("the Coulee Chapter X builder emits dataSource: \"live\"", () => {
    expect(DEPT_SUMMARY).toMatch(/export function buildCouleeDepartmentalPLSummary/);
    expect(DEPT_SUMMARY).toMatch(/dataSource:\s*"live"\s+as\s+ReportingDataSource/);
    // Does not consume Silver Springs seeds.
    const couleeBuilder = DEPT_SUMMARY.match(/export function buildCouleeDepartmentalPLSummary[\s\S]*?(?=\nexport |\n$)/)?.[0] ?? "";
    expect(couleeBuilder).not.toMatch(/SILVER_SPRINGS/i);
    expect(couleeBuilder).not.toMatch(/buildSilverSprings/);
  });
});

// --------------------------------------------------------------
// §15.3 — Redactor leaves real-data Chapter X alone
// --------------------------------------------------------------
describe("TB-HIST-11 §15.3 — redactor skips Chapter X when dataSource is \"live\"", () => {
  it("redactor's Chapter X line checks dataSource before wiping", () => {
    expect(MONTHLY_PKG).toMatch(/departmentalPLSummary:[\s\S]{0,300}pkg\.departmentalPLSummary\.dataSource\s*===\s*"live"[\s\S]{0,200}pkg\.departmentalPLSummary[\s\S]{0,200}makeUnavailable\(pkg\.departmentalPLSummary,\s*u\)/);
  });
});

// --------------------------------------------------------------
// §15.9 — Missing Budget does not suppress Actual
// --------------------------------------------------------------
describe("TB-HIST-11 §15.9 — Coulee cards render Actual even when Budget is unavailable", () => {
  it("buildCouleeDepartmentalPLSummary emits Revenue/COS/OpEx/NetIncome rows with real values", () => {
    const couleeBuilder = DEPT_SUMMARY.match(/export function buildCouleeDepartmentalPLSummary[\s\S]*?(?=\nexport |\n$)/)?.[0] ?? "";
    expect(couleeBuilder).toMatch(/label:\s*"Revenue"/);
    expect(couleeBuilder).toMatch(/label:\s*"Cost of Sales"/);
    expect(couleeBuilder).toMatch(/label:\s*"Operating Expenses"/);
    expect(couleeBuilder).toMatch(/label:\s*"Net Income"/);
    // Budget rows explicitly render "Unavailable" (not $0 or missing).
    expect(couleeBuilder).toMatch(/label:\s*"Budget YTD"[\s\S]{0,100}value:\s*"Unavailable"/);
    expect(couleeBuilder).toMatch(/label:\s*"Variance vs\.\s*Budget"[\s\S]{0,100}value:\s*"Unavailable"/);
  });
});

// --------------------------------------------------------------
// §15.10-11 — Zero live Silver Springs auxiliaries
// --------------------------------------------------------------
describe("TB-HIST-11 §15.10-11 — no live SILVER_SPRINGS_* auxiliary consumption", () => {
  it("Stewardship live path consumes UNAVAILABLE_STEWARDSHIP_AUX (not Silver Springs)", () => {
    // The call-site ternary.
    expect(MONTHLY_PKG).toMatch(/auxiliaryInputs:\s*hasRealData\s*\?\s*UNAVAILABLE_STEWARDSHIP_AUX\s*:\s*SILVER_SPRINGS_STEWARDSHIP_AUX/);
    // The unavailable sibling exists in the adapter module.
    expect(STEWARDSHIP).toMatch(/export const UNAVAILABLE_STEWARDSHIP_AUX:\s*StewardshipAuxiliaryInputs\s*=/);
  });

  it("Capital Fund live path consumes `undefined` (not Silver Springs)", () => {
    expect(MONTHLY_PKG).toMatch(/auxiliaryInputs:\s*hasRealData\s*\?\s*undefined\s*:\s*SILVER_SPRINGS_CAPITAL_FUND_AUX/);
    // demoFallback on live tenants throws (never invoked in practice).
    expect(MONTHLY_PKG).toMatch(/demoFallback:\s*hasRealData[\s\S]{0,500}throw\s+new\s+Error\("Capital Fund demoFallback invoked on a live tenant/);
  });

  it("Executive Summary live path (TB-HIST-8) remains guarded by hasRealData", () => {
    expect(MONTHLY_PKG).toMatch(/const\s+execAuxiliaryInputs\s*=\s*hasRealData\s*\?\s*undefined\s*:\s*SILVER_SPRINGS_EXEC_SUMMARY_AUX/);
  });
});
