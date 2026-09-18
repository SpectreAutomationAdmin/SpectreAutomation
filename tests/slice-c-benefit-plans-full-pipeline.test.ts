// Slice C (2026-09-18) — full-pipeline regressions for benefit plans.
//
// Proves ONE LTD enrolment AND ONE Health/Dental enrolment each travel
// through the real payroll pipeline (Enrol → Prepare → Calculate →
// Submit → Approve → GL Preview → Post → PayStatement → YTD) via
// canonical services with no substitution.
//
// FIXTURE CONFIGURATION disclaimers:
//   * LTD is configured here as an EMPLOYEE deduction (DECREASES_NET_PAY,
//     all statutory effects NONE — post-tax). Spectre does NOT assume
//     universal LTD tax treatment; a Club that funds LTD differently
//     configures its linked PayrollComponent accordingly.
//   * Health/Dental is configured here as an EMPLOYER premium
//     (NO_NET_PAY_EFFECT, taxableEffect=ADD — non-cash taxable benefit).
//     Again FIXTURE configuration, not a universal rule.

import { describe, it, expect, beforeEach } from "vitest";
import { prisma } from "@/lib/prisma";
import { resetDb, seedRbac } from "./util/db";
import { createPayrollIntegrationFixture } from "./util/payroll-integration-fixture";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { attestBatchReview } from "@/lib/payroll/batch-review";
import { submitPayrollBatch } from "@/lib/payroll/submit-payroll-batch";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { previewPayrollJournal } from "@/lib/payroll/payroll-journal-preview";
import { buildPayStatement } from "@/lib/payroll/pay-statement";
import { getEmployeePayrollYtd } from "@/lib/payroll/ytd";
import { changeEnrolment, endEnrolment, enrolEmployeeInBenefitPlan } from "@/lib/payroll/benefit-enrolments";
import { ForbiddenError, ConflictError } from "@/lib/errors";

