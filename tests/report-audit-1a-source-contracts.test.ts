// REPORT-AUDIT-1A (2026-10-05) — source-contract pins for the two
// final January remediation items before February authorization.
//
// §1  Section III PP&E Reinvestment honors ppeSplitAvailable signal
//     (renders — when the BS doesn't carry a gross/accum-dep split).
// §2  Section XII Departmental Payroll Analysis consumes the SAME
//     canonical resolvers Section II uses (no parallel calculator;
//     no Employee roster as financial Actual).

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPO = path.resolve(__dirname, "..");
const ADAPTER = path.join(REPO, "src/lib/reporting/stewardship-dashboard-adapter.ts");
const MONTHLY = path.join(REPO, "src/lib/reporting/monthly-package.ts");
const SECTION_XII = path.join(REPO, "src/lib/reporting/departmental-payroll-analysis.ts");

describe("REPORT-AUDIT-1A §1 — Section III PP&E Reinvestment availability", () => {
  it("StewardshipAvailabilityInputs declares ppeSplitAvailable: boolean", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const type = src.match(/export type StewardshipAvailabilityInputs = \{[\s\S]*?\};/)?.[0] ?? "";
    expect(type).toMatch(/ppeSplitAvailable: boolean/);
  });

  it("buildPpeReinvestmentCard renders unavailable when ppeSplitAvailable is false", () => {
    const src = readFileSync(ADAPTER, "utf8");
    const body = src.match(/function buildPpeReinvestmentCard\([\s\S]*?^}/m)?.[0] ?? "";
    expect(body).toMatch(/availability\.ppeSplitAvailable === false/);
    expect(body).toMatch(/assessment: "PP&E component split not configured\."/);
    expect(body).toMatch(/actual: "—"/);
    expect(body).toMatch(/tone: "neutral"/);
  });

  it("buildCapitalKpiCards threads availability into buildPpeReinvestmentCard", () => {
    const src = readFileSync(ADAPTER, "utf8");
    expect(src).toMatch(/buildPpeReinvestmentCard\(bs, aux, availability\)/);
  });

  it("monthly-package passes ppeSplitAvailable: false for Coulee (BS merges PP&E into BS_CAPITAL_ASSETS)", () => {
    const src = readFileSync(MONTHLY, "utf8");
    const call = src.match(/const stewardshipBundle = await getStewardshipForClub\(\{[\s\S]*?\}\);/)?.[0] ?? "";
    expect(call).toMatch(/ppeSplitAvailable: false/);
  });
});

