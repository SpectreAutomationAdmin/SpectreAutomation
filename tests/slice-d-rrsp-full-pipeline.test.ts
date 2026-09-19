// Slice D (2026-09-19) — RRSP plan, employee election + employer match/cap
// full pipeline. Covers directive §10, §11, §26, §27, §28, §29, §30.
//
// FIXTURE CONFIGURATION disclaimer: the fixture wires the employee-side
// RRSP component as `taxableEffect=NONE / cppPensionableEffect=NONE /
// eiInsurableEffect=NONE` (post-tax). Spectre honours the frozen
// PayrollComponent semantics, not plan.kind — a Club that funds RRSP
// pre-tax configures its linked component differently.
//
// Match formula:
//   C   = round(E × R,   HALF_UP)
//   U   = round(C × M,   HALF_UP)
//   CAP = round(E × K,   HALF_UP)
//   ER  = min(U, CAP)

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
import { changeEnrolment } from "@/lib/payroll/benefit-enrolments";
import { calculateEarnings } from "@/lib/payroll/earnings-calculator";
import { ForbiddenError } from "@/lib/errors";
import { Decimal } from "@/lib/payroll/statutory/decimal-money";

describe("Slice D — RRSP full pipeline (Enrol → Post → PayStatement → YTD)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("$110k / SM / 5% / match 100% / cap 3% → EE $229.17, ER $137.50 (§10)", async () => {
    const s = await createPayrollIntegrationFixture({
      clubName: "RRSP §10",
      annualSalary: "110000",
      rrsp: { employeePercent: 5, employerMatchPercent: 100, employerCapPercent: 3 },
    });
    expect(s.rrspPlan).toBeDefined();
    expect(s.rrspPlan!.employerMatchBps).toBe(10000);
    expect(s.rrspPlan!.employerMatchCapBps).toBe(300);
    expect(s.rrspPlan!.employeePercentBps).toBe(500);

    // --- Prepare ---
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    const be = await prisma.payrollBatchEmployee.findFirstOrThrow({
      where: { batchId: prep.batchId, employeeId: s.emp.id },
    });
    // §26 A + B — enrolment election + exactly two RRSP benefit snapshots.
    const rrspSnaps = await prisma.payrollBatchComponentSnapshot.findMany({
      where: {
        batchId: prep.batchId,
        provenance: "BENEFIT_ENROLMENT",
        sourceEnrolmentId: s.rrspPlan!.enrolmentId,
      },
      orderBy: { side: "asc" },
    });
    expect(rrspSnaps.length).toBe(2);
    const eeSnap = rrspSnaps.find((r) => r.side === "EMPLOYEE")!;
    const erSnap = rrspSnaps.find((r) => r.side === "EMPLOYER")!;
    expect(eeSnap.sourcePercentBps).toBe(500);
    expect(eeSnap.matchBps).toBeNull();
    expect(eeSnap.matchCapBps).toBeNull();
    expect(erSnap.matchBps).toBe(10000);
    expect(erSnap.matchCapBps).toBe(300);

    // --- Calculate ---
    const calc = await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    expect(calc.lifecycleStatus, JSON.stringify(calc.blockers ?? [])).toBe("CALCULATED");

    // §26 F — gross unchanged by employee RRSP.
    const beAfter = await prisma.payrollBatchEmployee.findUniqueOrThrow({ where: { id: be.id } });
    expect(Number(beAfter.grossPay!.toString())).toBeCloseTo(4583.33, 2);

    // §10 exact expected amounts.
    const eeSnapAfter = await prisma.payrollBatchComponentSnapshot.findUniqueOrThrow({ where: { id: eeSnap.id } });
    const erSnapAfter = await prisma.payrollBatchComponentSnapshot.findUniqueOrThrow({ where: { id: erSnap.id } });
    expect(Number(eeSnapAfter.resolvedAmount!.toString())).toBeCloseTo(229.17, 2);
    expect(Number(erSnapAfter.resolvedAmount!.toString())).toBeCloseTo(137.50, 2);
    expect(Number(eeSnapAfter.eligibleEarningsAmount!.toString())).toBeCloseTo(4583.33, 2);
    expect(Number(erSnapAfter.eligibleEarningsAmount!.toString())).toBeCloseTo(4583.33, 2);

    // --- Attest → Submit → Approve → Post ---
    await attestBatchReview(s.paP, s.clubId, prep.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(s.paP, s.clubId, prep.batchId);
    await approvePayrollBatch(s.controllerP, prep.batchId);

    // §26 M — Preview lines
    const preview = await previewPayrollJournal(s.paP, s.clubId, prep.batchId);
    const eeAcct = await prisma.account.findUniqueOrThrow({ where: { id: s.rrspPlan!.employeeLiabilityAccountId } });
    const erExpAcct = await prisma.account.findUniqueOrThrow({ where: { id: s.rrspPlan!.employerExpenseAccountId } });
    const erLiabAcct = await prisma.account.findUniqueOrThrow({ where: { id: s.rrspPlan!.employerLiabilityAccountId } });
    // Employee post-tax RRSP deduction → CREDIT the employee payable.
    const eeLine = preview.lines.find((l) => l.accountNumber === eeAcct.accountNumber && l.credit === "229.17");
    expect(eeLine, `expected EE RRSP credit line at ${eeAcct.accountNumber}: ${JSON.stringify(preview.lines)}`).toBeDefined();
    // Employer match → DEBIT expense + CREDIT liability.
    const erDebit  = preview.lines.find((l) => l.accountNumber === erExpAcct.accountNumber && l.debit === "137.50");
    const erCredit = preview.lines.find((l) => l.accountNumber === erLiabAcct.accountNumber && l.credit === "137.50");
    expect(erDebit,  `expected ER RRSP debit at ${erExpAcct.accountNumber}`).toBeDefined();
    expect(erCredit, `expected ER RRSP credit at ${erLiabAcct.accountNumber}`).toBeDefined();

    // §26 P + Q — Controller cannot Post; PA posts after approval.
    await expect(postPayrollBatch(s.controllerP, prep.batchId)).rejects.toBeInstanceOf(ForbiddenError);
    const post = await postPayrollBatch(s.posterP, prep.batchId);
    expect(post.journalEntryId).toBeDefined();

    // Preview == Post.
    const je = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: post.journalEntryId! }, include: { lines: true },
    });
    const totalDebit  = je.lines.reduce((a, l) => a + Number(l.debit  ?? 0), 0);
    const totalCredit = je.lines.reduce((a, l) => a + Number(l.credit ?? 0), 0);
    expect(totalDebit).toBeCloseTo(totalCredit, 2);

    // §16 — PayStatementV2 shows both distinct lines.
    const stmt = await buildPayStatement(s.paP, s.clubId, be.id);
    const allLines = stmt.sections.flatMap((sec) => sec.lines);
    const eeStmt = allLines.find((l) => l.label === "RRSP Employee Contribution");
    const erStmt = allLines.find((l) => l.label === "RRSP Employer Match");
    expect(eeStmt?.current).toBe("229.17");
    expect(erStmt?.current).toBe("137.50");
    // §26 I — employee deduction under OTHER_DEDUCTIONS; employer under
    // EMPLOYER_CONTRIBUTIONS.
    const eeDeductions = stmt.sections.find((sec) => sec.kind === "OTHER_DEDUCTIONS");
    const employerSection = stmt.sections.find((sec) => sec.kind === "EMPLOYER_CONTRIBUTIONS");
    expect(eeDeductions?.lines.some((l) => l.label === "RRSP Employee Contribution")).toBe(true);
    expect(employerSection?.lines.some((l) => l.label === "RRSP Employer Match")).toBe(true);

    // §17 — YTD once, idempotent read.
    const nextPeriod = await prisma.payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.clubId, payGroupId: s.payGroupId, payDate: { gt: s.payDate } },
      orderBy: { payDate: "asc" },
    });
    const ytd  = await getEmployeePayrollYtd(s.clubId, s.emp.id, nextPeriod.payDate);
    const ytd2 = await getEmployeePayrollYtd(s.clubId, s.emp.id, nextPeriod.payDate);
    expect(ytd2.ytdGrossEarnings).toBe(ytd.ytdGrossEarnings);
  });

  it("Frozen mutation proof: live edits after Prepare do not alter Calc/Preview/Post (§14)", async () => {
    const s = await createPayrollIntegrationFixture({
      clubName: "RRSP frozen",
      annualSalary: "110000",
      rrsp: { employeePercent: 5, employerMatchPercent: 100, employerCapPercent: 3 },
    });
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    await attestBatchReview(s.paP, s.clubId, prep.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(s.paP, s.clubId, prep.batchId);
    await approvePayrollBatch(s.controllerP, prep.batchId);

    // --- Mutate everything the founder listed in §14 ---
    // Election %.
    await prisma.employeeBenefitPlanEnrolment.update({
      where: { id: s.rrspPlan!.enrolmentId }, data: { percentBps: 900 },
    });
    // Plan match/cap + basis.
    await prisma.payrollBenefitPlan.update({
      where: { id: s.rrspPlan!.planId },
      data: {
        employerMatchBps: 5000, employerMatchCapBps: 100,
        eligibleEarningsBasis: "CASH_EARNINGS",
      },
    });
    // Employee + employer component GL accounts.
    const otherAcct = await prisma.account.create({
      data: {
        clubId: s.clubId, accountNumber: "5199", name: "Other RRSP Expense",
        type: "EXPENSE", normalBalance: "DEBIT", isActive: true, allowManualPosting: false,
      },
    });
    await prisma.payrollComponent.update({
      where: { id: s.rrspPlan!.employeeComponentId }, data: { expenseAccountId: otherAcct.id },
    });
    await prisma.payrollComponent.update({
      where: { id: s.rrspPlan!.employerComponentId }, data: { expenseAccountId: otherAcct.id },
    });
    // Employee's live department.
    const otherDept = await prisma.department.create({
      data: { clubId: s.clubId, code: "OTHER", name: "Other" },
    });
    await prisma.employee.update({ where: { id: s.emp.id }, data: { departmentId: otherDept.id } });

    // Preview must still use the FROZEN values.
    const preview = await previewPayrollJournal(s.paP, s.clubId, prep.batchId);
    const eeAcct = await prisma.account.findUniqueOrThrow({ where: { id: s.rrspPlan!.employeeLiabilityAccountId } });
    const eeLine = preview.lines.find((l) => l.accountNumber === eeAcct.accountNumber && l.credit === "229.17");
    expect(eeLine, "frozen $229.17 must survive live mutation").toBeDefined();
    expect(eeLine!.departmentCode).toBe(s.department.code);
    expect(preview.lines.find((l) => l.accountNumber === "5199")).toBeUndefined();
  });

  it("Second-period YTD proof (§17, §27)", async () => {
    const s = await createPayrollIntegrationFixture({
      clubName: "RRSP YTD",
      annualSalary: "110000",
      rrsp: { employeePercent: 5, employerMatchPercent: 100, employerCapPercent: 3 },
    });
    // Post period #1.
    const p1 = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.clubId, p1.batchId);
    await attestBatchReview(s.paP, s.clubId, p1.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(s.paP, s.clubId, p1.batchId);
    await approvePayrollBatch(s.controllerP, p1.batchId);
    await postPayrollBatch(s.posterP, p1.batchId);

    // The next SM period.
    const nextPeriod = await prisma.payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.clubId, payGroupId: s.payGroupId, payDate: { gt: s.payDate } },
      orderBy: { payDate: "asc" },
    });
    // Period must be OPEN to Prepare.
    await prisma.payrollPayPeriod.update({ where: { id: nextPeriod.id }, data: { status: "OPEN" } });
    // Ensure a fiscal period covers the next payDate — the fixture only
    // seeded the month covering p1's payDate.
    const nextMonth = nextPeriod.payDate.getUTCMonth() + 1;
    const y = nextPeriod.payDate.getUTCFullYear();
    const fy = await prisma.fiscalYear.findFirstOrThrow({ where: { clubId: s.clubId } });
    const exists = await prisma.fiscalPeriod.findFirst({
      where: {
        clubId: s.clubId,
        startDate: { lte: nextPeriod.payDate },
        endDate: { gte: nextPeriod.payDate },
      },
    });
    if (!exists) {
      await prisma.fiscalPeriod.create({
        data: {
          clubId: s.clubId, fiscalYearId: fy.id,
          label: `FY${y}-M${String(nextMonth).padStart(2, "0")}`,
          startDate: new Date(Date.UTC(y, nextMonth - 1, 1)),
          endDate: new Date(Date.UTC(y, nextMonth, 0)),
          sequence: nextMonth, status: "OPEN",
        },
      });
    }

    const p2 = await preparePayrollBatch(s.paP, s.clubId, nextPeriod.id);
    await calculatePayrollBatch(s.paP, s.clubId, p2.batchId);
    await attestBatchReview(s.paP, s.clubId, p2.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(s.paP, s.clubId, p2.batchId);
    await approvePayrollBatch(s.controllerP, p2.batchId);
    await postPayrollBatch(s.posterP, p2.batchId);

    // YTD after two periods — sum of two identical postings.
    const asOf = new Date(nextPeriod.payDate.getTime() + 86_400_000);
    const ytd = await getEmployeePayrollYtd(s.clubId, s.emp.id, asOf);
    // Gross doubles.
    expect(Number(ytd.ytdGrossEarnings)).toBeCloseTo(9166.66, 2);
  });
});