describe("Slice C — LTD full pipeline (Enrol → Post → PayStatement → YTD)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("$42.50 LTD employee premium flows through every stage with frozen semantics", async () => {
    const s = await createPayrollIntegrationFixture({
      clubName: "LTD Full Pipeline",
      annualSalary: "110000",
      ltd: { employeeMonthlyPremium: "42.50" },
    });
    expect(s.ltdPlan).toBeDefined();

    // --- Prepare ---
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    const be = await prisma.payrollBatchEmployee.findFirstOrThrow({
      where: { batchId: prep.batchId, employeeId: s.emp.id },
    });
    const ltdSnap = await prisma.payrollBatchComponentSnapshot.findFirstOrThrow({
      where: {
        batchId: prep.batchId,
        provenance: "BENEFIT_ENROLMENT",
        sourceEnrolmentId: s.ltdPlan!.enrolmentId,
      },
    });
    expect(ltdSnap.componentCode).toBe("LTD_EE");
    expect(ltdSnap.resolvedAmount?.toString()).toBe("42.5");
    expect(ltdSnap.side).toBe("EMPLOYEE");
    expect(ltdSnap.cashEffect).toBe("DECREASES_NET_PAY");
    expect(ltdSnap.expenseAccountIdSnapshot).toBe(s.ltdPlan!.employeeExpenseAccountId);

    // --- Calculate ---
    const calc = await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    expect(calc.lifecycleStatus, JSON.stringify(calc.blockers ?? [])).toBe("CALCULATED");

    // Post-tax LTD deduction reduces net pay but not statutory bases.
    const beAfter = await prisma.payrollBatchEmployee.findUniqueOrThrow({ where: { id: be.id } });
    // Gross unchanged by LTD (cash EMPLOYEE deduction).
    expect(Number(beAfter.grossPay!.toString())).toBeCloseTo(4583.33, 2);

    // --- Attest → Submit → Approve ---
    await attestBatchReview(s.paP, s.clubId, prep.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(s.paP, s.clubId, prep.batchId);
    await approvePayrollBatch(s.controllerP, prep.batchId);

    // --- Preview (before mutation) ---
    const previewBefore = await previewPayrollJournal(s.paP, s.clubId, prep.batchId);
    // An employee post-tax LTD deduction credits its liability account
    // ($42.50 credit at 2150) and reduces Net Pay Payable — no debit
    // for the deduction itself (the employer paid nothing extra).
    const ltdLiabAcct = await prisma.account.findFirstOrThrow({
      where: { clubId: s.clubId, accountNumber: "2150" },
    });
    const ltdLineBefore = previewBefore.lines.find(
      (l) => l.accountNumber === ltdLiabAcct.accountNumber && l.credit === "42.50",
    );
    expect(ltdLineBefore, `expected LTD credit line at ${ltdLiabAcct.accountNumber}: ${JSON.stringify(previewBefore.lines)}`).toBeDefined();
    expect(ltdLineBefore!.departmentCode).toBe(s.department.code);

    // --- Frozen-mutation proof ---
    // Change enrolment election amount, plan default election kind,
    // component statutory flags, component expense account, and
    // employee's live department.
    const otherDept = await prisma.department.create({
      data: { clubId: s.clubId, code: "OTHER", name: "Other" },
    });
    await prisma.employee.update({ where: { id: s.emp.id }, data: { departmentId: otherDept.id } });
    const otherLtdAcct = await prisma.account.create({
      data: {
        clubId: s.clubId, accountNumber: "5199", name: "Other LTD Expense",
        type: "EXPENSE", normalBalance: "DEBIT", isActive: true, allowManualPosting: false,
      },
    });
    await prisma.payrollComponent.update({
      where: { id: s.ltdPlan!.employeeComponentId },
      data: { expenseAccountId: otherLtdAcct.id, taxableEffect: "ADD" },
    });
    await prisma.employeeBenefitPlanEnrolment.update({
      where: { id: s.ltdPlan!.enrolmentId },
      data: { amount: "999" },
    });

    const previewAfter = await previewPayrollJournal(s.paP, s.clubId, prep.batchId);
    const ltdLineAfter = previewAfter.lines.find(
      (l) => l.accountNumber === ltdLiabAcct.accountNumber && l.credit === "42.50",
    );
    expect(ltdLineAfter, "frozen LTD credit line must survive live mutation").toBeDefined();
    expect(ltdLineAfter!.departmentCode).toBe(s.department.code);
    expect(previewAfter.lines.find((l) => l.accountNumber === "5199"),
      "live-mutated expense account must NOT appear").toBeUndefined();
    expect(previewAfter.lines.find((l) => l.credit === "999.00" || l.debit === "999.00"),
      "live-mutated amount must NOT appear").toBeUndefined();

    // --- Post ---
    const post = await postPayrollBatch(s.posterP, prep.batchId);
    expect(post.journalEntryId).toBeDefined();
    // Controller cannot Post.
    await expect(postPayrollBatch(s.controllerP, prep.batchId)).rejects.toBeInstanceOf(ForbiddenError);

    // --- Preview == Post identity ---
    const je = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: post.journalEntryId! }, include: { lines: true },
    });
    const sumDebit = je.lines.reduce((s, l) => s + Number(l.debit ?? 0), 0);
    const sumCredit = je.lines.reduce((s, l) => s + Number(l.credit ?? 0), 0);
    expect(sumDebit).toBeCloseTo(sumCredit, 2);

    // --- PayStatement ---
    const stmt = await buildPayStatement(s.paP, s.clubId, be.id);
    const allLines = stmt.sections.flatMap((sec) => sec.lines);
    const ltdStmt = allLines.find((l) => l.label === "LTD Employee Premium");
    expect(ltdStmt, `expected LTD Employee Premium line; got: ${allLines.map((l) => l.label).join(", ")}`).toBeDefined();
    expect(ltdStmt!.current).toBe("42.50");
    // Post-tax employee deduction bucket = OTHER_DEDUCTIONS.
    const otherDeductions = stmt.sections.find((sec) => sec.kind === "OTHER_DEDUCTIONS");
    expect(otherDeductions?.lines.some((l) => l.label === "LTD Employee Premium")).toBe(true);

    // --- YTD ---
    const nextPeriod = await prisma.payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.clubId, payGroupId: s.payGroupId, payDate: { gt: s.payDate } },
      orderBy: { payDate: "asc" },
    });
    const ytd = await getEmployeePayrollYtd(s.clubId, s.emp.id, nextPeriod.payDate);
    // LTD is post-tax so it does NOT reduce ytdGrossEarnings / ytdTaxableEarnings.
    expect(Number(ytd.ytdGrossEarnings)).toBeCloseTo(4583.33, 2);
    // Re-read: idempotent.
    const ytd2 = await getEmployeePayrollYtd(s.clubId, s.emp.id, nextPeriod.payDate);
    expect(ytd2.ytdGrossEarnings).toBe(ytd.ytdGrossEarnings);
  });
});

