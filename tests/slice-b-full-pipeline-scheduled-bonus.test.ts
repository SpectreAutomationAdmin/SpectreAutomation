// Slice B acceptance-blocker (2026-09-18) — full pipeline regression.
//
// Founder-directive §16 A-H proof-set. ONE scheduled bonus travels
// through the REAL services from schedule → Prepare → Calculate →
// Submit → Approve → GL Preview → Post → PayStatement → YTD.
//
// Distinctive values so the $1,500 bonus can be traced end-to-end:
//   Base salary               $110,000 annual / semi-monthly
//   Recurring Cell Phone      $75.00 per pay
//   Scheduled Performance Bonus $1,500.00 for the target period

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
import { ForbiddenError } from "@/lib/errors";

describe("Slice B acceptance blocker — Schedule → Prepare → … → Post → PayStatement → YTD", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("full pipeline: $1,500 bonus contributes exactly once through every stage", async () => {
    // ---------------------------------------------------------------
    // Compose fixture: $110k salary + $75 Cell Phone + $1,500 Bonus
    // scheduled for period seq=18 (Sep 16 → Oct 1, pay Sep 30).
    // ---------------------------------------------------------------
    const s = await createPayrollIntegrationFixture({
      clubName: "Full Pipeline Bonus",
      annualSalary: "110000",
      cellPhoneAmount: "75.00",
      bonusAmount: "1500",
    });
    expect(s.bonus, "bonus fixture required").toBeDefined();

    // Pre-Prepare — source is SCHEDULED.
    const scheduledBefore = await prisma.payrollScheduledOneTimeEarning.findFirstOrThrow({
      where: { clubId: s.clubId, employeeId: s.emp.id, payPeriodId: s.payPeriodId },
    });
    expect(scheduledBefore.status).toBe("SCHEDULED");
    expect(scheduledBefore.amount.toString()).toBe("1500");

    // ---------------------------------------------------------------
    // Prepare (REAL service).
    // ---------------------------------------------------------------
    const prep = await preparePayrollBatch(s.paP, s.clubId, s.payPeriodId);
    expect(prep.batchId).toBeDefined();

    // C. Source → snapshot proof.
    const scheduledAfter = await prisma.payrollScheduledOneTimeEarning.findUniqueOrThrow({
      where: { id: scheduledBefore.id },
    });
    expect(scheduledAfter.status).toBe("APPLIED");
    expect(scheduledAfter.appliedToBatchId).toBe(prep.batchId);
    expect(scheduledAfter.appliedSnapshotId).not.toBeNull();

    const oneTimeSnaps = await prisma.payrollBatchComponentSnapshot.findMany({
      where: { batchId: prep.batchId, provenance: "ONE_TIME_PAYROLL_ADJUSTMENT" },
    });
    expect(oneTimeSnaps.length).toBe(1);
    const bonusSnap = oneTimeSnaps[0]!;
    expect(bonusSnap.componentCode).toBe("PERF_BONUS");
    expect(bonusSnap.resolvedAmount?.toString()).toBe("1500");
    expect(bonusSnap.cashEffect).toBe("INCREASES_NET_PAY");
    expect(bonusSnap.expenseAccountIdSnapshot).toBe(s.bonus!.expenseAccountId);
    expect(bonusSnap.sourceComponentId).toBe(s.bonus!.id);
    // Frozen employee department on the batch employee.
    const be = await prisma.payrollBatchEmployee.findFirstOrThrow({
      where: { batchId: prep.batchId, employeeId: s.emp.id },
    });

    // ---------------------------------------------------------------
    // Calculate (REAL engine).
    // ---------------------------------------------------------------
    const calc = await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    expect(calc.lifecycleStatus, `calc blockers: ${JSON.stringify(calc.blockers ?? [])}`).toBe("CALCULATED");

    // Bonus contributes exactly once to gross (cash-earning bucket).
    const beAfterCalc = await prisma.payrollBatchEmployee.findUniqueOrThrow({
      where: { id: be.id },
    });
    // Base salary per period = 110000/24 = 4583.33; cell = 75; bonus = 1500;
    // total cash gross = 6158.33. Calc gross should reflect this before
    // any statutory reductions from taxableEffect (bonus adds to taxable).
    const grossPay = Number(beAfterCalc.grossPay!.toString());
    expect(grossPay).toBeCloseTo(4583.33 + 75 + 1500, 2);

    // Retry calculation is idempotent — snapshot count unchanged.
    const calc2 = await calculatePayrollBatch(s.paP, s.clubId, prep.batchId);
    expect(calc2.lifecycleStatus).toBe("CALCULATED");
    const oneTimeSnapsRetry = await prisma.payrollBatchComponentSnapshot.count({
      where: { batchId: prep.batchId, provenance: "ONE_TIME_PAYROLL_ADJUSTMENT" },
    });
    expect(oneTimeSnapsRetry).toBe(1);

    // ---------------------------------------------------------------
    // Submit + Approve + Post (real SoD principals).
    // ---------------------------------------------------------------
    await attestBatchReview(s.paP, s.clubId, prep.batchId, "CALCULATED_PAYROLL");
    await submitPayrollBatch(s.paP, s.clubId, prep.batchId);
    await approvePayrollBatch(s.controllerP, prep.batchId);

    // ---------------------------------------------------------------
    // GL Preview (before mutation).
    // ---------------------------------------------------------------
    const previewBefore = await previewPayrollJournal(s.paP, s.clubId, prep.batchId);
    // Preview lines use accountNumber + departmentCode (not IDs).
    const bonusAcctBefore = await prisma.account.findUniqueOrThrow({ where: { id: s.bonus!.expenseAccountId } });
    const bonusLineBefore = previewBefore.lines.find(
      (l) => l.accountNumber === bonusAcctBefore.accountNumber && l.debit === "1500.00",
    );
    expect(bonusLineBefore, `expected preview debit to bonus expense account #${bonusAcctBefore.accountNumber} for $1,500.00; got: ${JSON.stringify(previewBefore.lines)}`).toBeDefined();
    expect(bonusLineBefore!.departmentCode).toBe(s.department.code);

    // ---------------------------------------------------------------
    // Mutate live state AFTER Prepare — must not affect Preview or Post.
    // ---------------------------------------------------------------
    // Change the employee's live department.
    const otherDept = await prisma.department.create({
      data: { clubId: s.clubId, code: "OTHER", name: "Other" },
    });
    await prisma.employee.update({ where: { id: s.emp.id }, data: { departmentId: otherDept.id } });
    // Change the bonus component's live expense account.
    const differentAccount = await prisma.account.create({
      data: {
        clubId: s.clubId, accountNumber: "5199", name: "Different Bonus Expense",
        type: "EXPENSE", normalBalance: "DEBIT", isActive: true, allowManualPosting: false,
      },
    });
    await prisma.payrollComponent.update({
      where: { id: s.bonus!.id }, data: { expenseAccountId: differentAccount.id },
    });

    // Preview after mutation — same account, same department.
    const previewAfter = await previewPayrollJournal(s.paP, s.clubId, prep.batchId);
    const bonusLineAfter = previewAfter.lines.find(
      (l) => l.accountNumber === bonusAcctBefore.accountNumber && l.debit === "1500.00",
    );
    expect(bonusLineAfter, "preview must still use the FROZEN bonus expense account").toBeDefined();
    expect(bonusLineAfter!.departmentCode, "preview must still use the FROZEN employee department").toBe(s.department.code);
    // AND the live-mutated "different" account must NOT appear.
    const differentUsed = previewAfter.lines.find((l) => l.accountNumber === differentAccount.accountNumber);
    expect(differentUsed, "live-mutated component account must not appear in preview").toBeUndefined();

    // ---------------------------------------------------------------
    // Post — real Payroll-Admin poster (distinct from Controller-approver).
    // ---------------------------------------------------------------
    const post = await postPayrollBatch(s.posterP, prep.batchId);
    expect(post.journalEntryId).toBeDefined();

    // Controller CANNOT Post.
    await expect(postPayrollBatch(s.controllerP, prep.batchId)).rejects.toBeInstanceOf(ForbiddenError);

    // ---------------------------------------------------------------
    // Preview == Post (account + department + debit + credit).
    // ---------------------------------------------------------------
    const je = await prisma.journalEntry.findUniqueOrThrow({
      where: { id: post.journalEntryId! },
      include: { lines: true },
    });
    // Journal balances.
    const sumDebit = je.lines.reduce((sum, l) => sum + Number(l.debit ?? 0), 0);
    const sumCredit = je.lines.reduce((sum, l) => sum + Number(l.credit ?? 0), 0);
    expect(sumDebit).toBeCloseTo(sumCredit, 2);
    // Preview lines must reconcile 1:1 to the posted JE lines by
    // (accountNumber, departmentCode, debit, credit).
    // The JE stores accountId; look up numbers.
    const accountsForJe = await prisma.account.findMany({
      where: { id: { in: je.lines.map((l) => l.accountId) } },
      select: { id: true, accountNumber: true },
    });
    const acctNumById = new Map(accountsForJe.map((a) => [a.id, a.accountNumber]));
    const deptsForJe = await prisma.department.findMany({
      where: { id: { in: je.lines.map((l) => l.departmentId).filter((v): v is string => v != null) } },
      select: { id: true, code: true },
    });
    const deptCodeById = new Map(deptsForJe.map((d) => [d.id, d.code]));
    const previewKey = (l: { accountNumber: string; departmentCode: string | null; debit: string | null; credit: string | null }) =>
      `${l.accountNumber}|${l.departmentCode ?? ""}|${l.debit ?? "0.00"}|${l.credit ?? "0.00"}`;
    const jeKey = (l: { accountId: string; departmentId: string | null; debit: unknown; credit: unknown }) => {
      const acctNum = acctNumById.get(l.accountId) ?? l.accountId;
      const deptCode = l.departmentId ? deptCodeById.get(l.departmentId) ?? "" : "";
      return `${acctNum}|${deptCode}|${Number(l.debit ?? 0).toFixed(2)}|${Number(l.credit ?? 0).toFixed(2)}`;
    };
    const previewSet = new Set(previewAfter.lines.map(previewKey));
    const jeSet = new Set(je.lines.map(jeKey));
    expect(jeSet).toEqual(previewSet);

    // Source status remains APPLIED after Post — never renamed to PAID.
    const scheduledFinal = await prisma.payrollScheduledOneTimeEarning.findUniqueOrThrow({
      where: { id: scheduledBefore.id },
    });
    expect(scheduledFinal.status).toBe("APPLIED");

    // ---------------------------------------------------------------
    // PayStatement — bonus renders as its own line at $1,500.00.
    // ---------------------------------------------------------------
    const stmtAfterPost = await buildPayStatement(s.paP, s.clubId, be.id);
    const allLines = stmtAfterPost.sections.flatMap((sec) => sec.lines);
    const salaryLine = allLines.find((l) => l.label === "Salary" || l.label === "Base Salary");
    const cellLine = allLines.find((l) => l.label === "Cell Phone Allowance");
    const bonusLine = allLines.find((l) => l.label === "Performance Bonus");
    expect(salaryLine, `expected Salary line; got ${allLines.map((l) => l.label).join(", ")}`).toBeDefined();
    expect(cellLine).toBeDefined();
    expect(bonusLine).toBeDefined();
    expect(bonusLine!.current).toBe("1500.00");
    expect(bonusLine!.isOneTime).toBe(true);

    // ---------------------------------------------------------------
    // YTD — bonus contributes exactly once.
    // ---------------------------------------------------------------
    // YTD as-of a NEXT-period payDate so the just-posted batch is
    // "prior" and included in the aggregate.
    const nextPeriod = await prisma.payrollPayPeriod.findFirstOrThrow({
      where: { clubId: s.clubId, payGroupId: s.payGroupId, payDate: { gt: s.payDate } },
      orderBy: { payDate: "asc" },
    });
    const ytd = await getEmployeePayrollYtd(s.clubId, s.emp.id, nextPeriod.payDate);
    const ytdGross = Number(ytd.ytdGrossEarnings);
    expect(ytdGross, "YTD gross must include the bonus exactly once").toBeCloseTo(grossPay, 2);
    // Bonus is configured taxable + pensionable + insurable — YTD taxable
    // must be non-zero (and >= 1500 because bonus taxableEffect=ADD).
    const ytdTaxable = Number(ytd.ytdTaxableEarnings);
    expect(ytdTaxable).toBeGreaterThanOrEqual(1500);
    // Re-read YTD — identical values, no double-counting.
    const ytd2 = await getEmployeePayrollYtd(s.clubId, s.emp.id, nextPeriod.payDate);
    expect(ytd2.ytdGrossEarnings).toBe(ytd.ytdGrossEarnings);
    expect(ytd2.ytdTaxableEarnings).toBe(ytd.ytdTaxableEarnings);
    expect(ytd2.ytdCppEE).toBe(ytd.ytdCppEE);
    expect(ytd2.ytdEiEE).toBe(ytd.ytdEiEE);
  });
});
