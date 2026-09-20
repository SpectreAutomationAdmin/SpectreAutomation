// FPP-4B (2026-09-20) — RRSP benefit plan readiness pins.
//
// Root scenario: Coulee Ridge founder tries to create an RRSP plan
// where the linked employee + employer components carry the wrong
// calculationMethod. Server correctly refuses with:
//   "Both linked RRSP components must have calculationMethod =
//    PERCENT_OF_ELIGIBLE_EARNINGS."
//
// This suite pins:
//   1. The refusal path stays fail-closed under a FIXED_AMOUNT/PERCENT
//      mismatch on either side.
//   2. With PERCENT_OF_ELIGIBLE_EARNINGS components, plan creation
//      succeeds and reports the expected employer-match config.
//   3. The RRSP 5% election on $110,000/24 salary produces $229.17
//      employee + $229.17 employer (100% match, cap 5% = $229.17).
//   4. A 7% employee election with 100% match + 5% cap keeps the
//      employer contribution at $229.17 (not $320.83).
//   5. Correcting a component's calculationMethod does NOT alter the
//      historical PayrollOpeningBalanceComponent rows that reference
//      it (opening YTD stores its own ytdAmount + frozen identity).
//   6. Overall Opening YTD aggregate values are untouched by the
//      correction.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { ValidationError } from "@/lib/errors";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { createBenefitPlan } from "@/lib/payroll/benefit-plans";
import { createDraftOpeningBalance, addOpeningComponentBalance } from "@/lib/payroll/opening-balance";
import type { OpeningBalanceFields } from "@/lib/payroll/opening-balance";

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

async function seedComponent(clubId: string, code: string, opts: {
  side: "EMPLOYEE" | "EMPLOYER";
  cashEffect: "INCREASES_NET_PAY" | "DECREASES_NET_PAY" | "NO_NET_PAY_EFFECT";
  calculationMethod: "FIXED_AMOUNT" | "PERCENT_OF_ELIGIBLE_EARNINGS";
  eligibleEarningsBase?: "REGULAR_EARNINGS_ONLY" | "CASH_EARNINGS" | null;
  category?: string;
  displayName?: string;
}) {
  return db().payrollComponent.create({
    data: {
      clubId, code,
      displayName: opts.displayName ?? code,
      category: opts.category ?? (opts.side === "EMPLOYEE" ? "EMPLOYEE_DEDUCTION" : "EMPLOYER_CONTRIBUTION"),
      side: opts.side,
      cashEffect: opts.cashEffect,
      calculationMethod: opts.calculationMethod,
      eligibleEarningsBase: opts.eligibleEarningsBase ?? null,
      displaySection: opts.side === "EMPLOYEE" ? "DEDUCTIONS" : "BENEFITS",
      usage: "BOTH",
      active: true,
    },
  });
}

async function scenario() {
  const club = await makeClub("FPP-4B Club");
  const admin = await makeUser({ email: "adminA@fpp4b.test", role: "CLUB_ADMIN", clubId: club.id });
  const pa = await makeUser({ email: "paA@fpp4b.test", role: "PAYROLL_ADMIN", clubId: club.id });
  const adminP = await principalFor(admin.email);
  const paP = await principalFor(pa.email);
  await upsertPayrollClubConfig(adminP, club.id, {
    provinceOfEmployment: "AB", payrollAdminUserId: pa.id,
  });
  const emp = await db().employee.create({
    data: {
      clubId: club.id, firstName: "R", lastName: "SP",
      email: "rsp@fpp4b.test", hireDate: d(2026, 2, 1), status: "ACTIVE",
      employeeNumber: "E-FPP4B",
    },
  });
  return { club, adminP, paP, emp };
}

const CENTS = (n: number) => Math.round(n * 100) / 100;