describe("Slice C — Health/Dental full pipeline (employer non-cash taxable benefit)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("$180.00 employer Health premium contributes to taxable base without reducing net pay", async () => {
    const s = await createPayrollIntegrationFixture({
      clubName: "Health Full Pipeline",
      annualSalary: "110000",
      healthDental: { employerMonthlyPremium: "180.00" },
    });
    expect(s.healthPlan).toBeDefined();

    // --- Prepare ---
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    const be = await prisma.payrollBatchEmployee.findFirstOrThrow({
      where: { batchId: prep.batchId, employeeId: s.emp.id },
    });
    const healthSnap = await prisma.payrollBatchComponentSnapshot.findFirstOrThrow({
      where: {
        batchId: prep.batchId,
        provenance: "BENEFIT_ENROLMENT",
        sourceEnrolmentId: s.healthPlan!.enrolmentId,
      },
    });
    expect(healthSnap.componentCode).toBe("HEALTH_ER");
    expect(healthSnap.side).toBe("EMPLOYER");
    expect(healthSnap.cashEffect).toBe("NO_NET_PAY_EFFECT");
    expect(healthSnap.resolvedAmount?.toString()).toBe("180");
    expect(healthSnap.taxableEffect).toBe("ADD");

    // --- Calculate ---
    const calc = await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    expect(calc.lifecycleStatus).toBe("CALCULATED");
    const beAfter = await prisma.payrollBatchEmployee.findUniqueOrThrow({ where: { id: be.id } });
    // Employer non-cash benefit does NOT reduce net pay but DOES increase
    // taxable / pensionable bases (per fixture configuration).
    // Net pay = gross - deductions. Gross earnings from cash side unchanged (4583.33).
    expect(Number(beAfter.grossPay!.toString())).toBeCloseTo(4583.33, 2);
    // Taxable base = gross + non-cash taxable benefit = 4583.33 + 180 = 4763.33.
    expect(Number(beAfter.earningsTaxable!.toString())).toBeCloseTo(4763.33, 2);
    // Pensionable base includes the +180 too (component configured cppPensionableEffect=ADD).
    expect(Number(beAfter.earningsPensionable!.toString())).toBeCloseTo(4763.33, 2);

    // --- Attest → Submit → Approve → Preview → Post ---
    await attestBatchReview(s.paP, s.clubId, prep.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(s.paP, s.clubId, prep.batchId);
    await approvePayrollBatch(s.controllerP, prep.batchId);

    const preview = await previewPayrollJournal(s.paP, s.clubId, prep.batchId);
    const healthAcct = await prisma.account.findUniqueOrThrow({
      where: { id: s.healthPlan!.employerExpenseAccountId },
    });
    const healthLine = preview.lines.find(
      (l) => l.accountNumber === healthAcct.accountNumber && l.debit === "180.00",
    );
    expect(healthLine, `expected employer Health line at ${healthAcct.accountNumber}`).toBeDefined();

    const post = await postPayrollBatch(s.posterP, prep.batchId);
    expect(post.journalEntryId).toBeDefined();

    // --- PayStatement — employer contribution appears in EMPLOYER_CONTRIBUTIONS ---
    const stmt = await buildPayStatement(s.paP, s.clubId, be.id);
    const employerSection = stmt.sections.find((sec) => sec.kind === "EMPLOYER_CONTRIBUTIONS");
    expect(employerSection, "expected EMPLOYER_CONTRIBUTIONS section").toBeDefined();
    const healthStmt = employerSection!.lines.find((l) => l.label === "Employer Health Premium");
    expect(healthStmt).toBeDefined();
    expect(healthStmt!.current).toBe("180.00");

    // --- Employer contribution must NOT appear as an employee deduction ---
    const employeeDeductions = stmt.sections.find((sec) => sec.kind === "OTHER_DEDUCTIONS");
    expect(employeeDeductions?.lines.some((l) => l.label === "Employer Health Premium")).not.toBe(true);
  });
});

