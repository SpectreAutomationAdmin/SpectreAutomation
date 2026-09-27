// PAY-1C/3 — duplicate-business-payment guard.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import { findDuplicateEconomicPayments, assertNoDuplicateEconomicPayment } from "@/lib/payments/duplicate-guard";

async function seedInstruction(opts: {
  clubId: string; sourceId: string | null; recipientId: string;
  amount: string; status?: string; sameDestinationSnapshotId?: string;
}) {
  const c = db();
  const bankAcc = await c.account.create({
    data: {
      clubId: opts.clubId,
      accountNumber: "10" + Math.floor(Math.random() * 1_000_000),
      name: "Bank", type: "ASSET", normalBalance: "DEBIT",
      isBankAccount: true, isCashAccount: true, isActive: true,
      allowManualPosting: false, accountRole: "CASH",
    },
  });
  const bank = await c.bankAccount.create({
    data: {
      clubId: opts.clubId, institutionReference: "SIM",
      displayName: "Bank ***01", maskedIdentifier: "***01",
      currency: "CAD", status: "ACTIVE", glAccountId: bankAcc.id,
    },
  });
  const dest = opts.sameDestinationSnapshotId
    ? await c.paymentDestinationSnapshot.findUniqueOrThrow({ where: { id: opts.sameDestinationSnapshotId } })
    : await c.paymentDestinationSnapshot.create({
        data: {
          clubId: opts.clubId, recipientType: "EMPLOYEE",
          recipientId: opts.recipientId, sourceModel: "EmployeeBankAccount",
          sourceId: "eba-" + opts.recipientId, sourceVersion: 1,
          maskedIdentifier: "***02",
          institutionSecretRef: "kms:i", transitSecretRef: "kms:t", accountSecretRef: "kms:a",
          currency: "CAD",
        },
      });
  const run = await c.paymentRun.create({
    data: {
      clubId: opts.clubId, runNumber: "PR-" + Math.floor(Math.random() * 1_000_000),
      sourceType: "PAYROLL_BATCH", sourceId: opts.sourceId,
      fundingBankAccountId: bank.id, currency: "CAD",
      requestedExecutionDate: new Date("2026-12-30"),
      totalAmount: new Prisma.Decimal(opts.amount),
      instructionCount: 1,
      status: "AUTHORIZED",
      createdByUserId: "user-1",
    },
  });
  const inst = await c.paymentInstruction.create({
    data: {
      clubId: opts.clubId, runId: run.id,
      sourceType: "PAYROLL_BATCH", sourceId: opts.sourceId,
      recipientType: "EMPLOYEE", recipientId: opts.recipientId,
      amount: new Prisma.Decimal(opts.amount), currency: "CAD",
      destinationSnapshotId: dest.id,
      requestedExecutionDate: new Date("2026-12-30"),
      status: opts.status ?? "AUTHORIZED",
      instructionFingerprint: `ifp-${Math.random().toString(36).slice(2)}`,
      authorizedAt: new Date(),
    },
  });
  return { run, instruction: inst, destinationSnapshotId: dest.id };
}

describe("PAY-1C/3 · duplicate business payment guard", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("detects duplicate for same source + recipient + destination + amount", async () => {
    const club = await makeClub("D1 " + Math.random().toString(36).slice(2));
    const existing = await seedInstruction({
      clubId: club.id, sourceId: "batch-A", recipientId: "emp-1", amount: "1000.00",
    });
    // A proposed second run for the SAME batch — this is the duplicate case.
    const proposed = await seedInstruction({
      clubId: club.id, sourceId: "batch-A", recipientId: "emp-1", amount: "1000.00",
      status: "PREPARED",
      sameDestinationSnapshotId: existing.destinationSnapshotId,
    });
    const dupes = await findDuplicateEconomicPayments({
      clubId: club.id,
      sourceType: "PAYROLL_BATCH",
      sourceId: "batch-A",
      recipientType: "EMPLOYEE",
      recipientId: "emp-1",
      destinationSnapshotId: existing.destinationSnapshotId,
      amount: "1000.00",
      currency: "CAD",
      proposedRunId: proposed.run.id,
    });
    expect(dupes).toHaveLength(1);
    expect(dupes[0].paymentInstructionId).toBe(existing.instruction.id);
  });

  it("does NOT block recurring legitimate payroll — different batch (sourceId) same employee same amount", async () => {
    const club = await makeClub("D2 " + Math.random().toString(36).slice(2));
    const cycleA = await seedInstruction({
      clubId: club.id, sourceId: "batch-CYC-1", recipientId: "emp-2", amount: "1500.00",
    });
    // Second payroll cycle: distinct payrollBatchId — must NOT be flagged.
    const cycleB = await seedInstruction({
      clubId: club.id, sourceId: "batch-CYC-2", recipientId: "emp-2", amount: "1500.00",
      sameDestinationSnapshotId: cycleA.destinationSnapshotId,
    });
    const dupes = await findDuplicateEconomicPayments({
      clubId: club.id,
      sourceType: "PAYROLL_BATCH",
      sourceId: "batch-CYC-2",
      recipientType: "EMPLOYEE",
      recipientId: "emp-2",
      destinationSnapshotId: cycleA.destinationSnapshotId,
      amount: "1500.00",
      currency: "CAD",
      proposedRunId: cycleB.run.id,
    });
    expect(dupes).toHaveLength(0);
  });

  it("assertNoDuplicateEconomicPayment throws with a helpful message", async () => {
    const club = await makeClub("D3 " + Math.random().toString(36).slice(2));
    const existing = await seedInstruction({
      clubId: club.id, sourceId: "batch-B", recipientId: "emp-3", amount: "750.00",
    });
    await expect(
      assertNoDuplicateEconomicPayment({
        clubId: club.id,
        sourceType: "PAYROLL_BATCH",
        sourceId: "batch-B",
        recipientType: "EMPLOYEE",
        recipientId: "emp-3",
        destinationSnapshotId: existing.destinationSnapshotId,
        amount: "750.00",
        currency: "CAD",
        proposedRunId: "some-other-run-id",
      }),
    ).rejects.toThrow(/duplicate economic payment/);
  });

  it("no sourceId (null) never flags — the guard errs on legitimate", async () => {
    const club = await makeClub("D4 " + Math.random().toString(36).slice(2));
    const existing = await seedInstruction({
      clubId: club.id, sourceId: null, recipientId: "emp-4", amount: "300.00",
    });
    const dupes = await findDuplicateEconomicPayments({
      clubId: club.id,
      sourceType: "PAYROLL_BATCH",
      sourceId: null,
      recipientType: "EMPLOYEE",
      recipientId: "emp-4",
      destinationSnapshotId: existing.destinationSnapshotId,
      amount: "300.00",
      currency: "CAD",
      proposedRunId: "any-run",
    });
    expect(dupes).toHaveLength(0);
  });
});
