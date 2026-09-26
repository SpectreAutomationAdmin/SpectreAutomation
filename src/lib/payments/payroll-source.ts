// PAY-1A/2 (2026-09-26) — Payroll → Payments handoff.
//
// Preconditions for `preparePayrollPayments`:
//   1. Batch is POSTED (no earlier lifecycle).
//   2. Batch.transactionType is STANDARD or CORRECTION.
//   3. No pre-existing PaymentRun for this (sourceType=PAYROLL, sourceId=batchId).
//   4. Every INCLUDED batch employee with a NON-ZERO netPay has an
//      ACTIVE EmployeeBankAccount to snapshot.
//   5. Reconciliation: SUM(PaymentInstruction.amount)
//        == SUM(PayrollBatchEmployee.netPay WHERE status=INCLUDED AND netPay > 0)
//
// Failure modes (all fail-closed with no side effect):
//   - Non-POSTED batch
//   - REVERSAL transactionType — PAY-1A does not implement money recovery
//   - Duplicate preparation (existing PaymentRun)
//   - Negative-net line (unsupported)
//   - Missing / inactive employee bank account for a non-zero-net line
//   - Reconciliation mismatch

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/rbac";
import { assertTenantOwned } from "@/lib/services/tenant";
import type { Principal } from "@/lib/rbac";
import { assertPaymentsEnabled } from "./kill-switch";
import { createRun } from "./run";
import { createInstruction, assertReconciles } from "./instruction";
import { captureEmployeeDestination } from "./destination";
import { recordPaymentEvent } from "./events";

export interface PreparePayrollPaymentsInput {
  clubId: string;
  payrollBatchId: string;
  fundingBankAccountId: string;
  // When null, computed from payGroup.payDate.
  requestedExecutionDate?: Date | null;
}

export interface PreparePayrollPaymentsResult {
  runId: string;
  runNumber: string;
  instructionCount: number;
  totalAmount: string; // Decimal-safe
  skippedZeroNet: number;
}