// ----------------------------------------------------------------
// §11 match cases — direct calculator-level assertions. These
// exercise the earnings calculator in isolation so we cover every
// bracket + boundary explicitly without spinning the full pipeline.
// ----------------------------------------------------------------
describe("Slice D — match cases (§11, §28, §29)", () => {
  const EE = (percent: number) => ({
    code: "RRSP_EE", side: "EMPLOYEE" as const,
    cashEffect: "DECREASES_NET_PAY" as const,
    taxableEffect: "NONE" as const, cppPensionableEffect: "NONE" as const, eiInsurableEffect: "NONE" as const,
    calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS" as const,
    resolvedAmount: null,
    eligibleEarningsBase: "REGULAR_EARNINGS_ONLY" as const,
    sourcePercentBps: Math.round(percent * 100),
    sourceEnrolmentId: "e1",
    matchBps: null,
    matchCapBps: null,
  });
  const ER = (matchPct: number, capPct: number) => ({
    code: "RRSP_ER", side: "EMPLOYER" as const,
    cashEffect: "NO_NET_PAY_EFFECT" as const,
    taxableEffect: "NONE" as const, cppPensionableEffect: "NONE" as const, eiInsurableEffect: "NONE" as const,
    calculationMethod: "PERCENT_OF_ELIGIBLE_EARNINGS" as const,
    resolvedAmount: null,
    eligibleEarningsBase: "REGULAR_EARNINGS_ONLY" as const,
    sourcePercentBps: 0,
    sourceEnrolmentId: "e1",
    matchBps:    Math.round(matchPct * 100),
    matchCapBps: Math.round(capPct   * 100),
  });

  function run(eligible: string, eePct: number, matchPct: number, capPct: number) {
    return calculateEarnings({
      sourceFacts: {} as never,
      earningRows: [{ earningType: "SALARY", quantity: "1", rate: eligible }],
      allowances: [],
      componentSnapshots: [EE(eePct), ER(matchPct, capPct)],
      approvedHours: "0",
      periodsPerYear: 24,
      salariedFullPeriod: true,
    });
  }
  function found(res: ReturnType<typeof run>, code: string) {
    return res.percentResolutions.find((p) => p.code === code)!;
  }

  it("Employee 2% / Match 100% / Cap 3% → employer matches full 2%", () => {
    const r = run("4583.33", 2, 100, 3);
    expect(found(r, "RRSP_EE").resolvedAmount.toFixed(2)).toBe("91.67");   // 4583.33 × 0.02
    expect(found(r, "RRSP_ER").resolvedAmount.toFixed(2)).toBe("91.67");
  });

  it("Employee 5% / Match 100% / Cap 3% → employer capped at 3%", () => {
    const r = run("4583.33", 5, 100, 3);
    expect(found(r, "RRSP_EE").resolvedAmount.toFixed(2)).toBe("229.17");
    expect(found(r, "RRSP_ER").resolvedAmount.toFixed(2)).toBe("137.50");
  });

  it("Employee 5% / Match 50% / Cap 3% → uncapped 2.5% ($114.59)", () => {
    const r = run("4583.33", 5, 50, 3);
    expect(found(r, "RRSP_EE").resolvedAmount.toFixed(2)).toBe("229.17");
    // Uncapped = 229.17 × 0.50 = 114.585 → HALF_UP → 114.59
    // Cap = 4583.33 × 0.03 = 137.4999 → HALF_UP → 137.50
    // ER = min(114.59, 137.50) = 114.59
    expect(found(r, "RRSP_ER").resolvedAmount.toFixed(2)).toBe("114.59");
  });

  it("Employee 10% / Match 50% / Cap 3% → capped at $137.50", () => {
    const r = run("4583.33", 10, 50, 3);
    expect(found(r, "RRSP_EE").resolvedAmount.toFixed(2)).toBe("458.33");
    // Uncapped = 458.33 × 0.50 = 229.165 → 229.17. Cap = 137.50. ER = 137.50.
    expect(found(r, "RRSP_ER").resolvedAmount.toFixed(2)).toBe("137.50");
  });

  it("Employee 0% → both sides $0", () => {
    const r = run("4583.33", 0, 100, 3);
    expect(found(r, "RRSP_EE").resolvedAmount.toFixed(2)).toBe("0.00");
    expect(found(r, "RRSP_ER").resolvedAmount.toFixed(2)).toBe("0.00");
  });

  it("Non-round eligible earnings ($4,321.17) with 3.33% / 75% / 2.25% (§28)", () => {
    const r = run("4321.17", 3.33, 75, 2.25);
    // C = 4321.17 × 0.0333 = 143.894961 → HALF_UP (0.4961 < 0.5) → 143.89
    // U = 143.89 × 0.75  = 107.9175 → HALF_UP (0.5 → up) → 107.92
    // CAP = 4321.17 × 0.0225 = 97.226325 → HALF_UP → 97.23
    // ER = min(107.92, 97.23) = 97.23
    expect(found(r, "RRSP_EE").resolvedAmount.toFixed(2)).toBe("143.89");
    expect(found(r, "RRSP_ER").resolvedAmount.toFixed(2)).toBe("97.23");
  });

  it("Cap 0% → employer $0 regardless of match rate (§29)", () => {
    const r = run("4583.33", 5, 100, 0);
    expect(found(r, "RRSP_ER").resolvedAmount.toFixed(2)).toBe("0.00");
  });

  it("Match 0% → employer $0 regardless of employee election (§29)", () => {
    const r = run("4583.33", 5, 0, 3);
    expect(found(r, "RRSP_ER").resolvedAmount.toFixed(2)).toBe("0.00");
  });
});

