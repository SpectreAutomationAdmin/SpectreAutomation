// Slice C closeout (2026-09-18) — server-side authorization + statutory-
// effect independence regressions.
//
// §15 authorization proof:
//   - PAYROLL_ADMIN + CLUB_ADMIN + CONTROLLER may enrol / change / end.
//   - CONTROLLER exercises the narrow `payroll:benefit_enrolment:write`
//     grant WITHOUT holding broad `payroll:write`.
//   - A role that lacks the narrow grant (STAFF) is refused.
//
// §16 independence proof:
//   - A component configured taxableEffect=ADD + cppPensionableEffect=NONE
//     + eiInsurableEffect=NONE increases ONLY the taxable base. Pensionable
//     and insurable bases remain unchanged.
//   - Then re-configured with cppPensionableEffect=ADD too — pensionable
//     base grows, insurable base still does not.
//
// §17 boundary proof:
//   - `eligibleEarningsBasis` remains a payroll-period earnings basis
//     concept; it is NOT a CRA RRSP deduction-limit / contribution-room
//     ceiling. This slice never touches such a field.

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac, makeUser, principalFor } from "./util/db";
import { createPayrollIntegrationFixture } from "./util/payroll-integration-fixture";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import {
  enrolEmployeeInBenefitPlan,
  changeEnrolment,
  endEnrolment,
} from "@/lib/payroll/benefit-enrolments";
import { createBenefitPlan } from "@/lib/payroll/benefit-plans";
import { ForbiddenError } from "@/lib/errors";

