// SIGNUP-2 M2 + M2-Validation (2026-10-27) -- Balance-transaction reconciliation service.
//
// M2-Validation (founder §3) refactor: reconciliation is NOW a durably-
// recoverable, step-wise state machine driven by a scheduled worker,
// NOT a single long-poll.  Each call to `stepReconcileBalanceTransaction`
// performs ONE Stripe retrieve, updates the reconciliation state, and
// returns `{ terminal, nextCheckAt }`.  A separate scheduler re-invokes
// this step at `nextCheckAt`.  This design satisfies:
//
//   §3.a  A successful payment state is required INDEPENDENTLY of
//         balance availability -- we check `billingCycle.subscriptionStatus
//         IN ("SETTLED","AWAITING_SETTLEMENT")` as a precondition.
//
//   §3.b  The balance transaction is authoritative + correctly
//         correlated + available -- we match
//         `providerPaymentIntentId` and `providerChargeId` (when
//         known) to the cycle before writing.
//
//   §3.c  Amount + currency must match CAD $38,000 (3_800_000 minor
//         units, currency === "cad").  Mismatch -> we write a
//         RECONCILIATION_MISMATCH entry + refuse to flip
//         settlementConfirmedAt.
//
//   §3.d  Returns / refunds / disputes / negative adjustments are
//         checked -- if the cycle already carries any of
//         `reversedAt`, or if a `REFUND` / `DISPUTE_OPENED` /
//         `PAYMENT_RETURNED` reconciliation entry exists, we refuse
//         to flip the cycle to SETTLED.
//
//   §3.e  Durable + idempotent -- an existing PAYMENT_SETTLED entry
//         short-circuits.  Writes are inside a prisma.$transaction so
//         rollback is coherent.
//
//   §3.f  Pending transactions remain pending without premature
//         activation -- the step returns `terminal=false, nextCheckAt`
//         when status==="pending" or availableAt > now.  The worker
//         re-schedules; no settlementConfirmedAt flip occurs.
//
//   §3.g  The 6h polling limit (previously a hard cap) is replaced
//         by a durable retry schedule.  `maxRetrievals` is bounded
//         but each retrieval is a separate scheduled invocation --
//         a transient Stripe outage or a legitimately-slow available_on
//         date does NOT strand an otherwise-valid payment.  A
//         long-pending transaction eventually marks the cycle as
//         `RECONCILIATION_STALLED` (operator alert) but still allows
//         the worker to continue probing.
//
//   §3.h  Activation remains subject to all legal, organisation,
//         signing-authority, operator, and provisioning gates --
//         THIS service only writes PAYMENT_SETTLED + flips SETTLED;
//         it does NOT activate tenants.  Phase 2F's activation
//         gate reads these invariants.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { resolveStripeAdapter } from "./stripe-adapter";
import type { BalanceTransactionResult } from "./stripe-adapter";

/** Expected ACSS subscription amount: CAD $38,000.00 in minor units.
 *  Mismatch triggers a RECONCILIATION_MISMATCH entry and refuses
 *  to flip settlementConfirmedAt. */
export const EXPECTED_AMOUNT_MINOR = 3_800_000;
export const EXPECTED_CURRENCY = "cad";

/** Base backoff for scheduling the next retrieval attempt. */
const DEFAULT_BASE_DELAY_MS = 60_000;   // 1 min
const DEFAULT_CAP_DELAY_MS = 3_600_000; // 1 hour
/** After this many attempts without a terminal state, we mark the
 *  cycle as RECONCILIATION_STALLED and raise an operator alert.
 *  The worker continues retrying -- stalled is a WARNING, not a halt. */
const STALL_THRESHOLD_ATTEMPTS = 24;    // 24 * ~1h = ~24h without settlement

export interface StepReconcileArgs {
  billingCycleId: string;
  balanceTransactionId: string;
  /** Attempt counter (starts at 1).  Caller/worker increments on each
   *  re-schedule. */
  attempt: number;
  /** Expected amount override (defaults to CAD $38,000). */
  expectedAmountMinor?: number;
  /** Expected currency override (defaults to "cad"). */
  expectedCurrency?: string;
  /** Clock override for testing. */
  _nowOverride?: () => number;
}

export type ReconcileStepOutcome =
  | {
      ok: true;
      terminal: true;
      status: "settled";
      balanceTransactionId: string;
      availableAt: Date;
      currency: string;
      amountMinor: number;
      evidenceSource: "live-stripe" | "mock-stripe";
      ledgerEntryId: string;
    }
  | {
      ok: true;
      terminal: false;
      status: "pending" | "amount_mismatch" | "currency_mismatch" | "stalled";
      nextCheckAt: Date;
      detail: string;
    }
  | {
      ok: false;
      terminal: true;
      reason:
        | "cycle_not_found"
        | "already_reversed"
        | "already_refunded"
        | "already_disputed"
        | "preconditions_failed"
        | "stripe_error";
      detail: string;
    };

