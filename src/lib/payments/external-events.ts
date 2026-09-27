// PAY-1B/3 (2026-09-27) — External payment event ingestion.
//
// Every provider callback / async event flows through this service.
// It:
//   1. Persists a normalized `ExternalPaymentEvent` row.
//   2. Refuses to touch financial state until the envelope is VERIFIED
//      by the adapter's `verifyExternalEvent`.
//   3. Deduplicates on `(provider, providerEventId)` — a duplicate is
//      IGNORED, not RE-APPLIED.
//   4. Rejects tenant mismatches — an event that references a
//      providerInstructionId owned by a different clubId is dropped
//      with REJECTED_TENANT_MISMATCH and no state mutation.
//   5. Fails closed on:
//         - unknown provider status (REJECTED_UNKNOWN_STATUS)
//         - amount mismatch vs authorized instruction amount
//         - currency mismatch
//         - provider reference collision (same providerInstructionId
//           already bound to a different Spectre instruction)
//   6. Refuses to regress financial state (e.g. SETTLED → ACCEPTED
//      would be IGNORED_OUT_OF_ORDER).
//   7. When APPLIED, updates instruction status and (if SETTLED /
//      RETURNED) calls the same accounting service PAY-1A/4 uses —
//      no duplicate journals, no speculative journals on UNKNOWN.

import { prisma } from "@/lib/prisma";
import { Prisma } from "@prisma/client";
import { recordPaymentEvent } from "./events";
import { recordInstructionSettlement, recordInstructionReturn } from "./accounting";
import { raiseOperationalException } from "./operational-exceptions";
import type {
  ExternalPaymentEventEnvelope,
  ProviderProcessingStatus,
} from "./provider/contract";
import type { PaymentSourceType } from "./types";

const APPLIED = "APPLIED" as const;
const IGNORED_DUPLICATE = "IGNORED_DUPLICATE" as const;
const IGNORED_OUT_OF_ORDER = "IGNORED_OUT_OF_ORDER" as const;
const REJECTED_UNVERIFIED = "REJECTED_UNVERIFIED" as const;
const REJECTED_TENANT_MISMATCH = "REJECTED_TENANT_MISMATCH" as const;
const REJECTED_UNKNOWN_STATUS = "REJECTED_UNKNOWN_STATUS" as const;
const REJECTED_AMOUNT_MISMATCH = "REJECTED_AMOUNT_MISMATCH" as const;
const REJECTED_CURRENCY_MISMATCH = "REJECTED_CURRENCY_MISMATCH" as const;
const REJECTED_REFERENCE_COLLISION = "REJECTED_REFERENCE_COLLISION" as const;

export type IngestionOutcome =
  | typeof APPLIED
  | typeof IGNORED_DUPLICATE
  | typeof IGNORED_OUT_OF_ORDER
  | typeof REJECTED_UNVERIFIED
  | typeof REJECTED_TENANT_MISMATCH
  | typeof REJECTED_UNKNOWN_STATUS
  | typeof REJECTED_AMOUNT_MISMATCH
  | typeof REJECTED_CURRENCY_MISMATCH
  | typeof REJECTED_REFERENCE_COLLISION;

const KNOWN_STATUSES: readonly ProviderProcessingStatus[] = [
  "RECEIVED", "ACCEPTED", "PROCESSING", "SETTLED", "REJECTED", "RETURNED", "CANCELLED", "UNKNOWN",
];

// Precedence used to detect out-of-order events. A LOWER-precedence
// event received AFTER a higher-precedence status has already landed
// is IGNORED_OUT_OF_ORDER.
const STATUS_PRECEDENCE: Record<string, number> = {
  RECEIVED: 1, PROCESSING: 2, ACCEPTED: 3, SUBMITTED: 3,
  SETTLED: 5, RETURNED: 6, REJECTED: 4, CANCELLED: 4,
  UNKNOWN: 0,
};

export interface IngestExternalEventInput {
  clubId: string;
  connectionId?: string;
  envelope: ExternalPaymentEventEnvelope;
}

