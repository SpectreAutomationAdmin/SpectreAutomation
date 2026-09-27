// PAY-1C.1 — limit gate MUST be in the real submission path.
//
// Distinct from `pay1c3-limits.test.ts` (which tests the evaluator).
// This suite proves the ACTUAL submission service (scheduleAndSubmit)
// refuses at the limit boundary — no provider dispatch, no accounting
// mutation, authorization preserved.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { Prisma } from "@prisma/client";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { scheduleAndSubmit } from "@/lib/payments/submission";
import { authorizePaymentRun, submitForAuthorization } from "@/lib/payments/authorization";

async function seedRunReadyToSubmit(opts: { clubId: string; amount: string }) {
  const c = db();
  const bankAcc = await c.account.create({
    data: {
      clubId: opts.clubId,
      accountNumber: "10" + Math.floor(Math.random() * 1_000_000),
      name: "Bank Ops", type: "ASSET", normalBalance: "DEBIT",
      isBankAccount: true, isCashAccount: true, isActive: true,
      allowManualPosting: false, accountRole: "CASH",
    },
  });
  const bank = await c.bankAccount.create({
    data: {
      clubId: opts.clubId, institutionReference: "SIM",
      displayName: "Ops ***01", maskedIdentifier: "***01",
      currency: "CAD", status: "ACTIVE", glAccountId: bankAcc.id,
    },
  });
  const dest = await c.paymentDestinationSnapshot.create({
    data: {
      clubId: opts.clubId, recipientType: "EMPLOYEE",
      recipientId: "emp-lg-1", sourceModel: "EmployeeBankAccount",
      sourceId: "eba-lg-1", sourceVersion: 1,
      maskedIdentifier: "***02",
      institutionSecretRef: "kms:i", transitSecretRef: "kms:t", accountSecretRef: "kms:a",
      currency: "CAD",
    },
  });
  const run = await c.paymentRun.create({
    data: {
      clubId: opts.clubId,
      runNumber: "PR-LG-" + Math.floor(Math.random() * 1_000_000),
      sourceType: "PAYROLL_BATCH", sourceId: null,
      fundingBankAccountId: bank.id, currency: "CAD",
      requestedExecutionDate: new Date("2026-12-30"),
      totalAmount: new Prisma.Decimal(opts.amount),
      instructionCount: 1,
      status: "PREPARED",
      createdByUserId: "preparer",
    },
  });
  await c.paymentInstruction.create({
    data: {
      clubId: opts.clubId, runId: run.id,
      sourceType: "PAYROLL_BATCH", sourceReference: "emp-lg-1",
      recipientType: "EMPLOYEE", recipientId: "emp-lg-1",
      amount: new Prisma.Decimal(opts.amount), currency: "CAD",
      destinationSnapshotId: dest.id,
      requestedExecutionDate: new Date("2026-12-30"),
      status: "PREPARED", instructionFingerprint: "ifp-lg-1",
    },
  });
  return { runId: run.id, instructionId: (await c.paymentInstruction.findFirstOrThrow({ where: { runId: run.id } })).id };
}

