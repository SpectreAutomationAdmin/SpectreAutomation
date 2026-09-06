// Payroll-3C-3 (2026-09-08) — percentage components + directional
// statutory effects. Tests exercise the calculation engine directly
// (not the full prep→calc pipeline) where they can assert pure Decimal
// arithmetic without seeding a statutory package. A single end-to-end
// prep+calc test proves persistence + review-DTO integration.

import { describe, it, expect, beforeEach } from "vitest";
import Decimal from "decimal.js";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import {
  calculateEarnings,
  type ComponentSnapshotLike,
  type EarningsCalcResult,
} from "@/lib/payroll/earnings-calculator";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import { upsertPayrollComponent, createRecurringComponentAssignment } from "@/lib/payroll/components-catalogue";
import { writeEncryptedTd1Claims } from "@/lib/hr/td1-secure-write";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { seedCanadaAlbertaPackages2026 } from "@/lib/payroll/statutory/seed-ca-ab-2026";
import type { PayrollBatchSourceFactsV1 } from "@/lib/payroll/source-facts-schema";
import { ValidationError } from "@/lib/errors";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

function facts(annualSalary: number): PayrollBatchSourceFactsV1 {
  return {
    schemaVersion: 1,
    compensations: [{
      id: "comp_1", assignmentId: "assn_1", payType: "SALARY",
      annualSalary: String(annualSalary), hourlyRate: null,
      effectiveFrom: "2020-01-01T00:00:00.000Z", effectiveTo: null,
    }],
  } as unknown as PayrollBatchSourceFactsV1;
}

const salariedInput = (annual = 120_000) => ({
  sourceFacts: facts(annual),
  earningRows: [],
  allowances: [],
  approvedHours: "0",
  periodsPerYear: 24,
  salariedFullPeriod: true,
});

function snap(overrides: Partial<ComponentSnapshotLike> & { code: string }): ComponentSnapshotLike {
  return {
    side: "EMPLOYEE",
    cashEffect: "NO_NET_PAY_EFFECT",
    taxableEffect: "NONE",
    cppPensionableEffect: "NONE",
    eiInsurableEffect: "NONE",
    calculationMethod: "FIXED_AMOUNT",
    resolvedAmount: null,
    eligibleEarningsBase: null,
    sourcePercentBps: null,
    ...overrides,
  };
}

