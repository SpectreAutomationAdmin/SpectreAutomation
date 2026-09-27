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
import { assertPaymentRunWithinLimits, type LimitPaymentType } from "./limits";

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

  // PAY-1C/3: fail-closed limit evaluation BEFORE the AUTHORIZED →
  // SCHEDULED transition. If no limits are configured, this is a
  // no-op. If a limit is breached, an operational exception is
  // raised and submission is refused.
  const runSrc = await prisma.paymentRun.findUniqueOrThrow({
    where: { id: runId },
    select: { sourceType: true },
  });
  const paymentType: LimitPaymentType | undefined =
    runSrc.sourceType === "PAYROLL_BATCH"
      ? "PAYROLL"
      : runSrc.sourceType === "AP_INVOICE"
      ? "AP"
      : undefined;
  await assertPaymentRunWithinLimits({
    clubId: run.clubId,
    providerType,
    runId,
    paymentType,
  });

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
      // PAY-1A.2 — record attempt at start; the increment is atomic
      // even under concurrent retries via updateMany + CAS on the id.
      await prisma.paymentInstruction.update({
        where: { id: inst.id },
        data: {
          submissionAttempts: { increment: 1 },
          lastSubmissionAttemptAt: new Date(),
        },
      });

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
      // Provider timeout — ambiguous state. Spectre attempted
      // transmission but did not receive a provider response. Set the
      // instruction to SUBMITTING (accurate: attempt made, outcome
      // unknown) so retry-submit can pick it up. Do NOT revert to
      // SCHEDULED (that would falsely imply "never submitted").
      timedOut++;
      await prisma.$transaction(async (tx) => {
        await tx.paymentInstruction.update({
          where: { id: inst.id },
          data: {
            status: "SUBMITTING",
            // submissionAttempts was already incremented above.
          },
        });
        await recordPaymentEvent(
          {
            clubId: inst.clubId, runId, instructionId: inst.id,
            eventType: "PAYMENT_SUBMISSION_STARTED",
            newStatus: "SUBMITTING",
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

// ------------------------------------------------------------------
// PAY-1A.2 (2026-09-26) — Retry an ambiguously timed-out submission.
//
// Semantics:
//   - Same PaymentInstruction.id — no new instruction created.
//   - Same idempotencyKey "run:<runId>:inst:<instructionId>".
//   - Same PaymentDestinationSnapshot (immutable already).
//   - Same PaymentAuthorization.paymentFingerprint (re-verified here).
//   - If the recomputed fingerprint differs from the frozen
//     authorization, the authorization is INVALIDATED and the retry
//     is refused — a new authorization is required.

import { paymentFingerprint } from "./fingerprint";
import { invalidateAuthorization } from "./authorization";
import type { PaymentRunMaterialFields } from "./types";

export interface RetrySubmitOutcome {
  runId: string;
  attemptedInstructions: number;
  submitted: number;
  rejected: number;
  timedOutAgain: number;
  authorizationInvalidated: boolean;
}

export async function retrySubmit(
  principal: Principal,
  runId: string,
  providerType: "SIMULATOR" = "SIMULATOR",
): Promise<RetrySubmitOutcome> {
  assertPaymentsEnabled();
  const provider = selectProvider(providerType);

  const run = await prisma.paymentRun.findUnique({
    where: { id: runId },
    select: {
      id: true, clubId: true, status: true, runNumber: true,
      sourceType: true, sourceId: true,
      fundingBankAccountId: true, currency: true,
      requestedExecutionDate: true, totalAmount: true,
      authorization: { select: { id: true, paymentFingerprint: true, status: true } },
    },
  });
  if (!run) throw new Error("PAY-1A.2: PaymentRun not found.");
  requirePermission(principal, run.clubId, "payment:prepare");

  if (!run.authorization || run.authorization.status !== "ACTIVE") {
    throw new Error("PAY-1A.2: run has no ACTIVE authorization — cannot retry.");
  }
  if (run.status !== "SUBMITTING") {
    throw new Error(
      "PAY-1A.2: retry-submit requires run in SUBMITTING (ambiguous-attempt) state; current=" + run.status + ". " +
      "Use submit-to-provider for the initial submission.",
    );
  }

  // Recompute the payment fingerprint from CURRENT material state.
  const instructions = await prisma.paymentInstruction.findMany({
    where: { runId },
    select: {
      id: true, clubId: true, amount: true, currency: true,
      requestedExecutionDate: true, destinationSnapshotId: true,
      status: true, providerInstructionId: true, providerReference: true,
      instructionFingerprint: true, recipientType: true, recipientId: true,
    },
    orderBy: [{ recipientType: "asc" }, { recipientId: "asc" }],
  });
  const runMaterial: PaymentRunMaterialFields = {
    clubId: run.clubId,
    runNumber: run.runNumber,
    sourceType: run.sourceType as PaymentSourceType,
    sourceId: run.sourceId,
    fundingBankAccountId: run.fundingBankAccountId,
    currency: run.currency,
    requestedExecutionDate: run.requestedExecutionDate.toISOString(),
    totalAmount: new Prisma.Decimal(run.totalAmount).toFixed(2),
    instructionFingerprints: instructions.map((i) => i.instructionFingerprint),
  };
  const currentFp = paymentFingerprint(runMaterial);
  if (currentFp !== run.authorization.paymentFingerprint) {
    await prisma.$transaction(async (tx) => {
      await invalidateAuthorization(runId, "material-mutation-detected-on-retry", tx);
    });
    return {
      runId, attemptedInstructions: 0, submitted: 0, rejected: 0, timedOutAgain: 0,
      authorizationInvalidated: true,
    };
  }

  const retryable = instructions.filter((i) =>
    i.status === "SUBMITTING" || i.status === "SCHEDULED"
  );

  let submitted = 0, rejected = 0, timedOutAgain = 0;
  for (const inst of retryable) {
    const idemKey = idempotencyKeyFor(runId, inst.id);

    await prisma.paymentInstruction.update({
      where: { id: inst.id },
      data: {
        submissionAttempts: { increment: 1 },
        lastSubmissionAttemptAt: new Date(),
      },
    });

    try {
      let providerInstructionId: string | null = inst.providerInstructionId;
      let providerReference: string | null | undefined = inst.providerReference;
      let status: "SUBMITTED" | "ACCEPTED" | "REJECTED" = "SUBMITTED";
      let rejectionCode: string | undefined;
      let rejectionDescription: string | undefined;

      if (providerInstructionId) {
        const st = await provider.getStatus(providerInstructionId);
        providerReference = st.providerReference ?? providerReference;
        if (st.status === "REJECTED") { status = "REJECTED"; }
        else if (st.status === "ACCEPTED") { status = "ACCEPTED"; }
        else if (st.status === "SUBMITTED") { status = "SUBMITTED"; }
        else if (st.status === "SETTLED") { status = "ACCEPTED"; }
      } else {
        const out = await provider.submit({
          clubId: inst.clubId, runId, instructionId: inst.id,
          amount: new Prisma.Decimal(inst.amount).toFixed(2),
          currency: inst.currency,
          requestedExecutionDate: inst.requestedExecutionDate,
          idempotencyKey: idemKey,
          destinationRef: inst.destinationSnapshotId,
          fundingRef: run.fundingBankAccountId,
        });
        providerInstructionId = out.providerInstructionId;
        providerReference = out.providerReference;
        if (out.status === "REJECTED") {
          status = "REJECTED";
          rejectionCode = out.rejectionCode;
          rejectionDescription = out.rejectionDescription;
        } else {
          status = "SUBMITTED";
        }
      }

      await prisma.$transaction(async (tx) => {
        await tx.paymentInstruction.update({
          where: { id: inst.id },
          data: {
            providerType,
            providerInstructionId: providerInstructionId!,
            providerReference: providerReference ?? undefined,
            submittedAt: inst.status === "SUBMITTING" ? undefined : new Date(),
            status,
          },
        });
        await recordPaymentEvent(
          {
            clubId: inst.clubId, runId, instructionId: inst.id,
            eventType: status === "REJECTED" ? "PAYMENT_REJECTED" : "PAYMENT_SUBMITTED",
            previousStatus: inst.status,
            newStatus: status,
            actorUserId: principal.id,
            actorSource: "USER",
            providerReference: providerReference ?? undefined,
            meta: {
              retryAttempt: true,
              ...(status === "REJECTED"
                ? { code: rejectionCode, description: rejectionDescription }
                : {}),
            },
          },
          tx,
        );
      });
      if (status === "REJECTED") rejected++;
      else submitted++;
    } catch (err) {
      timedOutAgain++;
      await prisma.$transaction(async (tx) => {
        await recordPaymentEvent(
          {
            clubId: inst.clubId, runId, instructionId: inst.id,
            eventType: "PAYMENT_SUBMISSION_STARTED",
            actorUserId: principal.id,
            actorSource: "USER",
            meta: { retryAttempt: true, error: (err as Error).message, timedOut: true },
          },
          tx,
        );
      });
    }
  }

  const stillPending = await prisma.paymentInstruction.count({
    where: { runId, status: { in: ["SUBMITTING", "SCHEDULED"] } },
  });
  if (stillPending === 0) {
    await prisma.$transaction(async (tx) => {
      const cur = await tx.paymentRun.findUniqueOrThrow({ where: { id: runId }, select: { status: true } });
      if (cur.status === "SUBMITTING") {
        const okCount = await tx.paymentInstruction.count({
          where: { runId, status: { in: ["SUBMITTED", "ACCEPTED", "SETTLED"] } },
        });
        const target = okCount > 0 ? "SUBMITTED" : "REJECTED";
        await transitionRunState(
          runId, "SUBMITTING", target,
          { userId: principal.id, source: "SYSTEM" },
          target === "SUBMITTED" ? "PAYMENT_SUBMITTED" : "PAYMENT_REJECTED",
          tx,
        );
        if (target === "SUBMITTED") {
          await tx.paymentRun.update({ where: { id: runId }, data: { submittedAt: new Date() } });
        }
      }
    });
  }

  return {
    runId,
    attemptedInstructions: retryable.length,
    submitted, rejected, timedOutAgain,
    authorizationInvalidated: false,
  };
}