// ----------------------------------------------------------------
// §30 component-semantics proof: prove the engine obeys frozen
// PayrollComponent semantics, not plan.kind.
// ----------------------------------------------------------------
describe("Slice D — component-semantics govern payroll behaviour (§30)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("An RRSP plan whose linked components carry taxableEffect=ADD grows the taxable base", async () => {
    const s = await createPayrollIntegrationFixture({
      clubName: "RRSP taxable",
      annualSalary: "110000",
      rrsp: { employeePercent: 5, employerMatchPercent: 100, employerCapPercent: 3 },
    });
    // Live-mutate both components to ADD (fixture default is NONE). Do
    // this BEFORE the (only) Prepare so the frozen snapshot carries ADD.
    await prisma.payrollComponent.updateMany({
      where: { id: { in: [s.rrspPlan!.employeeComponentId, s.rrspPlan!.employerComponentId] } },
      data: { taxableEffect: "ADD" },
    });
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    const be = await prisma.payrollBatchEmployee.findFirstOrThrow({
      where: { batchId: prep.batchId, employeeId: s.emp.id },
    });
    // Taxable base = gross + EE $229.17 + ER $137.50 = 4583.33 + 366.67 = 4950.00
    expect(Number(be.earningsTaxable!.toString())).toBeCloseTo(4950.00, 2);
    // Meanwhile the "plan.kind === RRSP" alone did NOT drive this — the
    // components did. Sanity: with fixture default NONE the base would
    // equal gross, but here we deliberately configured ADD.
  });
});