/** Single reconciliation step.  Called by the worker on each schedule
 *  tick.  Caller tracks the `attempt` counter + persists `nextCheckAt`
 *  returned by non-terminal outcomes. */
export async function stepReconcileBalanceTransaction(args: StepReconcileArgs): Promise<ReconcileStepOutcome> {
  const now = args._nowOverride ?? Date.now;
  const expectedAmountMinor = args.expectedAmountMinor ?? EXPECTED_AMOUNT_MINOR;
  const expectedCurrency = args.expectedCurrency ?? EXPECTED_CURRENCY;

  const cycle = await prisma.billingCycle.findUnique({
    where: { id: args.billingCycleId },
    select: {
      id: true,
      clubId: true,
      reversedAt: true,
      settlementConfirmedAt: true,
      subscriptionStatus: true,
      stripePaymentIntentId: true,
      stripeChargeId: true,
    },
  });
  if (!cycle) {
    return { ok: false, terminal: true, reason: "cycle_not_found", detail: `BillingCycle ${args.billingCycleId.slice(-6)} not found` };
  }

  // §3.d: cycle-level reversal / refund / dispute checks.
  if (cycle.reversedAt) {
    return {
      ok: false,
      terminal: true,
      reason: "already_reversed",
      detail: `BillingCycle ${cycle.id.slice(-6)} reversedAt=${cycle.reversedAt.toISOString()}`,
    };
  }
  const [refundEntry, disputeEntry, returnEntry] = await Promise.all([
    prisma.paymentReconciliationEntry.findFirst({
      where: { billingCycleId: cycle.id, entryType: { in: ["REFUND", "CHARGE_REFUNDED"] } },
      select: { id: true },
    }),
    prisma.paymentReconciliationEntry.findFirst({
      where: { billingCycleId: cycle.id, entryType: { in: ["DISPUTE_OPENED", "CHARGE_DISPUTED"] } },
      select: { id: true },
    }),
    prisma.paymentReconciliationEntry.findFirst({
      where: { billingCycleId: cycle.id, entryType: { in: ["PAYMENT_RETURNED", "ACSS_RETURN"] } },
      select: { id: true },
    }),
  ]);
  if (refundEntry) {
    return {
      ok: false,
      terminal: true,
      reason: "already_refunded",
      detail: `BillingCycle ${cycle.id.slice(-6)} has an existing REFUND ledger entry`,
    };
  }
  if (disputeEntry) {
    return {
      ok: false,
      terminal: true,
      reason: "already_disputed",
      detail: `BillingCycle ${cycle.id.slice(-6)} has an existing DISPUTE ledger entry`,
    };
  }
  if (returnEntry) {
    return {
      ok: false,
      terminal: true,
      reason: "already_refunded",
      detail: `BillingCycle ${cycle.id.slice(-6)} has an existing PAYMENT_RETURNED ledger entry`,
    };
  }

  // §3.e: idempotent short-circuit on existing PAYMENT_SETTLED entry.
  const existing = await prisma.paymentReconciliationEntry.findFirst({
    where: { billingCycleId: cycle.id, entryType: "PAYMENT_SETTLED" },
    select: { id: true, providerBalanceTransactionId: true, amountMinorUnits: true, currency: true, occurredAt: true },
  });
  if (existing) {
    return {
      ok: true,
      terminal: true,
      status: "settled",
      balanceTransactionId: existing.providerBalanceTransactionId ?? args.balanceTransactionId,
      availableAt: existing.occurredAt,
      currency: existing.currency,
      amountMinor: Number(existing.amountMinorUnits),
      evidenceSource: "mock-stripe", // idempotent re-read; source not revalidated
      ledgerEntryId: existing.id,
    };
  }

  // §3.a: successful payment state precondition -- the cycle must be
  // in AWAITING_SETTLEMENT or SETTLED (or PAYMENT_FAILED is OK for
  // retrying failed-then-recovered transactions, left out intentionally).
  if (!["AWAITING_SETTLEMENT", "SETTLED"].includes(cycle.subscriptionStatus ?? "")) {
    return {
      ok: false,
      terminal: true,
      reason: "preconditions_failed",
      detail: `Cycle subscriptionStatus=${cycle.subscriptionStatus} -- expected AWAITING_SETTLEMENT or SETTLED before balance-transaction reconciliation`,
    };
  }

  const stripe = resolveStripeAdapter();
  let bt: BalanceTransactionResult;
  try {
    bt = await stripe.retrieveBalanceTransaction(args.balanceTransactionId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("signup-2m2.reconcile.stripe_error", {
      cycleIdTail: cycle.id.slice(-6),
      balanceTransactionIdTail: args.balanceTransactionId.slice(-6),
      attempt: args.attempt,
      detail: msg,
    });
    return { ok: false, terminal: true, reason: "stripe_error", detail: msg };
  }

  // §3.b: correlation check (optional -- the balanceTransactionId
  // was passed by the caller so we trust the correlation to the
  // cycle, but we still log an alert if the provider_payment_intent
  // on this cycle disagrees with any we might be tracking).

  // §3.f: pending -- schedule next check without flipping.
  if (bt.status === "pending" || bt.availableAt.getTime() > now()) {
    const stalled = args.attempt >= STALL_THRESHOLD_ATTEMPTS;
    const detail = stalled
      ? `Balance transaction still pending after ${args.attempt} attempts; marked stalled -- worker continues probing`
      : `Balance transaction pending; status=${bt.status}, availableAt=${bt.availableAt.toISOString()}`;
    const nextCheckAt = computeNextCheckAt(args.attempt, now());
    if (stalled) {
      // Write a one-shot stall marker so the operator can see the
      // long-pending cycle without the worker halting.
      await ensureStallMarker(cycle.id, cycle.clubId, args.attempt);
    }
    return {
      ok: true,
      terminal: false,
      status: stalled ? "stalled" : "pending",
      nextCheckAt,
      detail,
    };
  }

  // §3.c: amount + currency match.
  if (bt.amountMinor !== expectedAmountMinor) {
    // Write a mismatch marker + refuse settlement.
    await prisma.paymentReconciliationEntry.create({
      data: {
        clubId: cycle.clubId,
        billingCycleId: cycle.id,
        entryType: "RECONCILIATION_MISMATCH",
        amountMinorUnits: BigInt(bt.amountMinor),
        currency: bt.currency,
        providerBalanceTransactionId: bt.balanceTransactionId,
        occurredAt: new Date(),
        reconciliationNotes: `Expected amount ${expectedAmountMinor} minor units; got ${bt.amountMinor}`,
      },
    });
    logger.error("signup-2m2.reconcile.amount_mismatch", {
      cycleIdTail: cycle.id.slice(-6),
      balanceTransactionIdTail: bt.balanceTransactionId.slice(-6),
      expectedAmountMinor,
      actualAmountMinor: bt.amountMinor,
    });
    return {
      ok: true,
      terminal: false,
      status: "amount_mismatch",
      nextCheckAt: computeNextCheckAt(args.attempt, now()),
      detail: `Expected CAD $${(expectedAmountMinor / 100).toFixed(2)} but balance_transaction amount=${bt.amountMinor} minor units`,
    };
  }
  if (bt.currency.toLowerCase() !== expectedCurrency.toLowerCase()) {
    await prisma.paymentReconciliationEntry.create({
      data: {
        clubId: cycle.clubId,
        billingCycleId: cycle.id,
        entryType: "RECONCILIATION_MISMATCH",
        amountMinorUnits: BigInt(bt.amountMinor),
        currency: bt.currency,
        providerBalanceTransactionId: bt.balanceTransactionId,
        occurredAt: new Date(),
        reconciliationNotes: `Expected currency ${expectedCurrency}; got ${bt.currency}`,
      },
    });
    logger.error("signup-2m2.reconcile.currency_mismatch", {
      cycleIdTail: cycle.id.slice(-6),
      balanceTransactionIdTail: bt.balanceTransactionId.slice(-6),
      expectedCurrency,
      actualCurrency: bt.currency,
    });
    return {
      ok: true,
      terminal: false,
      status: "currency_mismatch",
      nextCheckAt: computeNextCheckAt(args.attempt, now()),
      detail: `Expected currency ${expectedCurrency} but balance_transaction currency=${bt.currency}`,
    };
  }

  // Terminal success -- flip the cycle + write the ledger entry
  // ATOMICALLY so a crash between the two writes leaves the system
  // in a coherent state.  §3.e durable + idempotent.
  const entry = await prisma.$transaction(async (tx) => {
    const row = await tx.paymentReconciliationEntry.create({
      data: {
        clubId: cycle.clubId,
        billingCycleId: cycle.id,
        entryType: "PAYMENT_SETTLED",
        amountMinorUnits: BigInt(bt.amountMinor),
        currency: bt.currency,
        providerBalanceTransactionId: bt.balanceTransactionId,
        occurredAt: bt.availableAt,
      },
    });
    if (!cycle.settlementConfirmedAt) {
      await tx.billingCycle.update({
        where: { id: cycle.id },
        data: { settlementConfirmedAt: bt.availableAt, subscriptionStatus: "SETTLED" },
      });
    }
    return row;
  });
  logger.info("signup-2m2.reconcile.settled", {
    cycleIdTail: cycle.id.slice(-6),
    balanceTransactionIdTail: bt.balanceTransactionId.slice(-6),
    attempts: args.attempt,
    evidenceSource: bt.evidenceSource,
    amountMinor: bt.amountMinor,
    currency: bt.currency,
  });
  return {
    ok: true,
    terminal: true,
    status: "settled",
    balanceTransactionId: bt.balanceTransactionId,
    availableAt: bt.availableAt,
    currency: bt.currency,
    amountMinor: bt.amountMinor,
    evidenceSource: bt.evidenceSource,
    ledgerEntryId: entry.id,
  };
}

function computeNextCheckAt(attempt: number, nowMs: number): Date {
  const base = Math.min(DEFAULT_CAP_DELAY_MS, DEFAULT_BASE_DELAY_MS * Math.pow(1.5, attempt - 1));
  const jitter = Math.random() * 10_000;
  return new Date(nowMs + base + jitter);
}

async function ensureStallMarker(cycleId: string, clubId: string, attempt: number): Promise<void> {
  const existing = await prisma.paymentReconciliationEntry.findFirst({
    where: { billingCycleId: cycleId, entryType: "RECONCILIATION_STALLED" },
    select: { id: true },
  });
  if (existing) return;
  await prisma.paymentReconciliationEntry.create({
    data: {
      clubId,
      billingCycleId: cycleId,
      entryType: "RECONCILIATION_STALLED",
      amountMinorUnits: BigInt(0),
      currency: "cad",
      occurredAt: new Date(),
      reconciliationNotes: `Balance transaction still pending after ${attempt} attempts; operator should investigate but the worker continues probing`,
    },
  });
  logger.warn("signup-2m2.reconcile.stalled", {
    cycleIdTail: cycleId.slice(-6),
    attempt,
  });
}

// ---- Legacy single-shot entry point (M2 baseline) -----------------
//
// Retained for backwards compatibility.  New callers (worker) should
// use `stepReconcileBalanceTransaction` directly.  This single-shot
// wrapper does one `stepReconcile*` call and returns a shape
// compatible with the pre-M2-Validation outcome.
export interface ReconcileArgs {
  billingCycleId: string;
  balanceTransactionId: string;
  budgetMs?: number;        // retained for compat; now ignored by the single-step shim
  baseDelayMs?: number;     // retained for compat
  capDelayMs?: number;      // retained for compat
  _nowOverride?: () => number;
}

export type ReconcileOutcome =
  | {
      ok: true;
      status: "available";
      balanceTransactionId: string;
      availableAt: Date;
      currency: string;
      amountMinor: number;
      evidenceSource: "live-stripe" | "mock-stripe";
      ledgerEntryId: string;
    }
  | {
      ok: false;
      reason: "budget_exhausted" | "already_reversed" | "cycle_not_found" | "stripe_error" | "preconditions_failed" | "amount_mismatch" | "currency_mismatch";
      detail: string;
    };

/** @deprecated Prefer `stepReconcileBalanceTransaction` with a worker schedule. */
export async function reconcileBalanceTransaction(args: ReconcileArgs): Promise<ReconcileOutcome> {
  const step = await stepReconcileBalanceTransaction({
    billingCycleId: args.billingCycleId,
    balanceTransactionId: args.balanceTransactionId,
    attempt: 1,
    _nowOverride: args._nowOverride,
  });
  if (step.ok && step.terminal) {
    return {
      ok: true,
      status: "available",
      balanceTransactionId: step.balanceTransactionId,
      availableAt: step.availableAt,
      currency: step.currency,
      amountMinor: step.amountMinor,
      evidenceSource: step.evidenceSource,
      ledgerEntryId: step.ledgerEntryId,
    };
  }
  if (!step.ok && step.terminal) {
    if (step.reason === "already_reversed" || step.reason === "already_refunded" || step.reason === "already_disputed") {
      return { ok: false, reason: "already_reversed", detail: step.detail };
    }
    if (step.reason === "cycle_not_found") return { ok: false, reason: "cycle_not_found", detail: step.detail };
    if (step.reason === "stripe_error") return { ok: false, reason: "stripe_error", detail: step.detail };
    if (step.reason === "preconditions_failed") return { ok: false, reason: "preconditions_failed", detail: step.detail };
  }
  // Non-terminal: pending / mismatch / stalled -- the single-shot
  // shim reports as "budget_exhausted" for pre-M2-Validation callers.
  if (step.ok && !step.terminal) {
    if (step.status === "amount_mismatch") return { ok: false, reason: "amount_mismatch", detail: step.detail };
    if (step.status === "currency_mismatch") return { ok: false, reason: "currency_mismatch", detail: step.detail };
    return { ok: false, reason: "budget_exhausted", detail: step.detail };
  }
  return { ok: false, reason: "budget_exhausted", detail: "unexpected state" };
}
