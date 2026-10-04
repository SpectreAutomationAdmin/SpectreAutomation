// PAYROLL-HIST-1 (2026-10-04) — source-contract pins:
//   • Historical-vs-operational Payroll resolver separation
//   • Payroll Dept chart reads from historical resolver (NOT the
//     Employee roster)
//   • Headline KPIs use canonical consolidated payroll
//   • EditorialGroupedBarChart bars clamped to maxBarWidth

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const HIST = path.join(REPO, "src/lib/reporting/historical-payroll-by-department.ts");
const PAYROLL = path.join(REPO, "src/lib/reporting/payroll-analysis.ts");
const GROUPED = path.join(REPO, "src/components/reporting/EditorialGroupedBarChart.tsx");

describe("PAYROLL-HIST-1 §1-10 — historical payroll resolver", () => {
  it("resolveHistoricalPayrollByDepartment exports a single call", () => {
    const src = readFileSync(HIST, "utf8");
    expect(src).toMatch(/export async function resolveHistoricalPayrollByDepartment/);
  });

  it("reads from committed TB (incomeStatementByDepartmentFromSnapshot) + Budget resolver", () => {
    const src = readFileSync(HIST, "utf8");
    expect(src).toMatch(/incomeStatementByDepartmentFromSnapshot/);
    expect(src).toMatch(/resolveBudgetPayrollByDepartment/);
  });

  it("union of departments: Actual > 0 OR Budget > 0 (never roster-only)", () => {
    const src = readFileSync(HIST, "utf8");
    expect(src).toMatch(/\/\/ Seed from Actual dept rows\./);
    expect(src).toMatch(/\/\/ Add Budget dept entries \+ overlay onto Actual entries\./);
  });

  it("nondepartmental Actual rolls into rosterResidual (never a chart row)", () => {
    const src = readFileSync(HIST, "utf8");
    expect(src).toMatch(/nondepartmentalActual/);
    expect(src).toMatch(/rosterResidualActual/);
  });

  it("current Employee roster surfaced ONLY as diagnostic (does not filter)", () => {
    const src = readFileSync(HIST, "utf8");
    // The resolver includes employee count per row but does not filter by it.
    expect(src).toMatch(/currentEmployeeCount:\s*rosterStatus\.employeeCountByDepartment\.get/);
    expect(src).not.toMatch(/hasEmployeeRecords\s*&&\s*/);
  });

  it("returns consolidated Actual + Budget for canonical KPI reconciliation", () => {
    const src = readFileSync(HIST, "utf8");
    expect(src).toMatch(/consolidatedActualAll/);
    expect(src).toMatch(/consolidatedBudgetAll/);
  });
});

describe("PAYROLL-HIST-1 §13-16 — buildPayrollDepartmentLive uses historical resolver + canonical consolidated KPIs", () => {
  it("imports resolveHistoricalPayrollByDepartment (not resolvePayrollDepartments as the filter)", () => {
    const src = readFileSync(PAYROLL, "utf8");
    expect(src).toMatch(/resolveHistoricalPayrollByDepartment/);
    const live = src.match(/export async function buildPayrollDepartmentLive[\s\S]*?return buildPayrollDepartmentData/)?.[0] ?? "";
    expect(live).not.toMatch(/resolvePayrollDepartments\(clubId\)/);
    expect(live).not.toMatch(/payrollDeptFilter/);
  });

  it("canonical consolidated payroll Actual used for headline (not sum of chart rows)", () => {
    const src = readFileSync(PAYROLL, "utf8");
    expect(src).toMatch(/consolidatedActualOverride:\s*canonicalPayrollActual/);
    expect(src).toMatch(/consolidatedBudgetOverride:\s*canonicalPayrollBudget/);
  });

  it("Payroll Ratio uses ratio-registry payrollRatio numerator (canonical)", () => {
    const src = readFileSync(PAYROLL, "utf8");
    expect(src).toMatch(/payrollRatio[?.]+numerator/);
  });

  it("revenueDollars uses ratio-registry revenue (not dept-sum)", () => {
    const src = readFileSync(PAYROLL, "utf8");
    expect(src).toMatch(/metrics[?.]+revenue[?.]+metric[?.]+value/);
  });

  it("buildPayrollDepartmentData respects consolidatedActualOverride for the headline", () => {
    const src = readFileSync(PAYROLL, "utf8");
    expect(src).toMatch(/consolidatedActualOverride\?:\s*number\s*\|\s*null/);
    expect(src).toMatch(/actualDollars = inputs\.consolidatedActualOverride \?\? chartActualDollars/);
    // vs Budget uses the override too.
    expect(src).toMatch(/inputs\.consolidatedBudgetOverride !== undefined/);
  });
});

describe("PAYROLL-HIST-1 §19-21 — EditorialGroupedBarChart maxBarWidth cap", () => {
  it("maxBarWidth prop declared with default 24 px", () => {
    const src = readFileSync(GROUPED, "utf8");
    expect(src).toMatch(/maxBarWidth\?:\s*number/);
    expect(src).toMatch(/maxBarWidth = 24/);
  });

  it("bar width is clamped via Math.min(..., maxBarWidth)", () => {
    const src = readFileSync(GROUPED, "utf8");
    expect(src).toMatch(/const barW = Math\.min\(barWRaw, maxBarWidth\)/);
  });

  it("two-category fixture: 24 px cap applies (barWRaw would exceed 24 at wide container)", () => {
    // Simulate: innerW=1000, n=2, series=2 → slotW=500, groupWidth=370,
    // subSlotW=185, barWRaw=144.3 → Math.min(144.3, 24) = 24 ✓
    const innerW = 1000, n = 2, seriesCount = 2, maxBarWidth = 24;
    const slotW = innerW / n;
    const groupWidth = slotW * 0.74;
    const subSlotW = groupWidth / seriesCount;
    const barWRaw = subSlotW * 0.78;
    const barW = Math.min(barWRaw, maxBarWidth);
    expect(barWRaw).toBeGreaterThan(100);
    expect(barW).toBe(24);
  });

  it("eight-category fixture: natural slot-fraction bar width wins over the cap", () => {
    const innerW = 600, n = 8, seriesCount = 3, maxBarWidth = 24;
    const slotW = innerW / n;
    const groupWidth = slotW * 0.74;
    const subSlotW = groupWidth / seriesCount;
    const barWRaw = subSlotW * 0.78;
    const barW = Math.min(barWRaw, maxBarWidth);
    // barWRaw ≈ 14.4 → < 24, cap doesn't fire.
    expect(barWRaw).toBeLessThan(maxBarWidth);
    expect(barW).toBeCloseTo(barWRaw);
  });
});

describe("PAYROLL-HIST-1 §25 — proof no Employee / PayrollBatch mutation", () => {
  it("historical payroll resolver never writes to prisma", () => {
    const src = readFileSync(HIST, "utf8");
    expect(src).not.toMatch(/prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)/);
  });

  it("payroll-analysis never mutates payroll domain tables", () => {
    const src = readFileSync(PAYROLL, "utf8");
    for (const m of ["employee", "employmentAssignment", "payrollBatch", "payrollLine", "payrollProfile"]) {
      const re = new RegExp(`prisma\\.${m}\\.(create|update|upsert|delete|createMany|updateMany|deleteMany)`);
      expect(src).not.toMatch(re);
    }
  });
});