describe("Slice C closeout — server-side authorization for enrolments", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("PA + Club Admin + Controller may enrol; unauthorized role is refused", async () => {
    const s = await createPayrollIntegrationFixture({
      clubName: "Enrol Authz", ltd: { employeeMonthlyPremium: "42.50" },
    });
    // The fixture already enrolled once via adminP (CLUB_ADMIN). End it
    // so we can re-enrol from other roles.
    await endEnrolment(s.adminP, s.clubId, s.ltdPlan!.enrolmentId, {
      effectiveTo: new Date("2021-01-01T00:00:00.000Z"),
    });

    // --- CONTROLLER may enrol (narrow grant) ---
    const controllerEnrol = await enrolEmployeeInBenefitPlan(s.controllerP, s.clubId, {
      employeeId: s.emp.id, planId: s.ltdPlan!.planId,
      effectiveFrom: new Date("2021-02-01T00:00:00.000Z"),
      effectiveTo: new Date("2021-03-01T00:00:00.000Z"),
      electionKind: "FIXED_AMOUNT", amount: "45.00",
    });
    expect(controllerEnrol.status).toBe("ACTIVE");

    // --- PA may enrol ---
    const paEnrol = await enrolEmployeeInBenefitPlan(s.paP, s.clubId, {
      employeeId: s.emp.id, planId: s.ltdPlan!.planId,
      effectiveFrom: new Date("2021-04-01T00:00:00.000Z"),
      effectiveTo: new Date("2021-05-01T00:00:00.000Z"),
      electionKind: "FIXED_AMOUNT", amount: "46.00",
    });
    expect(paEnrol.status).toBe("ACTIVE");

    // --- CLUB_ADMIN may enrol ---
    const adminEnrol = await enrolEmployeeInBenefitPlan(s.adminP, s.clubId, {
      employeeId: s.emp.id, planId: s.ltdPlan!.planId,
      effectiveFrom: new Date("2021-06-01T00:00:00.000Z"),
      effectiveTo: new Date("2021-07-01T00:00:00.000Z"),
      electionKind: "FIXED_AMOUNT", amount: "47.00",
    });
    expect(adminEnrol.status).toBe("ACTIVE");

    // --- Unauthorized role is refused ---
    // STAFF has no payroll grants at all.
    const rep = await makeUser({
      email: `rep.${s.clubId}@t.test`, role: "STAFF", clubId: s.clubId,
    });
    const repP = await principalFor(rep.email);
    await expect(enrolEmployeeInBenefitPlan(repP, s.clubId, {
      employeeId: s.emp.id, planId: s.ltdPlan!.planId,
      effectiveFrom: new Date("2021-08-01T00:00:00.000Z"),
      electionKind: "FIXED_AMOUNT", amount: "50.00",
    })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Controller may Change and End; the same unauthorized role is refused", async () => {
    const s = await createPayrollIntegrationFixture({
      clubName: "Change/End Authz", ltd: { employeeMonthlyPremium: "42.50" },
    });
    // Change from Controller.
    const successor = await changeEnrolment(s.controllerP, s.clubId, {
      enrolmentId: s.ltdPlan!.enrolmentId,
      effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      electionKind: "FIXED_AMOUNT", amount: "55.00",
    });
    expect(successor.status).toBe("ACTIVE");

    // End from Controller.
    const ended = await endEnrolment(s.controllerP, s.clubId, successor.id, {
      effectiveTo: new Date("2026-03-01T00:00:00.000Z"),
    });
    expect(ended.status).toBe("ENDED");

    // Unauthorized role.
    const rep = await makeUser({
      email: `rep2.${s.clubId}@t.test`, role: "STAFF", clubId: s.clubId,
    });
    const repP = await principalFor(rep.email);
    await expect(endEnrolment(repP, s.clubId, successor.id, {
      effectiveTo: new Date("2026-04-01T00:00:00.000Z"),
    })).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("Slice C closeout — statutory-effect independence regression", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("taxable=ADD + pensionable=NONE + insurable=NONE grows ONLY taxable base", async () => {
    // Bootstrap the fixture without a benefit — we'll wire a custom
    // component + plan + enrolment directly so we control the effect
    // triple exactly.
    const s = await createPayrollIntegrationFixture({
      clubName: "Effect Independence 1", annualSalary: "110000",
    });

    // Custom TAXABLE-ONLY employer benefit — proves the three effects
    // are independent: taxable ADD, pensionable NONE, insurable NONE.
    const gymExpense = await prisma.account.create({
      data: {
        clubId: s.clubId, accountNumber: "5170", name: "Gym Membership Benefit Expense",
        type: "EXPENSE", normalBalance: "DEBIT", isActive: true, allowManualPosting: false,
      },
    });
    const gymLiab = await prisma.account.create({
      data: {
        clubId: s.clubId, accountNumber: "2170", name: "Gym Benefit Liability",
        type: "LIABILITY", normalBalance: "CREDIT", isActive: true, allowManualPosting: false,
      },
    });
    const gym = await prisma.payrollComponent.create({
      data: {
        clubId: s.clubId, code: "GYM_ER_TAXABLE_ONLY", displayName: "Employer Gym Membership (Taxable Only)",
        category: "TAXABLE_BENEFIT", side: "EMPLOYER",
        cashEffect: "NO_NET_PAY_EFFECT",
        taxableEffect: "ADD",
        cppPensionableEffect: "NONE",
        eiInsurableEffect: "NONE",
        calculationMethod: "FIXED_AMOUNT", displaySection: "BENEFITS",
        usage: "RECURRING", expenseAccountId: gymExpense.id, liabilityAccountId: gymLiab.id,
      },
    });
    const plan = await createBenefitPlan(s.adminP, s.clubId, {
      kind: "HEALTH_DENTAL", code: "GYM_TAX_ONLY", name: "Gym (Taxable Only Fixture)",
      effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
      employerComponentId: gym.id,
      defaultElectionKind: "FIXED_AMOUNT",
    });
    await enrolEmployeeInBenefitPlan(s.adminP, s.clubId, {
      employeeId: s.emp.id, planId: plan.id,
      effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
      electionKind: "FIXED_AMOUNT", amount: "80.00",
    });

    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    // Snapshot proves the frozen tri-effect matches the source component.
    const snap = await prisma.payrollBatchComponentSnapshot.findFirstOrThrow({
      where: { batchId: prep.batchId, componentCode: "GYM_ER_TAXABLE_ONLY" },
    });
    expect(snap.taxableEffect).toBe("ADD");
    expect(snap.cppPensionableEffect).toBe("NONE");
    expect(snap.eiInsurableEffect).toBe("NONE");

    const calc = await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    expect(calc.lifecycleStatus).toBe("CALCULATED");
    const be = await prisma.payrollBatchEmployee.findFirstOrThrow({
      where: { batchId: prep.batchId, employeeId: s.emp.id },
    });
    // Gross unchanged by non-cash benefit.
    expect(Number(be.grossPay!.toString())).toBeCloseTo(4583.33, 2);
    // Taxable base grew by $80.
    expect(Number(be.earningsTaxable!.toString())).toBeCloseTo(4663.33, 2);
    // Pensionable + insurable bases DID NOT grow.
    expect(Number(be.earningsPensionable!.toString())).toBeCloseTo(4583.33, 2);
    expect(Number(be.earningsInsurable!.toString())).toBeCloseTo(4583.33, 2);
  });

  it("taxable=ADD + pensionable=ADD + insurable=NONE grows taxable AND pensionable, not insurable", async () => {
    const s = await createPayrollIntegrationFixture({
      clubName: "Effect Independence 2", annualSalary: "110000",
    });
    const exp = await prisma.account.create({
      data: {
        clubId: s.clubId, accountNumber: "5171", name: "Tuition Benefit Expense",
        type: "EXPENSE", normalBalance: "DEBIT", isActive: true, allowManualPosting: false,
      },
    });
    const liab = await prisma.account.create({
      data: {
        clubId: s.clubId, accountNumber: "2171", name: "Tuition Benefit Liability",
        type: "LIABILITY", normalBalance: "CREDIT", isActive: true, allowManualPosting: false,
      },
    });
    const comp = await prisma.payrollComponent.create({
      data: {
        clubId: s.clubId, code: "TUITION_ER", displayName: "Employer Tuition (Taxable + Pensionable)",
        category: "TAXABLE_BENEFIT", side: "EMPLOYER",
        cashEffect: "NO_NET_PAY_EFFECT",
        taxableEffect: "ADD", cppPensionableEffect: "ADD", eiInsurableEffect: "NONE",
        calculationMethod: "FIXED_AMOUNT", displaySection: "BENEFITS",
        usage: "RECURRING", expenseAccountId: exp.id, liabilityAccountId: liab.id,
      },
    });
    const plan = await createBenefitPlan(s.adminP, s.clubId, {
      kind: "HEALTH_DENTAL", code: "TUITION", name: "Tuition Reimbursement",
      effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
      employerComponentId: comp.id,
      defaultElectionKind: "FIXED_AMOUNT",
    });
    await enrolEmployeeInBenefitPlan(s.adminP, s.clubId, {
      employeeId: s.emp.id, planId: plan.id,
      effectiveFrom: new Date("2020-01-01T00:00:00.000Z"),
      electionKind: "FIXED_AMOUNT", amount: "125.00",
    });

    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    const be = await prisma.payrollBatchEmployee.findFirstOrThrow({
      where: { batchId: prep.batchId, employeeId: s.emp.id },
    });
    expect(Number(be.grossPay!.toString())).toBeCloseTo(4583.33, 2);
    // Taxable grew by $125.
    expect(Number(be.earningsTaxable!.toString())).toBeCloseTo(4708.33, 2);
    // Pensionable grew by $125 (independently configured).
    expect(Number(be.earningsPensionable!.toString())).toBeCloseTo(4708.33, 2);
    // Insurable DID NOT grow.
    expect(Number(be.earningsInsurable!.toString())).toBeCloseTo(4583.33, 2);
  });
});
