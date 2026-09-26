// PAY-1A/4 (2026-09-26) — Payment submission service.
//
// Two operations:
//   • scheduleAndSubmit(runId) — AUTHORIZED → SCHEDULED → SUBMITTING →
//     submits each instruction through the selected provider →
//     per-instruction outcome (SUBMITTED | REJECTED).
//   • pollAndAdvance(runId) — polls the provider for each SUBMITTED /
//     ACCEPTED instruction, advances status, invokes settlement/return
//     accounting on transitions.
//
// Idempotency invariants:
//   • Each instruction has a stable idempotencyKey = "run:<runId>:inst:<instructionId>".
//     A retry on submit returns the SAME providerInstructionId; only
//     one economic payment ever exists per instruction.
//   • Settlement/return accounting is per-instruction and refuses
//     if the instruction is already settled/returned (see accounting.ts).
//   • Concurrency: CAS on run.status prevents two workers from
//     simultaneously advancing the same transition.

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { requirePermission } from "@/lib/rbac";
import type { Principal } from "@/lib/rbac";
import { assertPaymentsEnabled } from "./kill-switch";
import { transitionRunState } from "./run";
import { recordPaymentEvent } from "./events";
import { selectProvider } from "./provider/selector";
import {
  recordInstructionSettlement,
  recordInstructionReturn,
} from "./accounting";
import type { PaymentSourceType } from "./types";

function idempotencyKeyFor(runId: string, instructionId: string): string {
  return `run:${runId}:inst:${instructionId}`;
}

export interface SubmitOutcomeSummary {
  runId: string;
  provider: string;
  submitted: number;
  rejected: number;
  timedOutInstructions: number;
}