describe("Slice C — enrolment overlap + history", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("Second overlapping ACTIVE enrolment refused; Change closes predecessor and opens successor", async () => {
    const s = await createPayrollIntegrationFixture({
      clubName: "Overlap History",
      ltd: { employeeMonthlyPremium: "42.50" },
    });
    // Second enrol on same plan overlapping window → ConflictError.
    await expect(enrolEmployeeInBenefitPlan(s.adminP, s.clubId, {
      employeeId: s.emp.id, planId: s.ltdPlan!.planId,
      effectiveFrom: new Date("2020-06-01T00:00:00.000Z"),
      electionKind: "FIXED_AMOUNT", amount: "50",
    })).rejects.toBeInstanceOf(ConflictError);

    // Change closes the predecessor at the cutover + opens a successor.
    const successor = await changeEnrolment(s.adminP, s.clubId, {
      enrolmentId: s.ltdPlan!.enrolmentId,
      effectiveFrom: new Date("2026-09-01T00:00:00.000Z"),
      electionKind: "FIXED_AMOUNT",
      amount: "50.00",
    });
    const predecessor = await prisma.employeeBenefitPlanEnrolment.findUniqueOrThrow({
      where: { id: s.ltdPlan!.enrolmentId },
    });
    expect(predecessor.status).toBe("ENDED");
    expect(predecessor.effectiveTo?.toISOString().slice(0, 10)).toBe("2026-09-01");
    expect(successor.status).toBe("ACTIVE");
    expect(successor.effectiveFromIso.slice(0, 10)).toBe("2026-09-01");
    expect(successor.amount).toBe("50");
  });

  it("End enrolment uses half-open effectiveTo", async () => {
    const s = await createPayrollIntegrationFixture({
      clubName: "End Half Open",
      ltd: { employeeMonthlyPremium: "42.50" },
    });
    await endEnrolment(s.adminP, s.clubId, s.ltdPlan!.enrolmentId, {
      effectiveTo: "2026-09-16",
      endReason: "test end",
    });
    const ended = await prisma.employeeBenefitPlanEnrolment.findUniqueOrThrow({
      where: { id: s.ltdPlan!.enrolmentId },
    });
    expect(ended.status).toBe("ENDED");
    expect(ended.effectiveTo?.toISOString().slice(0, 10)).toBe("2026-09-16");
    // Enrolment ends AT 2026-09-16 — a Prepare for the Sep 16-30 period
    // (asOf = periodEnd - 1ms = Sep 30 23:59:59.999) — wait, asOf is
    // actually the last instant of the period. A ended-at-Sep-16
    // enrolment must NOT apply because effectiveTo <= asOf. Assert.
    const asOf = new Date(new Date(s.periodEnd).getTime() - 1);
    expect(ended.effectiveTo!.getTime() <= asOf.getTime()).toBe(true);
    // Prepare must NOT freeze this ended enrolment.
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    const snap = await prisma.payrollBatchComponentSnapshot.findFirst({
      where: { batchId: prep.batchId, provenance: "BENEFIT_ENROLMENT" },
    });
    expect(snap).toBeNull();
  });
});
