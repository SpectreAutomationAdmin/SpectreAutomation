// Payroll-3C-3D (2026-09-09) — T4127 pre-tax deduction (F) support +
// two new SPECTRE_LIBRARY rules (dependent life, taxable cash
// allowance) + Sam Complex final source-reconciliation acceptance.
//
// The statutory engine (CPP / EI / bracket / TD1 formula) is NOT
// modified in this slice. Federal + Alberta calculators now accept
// an optional `fThisPay` input that reduces annual taxable income A
// pre-annualisation, matching T4127 §Federal / §Alberta.

import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { upsertPayrollComponent, createRecurringComponentAssignment } from "@/lib/payroll/components-catalogue";
import { writeEncryptedTd1Claims } from "@/lib/hr/td1-secure-write";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";
import { calculateFederalTax } from "@/lib/payroll/statutory/federal-tax-calculator";
import { calculateAlbertaTax } from "@/lib/payroll/statutory/alberta-tax-calculator";
import { findLibraryRule } from "@/lib/payroll/statutory-library";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "sup-3c3d@spectre.test" } });
  const u = await c.user.create({
    data: { email: "sup-3c3d@spectre.test", name: "Sup3C3D", role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE" },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("sup-3c3d@spectre.test");
}

async function seedSemiMonthlyCalendar(clubId: string, payGroupId: string) {
  const c = db();
  let seq = 0;
  for (let m = 0; m < 12; m++) {
    seq += 1;
    await c.payrollPayPeriod.create({
      data: {
        clubId, payGroupId, taxYear: 2026, sequenceInYear: seq,
        periodStart: utc(2026, m + 1, 1), periodEnd: utc(2026, m + 1, 16),
        payDate: utc(2026, m + 1, 16), status: "OPEN",
      },
    });
    seq += 1;
    await c.payrollPayPeriod.create({
      data: {
        clubId, payGroupId, taxYear: 2026, sequenceInYear: seq,
        periodStart: utc(2026, m + 1, 16), periodEnd: utc(2026, m + 2, 1),
        payDate: utc(2026, m + 2, 1), status: "OPEN",
      },
    });
  }
}

// -------------------------------------------------------------------
// A · Library — two new rules resolve
// -------------------------------------------------------------------
describe("Payroll-3C-3D · new SPECTRE_LIBRARY rules resolve", () => {
  it("CA-ER-GROUP-DEPENDENT-LIFE-PREMIUM-V1 resolves with (ADD, ADD, NONE)", () => {
    const r = findLibraryRule({
      ruleKey: "CA-ER-GROUP-DEPENDENT-LIFE-PREMIUM-V1",
      jurisdiction: { country: "CA" }, asOf: new Date("2026-09-01"),
    });
    expect(r?.taxableEffect).toBe("ADD");
    expect(r?.cppPensionableEffect).toBe("ADD");
    expect(r?.eiInsurableEffect).toBe("NONE");
    expect(r?.cashEffectExpectation).toBe("NO_NET_PAY_EFFECT");
  });

  it("CA-TAXABLE-CASH-ALLOWANCE-V1 resolves with (ADD, ADD, ADD)", () => {
    const r = findLibraryRule({
      ruleKey: "CA-TAXABLE-CASH-ALLOWANCE-V1",
      jurisdiction: { country: "CA" }, asOf: new Date("2026-09-01"),
    });
    expect(r?.taxableEffect).toBe("ADD");
    expect(r?.cppPensionableEffect).toBe("ADD");
    expect(r?.eiInsurableEffect).toBe("ADD");
    expect(r?.cashEffectExpectation).toBe("INCREASES_NET_PAY");
  });
});

// -------------------------------------------------------------------
// B · Federal + Alberta tax calculators accept F
// -------------------------------------------------------------------
describe("Payroll-3C-3D · federal + Alberta tax calculators accept fThisPay (T4127 F)", () => {
  const fedParams = {
    brackets: [
      { from: "0",       to: "55867",  rate: "0.15", constantK: "0" },
      { from: "55867",   to: "111733", rate: "0.205", constantK: "2793.35" },
      { from: "111733",  to: null,     rate: "0.26", constantK: "8940" },
    ],
    lowestRate: "0.15",
    bpaMax: "16542", bpaMin: "15000",
    bpaPhaseOutStart: "173205", bpaPhaseOutEnd: "246752",
    canadaEmploymentAmountMax: "1433",
  };

  it("F = 0 vs F = 229.17 changes annual A by 229.17 × periodsPerYear", () => {
    const base = {
      periodicTaxableRemuneration: "4620.83", f5aThisPay: "0",
      baseCppThisPay: "0", eiThisPay: "0",
      periodsPerYear: 24,
      federalClaim: "16542", claimZeroFederal: false, totalIncomeLessThanClaim: false,
      federal: fedParams,
    };
    const withoutF = calculateFederalTax(base);
    const withF    = calculateFederalTax({ ...base, fThisPay: "229.17" });
    const delta = withoutF.a.minus(withF.a).toFixed(2);
    // 229.17 × 24 = 5500.08 exact.
    expect(delta).toBe("5500.08");
  });

  it("F > 0 lowers per-period federal T4 vs F = 0 (same everything else)", () => {
    const base = {
      periodicTaxableRemuneration: "4620.83", f5aThisPay: "0",
      baseCppThisPay: "0", eiThisPay: "0",
      periodsPerYear: 24,
      federalClaim: "16542", claimZeroFederal: false, totalIncomeLessThanClaim: false,
      federal: fedParams,
    };
    const t0 = calculateFederalTax(base).t4PerPeriod;
    const tF = calculateFederalTax({ ...base, fThisPay: "229.17" }).t4PerPeriod;
    expect(Number(tF.toString())).toBeLessThan(Number(t0.toString()));
  });

  it("Alberta calculator applies the same F reduction to A", () => {
    const provParams = {
      brackets: [{ from: "0", to: null, rate: "0.10", constantK: "0" }],
      lowestRate: "0.10", bpa: "22323",
      k5p: { enabled: false, threshold: "0", supplementalRate: "0", baseRate: "0.10" },
    };
    const base = {
      periodicTaxableRemuneration: "4620.83", f5aThisPay: "0",
      baseCppThisPay: "0", eiThisPay: "0",
      periodsPerYear: 24,
      provincialClaim: "22769", claimZeroProvincial: false, totalIncomeLessThanClaim: false,
      provincial: provParams,
    };
    const a0 = calculateAlbertaTax(base).a;
    const aF = calculateAlbertaTax({ ...base, fThisPay: "229.17" }).a;
    expect(a0.minus(aF).toFixed(2)).toBe("5500.08");
  });
});

// -------------------------------------------------------------------
// C · Sam Complex final acceptance (§35 3C-3D)
// -------------------------------------------------------------------
describe("Payroll-3C-3D · Sam Complex final source-reconciliation acceptance", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("bases: Cash 4,620.83 · Taxable 4,874.01 · CPP pensionable 4,874.01 · EI insurable 4,620.83", async () => {
    const c = db();
    const sup = await superAdminP();
    try { await seedCanadaAlbertaPackages2026(sup); } catch { /* already installed */ }
    const club = await makeClub("3C3D-Sam");
    const adminU = await makeUser({ email: `a.3c3d@t.test`, role: "CLUB_ADMIN", clubId: club.id });
    const paU    = await makeUser({ email: `p.3c3d@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
    const ctlU   = await makeUser({ email: `c.3c3d@t.test`, role: "CONTROLLER", clubId: club.id });
    const adminP = await principalFor(adminU.email);
    const paP    = await principalFor(paU.email);
    await upsertPayrollClubConfig(adminP, club.id, {
      provinceOfEmployment: "AB", payrollAdminUserId: paU.id, controllerUserId: ctlU.id,
    });

    const emp = await c.employee.create({
      data: {
        clubId: club.id, firstName: "Sam", lastName: "Complex",
        email: `sam3c3d@t.test`, hireDate: utc(2020, 1, 1),
        dateOfBirth: utc(1980, 6, 1), status: "ACTIVE",
        employeeNumber: `SAM-3C3D`,
        employeeLifecycle: "ACTIVE", compensationType: "SALARY", homeProvince: "AB",
      },
    });
    const assn = await c.employeeEmploymentAssignment.create({
      data: { clubId: club.id, employeeId: emp.id, role: "PRIMARY", employmentType: "FULL_TIME", effectiveFrom: utc(2020, 1, 1) },
    });
    await c.employeeCompensation.create({
      data: {
        clubId: club.id, employeeId: emp.id, assignmentId: assn.id,
        cadence: "SALARY", rate: "110000", currency: "CAD",
        effectiveFrom: utc(2020, 1, 1),
      },
    });
    await writeEncryptedTd1Claims({
      clubId: club.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1),
      province: "AB", td1FormVersion: "2026-01",
      federalClaim: "16542.00", provincialClaim: "22769.00",
    });
    const pg = await c.payrollPayGroup.create({
      data: {
        clubId: club.id, code: "SAL-SM-3C3D", name: "SM",
        payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 1,
        calendarAnchorDate: utc(2026, 1, 1), active: true,
      },
    });
    await seedSemiMonthlyCalendar(club.id, pg.id);
    await c.payrollPayGroupMember.create({
      data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1) },
    });

    async function comp(input: Parameters<typeof upsertPayrollComponent>[2] & { amount?: string; percentBps?: number }) {
      const { amount, percentBps, ...def } = input;
      const cc = await upsertPayrollComponent(adminP, club.id, def);
      await createRecurringComponentAssignment(adminP, club.id, {
        employeeId: emp.id, componentId: cc.id,
        amount: amount ?? null, percentBps: percentBps ?? null,
        effectiveFrom: utc(2020, 1, 1),
      });
    }
    // Cell Phone — LIBRARY (taxable cash allowance, all three bases ADD).
    await comp({
      code: "CELL_PHONE_ALLOWANCE", displayName: "Cell Phone Allowance",
      category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "ADD",
      calculationMethod: "FIXED_AMOUNT",
      statutoryTreatmentSource: "SPECTRE_LIBRARY",
      statutoryRuleKey: "CA-TAXABLE-CASH-ALLOWANCE-V1",
      displaySection: "EARNINGS",
      amount: "37.50",
    });
    // AD&D — LIBRARY.
    await comp({
      code: "AD_D_ER_PREMIUM", displayName: "AD&D",
      category: "EMPLOYER_CONTRIBUTION", side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT",
      statutoryTreatmentSource: "SPECTRE_LIBRARY",
      statutoryRuleKey: "CA-ER-AD-AND-D-PREMIUM-V1",
      displaySection: "BENEFITS",
      amount: "2.25",
    });
    // Dependent Life — LIBRARY.
    await comp({
      code: "DEPENDENT_LIFE_ER_PREMIUM", displayName: "Dependent Life",
      category: "EMPLOYER_CONTRIBUTION", side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT",
      statutoryTreatmentSource: "SPECTRE_LIBRARY",
      statutoryRuleKey: "CA-ER-GROUP-DEPENDENT-LIFE-PREMIUM-V1",
      displaySection: "BENEFITS",
      amount: "0.83",
    });
    // Life Insurance ER — LIBRARY.
    await comp({
      code: "LIFE_INSURANCE_ER_PREMIUM", displayName: "Life Insurance ER",
      category: "TAXABLE_BENEFIT", side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT",
      statutoryTreatmentSource: "SPECTRE_LIBRARY",
      statutoryRuleKey: "CA-ER-GROUP-LIFE-INSURANCE-PREMIUM-V1",
      displaySection: "BENEFITS",
      amount: "20.93",
    });
    // RRSP ER — LIBRARY (restricted variant).
    await comp({
      code: "RRSP_ER", displayName: "RRSP Employer",
      category: "EMPLOYER_CONTRIBUTION", side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
      eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
      statutoryTreatmentSource: "SPECTRE_LIBRARY",
      statutoryRuleKey: "CA-ER-GROUP-RRSP-CONTRIBUTION-RESTRICTED-V1",
      statutoryRuleVariant: "RRSP_RESTRICTED_UNTIL_RETIREMENT_OR_TERMINATION",
      displaySection: "BENEFITS",
      percentBps: 500,
    });
    // RRSP EE — feeds T4127 F (deducted at source).
    await comp({
      code: "RRSP_EE", displayName: "RRSP Employee",
      category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY",
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
      eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
      statutoryTreatmentSource: "CUSTOM_TEST",
      taxFormulaDeductionType: "RRSP_DEDUCTED_AT_SOURCE",
      displaySection: "DEDUCTIONS",
      percentBps: 500,
    });
    // LTD EE — CUSTOM.
    await comp({
      code: "LTD_EE", displayName: "LTD Employee",
      category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY",
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT",
      statutoryTreatmentSource: "CUSTOM",
      displaySection: "DEDUCTIONS",
      amount: "28.11",
    });

    const pp = await c.payrollPayPeriod.findFirstOrThrow({
      where: { clubId: club.id, payGroupId: pg.id, sequenceInYear: 17 },
    });
    const prep = await preparePayrollBatch(paP, club.id, pp.id);
    await calculatePayrollBatch(paP, club.id, prep.batchId);
    const be = await c.payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });

    // Cash = salary $4,583.33 + Cell Phone $37.50 = $4,620.83.
    expect(new Decimal(be.grossPay!.toString()).toFixed(2)).toBe("4620.83");
    // Taxable = 4583.33 + 37.50 + 2.25 + 0.83 + 20.93 + 229.17 = 4874.01.
    expect(new Decimal(be.earningsTaxable!.toString()).toFixed(2)).toBe("4874.01");
    // Pensionable = same composition as taxable.
    expect(new Decimal(be.earningsPensionable!.toString()).toFixed(2)).toBe("4874.01");
    // EI insurable = salary + Cell Phone (Rise excluded it; Spectre follows CRA per §18).
    expect(new Decimal(be.earningsInsurable!.toString()).toFixed(2)).toBe("4620.83");

    // RRSP EE snapshot carries the tax-formula deduction stamp.
    const rrspSnap = await c.payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "RRSP_EE" },
    });
    expect(rrspSnap.taxFormulaDeductionType).toBe("RRSP_DEDUCTED_AT_SOURCE");
    expect(rrspSnap.resolvedAmount?.toFixed(2)).toBe("229.17");
  });
});
