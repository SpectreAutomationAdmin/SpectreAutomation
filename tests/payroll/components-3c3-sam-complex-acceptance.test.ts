// Payroll-3C-3 (2026-09-08) — Sam Complex structural acceptance.
//
// Founder request: for a semi-monthly $110,000 annual-salary employee
// with the seven catalogue components, assert the pre-statutory
// economic totals independently derived from the supplied source
// paystub's STRUCTURE (not its exact CPP/EI/tax/net numbers).
//
// Expected pre-statutory numbers:
//   Cash earnings                            = $4,620.83
//     Regular salary   $110,000 / 24         = $4,583.33
//     Cell phone allowance                   = $   37.50
//
//   Employer benefits / contributions total  = $  253.18
//     AD&D                                   = $    2.25
//     Dependent life                         = $    0.83
//     Life insurance (taxable benefit)       = $   20.93
//     RRSP ER (5% of $4,583.33)              = $  229.17
//
//   Configured employee deductions
//     (BEFORE statutory deductions)          = $  257.28
//     LTD                                    = $   28.11
//     RRSP EE (5% of $4,583.33)              = $  229.17
//
// This suite does NOT assert CPP / CPP2 / EI / income-tax / net
// numbers. Those require verified YTD balances and verified
// SPECTRE_LIBRARY statutory treatments for RRSP EE + the
// employer-side benefits — none of which are in scope for 3C-3.

