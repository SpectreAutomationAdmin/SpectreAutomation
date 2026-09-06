// Payroll-3C-3C (2026-09-09) — SPECTRE_LIBRARY provenance + Sam
// acceptance after verified Canadian statutory rules are applied.
//
// This suite verifies §29 (library provenance) and §30 (Sam
// acceptance) of the 3C-3C brief. It does NOT change the statutory
// engine (CPP / EI / tax formulas) — only the component-level
// treatment inputs the calculator consumes.

import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { upsertPayrollComponent, createRecurringComponentAssignment } from "@/lib/payroll/components-catalogue";
import { writeEncryptedTd1Claims } from "@/lib/hr/td1-secure-write";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";
import { findLibraryRule, assertLibraryRuleResolves, RULES } from "@/lib/payroll/statutory-library";
import { ValidationError } from "@/lib/errors";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "sup-3c3c@spectre.test" } });
  const u = await c.user.create({
    data: { email: "sup-3c3c@spectre.test", name: "Sup3C3C", role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE" },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("sup-3c3c@spectre.test");
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
// A · Library provenance (§29)
// -------------------------------------------------------------------
describe("Payroll-3C-3C · statutory library — provenance + fail-closed guard", () => {
  it("resolves every currently-registered rule for an in-range pay date", () => {
    for (const r of RULES) {
      const found = findLibraryRule({
        ruleKey: r.ruleKey, variant: r.variant,
        jurisdiction: r.jurisdiction, asOf: new Date("2026-09-01"),
      });
      expect(found?.ruleKey).toBe(r.ruleKey);
    }
  });

  it("REFUSES an unknown rule key (unknown SPECTRE_LIBRARY cannot resolve)", () => {
    expect(() => assertLibraryRuleResolves({
      ruleKey: "CA-NOT-A-REAL-RULE-V1",
      jurisdiction: { country: "CA" }, asOf: new Date("2026-09-01"),
    })).toThrow(/SPECTRE_LIBRARY rule not found/);
  });

  it("REFUSES a rule that is not effective on the given asOf date", () => {
    expect(() => assertLibraryRuleResolves({
      ruleKey: "CA-ER-AD-AND-D-PREMIUM-V1",
      jurisdiction: { country: "CA" },
      asOf: new Date("1900-01-01"), // before effectiveFrom
    })).toThrow();
  });

  it("distinguishes RRSP WITHDRAWABLE vs RESTRICTED variants — different EI treatment", () => {
    const withdrawable = findLibraryRule({
      ruleKey: "CA-ER-GROUP-RRSP-CONTRIBUTION-WITHDRAWABLE-V1",
      variant: "RRSP_WITHDRAWABLE",
      jurisdiction: { country: "CA" }, asOf: new Date("2026-09-01"),
    });
    const restricted = findLibraryRule({
      ruleKey: "CA-ER-GROUP-RRSP-CONTRIBUTION-RESTRICTED-V1",
      variant: "RRSP_RESTRICTED_UNTIL_RETIREMENT_OR_TERMINATION",
      jurisdiction: { country: "CA" }, asOf: new Date("2026-09-01"),
    });
    expect(withdrawable?.eiInsurableEffect).toBe("ADD");
    expect(restricted?.eiInsurableEffect).toBe("NONE");
    expect(withdrawable?.taxableEffect).toBe("ADD");
    expect(restricted?.taxableEffect).toBe("ADD");
    expect(withdrawable?.cppPensionableEffect).toBe("ADD");
    expect(restricted?.cppPensionableEffect).toBe("ADD");
  });
});

// -------------------------------------------------------------------
// B · Catalogue upsert refuses SPECTRE_LIBRARY without a matching rule
// -------------------------------------------------------------------
describe("Payroll-3C-3C · SPECTRE_LIBRARY provenance guard on component upsert", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("REFUSES SPECTRE_LIBRARY with no statutoryRuleKey", async () => {
    const sup = await superAdminP();
    const club = await makeClub("3C3C-Guard");
    const adminU = await makeUser({ email: `a.guard@t.test`, role: "CLUB_ADMIN", clubId: club.id });
    const adminP = await principalFor(adminU.email);
    void sup;

    await expect(upsertPayrollComponent(adminP, club.id, {
      code: "TEST_LIB_NOKEY", displayName: "no key",
      category: "TAXABLE_BENEFIT", side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT",
      statutoryTreatmentSource: "SPECTRE_LIBRARY",
      displaySection: "BENEFITS",
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("REFUSES SPECTRE_LIBRARY with a ruleKey that does not resolve", async () => {
    const club = await makeClub("3C3C-Guard-Bad");
    const adminU = await makeUser({ email: `a.badkey@t.test`, role: "CLUB_ADMIN", clubId: club.id });
    const adminP = await principalFor(adminU.email);
    await expect(upsertPayrollComponent(adminP, club.id, {
      code: "TEST_LIB_BADKEY", displayName: "bad key",
      category: "TAXABLE_BENEFIT", side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT",
      statutoryTreatmentSource: "SPECTRE_LIBRARY",
      statutoryRuleKey: "CA-DOES-NOT-EXIST-V9",
      displaySection: "BENEFITS",
    })).rejects.toThrow();
  });

  it("REFUSES SPECTRE_LIBRARY when inline effects diverge from the rule", async () => {
    const club = await makeClub("3C3C-Guard-Divergent");
    const adminU = await makeUser({ email: `a.diverge@t.test`, role: "CLUB_ADMIN", clubId: club.id });
    const adminP = await principalFor(adminU.email);
    await expect(upsertPayrollComponent(adminP, club.id, {
      code: "TEST_LIB_DIVERGE", displayName: "divergent",
      category: "TAXABLE_BENEFIT", side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT",
      // Deliberately wrong — AD&D library rule says EI = NONE, not ADD.
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "ADD",
      calculationMethod: "FIXED_AMOUNT",
      statutoryTreatmentSource: "SPECTRE_LIBRARY",
      statutoryRuleKey: "CA-ER-AD-AND-D-PREMIUM-V1",
      displaySection: "BENEFITS",
    })).rejects.toBeInstanceOf(ValidationError);
  });

  it("PERMITS SPECTRE_LIBRARY when key + variant + effects all match", async () => {
    const club = await makeClub("3C3C-Guard-OK");
    const adminU = await makeUser({ email: `a.ok@t.test`, role: "CLUB_ADMIN", clubId: club.id });
    const adminP = await principalFor(adminU.email);
    const r = await upsertPayrollComponent(adminP, club.id, {
      code: "TEST_LIB_OK", displayName: "ok",
      category: "TAXABLE_BENEFIT", side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT",
      statutoryTreatmentSource: "SPECTRE_LIBRARY",
      statutoryRuleKey: "CA-ER-AD-AND-D-PREMIUM-V1",
      displaySection: "BENEFITS",
    });
    expect(r.createdOrUpdated).toBe("created");
  });
});

// -------------------------------------------------------------------
// C · Sam acceptance after library rules
// -------------------------------------------------------------------
describe("Payroll-3C-3C · Sam Complex acceptance after verified library rules", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Sam bases move: taxable $4,873.18, pensionable $4,873.18, EI still $4,583.33 (Dependent Life $0.83 remains CUSTOM_PENDING)", async () => {
    const c = db();
    const sup = await superAdminP();
    try { await seedCanadaAlbertaPackages2026(sup); } catch { /* already installed */ }
    const club = await makeClub("3C3C-Sam");
    const adminU = await makeUser({ email: `a.sam@t.test`, role: "CLUB_ADMIN", clubId: club.id });
    const paU    = await makeUser({ email: `p.sam@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
    const ctlU   = await makeUser({ email: `c.sam@t.test`, role: "CONTROLLER", clubId: club.id });
    const adminP = await principalFor(adminU.email);
    const paP    = await principalFor(paU.email);
    await upsertPayrollClubConfig(adminP, club.id, {
      provinceOfEmployment: "AB", payrollAdminUserId: paU.id, controllerUserId: ctlU.id,
    });

    const emp = await c.employee.create({
      data: {
        clubId: club.id, firstName: "Sam", lastName: "Complex",
        email: `sam@t.test`, hireDate: utc(2020, 1, 1),
        dateOfBirth: utc(1980, 6, 1), status: "ACTIVE",
        employeeNumber: `SAM-3C3C`,
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
      federalClaim: "16452.00", provincialClaim: "22769.00",
    });
    const pg = await c.payrollPayGroup.create({
      data: {
        clubId: club.id, code: "SAL-SM-3C3C", name: "Salary Semi-Monthly",
        payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 1,
        calendarAnchorDate: utc(2026, 1, 1), active: true,
      },
    });
    await seedSemiMonthlyCalendar(club.id, pg.id);
    await c.payrollPayGroupMember.create({
      data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1) },
    });

    // Component catalogue mirroring the updated Sam fixture.
    async function comp(input: Parameters<typeof upsertPayrollComponent>[2] & { amount?: string; percentBps?: number }) {
      const { amount, percentBps, ...def } = input;
      const cc = await upsertPayrollComponent(adminP, club.id, def);
      await createRecurringComponentAssignment(adminP, club.id, {
        employeeId: emp.id, componentId: cc.id,
        amount: amount ?? null, percentBps: percentBps ?? null,
        effectiveFrom: utc(2020, 1, 1),
      });
    }
    // AD&D — SPECTRE_LIBRARY.
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
    // Life Insurance ER — SPECTRE_LIBRARY.
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
    // Dependent Life — CUSTOM_PENDING (NONE across the board).
    await comp({
      code: "DEPENDENT_LIFE_ER_PREMIUM", displayName: "Dependent Life",
      category: "EMPLOYER_CONTRIBUTION", side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT",
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT",
      statutoryTreatmentSource: "CUSTOM",
      displaySection: "BENEFITS",
      amount: "0.83",
    });
    // RRSP ER — SPECTRE_LIBRARY (restricted variant).
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
    // RRSP EE — CUSTOM_TEST (unchanged, §11).
    await comp({
      code: "RRSP_EE", displayName: "RRSP Employee",
      category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY",
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
      eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
      statutoryTreatmentSource: "CUSTOM_TEST",
      displaySection: "DEDUCTIONS",
      percentBps: 500,
    });
    // LTD EE — CUSTOM (unchanged, §12).
    await comp({
      code: "LTD_EE", displayName: "LTD Employee",
      category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY",
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT",
      statutoryTreatmentSource: "CUSTOM",
      displaySection: "DEDUCTIONS",
      amount: "28.11",
    });
    // Cell Phone — CUSTOM (unchanged, §13).
    await comp({
      code: "CELL_PHONE_ALLOWANCE", displayName: "Cell Phone Allowance",
      category: "ALLOWANCE", side: "EMPLOYEE", cashEffect: "INCREASES_NET_PAY",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT",
      statutoryTreatmentSource: "CUSTOM",
      displaySection: "EARNINGS",
      amount: "37.50",
    });

    const pp = await c.payrollPayPeriod.findFirstOrThrow({
      where: { clubId: club.id, payGroupId: pg.id, sequenceInYear: 17 },
    });
    const prep = await preparePayrollBatch(paP, club.id, pp.id);
    await calculatePayrollBatch(paP, club.id, prep.batchId);
    const be = await c.payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });

    // Cash unchanged.
    expect(new Decimal(be.grossPay!.toString()).toFixed(2)).toBe("4620.83");
    // Taxable: salary 4583.33 + Cell 37.50 + AD&D 2.25 + Life 20.93 + RRSP ER 229.17 = 4873.18.
    // (Dependent Life 0.83 is CUSTOM_PENDING, deliberately excluded.)
    expect(new Decimal(be.earningsTaxable!.toString()).toFixed(2)).toBe("4873.18");
    // Pensionable = same shape.
    expect(new Decimal(be.earningsPensionable!.toString()).toFixed(2)).toBe("4873.18");
    // EI insurable unchanged — all TB/employer items are non-EI.
    expect(new Decimal(be.earningsInsurable!.toString()).toFixed(2)).toBe("4583.33");
  });

  it("snapshot for AD&D freezes rule provenance (key, version, source authority + title)", async () => {
    const c = db();
    const sup = await superAdminP();
    try { await seedCanadaAlbertaPackages2026(sup); } catch { /* already installed */ }
    const club = await makeClub("3C3C-Prov");
    const adminU = await makeUser({ email: `a.prov@t.test`, role: "CLUB_ADMIN", clubId: club.id });
    const paU    = await makeUser({ email: `p.prov@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
    const ctlU   = await makeUser({ email: `c.prov@t.test`, role: "CONTROLLER", clubId: club.id });
    const adminP = await principalFor(adminU.email);
    const paP    = await principalFor(paU.email);
    await upsertPayrollClubConfig(adminP, club.id, {
      provinceOfEmployment: "AB", payrollAdminUserId: paU.id, controllerUserId: ctlU.id,
    });

    const emp = await c.employee.create({
      data: {
        clubId: club.id, firstName: "Prov", lastName: "Test",
        email: `prov@t.test`, hireDate: utc(2020, 1, 1),
        dateOfBirth: utc(1980, 6, 1), status: "ACTIVE",
        employeeNumber: `PROV`, employeeLifecycle: "ACTIVE",
        compensationType: "SALARY", homeProvince: "AB",
      },
    });
    const assn = await c.employeeEmploymentAssignment.create({
      data: { clubId: club.id, employeeId: emp.id, role: "PRIMARY", employmentType: "FULL_TIME", effectiveFrom: utc(2020, 1, 1) },
    });
    await c.employeeCompensation.create({
      data: {
        clubId: club.id, employeeId: emp.id, assignmentId: assn.id,
        cadence: "SALARY", rate: "60000", currency: "CAD",
        effectiveFrom: utc(2020, 1, 1),
      },
    });
    await writeEncryptedTd1Claims({
      clubId: club.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1),
      province: "AB", td1FormVersion: "2026-01",
      federalClaim: "16452.00", provincialClaim: "22769.00",
    });
    const pg = await c.payrollPayGroup.create({
      data: {
        clubId: club.id, code: "SAL-SM-PROV", name: "SM",
        payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 1,
        calendarAnchorDate: utc(2026, 1, 1), active: true,
      },
    });
    await seedSemiMonthlyCalendar(club.id, pg.id);
    await c.payrollPayGroupMember.create({
      data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1) },
    });

    const adnd = await upsertPayrollComponent(adminP, club.id, {
      code: "AD_D_ER_PREMIUM", displayName: "AD&D",
      category: "EMPLOYER_CONTRIBUTION", side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT",
      taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
      calculationMethod: "FIXED_AMOUNT",
      statutoryTreatmentSource: "SPECTRE_LIBRARY",
      statutoryRuleKey: "CA-ER-AD-AND-D-PREMIUM-V1",
      displaySection: "BENEFITS",
    });
    await createRecurringComponentAssignment(adminP, club.id, {
      employeeId: emp.id, componentId: adnd.id,
      amount: "2.25", effectiveFrom: utc(2020, 1, 1),
    });
    const pp = await c.payrollPayPeriod.findFirstOrThrow({
      where: { clubId: club.id, payGroupId: pg.id, sequenceInYear: 17 },
    });
    const prep = await preparePayrollBatch(paP, club.id, pp.id);
    const snap = await c.payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "AD_D_ER_PREMIUM" },
    });
    expect(snap.statutoryTreatmentSource).toBe("SPECTRE_LIBRARY");
    expect(snap.statutoryRuleKey).toBe("CA-ER-AD-AND-D-PREMIUM-V1");
    expect(snap.statutoryRuleVariant).toBe("DEFAULT");
    expect(snap.statutoryRuleVersion).toBe("1.0.0");
    expect(snap.statutoryRuleSourceAuthority).toBe("CRA");
    expect(snap.statutoryRuleSourceTitle).toContain("T4130");
  });
});