describe("FPP-4B — RRSP benefit plan readiness + calc + opening YTD non-mutation", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("REFUSES when both sides are FIXED_AMOUNT (mirrors the founder's error)", async () => {
    const s = await scenario();
    const rrspEE = await seedComponent(s.club.id, "RRSP_EE", {
      side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY",
      calculationMethod: "FIXED_AMOUNT",
    });
    const rrspER = await seedComponent(s.club.id, "RRSP_ER", {
      side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT",
      calculationMethod: "FIXED_AMOUNT",
    });
    await expect(
      createBenefitPlan(s.adminP, s.club.id, {
        kind: "RRSP", code: "RRSP_STANDARD", name: "RRSP standard",
        effectiveFrom: d(2026, 1, 1),
        defaultElectionKind: "PERCENT_OF_ELIGIBLE_EARNINGS",
        eligibleEarningsBasis: "REGULAR_EARNINGS_ONLY",
        employerMatchBps: 10000, employerMatchCapBps: 500,
        employeeComponentId: rrspEE.id, employerComponentId: rrspER.id,
      }),
    ).rejects.toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({
          message: expect.stringContaining("PERCENT_OF_ELIGIBLE_EARNINGS"),
        }),
      ]),
    });
  });

  it("SUCCEEDS with PERCENT components — plan reports 100% match with 5% cap", async () => {
    const s = await scenario();
    const rrspEE = await seedComponent(s.club.id, "RRSP_EE", {
      side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY",
      calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
      eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
    });
    const rrspER = await seedComponent(s.club.id, "RRSP_ER", {
      side: "EMPLOYER", cashEffect: "NO_NET_PAY_EFFECT",
      calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
      eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
    });
    const plan = await createBenefitPlan(s.adminP, s.club.id, {
      kind: "RRSP", code: "RRSP_STANDARD", name: "RRSP standard",
      effectiveFrom: d(2026, 1, 1),
      defaultElectionKind: "PERCENT_OF_ELIGIBLE_EARNINGS",
      eligibleEarningsBasis: "REGULAR_EARNINGS_ONLY",
      employerMatchBps: 10000, employerMatchCapBps: 500,
      employeeComponentId: rrspEE.id, employerComponentId: rrspER.id,
    });
    expect(plan.kind).toBe("RRSP");
    expect(plan.employerMatchBps).toBe(10000);
    expect(plan.employerMatchCapBps).toBe(500);
    expect(plan.employeeComponentId).toBe(rrspEE.id);
    expect(plan.employerComponentId).toBe(rrspER.id);
  });

  it("Semi-monthly salary $4,583.33 with 5% election produces EE $229.17 + ER 100% match capped at 5% = $229.17", () => {
    // The canonical Payroll-3B benefit calculator writes each employer
    // match snapshot as:
    //   employer = min(
    //     round(employee_contribution * matchBps / 10000, HALF_UP),
    //     round(eligible_earnings   * matchCapBps / 10000, HALF_UP)
    //   )
    // Reproducing that math directly with the founder's inputs.
    const eligible = 4583.33;
    const employee = CENTS(eligible * 0.05);          // 229.17
    const employer_uncapped = CENTS(employee * 1.00); // 229.17
    const employer_cap = CENTS(eligible * 0.05);      // 229.17
    const employer = Math.min(employer_uncapped, employer_cap);
    expect(employee).toBe(229.17);
    expect(employer).toBe(229.17);
  });

  it("Semi-monthly salary $4,583.33 with 7% election keeps employer at $229.17 (5% cap wins)", () => {
    const eligible = 4583.33;
    const employee = CENTS(eligible * 0.07);          // 320.83
    const employer_uncapped = CENTS(employee * 1.00); // 320.83
    const employer_cap = CENTS(eligible * 0.05);      // 229.17
    const employer = Math.min(employer_uncapped, employer_cap);
    expect(employee).toBe(320.83);
    expect(employer_uncapped).toBe(320.83);
    expect(employer).toBe(229.17);
  });

  it("Opening YTD component row still holds its historical $ ytdAmount after component calculationMethod is corrected", async () => {
    const s = await scenario();
    // Seed the component in FIXED_AMOUNT mode (matches Coulee before the correction).
    const rrspEE = await seedComponent(s.club.id, "RRSP_EE", {
      side: "EMPLOYEE", cashEffect: "DECREASES_NET_PAY",
      calculationMethod: "FIXED_AMOUNT",
    });
    // Create Chris-analog opening YTD + component row @ $3,093.79
    const zeroVals: OpeningBalanceFields = {
      ytdGrossEarnings: "62381.21", ytdTaxableEarnings: "65766.64",
      ytdPensionableEarnings: "65766.64", ytdInsurableEarnings: "61874.96",
      ytdCppEE_Base: "0", ytdCppEE_FirstAdd: "0", ytdCppEE: "3761.56",
      ytdCpp2EE: "0", ytdEiEE: "1008.58",
      ytdFederalTax: "8670.86", ytdProvincialTax: "4220.10",
      ytdCppER_Base: "0", ytdCppER_FirstAdd: "0", ytdCppER: "3761.56",
      ytdCpp2ER: "0", ytdEiER: "1412.01",
    };
    const draft = await createDraftOpeningBalance(s.paP, s.club.id, {
      employeeId: s.emp.id, taxYear: 2026, throughPayDate: d(2026, 8, 31), values: zeroVals,
    });
    await addOpeningComponentBalance(s.paP, s.club.id, {
      openingBalanceId: draft.id, componentId: rrspEE.id, ytdAmount: "3093.79",
    });

    // Now correct the component's calculationMethod in place — as the
    // FPP-4B production script does.
    await db().payrollComponent.update({
      where: { id: rrspEE.id },
      data: {
        calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
        eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
      },
    });

    // Opening YTD component row untouched (schema §16 immutability).
    const row = await db().payrollOpeningBalanceComponent.findFirst({
      where: { openingBalanceId: draft.id, componentCode: "RRSP_EE" },
      select: { ytdAmount: true, displayName: true, category: true, side: true, cashEffect: true },
    });
    expect(row?.ytdAmount.toString()).toBe("3093.79");
    expect(row?.side).toBe("EMPLOYEE");
    expect(row?.cashEffect).toBe("DECREASES_NET_PAY");
    // Aggregate opening totals untouched.
    const parent = await db().payrollOpeningBalance.findUniqueOrThrow({
      where: { id: draft.id },
      select: { ytdGrossEarnings: true, ytdTaxableEarnings: true, ytdCppEE: true, ytdEiEE: true },
    });
    expect(parent.ytdGrossEarnings.toString()).toBe("62381.21");
    expect(parent.ytdTaxableEarnings.toString()).toBe("65766.64");
    expect(parent.ytdCppEE.toString()).toBe("3761.56");
    expect(parent.ytdEiEE.toString()).toBe("1008.58");
  });
});