export async function ingestExternalEvent(
  input: IngestExternalEventInput,
): Promise<{ outcome: IngestionOutcome; eventId: string }> {
  const env = input.envelope;

  // Duplicate detection at the DB layer — unique index catches the race.
  // We also check explicitly first so we can return IGNORED_DUPLICATE
  // cleanly.
  const existing = await prisma.externalPaymentEvent.findUnique({
    where: { provider_providerEventId: { provider: env.provider, providerEventId: env.providerEventId } },
    select: { id: true, processingStatus: true },
  });
  if (existing) {
    return { outcome: IGNORED_DUPLICATE, eventId: existing.id };
  }

  // Persist first — the row is our audit even if we ultimately reject.
  let row;
  try {
    row = await prisma.externalPaymentEvent.create({
      data: {
        clubId: input.clubId,
        connectionId: input.connectionId ?? null,
        provider: env.provider,
        providerEventId: env.providerEventId,
        providerInstructionId: env.providerInstructionId ?? null,
        providerReference: env.providerReference ?? null,
        eventType: env.eventType,
        providerTimestamp: env.providerTimestamp ?? null,
        status: env.status ?? null,
        amount: env.amount ? new Prisma.Decimal(env.amount) : null,
        currency: env.currency ?? null,
        returnCode: env.returnCode ?? null,
        returnDescription: env.returnDescription ?? null,
        payloadHash: env.payloadHash,
        rawPayloadReference: env.rawPayloadReference ?? null,
        verificationStatus: env.verificationStatus,
        processingStatus: "PENDING",
      },
      select: { id: true },
    });
  } catch (err) {
    // Concurrent duplicate — refetch and return duplicate.
    const dup = await prisma.externalPaymentEvent.findUnique({
      where: { provider_providerEventId: { provider: env.provider, providerEventId: env.providerEventId } },
      select: { id: true },
    });
    if (dup) return { outcome: IGNORED_DUPLICATE, eventId: dup.id };
    throw err;
  }

  const finish = async (outcome: IngestionOutcome, note?: string): Promise<{ outcome: IngestionOutcome; eventId: string }> => {
    await prisma.externalPaymentEvent.update({
      where: { id: row!.id },
      data: { processingStatus: outcome, processingNote: note ?? null, processedAt: new Date() },
    });
    // Raise Work Intake exceptions for conditions that need human
    // attention. Duplicates + out-of-order are informational only.
    const exceptionKind =
      outcome === REJECTED_UNVERIFIED ? "VERIFICATION_FAILURE" :
      outcome === REJECTED_AMOUNT_MISMATCH ? "AMOUNT_MISMATCH" :
      outcome === REJECTED_CURRENCY_MISMATCH ? "CURRENCY_MISMATCH" :
      outcome === REJECTED_REFERENCE_COLLISION ? "REFERENCE_COLLISION" :
      outcome === REJECTED_UNKNOWN_STATUS ? "UNKNOWN_OUTCOME" :
      null;
    if (exceptionKind) {
      await raiseOperationalException({
        clubId: input.clubId,
        kind: exceptionKind,
        externalEventId: row!.id,
        summary: `Payment event ${env.provider}:${env.providerEventId} — ${exceptionKind}`,
        detail: note ?? undefined,
      }).catch(() => { /* never fail ingestion because Work Intake write failed */ });
    }
    return { outcome, eventId: row!.id };
  };

  // 1. Verification.
  if (env.verificationStatus !== "VERIFIED") {
    return finish(REJECTED_UNVERIFIED, `verificationStatus=${env.verificationStatus}`);
  }

  // 2. Unknown provider status.
  if (env.status && !KNOWN_STATUSES.includes(env.status)) {
    return finish(REJECTED_UNKNOWN_STATUS, `status=${env.status}`);
  }

  // 3. Reference resolution — locate the target PaymentInstruction.
  if (!env.providerInstructionId) {
    // A signed event that has no target — persist and move on.
    // Not applied; not rejected in a way that requires re-delivery.
    return finish(APPLIED, "no providerInstructionId — informational only");
  }
  const targets = await prisma.paymentInstruction.findMany({
    where: { providerInstructionId: env.providerInstructionId },
    select: {
      id: true, clubId: true, runId: true, amount: true, currency: true,
      status: true, settledAt: true, returnedAt: true, recipientId: true,
    },
  });
  // Provider reference collision — same providerInstructionId on more than one Spectre row.
  if (targets.length > 1) {
    return finish(REJECTED_REFERENCE_COLLISION, `providerInstructionId matches ${targets.length} Spectre instructions`);
  }
  if (targets.length === 0) {
    return finish(APPLIED, "unknown providerInstructionId — informational only");
  }
  const inst = targets[0];

  // 4. Tenant isolation.
  if (inst.clubId !== input.clubId) {
    return finish(REJECTED_TENANT_MISMATCH, `event clubId=${input.clubId} but instruction clubId=${inst.clubId}`);
  }

  // 5. Amount / currency mismatch.
  if (env.amount) {
    const eventAmount = new Prisma.Decimal(env.amount);
    if (!eventAmount.eq(inst.amount)) {
      return finish(REJECTED_AMOUNT_MISMATCH, `event=${eventAmount.toFixed(2)} inst=${new Prisma.Decimal(inst.amount).toFixed(2)}`);
    }
  }
  if (env.currency && env.currency !== inst.currency) {
    return finish(REJECTED_CURRENCY_MISMATCH, `event=${env.currency} inst=${inst.currency}`);
  }

  // 6. Out-of-order detection.
  const currentPrec = STATUS_PRECEDENCE[inst.status] ?? 0;
  const eventPrec = env.status ? (STATUS_PRECEDENCE[env.status] ?? 0) : 0;
  // SETTLED / RETURNED are terminal in the "forward" direction; a
  // subsequent LOWER-precedence event never regresses them.
  if (currentPrec >= 5 && eventPrec < currentPrec && env.status !== "RETURNED") {
    return finish(IGNORED_OUT_OF_ORDER, `current=${inst.status} incoming=${env.status}`);
  }

  // 7. Apply the event — settlement / return / status update.
  const run = await prisma.paymentRun.findUniqueOrThrow({
    where: { id: inst.runId },
    select: {
      id: true, clubId: true, currency: true, sourceType: true, sourceId: true,
      fundingBankAccount: { select: { id: true, glAccountId: true } },
    },
  });
  const resolvedRun = {
    id: run.id, clubId: run.clubId, currency: run.currency,
    sourceType: run.sourceType as PaymentSourceType, sourceId: run.sourceId,
    fundingBankAccount: run.fundingBankAccount,
  };

  if (env.eventType === "SETTLED" || env.status === "SETTLED") {
    if (inst.settledAt) {
      return finish(IGNORED_DUPLICATE, `already settled at ${inst.settledAt.toISOString()}`);
    }
    await prisma.$transaction(async (tx) => {
      await recordInstructionSettlement(
        tx, resolvedRun,
        { id: inst.id, clubId: inst.clubId, amount: new Prisma.Decimal(inst.amount),
          settledAt: inst.settledAt, returnedAt: inst.returnedAt, recipientId: inst.recipientId },
        env.providerTimestamp ?? new Date(),
      );
      await recordPaymentEvent(
        {
          clubId: inst.clubId, runId: inst.runId, instructionId: inst.id,
          eventType: "PAYMENT_SETTLED",
          previousStatus: inst.status,
          newStatus: "SETTLED",
          actorSource: "PROVIDER",
          providerReference: env.providerReference,
          meta: { source: "external-event", externalEventId: row!.id },
        },
        tx,
      );
    });
    return finish(APPLIED, "settled via external event");
  }

  if (env.eventType === "RETURNED" || env.status === "RETURNED") {
    if (!inst.settledAt) {
      // Adapter should have delivered SETTLED first; refuse to invent
      // a return without a settlement — falls to out-of-order.
      return finish(IGNORED_OUT_OF_ORDER, "return before settlement");
    }
    if (inst.returnedAt) {
      return finish(IGNORED_DUPLICATE, `already returned at ${inst.returnedAt.toISOString()}`);
    }
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.paymentInstruction.findUniqueOrThrow({
        where: { id: inst.id },
        select: { settledAt: true, returnedAt: true, amount: true, clubId: true, recipientId: true, status: true },
      });
      await recordInstructionReturn(
        tx, resolvedRun,
        { id: inst.id, clubId: fresh.clubId, amount: new Prisma.Decimal(fresh.amount),
          settledAt: fresh.settledAt, returnedAt: fresh.returnedAt, recipientId: fresh.recipientId },
        env.providerTimestamp ?? new Date(),
        env.returnCode ?? "UNKNOWN",
        env.returnDescription ?? "",
      );
    });
    return finish(APPLIED, "returned via external event");
  }

  // Status-only update (ACCEPTED, PROCESSING, RECEIVED).
  if (env.status === "ACCEPTED" && inst.status === "SUBMITTED") {
    await prisma.$transaction(async (tx) => {
      await tx.paymentInstruction.update({
        where: { id: inst.id },
        data: { status: "ACCEPTED", acceptedAt: new Date() },
      });
      await recordPaymentEvent(
        {
          clubId: inst.clubId, runId: inst.runId, instructionId: inst.id,
          eventType: "PAYMENT_ACCEPTED",
          previousStatus: "SUBMITTED",
          newStatus: "ACCEPTED",
          actorSource: "PROVIDER",
          providerReference: env.providerReference,
          meta: { source: "external-event", externalEventId: row!.id },
        },
        tx,
      );
    });
    return finish(APPLIED, "accepted via external event");
  }

  // Any other applied path with no explicit financial action is a
  // notification-only event.
  return finish(APPLIED, "status update recorded (no financial mutation)");
}