import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { upsertPayrollComponent, createRecurringComponentAssignment } from "@/lib/payroll/components-catalogue";
import { writeEncryptedTd1Claims } from "@/lib/hr/td1-secure-write";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function superAdminP() {
  const c = db();
  await c.user.deleteMany({ where: { email: "sup-sam@spectre.test" } });
  const u = await c.user.create({
    data: { email: "sup-sam@spectre.test", name: "Sup", role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE" },
  });
  await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
  return principalFor("sup-sam@spectre.test");
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

describe("Payroll-3C-3 · Sam Complex acceptance (structural, pre-statutory)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("$110,000 annual → $4,583.33 semi-monthly regular; 7 components produce the exact founder-requested totals", async () => {
    const c = db();
    const sup = await superAdminP();
    await seedCanadaAlbertaPackages2026(sup);

    const club = await makeClub("Sam Complex Accept");
    const admin = await makeUser({ email: `a.${club.id}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
    const pa    = await makeUser({ email: `p.${club.id}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
    const ctl   = await makeUser({ email: `c.${club.id}@t.test`, role: "CONTROLLER",    clubId: club.id });
    const adminP = await principalFor(admin.email);
    const paP    = await principalFor(pa.email);
    await upsertPayrollClubConfig(adminP, club.id, {
      provinceOfEmployment: "AB", payrollAdminUserId: pa.id, controllerUserId: ctl.id,
    });

    // Sam — $110,000 annual, semi-monthly.
    const emp = await c.employee.create({
      data: {
        clubId: club.id, firstName: "Sam", lastName: "Complex",
        email: `sam.${club.id}@t.test`, hireDate: utc(2020, 1, 1),
        dateOfBirth: utc(1980, 6, 1), status: "ACTIVE",
        employeeNumber: `SAM-${club.id.slice(-4)}`,
        employeeLifecycle: "ACTIVE", compensationType: "SALARY", homeProvince: "AB",
      },
    });
    const assn = await c.employeeEmploymentAssignment.create({
      data: {
        clubId: club.id, employeeId: emp.id, role: "PRIMARY",
        employmentType: "FULL_TIME", effectiveFrom: utc(2020, 1, 1),
      },
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
        clubId: club.id, code: "SAL-SM", name: "Salary Semi-Monthly",
        payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 1,
        calendarAnchorDate: utc(2026, 1, 1), active: true,
      },
    });
    await seedSemiMonthlyCalendar(club.id, pg.id);
    const pp = await c.payrollPayPeriod.findFirstOrThrow({
      where: { clubId: club.id, payGroupId: pg.id, sequenceInYear: 17 },
    });
    await c.payrollPayGroupMember.create({
      data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1) },
    });

    // Component catalogue — mirrors scripts/payroll-founder-preview-components.ts.
    async function mkFixed(code: string, section: "EARNINGS" | "BENEFITS" | "DEDUCTIONS",
                          side: "EMPLOYEE" | "EMPLOYER", cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
                          category: string, amount: string, taxable = "NONE", cpp = "NONE", ei = "NONE") {
      const comp = await upsertPayrollComponent(adminP, club.id, {
        code, displayName: code, category: category as never, side,
        cashEffect,
        taxableEffect: taxable as never, cppPensionableEffect: cpp as never, eiInsurableEffect: ei as never,
        calculationMethod: "FIXED_AMOUNT",
        statutoryTreatmentSource: "CUSTOM_TEST",
        displaySection: section,
      });
      await createRecurringComponentAssignment(adminP, club.id, {
        employeeId: emp.id, componentId: comp.id, amount, effectiveFrom: utc(2020, 1, 1),
      });
    }
    async function mkPercent(code: string, section: "EARNINGS" | "BENEFITS" | "DEDUCTIONS",
                             side: "EMPLOYEE" | "EMPLOYER", cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT",
                             category: string, percentBps: number) {
      const comp = await upsertPayrollComponent(adminP, club.id, {
        code, displayName: code, category: category as never, side,
        cashEffect,
        taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
        calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
        eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
        statutoryTreatmentSource: "CUSTOM_TEST",
        displaySection: section,
      });
      await createRecurringComponentAssignment(adminP, club.id, {
        employeeId: emp.id, componentId: comp.id, percentBps, effectiveFrom: utc(2020, 1, 1),
      });
    }

    // Cell phone allowance — cash + taxable + CPP (as per source paystub structure) but NOT insurable.
    await mkFixed("CELL_PHONE_ALLOWANCE", "EARNINGS", "EMPLOYEE", "INCREASES_NET_PAY", "ALLOWANCE", "37.50", "ADD", "ADD", "NONE");
    // Employer contributions.
    await mkFixed("AD_D_ER_PREMIUM",           "BENEFITS", "EMPLOYER", "NO_NET_PAY_EFFECT", "EMPLOYER_CONTRIBUTION", "2.25");
    await mkFixed("DEPENDENT_LIFE_ER_PREMIUM", "BENEFITS", "EMPLOYER", "NO_NET_PAY_EFFECT", "EMPLOYER_CONTRIBUTION", "0.83");
    // Life insurance is treated as a taxable benefit in the source paystub structure.
    await mkFixed("LIFE_INSURANCE_ER_PREMIUM", "BENEFITS", "EMPLOYER", "NO_NET_PAY_EFFECT", "TAXABLE_BENEFIT", "20.93", "ADD", "ADD", "NONE");
    // Employee deduction (fixed).
    await mkFixed("LTD_EE", "DEDUCTIONS", "EMPLOYEE", "DECREASES_NET_PAY", "EMPLOYEE_DEDUCTION", "28.11");
    // Percent components — RRSP EE + RRSP ER, both 5% of REGULAR_EARNINGS_ONLY.
    await mkPercent("RRSP_EE", "DEDUCTIONS", "EMPLOYEE", "DECREASES_NET_PAY", "EMPLOYEE_DEDUCTION", 500);
    await mkPercent("RRSP_ER", "BENEFITS",   "EMPLOYER", "NO_NET_PAY_EFFECT", "EMPLOYER_CONTRIBUTION", 500);

    const prep = await preparePayrollBatch(paP, club.id, pp.id);
    await calculatePayrollBatch(paP, club.id, prep.batchId);
    const be = await c.payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });

    // Salary derivation.
    // $110,000 / 24 = $4,583.3333… → Decimal-preserved through cashEarnings.
    // cashEarnings = 4583.33 + 37.50 (cell phone) = 4620.83.
    expect(be.grossPay).not.toBeNull();
    expect(new Decimal(be.grossPay!.toString()).toFixed(2)).toBe("4620.83");

    // Snapshot per-code assertions.
    const snaps = await c.payrollBatchComponentSnapshot.findMany({
      where: { batchId: prep.batchId },
    });
    const byCode = new Map(snaps.map((s) => [s.componentCode, s]));

    // RRSP EE 5% of REGULAR_EARNINGS_ONLY ($4,583.33) = $229.17.
    const rrspEe = byCode.get("RRSP_EE");
    expect(rrspEe?.eligibleEarningsAmount?.toFixed(2)).toBe("4583.33");
    expect(rrspEe?.resolvedAmount?.toFixed(2)).toBe("229.17");
    // RRSP ER same math, employer side.
    const rrspEr = byCode.get("RRSP_ER");
    expect(rrspEr?.eligibleEarningsAmount?.toFixed(2)).toBe("4583.33");
    expect(rrspEr?.resolvedAmount?.toFixed(2)).toBe("229.17");
    expect(rrspEr?.side).toBe("EMPLOYER");
    // FIXED_AMOUNT amounts preserved.
    expect(byCode.get("CELL_PHONE_ALLOWANCE")?.resolvedAmount?.toFixed(2)).toBe("37.50");
    expect(byCode.get("AD_D_ER_PREMIUM")?.resolvedAmount?.toFixed(2)).toBe("2.25");
    expect(byCode.get("DEPENDENT_LIFE_ER_PREMIUM")?.resolvedAmount?.toFixed(2)).toBe("0.83");
    expect(byCode.get("LIFE_INSURANCE_ER_PREMIUM")?.resolvedAmount?.toFixed(2)).toBe("20.93");
    expect(byCode.get("LTD_EE")?.resolvedAmount?.toFixed(2)).toBe("28.11");

    // Independently-derived totals (§ founder brief).
    // Employer benefits/contributions total = 2.25 + 0.83 + 20.93 + 229.17 = 253.18.
    const employerBenefitsTotal = snaps
      .filter((s) => s.side === "EMPLOYER" && s.resolvedAmount != null)
      .reduce((acc, s) => acc.plus(new Decimal(s.resolvedAmount!.toString())), new Decimal(0));
    expect(employerBenefitsTotal.toFixed(2)).toBe("253.18");

    // Configured employee deductions BEFORE statutory deductions
    //   = LTD $28.11 + RRSP EE $229.17 = $257.28.
    const employeeConfiguredDeductionsTotal = snaps
      .filter((s) => s.side === "EMPLOYEE" && s.cashEffect === "DECREASES_NET_PAY" && s.resolvedAmount != null)
      .reduce((acc, s) => acc.plus(new Decimal(s.resolvedAmount!.toString())), new Decimal(0));
    expect(employeeConfiguredDeductionsTotal.toFixed(2)).toBe("257.28");

    // Sanity-check: statutory bases are unaffected by RRSP EE/ER
    // (both have all statutory effects = NONE in this CUSTOM_TEST
    // treatment) and by AD&D / Dep Life (NONE across the board).
    // Cell phone lifts taxable + CPP but not EI; Life Insurance
    // lifts taxable + CPP as a taxable benefit.
    //   taxable  = 4583.33 + 37.50 + 20.93 = 4641.76
    //   pension  = 4583.33 + 37.50 + 20.93 = 4641.76
    //   insurable = 4583.33 (cell + life not insurable)
    expect(new Decimal(be.earningsTaxable!.toString()).toFixed(2)).toBe("4641.76");
    expect(new Decimal(be.earningsPensionable!.toString()).toFixed(2)).toBe("4641.76");
    expect(new Decimal(be.earningsInsurable!.toString()).toFixed(2)).toBe("4583.33");

    // Explicit non-claim: this suite does NOT assert CPP / CPP2 / EI /
    // federal tax / provincial tax / net pay. Reproducing the source
    // paystub's exact statutory numbers requires (a) verified YTD
    // balances at the batch's pay date, (b) verified SPECTRE_LIBRARY
    // treatments for RRSP EE + employer-paid life insurance. Neither
    // is in scope for 3C-3.
  });
});