describe("PAY-1C.1 · limit gate is in the real submission path", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("scheduleAndSubmit REFUSES when a synthetic PER_INSTRUCTION limit is below the authorized amount — no provider dispatch, no accounting, authorization preserved", async () => {
    const club = await makeClub("LG " + Math.random().toString(36).slice(2));
    const paE = `pa-${Math.random().toString(36).slice(2)}@t.test`;
    const cE  = `ctrl-${Math.random().toString(36).slice(2)}@t.test`;
    await makeUser({ email: paE, role: "PAYROLL_ADMIN", clubId: club.id });
    await makeUser({ email: cE,  role: "CONTROLLER",   clubId: club.id });
    const pa = await principalFor(paE);
    const ctrl = await principalFor(cE);

    const seeded = await seedRunReadyToSubmit({ clubId: club.id, amount: "150.00" });
    // Point the run at the preparer so SoD lets the ctrl authorize.
    await db().paymentRun.update({ where: { id: seeded.runId }, data: { createdByUserId: pa.id } });

    await submitForAuthorization(pa, seeded.runId);
    await authorizePaymentRun(ctrl, seeded.runId);

    // Snapshot AUTHORIZED state.
    const runBefore = await db().paymentRun.findUniqueOrThrow({
      where: { id: seeded.runId },
      select: { status: true, paymentFingerprint: true, totalAmount: true, currency: true },
    });
    const instBefore = await db().paymentInstruction.findUniqueOrThrow({
      where: { id: seeded.instructionId },
      select: { status: true, amount: true, currency: true, destinationSnapshotId: true, providerInstructionId: true, submissionAttempts: true },
    });
    const authBefore = await db().paymentAuthorization.findFirstOrThrow({
      where: { runId: seeded.runId },
      select: { id: true, status: true, paymentFingerprint: true },
    });

    // Configure PER_INSTRUCTION limit at CAD $100 (below the $150 amount).
    await db().paymentLimit.create({
      data: {
        clubId: club.id, providerType: null,
        kind: "PER_INSTRUCTION", currency: "CAD",
        amountLimit: new Prisma.Decimal("100.00"), status: "ACTIVE",
        reason: "PAY-1C.1 acceptance-test limit",
      },
    });

    await expect(scheduleAndSubmit(pa, seeded.runId)).rejects.toThrow(/PER_INSTRUCTION/);

    // Nothing changed.
    const runAfter = await db().paymentRun.findUniqueOrThrow({
      where: { id: seeded.runId },
      select: { status: true, paymentFingerprint: true, totalAmount: true, currency: true },
    });
    const instAfter = await db().paymentInstruction.findUniqueOrThrow({
      where: { id: seeded.instructionId },
      select: { status: true, amount: true, currency: true, destinationSnapshotId: true, providerInstructionId: true, submissionAttempts: true },
    });
    const authAfter = await db().paymentAuthorization.findFirstOrThrow({
      where: { runId: seeded.runId },
      select: { id: true, status: true, paymentFingerprint: true },
    });
    expect(runAfter).toEqual(runBefore);
    expect(instAfter).toEqual(instBefore);
    expect(authAfter).toEqual(authBefore);

    // No JEs, no cash movement.
    const jes = await db().journalEntry.count({ where: { clubId: club.id } });
    expect(jes).toBe(0);

    // Work Intake exception surfaced.
    const wi = await db().workIntakeItem.findFirst({
      where: { clubId: club.id, workSubtype: "PAYMENT_EXCEPTION_AMOUNT_MISMATCH" },
    });
    expect(wi).not.toBeNull();
  });

  it("retiring the limit lets the SAME authorized payment continue — no new PaymentInstruction created", async () => {
    const club = await makeClub("LG2 " + Math.random().toString(36).slice(2));
    const paE = `pa-${Math.random().toString(36).slice(2)}@t.test`;
    const cE  = `ctrl-${Math.random().toString(36).slice(2)}@t.test`;
    await makeUser({ email: paE, role: "PAYROLL_ADMIN", clubId: club.id });
    await makeUser({ email: cE,  role: "CONTROLLER",   clubId: club.id });
    const pa = await principalFor(paE);
    const ctrl = await principalFor(cE);
    const seeded = await seedRunReadyToSubmit({ clubId: club.id, amount: "150.00" });
    await db().paymentRun.update({ where: { id: seeded.runId }, data: { createdByUserId: pa.id } });
    await submitForAuthorization(pa, seeded.runId);
    await authorizePaymentRun(ctrl, seeded.runId);

    const limit = await db().paymentLimit.create({
      data: {
        clubId: club.id, providerType: null, kind: "PER_INSTRUCTION",
        currency: "CAD", amountLimit: new Prisma.Decimal("100.00"), status: "ACTIVE",
      },
    });
    await expect(scheduleAndSubmit(pa, seeded.runId)).rejects.toThrow(/PER_INSTRUCTION/);

    // Retire the limit; same authorized economic payment must submit.
    await db().paymentLimit.update({ where: { id: limit.id }, data: { status: "RETIRED", effectiveUntil: new Date() } });
    const before = await db().paymentInstruction.count({ where: { runId: seeded.runId } });
    const out = await scheduleAndSubmit(pa, seeded.runId);
    const after = await db().paymentInstruction.count({ where: { runId: seeded.runId } });
    expect(after).toBe(before);
    expect(out.submitted + out.rejected + out.timedOutInstructions).toBeGreaterThanOrEqual(1);
  });
});
