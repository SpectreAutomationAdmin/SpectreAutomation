// SIGNUP-2 Phase 2A (2026-10-25) -- Append-only payment-reconciliation
// ledger primitives.
//
// Append-only.  No row ever updates `entryType` or `amountMinorUnits`
// after creation.  A correction creates a new OPERATOR_ADJUSTMENT row
// with `correctsEntryId` pointing at the original.  This guarantees
// the ledger survives any one layer of the three-level record
// separation being corrupted.
//
// Idempotency: `providerEventId` is unique across the ledger when
// present; a replayed Stripe webhook produces a no-op on insert.
// Operator-adjustment rows have null `providerEventId` by design.
//
// Phase 2A ships the write function + the enum.  No code path OUTSIDE
// this file emits a ledger write in Phase 2A; webhook routes land in
// Phase 2F.

import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";

/** The entry-type enum.  Must match v3 Section 4b of the architecture
 *  doc.  Any new type requires a code change here + a contract-test
 *  update. */
export const LEDGER_ENTRY_TYPES = [
  // Commercial lifecycle entries (Spectre-emitted on state transitions)
  "BILLING_CYCLE_OPENED",
  "PAYMENT_INITIATED",
  "ACTIVATION_READY",
  "MANUAL_INVOICE_CLEARED",
  // Provider-event mirrors (emitted by webhook handlers)
  "PAYMENT_PROCESSING",
  "CHARGE_SETTLED",
  "FUNDS_AVAILABLE",
  "DISPUTE_OPENED",
  "DISPUTE_CLOSED",
  "REFUND_ISSUED",
  "REFUND_FAILED",
  "REVERSAL",
  "NSF_POST_SETTLEMENT",
  // Operator-correction rows
  "OPERATOR_ADJUSTMENT",
] as const;
export type LedgerEntryType = (typeof LEDGER_ENTRY_TYPES)[number];

export interface AppendLedgerEntryArgs {
  clubId?: string | null;
  billingCycleId?: string | null;
  entryType: LedgerEntryType;
  amountMinorUnits: bigint;   // CAD cents; sign per entry type
  currency: string;           // "cad"
  providerEventId?: string | null;
  providerPaymentIntentId?: string | null;
  providerChargeId?: string | null;
  providerBalanceTransactionId?: string | null;
  providerFeeAmount?: bigint | null;
  providerNetAmount?: bigint | null;
  occurredAt: Date;
  operatorUserId?: string | null;
  correctsEntryId?: string | null;
  reconciliationNotes?: string | null;
}

/**
 * Append a new ledger entry.  Idempotent on `providerEventId`:
 * replaying the same Stripe event id yields the same row id and
 * does not create a duplicate.
 *
 * OPERATOR_ADJUSTMENT entries bypass the idempotency check (they
 * have null `providerEventId` and are expected to be unique per
 * operator action) but MUST reference the entry they correct via
 * `correctsEntryId`.
 */
export async function appendLedgerEntry(args: AppendLedgerEntryArgs): Promise<{ id: string; createdNew: boolean }> {
  if (!(LEDGER_ENTRY_TYPES as readonly string[]).includes(args.entryType)) {
    throw new AppError(
      "SIGNUP_2_LEDGER_INVALID_ENTRY_TYPE",
      `Unknown ledger entry type '${args.entryType}'`,
      400,
    );
  }
  if (args.currency.toLowerCase() !== args.currency) {
    throw new AppError(
      "SIGNUP_2_LEDGER_CURRENCY_LOWERCASE",
      `Ledger currency must be lowercase ISO code (got '${args.currency}')`,
      400,
    );
  }
  if (args.entryType === "OPERATOR_ADJUSTMENT") {
    if (!args.correctsEntryId) {
      throw new AppError(
        "SIGNUP_2_LEDGER_ADJUSTMENT_MISSING_SOURCE",
        "OPERATOR_ADJUSTMENT entries must reference a correctsEntryId",
        400,
      );
    }
    if (!args.operatorUserId) {
      throw new AppError(
        "SIGNUP_2_LEDGER_ADJUSTMENT_MISSING_OPERATOR",
        "OPERATOR_ADJUSTMENT entries must record the operator user id",
        400,
      );
    }
  }

  // Idempotency on providerEventId.  If a row with this event id
  // already exists for this clubId + entryType, return it rather
  // than inserting a duplicate.  This is Spectre's defence against
  // Stripe's at-least-once webhook delivery.
  if (args.providerEventId) {
    const existing = await prisma.paymentReconciliationEntry.findFirst({
      where: {
        providerEventId: args.providerEventId,
        entryType: args.entryType,
        clubId: args.clubId ?? undefined,
      },
      select: { id: true },
    });
    if (existing) return { id: existing.id, createdNew: false };
  }

  const row = await prisma.paymentReconciliationEntry.create({
    data: {
      clubId: args.clubId ?? null,
      billingCycleId: args.billingCycleId ?? null,
      entryType: args.entryType,
      amountMinorUnits: args.amountMinorUnits,
      currency: args.currency,
      providerEventId: args.providerEventId ?? null,
      providerPaymentIntentId: args.providerPaymentIntentId ?? null,
      providerChargeId: args.providerChargeId ?? null,
      providerBalanceTransactionId: args.providerBalanceTransactionId ?? null,
      providerFeeAmount: args.providerFeeAmount ?? null,
      providerNetAmount: args.providerNetAmount ?? null,
      occurredAt: args.occurredAt,
      operatorUserId: args.operatorUserId ?? null,
      correctsEntryId: args.correctsEntryId ?? null,
      reconciliationNotes: args.reconciliationNotes ?? null,
    },
    select: { id: true },
  });
  return { id: row.id, createdNew: true };
}

/**
 * Mark a ledger entry reconciled with the provider.  Does NOT
 * mutate `entryType` or `amountMinorUnits` (append-only invariant);
 * only reconciliation metadata.
 */
export async function markReconciled(args: {
  entryId: string;
  reconciliationNotes?: string | null;
}): Promise<void> {
  await prisma.paymentReconciliationEntry.update({
    where: { id: args.entryId },
    data: {
      reconciledWithProvider: true,
      reconciledAt: new Date(),
      reconciliationNotes: args.reconciliationNotes ?? undefined,
    },
  });
}

/**
 * Convenience: expected signs per entry type.  The amount sign
 * tells the ledger reader whether this entry represents an inflow
 * (positive) or outflow (negative) relative to Spectre's expected
 * revenue stream.  Enforcement in a contract test, not a runtime
 * check (operator corrections may legitimately take either sign).
 */
export const EXPECTED_SIGN_BY_TYPE: Readonly<Record<LedgerEntryType, "positive" | "negative" | "either">> = {
  BILLING_CYCLE_OPENED:   "positive",  // expected revenue
  PAYMENT_INITIATED:      "positive",
  ACTIVATION_READY:       "positive",
  MANUAL_INVOICE_CLEARED: "positive",
  PAYMENT_PROCESSING:     "positive",
  CHARGE_SETTLED:         "positive",
  FUNDS_AVAILABLE:        "positive",
  DISPUTE_OPENED:         "negative",  // potential reversal
  DISPUTE_CLOSED:         "either",    // depends on outcome
  REFUND_ISSUED:          "negative",
  REFUND_FAILED:          "either",
  REVERSAL:               "negative",
  NSF_POST_SETTLEMENT:    "negative",
  OPERATOR_ADJUSTMENT:    "either",
} as const;