describe("REPORT-AUDIT-1A §2 — Section XII canonical payroll data path", () => {
  it("Section XII builder imports the canonical payroll resolvers (not a new calculator)", () => {
    const src = readFileSync(SECTION_XII, "utf8");
    expect(src).toMatch(/import \{ resolveHistoricalPayrollByDepartment \} from "@\/lib\/reporting\/historical-payroll-by-department"/);
    expect(src).toMatch(/import \{ resolveBudgetPayrollByDepartment \} from "@\/lib\/reporting\/budget-resolver"/);
  });

  it("Section XII does NOT read from prisma.employee / payrollBatch / payrollLine (no roster-as-financial-Actual)", () => {
    const src = readFileSync(SECTION_XII, "utf8");
    for (const forbidden of [
      /prisma\.employee\./,
      /prisma\.employmentAssignment\./,
      /prisma\.payrollBatch\./,
      /prisma\.payrollLine\./,
      /prisma\.payrollProfile\./,
    ]) {
      expect(src, `Section XII must not read from ${forbidden.source}`).not.toMatch(forbidden);
    }
  });

  it("buildCouleeDepartmentalPayrollAnalysis is async + takes projection", () => {
    const src = readFileSync(SECTION_XII, "utf8");
    expect(src).toMatch(/export async function buildCouleeDepartmentalPayrollAnalysis\(opts: \{[\s\S]*?projection: FsGroupProjection \| null;/);
  });

  it("builder reads Actual from historical resolver + Budget from the Budget resolver", () => {
    const src = readFileSync(SECTION_XII, "utf8");
    // Scope by splitting on "export async function buildCouleeDepartmentalPayrollAnalysis"
    // and taking the slice from there to end-of-file (last builder in the file).
    const idx = src.indexOf("export async function buildCouleeDepartmentalPayrollAnalysis");
    const body = idx >= 0 ? src.slice(idx) : "";
    expect(body).toMatch(/await resolveHistoricalPayrollByDepartment\(/);
    expect(body).toMatch(/await resolveBudgetPayrollByDepartment\(/);
  });

  it("Section XII filters out departments with zero Actual AND zero Budget (renders only authoritative activity)", () => {
    const src = readFileSync(SECTION_XII, "utf8");
    const idx = src.indexOf("export async function buildCouleeDepartmentalPayrollAnalysis");
    const body = idx >= 0 ? src.slice(idx) : "";
    expect(body).toMatch(/if \(ytdActual === 0 && ytdBudget === 0\) continue/);
  });

  it("wages / taxes & benefits split rendered as 0 + unavailable callout (no fabricated split)", () => {
    const src = readFileSync(SECTION_XII, "utf8");
    const idx = src.indexOf("export async function buildCouleeDepartmentalPayrollAnalysis");
    const body = idx >= 0 ? src.slice(idx) : "";
    expect(body).toMatch(/wages: 0,[\s\S]*?taxesBenefits: 0,/);
    expect(body).toMatch(/Compensation split unavailable/);
    expect(body).toMatch(/Wages \/ taxes & benefits split is not configured/);
  });

  it("Payroll-to-Revenue reads canonical Operating Revenue from projection.totals (no hardcoded ratio)", () => {
    const src = readFileSync(SECTION_XII, "utf8");
    const idx = src.indexOf("export async function buildCouleeDepartmentalPayrollAnalysis");
    const body = idx >= 0 ? src.slice(idx) : "";
    expect(body).toMatch(/projection\.totals\.operatingRevenue\.ytdActual/);
    // No hardcoded "59.2%" ratio (Silver Springs demo).
    expect(body).not.toMatch(/59\.2/);
  });

  it("Section XII dataSource emitted as 'live' when canonical builder used", () => {
    const src = readFileSync(SECTION_XII, "utf8");
    const idx = src.indexOf("export async function buildCouleeDepartmentalPayrollAnalysis");
    const body = idx >= 0 ? src.slice(idx) : "";
    expect(body).toMatch(/dataSource: "live"/);
  });

  it("monthly-package wires live tenants to the canonical builder; demo keeps Silver Springs", () => {
    const src = readFileSync(MONTHLY, "utf8");
    expect(src).toMatch(/departmentalPayrollAnalysis: hasRealData[\s\S]*?await buildCouleeDepartmentalPayrollAnalysis\(\{[\s\S]*?projection: fsGroupProjection,[\s\S]*?\}\)[\s\S]*?: buildSilverSpringsDepartmentalPayrollAnalysis/);
  });

  it("redactor preserves live Section XII (does not makeUnavailable when dataSource is 'live')", () => {
    const src = readFileSync(MONTHLY, "utf8");
    const redactorBlock = src.match(/departmentalPayrollAnalysis:[\s\S]*?pkg\.departmentalPayrollAnalysis\.dataSource === "live"[\s\S]*?: makeUnavailable\(pkg\.departmentalPayrollAnalysis, u\),/)?.[0];
    expect(redactorBlock).toBeTruthy();
  });
});

describe("REPORT-AUDIT-1A — no accounting-data mutation + no new calculator", () => {
  it("adapter + Section XII never write to prisma", () => {
    for (const f of [ADAPTER, SECTION_XII]) {
      const src = readFileSync(f, "utf8");
      expect(src, `${path.basename(f)} must not call prisma writes`)
        .not.toMatch(/prisma\.\w+\.(create|update|upsert|delete|createMany|updateMany|deleteMany)/);
    }
  });

  it("Section XII does not duplicate the regex-based classifier from the old adapter", () => {
    const src = readFileSync(SECTION_XII, "utf8");
    const idx = src.indexOf("export async function buildCouleeDepartmentalPayrollAnalysis");
    const body = idx >= 0 ? src.slice(idx) : "";
    expect(body).not.toMatch(/\/payroll\|benefit\|wages\//i);
  });
});