// ------------------------------------------------------------------
// AUTHORIZED → SCHEDULED → SUBMITTING → SUBMITTED (per instruction).
// ------------------------------------------------------------------
export async function scheduleAndSubmit(
  principal: Principal,
  runId: string,
  providerType: "SIMULATOR" = "SIMULATOR",
): Promise<SubmitOutcomeSummary> {
  assertPaymentsEnabled();
  const provider = selectProvider(providerType);

  // Load fresh state and gate on transitions.
  const run = await prisma.paymentRun.findUnique({
    where: { id: runId },
    select: {
      id: true, clubId: true, status: true, currency: true,
      requestedExecutionDate: true, fundingBankAccountId: true,
      fundingBankAccount: { select: { id: true, glAccountId: true } },
    },
  });
  if (!run) throw new Error("PAY-1A: PaymentRun not found.");
  requirePermission(principal, run.clubId, "payment:prepare");

  if (run.status === "AUTHORIZED") {
    await prisma.$transaction(async (tx) => {
      await transitionRunState(
        runId, "AUTHORIZED", "SCHEDULED",
        { userId: principal.id, source: "SYSTEM" },
        "PAYMENT_SCHEDULED",
        tx,
      );
      await tx.paymentRun.update({
        where: { id: runId },
        data: { scheduledAt: new Date(), providerType },
      });
      await tx.paymentInstruction.updateMany({
        where: { runId, status: "AUTHORIZED" },
        data: { status: "SCHEDULED", scheduledAt: new Date() },
      });
    });
  }
  if (run.status !== "SCHEDULED" && run.status !== "AUTHORIZED") {
    throw new Error(`PAY-1A: run must be AUTHORIZED or SCHEDULED to submit; current=${run.status}`);
  }

  // Transition to SUBMITTING before per-instruction submit.
  await prisma.$transaction(async (tx) => {
    await transitionRunState(
      runId, "SCHEDULED", "SUBMITTING",
      { userId: principal.id, source: "SYSTEM" },
      "PAYMENT_SUBMISSION_STARTED",
      tx,
    );
  });

  const instructions = await prisma.paymentInstruction.findMany({
    where: { runId, status: { in: ["SCHEDULED", "SUBMITTING", "SUBMITTED"] } },
    select: {
      id: true, clubId: true, amount: true, currency: true,
      requestedExecutionDate: true, destinationSnapshotId: true,
      status: true, providerInstructionId: true,
    },
  });

  let submitted = 0, rejected = 0, timedOut = 0;
  for (const inst of instructions) {
    const idemKey = idempotencyKeyFor(runId, inst.id);
    try {
      const out = await provider.submit({
        clubId: inst.clubId,
        runId,
        instructionId: inst.id,
        amount: new Prisma.Decimal(inst.amount).toFixed(2),
        currency: inst.currency,
        requestedExecutionDate: inst.requestedExecutionDate,
        idempotencyKey: idemKey,
        destinationRef: inst.destinationSnapshotId,
        fundingRef: run.fundingBankAccountId,
      });
      await prisma.$transaction(async (tx) => {
        await tx.paymentInstruction.update({
          where: { id: inst.id },
          data: {
            providerType,
            providerInstructionId: out.providerInstructionId,
            providerReference: out.providerReference,
            submittedAt: new Date(),
            status: out.status === "REJECTED" ? "REJECTED" : "SUBMITTED",
          },
        });
        await recordPaymentEvent(
          {
            clubId: inst.clubId, runId, instructionId: inst.id,
            eventType: out.status === "REJECTED" ? "PAYMENT_REJECTED" : "PAYMENT_SUBMITTED",
            newStatus: out.status === "REJECTED" ? "REJECTED" : "SUBMITTED",
            actorSource: "PROVIDER",
            providerReference: out.providerReference,
            meta: out.status === "REJECTED" ? { code: out.rejectionCode, description: out.rejectionDescription } : undefined,
          },
          tx,
        );
      });
      if (out.status === "REJECTED") rejected++;
      else submitted++;
    } catch (err) {
      // Provider timeout — leave instruction status untouched;
      // caller retries with the SAME idempotencyKey.
      timedOut++;
      await prisma.$transaction(async (tx) => {
        await recordPaymentEvent(
          {
            clubId: inst.clubId, runId, instructionId: inst.id,
            eventType: "PAYMENT_SUBMISSION_STARTED",
            actorSource: "PROVIDER",
            meta: { error: (err as Error).message, timedOut: true },
          },
          tx,
        );
      });
    }
  }

  // Flip run to SUBMITTED once at least one instruction is SUBMITTED
  // OR REJECTED. If everything timed out, leave in SUBMITTING for retry.
  if (submitted + rejected > 0) {
    await prisma.$transaction(async (tx) => {
      await transitionRunState(
        runId, "SUBMITTING", submitted > 0 ? "SUBMITTED" : "REJECTED",
        { userId: principal.id, source: "SYSTEM" },
        submitted > 0 ? "PAYMENT_SUBMITTED" : "PAYMENT_REJECTED",
        tx,
        { meta: { submitted, rejected, timedOut } },
      );
      await tx.paymentRun.update({
        where: { id: runId },
        data: { submittedAt: new Date() },
      });
    });
  }

  return { runId, provider: providerType, submitted, rejected, timedOutInstructions: timedOut };
}

// ------------------------------------------------------------------
// Poll each SUBMITTED/ACCEPTED instruction. Advance status. Book
// settlement / return journals as appropriate.
// ------------------------------------------------------------------
export interface PollOutcomeSummary {
  runId: string;
  accepted: number;
  settled: number;
  returned: number;
}