export async function preparePayrollPayments(
  principal: Principal,
  input: PreparePayrollPaymentsInput,
): Promise<PreparePayrollPaymentsResult> {
  assertPaymentsEnabled();
  requirePermission(principal, input.clubId, "payment:prepare");

  return prisma.$transaction(async (tx) => {
    // 1. Load + validate batch.
    const batch = await tx.payrollBatch.findFirst({
      where: { id: input.payrollBatchId, clubId: input.clubId },
      select: {
        id: true, clubId: true, status: true, transactionType: true,
        payPeriod: { select: { periodEnd: true } },
        payGroup: { select: { payDateOffsetDays: true } },
      },
    });
    if (!batch) throw new Error("PAY-1A: PayrollBatch not found or not owned by this tenant.");
    assertTenantOwned({ clubId: batch.clubId }, principal);

    if (batch.status !== "POSTED") {
      throw new Error(`PAY-1A: PayrollBatch is not POSTED (status=${batch.status}); refuse to prepare payments.`);
    }
    if (batch.transactionType === "REVERSAL") {
      throw new Error(
        "PAY-1A: refusing to prepare payments for a REVERSAL payroll. " +
        "Payroll reversal and payment return are distinct financial concepts; " +
        "money recovery/debit semantics are out of scope for PAY-1A.",
      );
    }
    if (batch.transactionType !== "STANDARD" && batch.transactionType !== "CORRECTION") {
      throw new Error(`PAY-1A: unsupported PayrollBatch transactionType=${batch.transactionType}.`);
    }

    // 2. Duplicate-preparation guard.
    const existing = await tx.paymentRun.findFirst({
      where: { clubId: batch.clubId, sourceType: "PAYROLL", sourceId: batch.id },
      select: { id: true, runNumber: true, status: true },
    });
    if (existing) {
      throw new Error(
        `PAY-1A: PaymentRun already exists for this payroll batch (${existing.runNumber}, status=${existing.status}). ` +
        "Cancel it first if a new run is intended.",
      );
    }

    // 3. Load frozen batch employees.
    const employees = await tx.payrollBatchEmployee.findMany({
      where: { batchId: batch.id, status: "INCLUDED" },
      select: {
        id: true, employeeId: true, netPay: true,
      },
    });
    if (employees.length === 0) {
      throw new Error("PAY-1A: PayrollBatch has no INCLUDED employees to pay.");
    }
    let sumNet = new Prisma.Decimal(0);
    for (const e of employees) {
      const np = e.netPay ?? new Prisma.Decimal(0);
      if (np.lt(0)) {
        throw new Error(
          `PAY-1A: negative net pay (${np.toFixed(2)}) for employee ${e.employeeId} is not supported. ` +
          "Payment debits/recovery are out of scope.",
        );
      }
      sumNet = sumNet.plus(np);
    }

    // 4. Compute requestedExecutionDate.
    const execDate = input.requestedExecutionDate ?? new Date(
      batch.payPeriod.periodEnd.getTime() + batch.payGroup.payDateOffsetDays * 24 * 60 * 60 * 1000,
    );

    // 5. Create the run.
    const run = await createRun(principal, {
      clubId: batch.clubId,
      sourceType: "PAYROLL",
      sourceId: batch.id,
      sourceReference: batch.id,
      fundingBankAccountId: input.fundingBankAccountId,
      currency: "CAD",
      requestedExecutionDate: execDate,
      createdByUserId: principal.id,
    }, tx);

    // 6. For each non-zero-net employee, snapshot destination + create instruction.
    let instructionCount = 0;
    let skippedZeroNet = 0;
    let sumInstruction = new Prisma.Decimal(0);
    for (const e of employees) {
      const np = e.netPay ?? new Prisma.Decimal(0);
      if (np.isZero()) { skippedZeroNet++; continue; }

      const activeBank = await tx.employeeBankAccount.findFirst({
        where: { employeeId: e.employeeId, clubId: batch.clubId, status: "ACTIVE" },
        select: { id: true },
      });
      if (!activeBank) {
        throw new Error(
          `PAY-1A: employee ${e.employeeId} has non-zero net pay ${np.toFixed(2)} but no ACTIVE bank account. ` +
          "Fail-closed: no payment can be prepared without a bound destination.",
        );
      }
      const snap = await captureEmployeeDestination(principal, {
        clubId: batch.clubId, employeeId: e.employeeId, employeeBankAccountId: activeBank.id,
      }, tx);
      await createInstruction({
        clubId: batch.clubId,
        runId: run.id,
        sourceType: "PAYROLL",
        sourceId: batch.id,
        sourceReference: `${batch.id}:${e.id}`,
        recipientType: "EMPLOYEE",
        recipientId: e.employeeId,
        amount: np.toFixed(2),
        currency: "CAD",
        destinationSnapshotId: snap.id,
        requestedExecutionDate: execDate,
        fundingBankAccountId: input.fundingBankAccountId,
      }, tx);
      instructionCount++;
      sumInstruction = sumInstruction.plus(np);
    }

    // 7. Reconcile: sum(instructions) MUST equal sum(non-zero netPay).
    assertReconciles(sumNet, sumInstruction);

    // 8. Persist totals on the run.
    await tx.paymentRun.update({
      where: { id: run.id },
      data: {
        totalAmount: sumInstruction,
        instructionCount,
      },
    });
    await recordPaymentEvent({
      clubId: batch.clubId,
      runId: run.id,
      eventType: "PAYMENT_PREPARED",
      newStatus: "PREPARED",
      actorUserId: principal.id,
      actorSource: "USER",
      meta: {
        payrollBatchId: batch.id,
        instructionCount,
        skippedZeroNet,
        totalAmount: sumInstruction.toFixed(2),
      },
    }, tx);

    return {
      runId: run.id,
      runNumber: run.runNumber,
      instructionCount,
      totalAmount: sumInstruction.toFixed(2),
      skippedZeroNet,
    };
  });
}