// -------------------------------------------------------------------
// A · Percentage arithmetic
// -------------------------------------------------------------------
describe("Payroll-3C-3 · percentage math (Decimal)", () => {
  it("5% × $5000 = $250.00 (REGULAR_EARNINGS_ONLY)", () => {
    const r = calculateEarnings({
      ...salariedInput(120_000),
      componentSnapshots: [snap({
        code: "PCT",
        cashEffect: "DECREASES_NET_PAY", side: "EMPLOYEE",
        calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
        sourcePercentBps: 500, eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
      })],
    });
    expect(r.percentResolutions).toHaveLength(1);
    expect(r.percentResolutions[0].eligibleAmount.toFixed(2)).toBe("5000.00");
    expect(r.percentResolutions[0].resolvedAmount.toFixed(2)).toBe("250.00");
    // DECREASES_NET_PAY → shows up in employeeDeductionsFromComponents.
    expect(r.employeeDeductionsFromComponents.toFixed(2)).toBe("250.00");
    // cash unchanged; the deduction is applied on net-pay side by caller.
    expect(r.cashEarnings.toFixed(2)).toBe("5000.00");
  });

  it("0% resolves to $0.00", () => {
    const r = calculateEarnings({
      ...salariedInput(120_000),
      componentSnapshots: [snap({
        code: "PCT", cashEffect: "DECREASES_NET_PAY", side: "EMPLOYEE",
        calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
        sourcePercentBps: 0, eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
      })],
    });
    expect(r.percentResolutions[0].resolvedAmount.toFixed(2)).toBe("0.00");
    expect(r.employeeDeductionsFromComponents.toFixed(2)).toBe("0.00");
  });

  it("100% resolves to full eligible amount", () => {
    const r = calculateEarnings({
      ...salariedInput(120_000),
      componentSnapshots: [snap({
        code: "PCT", cashEffect: "DECREASES_NET_PAY", side: "EMPLOYEE",
        calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
        sourcePercentBps: 10_000, eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
      })],
    });
    expect(r.percentResolutions[0].resolvedAmount.toFixed(2)).toBe("5000.00");
  });

  it("non-round: 3.75% × 5000 = 187.50 (Decimal, not float)", () => {
    const r = calculateEarnings({
      ...salariedInput(120_000),
      componentSnapshots: [snap({
        code: "PCT", cashEffect: "DECREASES_NET_PAY", side: "EMPLOYEE",
        calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
        sourcePercentBps: 375, eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
      })],
    });
    expect(r.percentResolutions[0].resolvedAmount.toFixed(2)).toBe("187.50");
  });

  it("invalid percentBps (> 100%) refused by the catalogue upsert", async () => {
    await resetDb(); await seedRbac();
    const club = await makeClub("Pct Val");
    const admin = await makeUser({ email: `a.${club.id}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
    const adminP = await principalFor(admin.email);
    const comp = await upsertPayrollComponent(adminP, club.id, {
      code: "PCT", displayName: "Pct", category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
      cashEffect: "DECREASES_NET_PAY",
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
      eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
      displaySection: "DEDUCTIONS",
    });
    const emp = await db().employee.create({
      data: {
        clubId: club.id, firstName: "E", lastName: "E", email: `e.${club.id}@t.test`,
        hireDate: utc(2020, 1, 1), status: "ACTIVE", employeeNumber: "X",
        employeeLifecycle: "ACTIVE", compensationType: "SALARY", homeProvince: "AB",
      },
    });
    await expect(createRecurringComponentAssignment(adminP, club.id, {
      employeeId: emp.id, componentId: comp.id, percentBps: 20_001,
      effectiveFrom: utc(2020, 1, 1),
    })).rejects.toBeInstanceOf(ValidationError);
  });
});

// -------------------------------------------------------------------
// B · Eligible-earnings base variants (§7)
// -------------------------------------------------------------------
describe("Payroll-3C-3 · eligible-earnings base variants", () => {
  it("REGULAR_EARNINGS_ONLY excludes cash allowance", () => {
    const r = calculateEarnings({
      ...salariedInput(120_000),
      componentSnapshots: [
        // Fixed cash allowance $37.50, INCREASES_NET_PAY.
        snap({ code: "ALLOW", cashEffect: "INCREASES_NET_PAY", side: "EMPLOYEE",
               calculationMethod: "FIXED_AMOUNT", resolvedAmount: "37.50" }),
        // Percent 5% of REGULAR_EARNINGS_ONLY → 5000 × 5% = 250.
        snap({ code: "PCT", cashEffect: "DECREASES_NET_PAY", side: "EMPLOYEE",
               calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
               sourcePercentBps: 500, eligibleEarningsBase: "REGULAR_EARNINGS_ONLY" }),
      ],
    });
    // Allowance is EXCLUDED from eligible base.
    expect(r.percentResolutions[0].eligibleAmount.toFixed(2)).toBe("5000.00");
    expect(r.percentResolutions[0].resolvedAmount.toFixed(2)).toBe("250.00");
  });

  it("CASH_EARNINGS includes cash allowance", () => {
    const r = calculateEarnings({
      ...salariedInput(120_000),
      componentSnapshots: [
        snap({ code: "ALLOW", cashEffect: "INCREASES_NET_PAY", side: "EMPLOYEE",
               calculationMethod: "FIXED_AMOUNT", resolvedAmount: "37.50" }),
        snap({ code: "PCT", cashEffect: "DECREASES_NET_PAY", side: "EMPLOYEE",
               calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
               sourcePercentBps: 500, eligibleEarningsBase: "CASH_EARNINGS" }),
      ],
    });
    // Cash baseline pre-percent = 5000 + 37.50 = 5037.50; 5% = 251.88.
    expect(r.percentResolutions[0].eligibleAmount.toFixed(2)).toBe("5037.50");
    expect(r.percentResolutions[0].resolvedAmount.toFixed(2)).toBe("251.88");
  });
});

// -------------------------------------------------------------------
// C · Directional statutory effects (§18-20) — pure capability
// -------------------------------------------------------------------
describe("Payroll-3C-3 · directional statutory effects", () => {
  it("SUBTRACT on taxable lowers taxable base without touching cash", () => {
    const r = calculateEarnings({
      ...salariedInput(120_000),
      componentSnapshots: [snap({
        code: "PRE_TAX", cashEffect: "DECREASES_NET_PAY", side: "EMPLOYEE",
        calculationMethod: "FIXED_AMOUNT", resolvedAmount: "250.00",
        taxableEffect: "SUBTRACT",
      })],
    });
    expect(r.cashEarnings.toFixed(2)).toBe("5000.00");
    expect(r.taxableRemuneration.toFixed(2)).toBe("4750.00");
    expect(r.cppPensionableRemuneration.toFixed(2)).toBe("5000.00");
    expect(r.eiInsurableRemuneration.toFixed(2)).toBe("5000.00");
  });

  it("SUBTRACT on CPP lowers pensionable base only", () => {
    const r = calculateEarnings({
      ...salariedInput(120_000),
      componentSnapshots: [snap({
        code: "PRE_CPP", cashEffect: "NO_NET_PAY_EFFECT", side: "EMPLOYER",
        calculationMethod: "FIXED_AMOUNT", resolvedAmount: "100.00",
        cppPensionableEffect: "SUBTRACT",
      })],
    });
    expect(r.cashEarnings.toFixed(2)).toBe("5000.00");
    expect(r.taxableRemuneration.toFixed(2)).toBe("5000.00");
    expect(r.cppPensionableRemuneration.toFixed(2)).toBe("4900.00");
    expect(r.eiInsurableRemuneration.toFixed(2)).toBe("5000.00");
  });

  it("SUBTRACT on EI lowers insurable base only", () => {
    const r = calculateEarnings({
      ...salariedInput(120_000),
      componentSnapshots: [snap({
        code: "PRE_EI", cashEffect: "NO_NET_PAY_EFFECT", side: "EMPLOYER",
        calculationMethod: "FIXED_AMOUNT", resolvedAmount: "42.00",
        eiInsurableEffect: "SUBTRACT",
      })],
    });
    expect(r.eiInsurableRemuneration.toFixed(2)).toBe("4958.00");
    expect(r.taxableRemuneration.toFixed(2)).toBe("5000.00");
    expect(r.cppPensionableRemuneration.toFixed(2)).toBe("5000.00");
  });

  it("ADD + SUBTRACT compose: +100 taxable benefit and −250 taxable deduction → net −150", () => {
    const r = calculateEarnings({
      ...salariedInput(120_000),
      componentSnapshots: [
        snap({ code: "TAX_BEN", cashEffect: "NO_NET_PAY_EFFECT", side: "EMPLOYER",
               calculationMethod: "FIXED_AMOUNT", resolvedAmount: "100.00",
               taxableEffect: "ADD" }),
        snap({ code: "PRE_TAX", cashEffect: "DECREASES_NET_PAY", side: "EMPLOYEE",
               calculationMethod: "FIXED_AMOUNT", resolvedAmount: "250.00",
               taxableEffect: "SUBTRACT" }),
      ],
    });
    // Taxable: 5000 + 100 − 250 = 4850.
    expect(r.taxableRemuneration.toFixed(2)).toBe("4850.00");
    // Cash unchanged.
    expect(r.cashEarnings.toFixed(2)).toBe("5000.00");
  });
});

// -------------------------------------------------------------------
// D · Negative-base floor (§21)
// -------------------------------------------------------------------
describe("Payroll-3C-3 · negative-base protection", () => {
  it("SUBTRACT larger than base floors at 0 and emits NEGATIVE_BASE_FLOORED diagnostic", () => {
    const r = calculateEarnings({
      ...salariedInput(120_000),
      componentSnapshots: [snap({
        code: "HUGE", cashEffect: "DECREASES_NET_PAY", side: "EMPLOYEE",
        calculationMethod: "FIXED_AMOUNT", resolvedAmount: "9000.00",
        taxableEffect: "SUBTRACT",
      })],
    });
    expect(r.taxableRemuneration.toFixed(2)).toBe("0.00");
    expect(r.diagnostics.some((d) => d.code === "NEGATIVE_BASE_FLOORED" && /taxable/i.test(d.message))).toBe(true);
  });
});

// -------------------------------------------------------------------
// E · Employer-side vs employee-side paired % contributions
// -------------------------------------------------------------------
describe("Payroll-3C-3 · paired employee + employer percentage contributions", () => {
  it("both % of REGULAR_EARNINGS_ONLY yield independent amounts on the correct side", () => {
    const r: EarningsCalcResult = calculateEarnings({
      ...salariedInput(120_000),
      componentSnapshots: [
        // Employee 5% (deduction)
        snap({ code: "EE_PCT", cashEffect: "DECREASES_NET_PAY", side: "EMPLOYEE",
               calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
               sourcePercentBps: 500, eligibleEarningsBase: "REGULAR_EARNINGS_ONLY" }),
        // Employer 4% (employer cost)
        snap({ code: "ER_PCT", cashEffect: "NO_NET_PAY_EFFECT", side: "EMPLOYER",
               calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
               sourcePercentBps: 400, eligibleEarningsBase: "REGULAR_EARNINGS_ONLY" }),
      ],
    });
    expect(r.employeeDeductionsFromComponents.toFixed(2)).toBe("250.00");
    expect(r.employerContributionsFromComponents.toFixed(2)).toBe("200.00");
    // Employee net (cash) unchanged by employer contribution.
    expect(r.cashEarnings.toFixed(2)).toBe("5000.00");
  });
});

// -------------------------------------------------------------------
// F · End-to-end percent snapshot immutability + persistence via calc
// -------------------------------------------------------------------
describe("Payroll-3C-3 · percent snapshot immutability + persistence", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("prep freezes % and eligible base; calc writes back resolved + eligibleAmount; live edit does not mutate old batch", async () => {
    const c = db();
    const sup = await (async () => {
      await c.user.deleteMany({ where: { email: "sup-3c3@spectre.test" } });
      const u = await c.user.create({
        data: { email: "sup-3c3@spectre.test", name: "Sup", role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE" },
      });
      await c.userClubRole.create({ data: { userId: u.id, clubId: null, roleKey: "SUPER_ADMIN" } });
      return principalFor("sup-3c3@spectre.test");
    })();
    await seedCanadaAlbertaPackages2026(sup);
    const club = await makeClub("Pct E2E");
    const admin = await makeUser({ email: `a.${club.id}@t.test`, role: "CLUB_ADMIN", clubId: club.id });
    const pa    = await makeUser({ email: `p.${club.id}@t.test`, role: "PAYROLL_ADMIN", clubId: club.id });
    const ctl   = await makeUser({ email: `c.${club.id}@t.test`, role: "CONTROLLER",    clubId: club.id });
    const adminP = await principalFor(admin.email);
    const paP    = await principalFor(pa.email);
    await upsertPayrollClubConfig(adminP, club.id, {
      provinceOfEmployment: "AB", payrollAdminUserId: pa.id, controllerUserId: ctl.id,
    });

    const emp = await c.employee.create({
      data: {
        clubId: club.id, firstName: "Sam", lastName: "C",
        email: `s.${club.id}@t.test`, hireDate: utc(2020, 1, 1),
        dateOfBirth: utc(1985, 5, 12), status: "ACTIVE",
        employeeNumber: "SC", employeeLifecycle: "ACTIVE",
        compensationType: "SALARY", homeProvince: "AB",
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
        cadence: "SALARY", rate: "120000", currency: "CAD",
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
    // Seed 24 semi-monthly periods for 2026.
    let seq = 0;
    for (let m = 0; m < 12; m++) {
      seq += 1;
      await c.payrollPayPeriod.create({
        data: {
          clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: seq,
          periodStart: utc(2026, m + 1, 1), periodEnd: utc(2026, m + 1, 16),
          payDate: utc(2026, m + 1, 16), status: "OPEN",
        },
      });
      seq += 1;
      await c.payrollPayPeriod.create({
        data: {
          clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: seq,
          periodStart: utc(2026, m + 1, 16), periodEnd: utc(2026, m + 2, 1),
          payDate: utc(2026, m + 2, 1), status: "OPEN",
        },
      });
    }
    const pp = await c.payrollPayPeriod.findFirstOrThrow({
      where: { clubId: club.id, payGroupId: pg.id, sequenceInYear: 17 },
    });
    await c.payrollPayGroupMember.create({
      data: { clubId: club.id, payGroupId: pg.id, employeeId: emp.id, effectiveFrom: utc(2020, 1, 1) },
    });

    const rrspEe = await upsertPayrollComponent(adminP, club.id, {
      code: "RRSP_EE", displayName: "Employee RRSP",
      category: "EMPLOYEE_DEDUCTION", side: "EMPLOYEE",
      cashEffect: "DECREASES_NET_PAY",
      taxableEffect: "NONE", cppPensionableEffect: "NONE", eiInsurableEffect: "NONE",
      calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS",
      eligibleEarningsBase: "REGULAR_EARNINGS_ONLY",
      statutoryTreatmentSource: "CUSTOM_TEST",
      displaySection: "DEDUCTIONS",
    });
    const assignment = await createRecurringComponentAssignment(adminP, club.id, {
      employeeId: emp.id, componentId: rrspEe.id,
      percentBps: 500, effectiveFrom: utc(2020, 1, 1),
    });

    // Prep freezes % + eligible base; resolvedAmount is null at prep.
    const prep = await preparePayrollBatch(paP, club.id, pp.id);
    const preSnap = await c.payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "RRSP_EE" },
    });
    expect(preSnap.sourcePercentBps).toBe(500);
    expect(preSnap.eligibleEarningsBase).toBe("REGULAR_EARNINGS_ONLY");
    expect(preSnap.resolvedAmount).toBeNull();

    // Calc runs, writes back resolved + eligible amount.
    await calculatePayrollBatch(paP, club.id, prep.batchId);
    const postSnap = await c.payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "RRSP_EE" },
    });
    expect(postSnap.resolvedAmount!.toFixed(2)).toBe("250.00");
    expect(postSnap.eligibleEarningsAmount!.toFixed(2)).toBe("5000.00");

    // Later live edit — bump to 6% + change eligible base to CASH_EARNINGS.
    await c.employeeRecurringPayrollComponent.update({
      where: { id: assignment.id }, data: { percentBps: 600 },
    });
    await c.payrollComponent.update({
      where: { id: rrspEe.id }, data: { eligibleEarningsBase: "CASH_EARNINGS" },
    });

    // Historical batch snapshot is unchanged.
    const stillOld = await c.payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "RRSP_EE" },
    });
    expect(stillOld.sourcePercentBps).toBe(500);
    expect(stillOld.eligibleEarningsBase).toBe("REGULAR_EARNINGS_ONLY");
    expect(stillOld.resolvedAmount!.toFixed(2)).toBe("250.00");
  });
});