export async function pollAndAdvance(runId: string, providerType: "SIMULATOR" = "SIMULATOR"): Promise<PollOutcomeSummary> {
  assertPaymentsEnabled();
  const provider = selectProvider(providerType);

  const run = await prisma.paymentRun.findUnique({
    where: { id: runId },
    select: {
      id: true, clubId: true, status: true, currency: true,
      sourceType: true, sourceId: true,
      fundingBankAccountId: true,
      fundingBankAccount: { select: { id: true, glAccountId: true } },
    },
  });
  if (!run) throw new Error("PAY-1A: PaymentRun not found.");
  const resolvedRun = {
    id: run.id, clubId: run.clubId, currency: run.currency,
    sourceType: run.sourceType as PaymentSourceType, sourceId: run.sourceId,
    fundingBankAccount: run.fundingBankAccount,
  };

  const instructions = await prisma.paymentInstruction.findMany({
    where: {
      runId,
      status: { in: ["SUBMITTED", "ACCEPTED", "SETTLED"] },
      providerInstructionId: { not: null },
    },
    select: {
      id: true, clubId: true, amount: true, status: true,
      providerInstructionId: true, settledAt: true, returnedAt: true, recipientId: true,
    },
  });

  let accepted = 0, settled = 0, returned = 0;

  for (const inst of instructions) {
    const status = await provider.getStatus(inst.providerInstructionId!);
    // Handle transitions.
    if (status.status === "ACCEPTED" && inst.status === "SUBMITTED") {
      await prisma.$transaction(async (tx) => {
        await tx.paymentInstruction.update({
          where: { id: inst.id },
          data: { status: "ACCEPTED", acceptedAt: new Date() },
        });
        await recordPaymentEvent(
          {
            clubId: inst.clubId, runId, instructionId: inst.id,
            eventType: "PAYMENT_ACCEPTED", newStatus: "ACCEPTED", actorSource: "PROVIDER",
            providerReference: status.providerReference,
          },
          tx,
        );
      });
      accepted++;
    }
    if (status.status === "SETTLED" && inst.status !== "SETTLED" && !inst.settledAt) {
      await prisma.$transaction(async (tx) => {
        await recordInstructionSettlement(
          tx, resolvedRun,
          {
            id: inst.id, clubId: inst.clubId,
            amount: new Prisma.Decimal(inst.amount),
            settledAt: inst.settledAt, returnedAt: inst.returnedAt, recipientId: inst.recipientId,
          },
          status.settledAt ?? new Date(),
        );
      });
      settled++;
    }
    if (status.status === "RETURNED" && !inst.returnedAt) {
      // Refresh the row so `settledAt` reflects the just-created settlement.
      const fresh = await prisma.paymentInstruction.findUniqueOrThrow({
        where: { id: inst.id },
        select: { settledAt: true, returnedAt: true, amount: true, clubId: true, recipientId: true },
      });
      await prisma.$transaction(async (tx) => {
        await recordInstructionReturn(
          tx, resolvedRun,
          {
            id: inst.id, clubId: fresh.clubId,
            amount: new Prisma.Decimal(fresh.amount),
            settledAt: fresh.settledAt, returnedAt: fresh.returnedAt, recipientId: fresh.recipientId,
          },
          status.returnedAt ?? new Date(),
          status.returnCode ?? "UNKNOWN",
          status.returnDescription ?? "",
        );
      });
      returned++;
    }
  }

  // Roll-up: if all instructions SETTLED → run SETTLED; if all SUBMITTED
  // → ACCEPTED → run ACCEPTED. This is per §19 — accepted ≠ settled.
  const remaining = await prisma.paymentInstruction.findMany({
    where: { runId },
    select: { status: true },
  });
  const allSettledOrReturned = remaining.every(
    (i) => i.status === "SETTLED" || i.status === "RETURNED",
  );
  const allAccepted = remaining.every((i) => i.status === "ACCEPTED" || i.status === "SETTLED" || i.status === "RETURNED");
  if (allSettledOrReturned && run.status !== "SETTLED") {
    await prisma.$transaction(async (tx) => {
      // May transition from SUBMITTED, ACCEPTED directly.
      const cur = await tx.paymentRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true } });
      if (cur.status === "SUBMITTED") {
        await transitionRunState(runId, "SUBMITTED", "ACCEPTED", { source: "SYSTEM" }, "PAYMENT_ACCEPTED", tx);
      }
      const cur2 = await tx.paymentRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true } });
      if (cur2.status === "ACCEPTED") {
        await transitionRunState(runId, "ACCEPTED", "SETTLED", { source: "SYSTEM" }, "PAYMENT_SETTLED", tx);
      }
      await tx.paymentRun.update({ where: { id: runId }, data: { fullySettledAt: new Date() } });
    });
  } else if (allAccepted && run.status === "SUBMITTED") {
    await prisma.$transaction(async (tx) => {
      await transitionRunState(runId, "SUBMITTED", "ACCEPTED", { source: "SYSTEM" }, "PAYMENT_ACCEPTED", tx);
    });
  }
  return { runId, accepted, settled, returned };
}
