// SIGNUP-2 M2 (2026-10-27) -- Balance-transaction reconciliation service.
//
// Polls the Stripe adapter's `retrieveBalanceTransaction` until the
// balance transaction's `status === "available"` AND `availableAt <=
// now`.  Writes the terminal state into `BillingCycle` + a
// `PaymentReconciliationEntry` so downstream readers (Phase 2F
// activation gate, M1d AMBIGUOUS classifier) can observe the
// authoritative provider evidence.
//
// Design:
//   - Bounded wall-clock budget: default 6 hours (ACSS debits
//     typically settle at T+5 business days; the long-poll
//     runs on a worker schedule, not an open HTTP request).
//     Callers can override.
//   - Jittered exponential backoff between polls.
//   - Idempotent: a terminal entry (settlement or reversal) causes
//     the poller to return immediately without re-querying Stripe.
//   - Never fabricates evidence.  If the adapter is mock, the
//     result carries `evidenceSource: "mock-stripe"` and the
//     production activation gate rejects it (see Phase 2F guard).
//
// This service is invoked from:
//   (a) the Phase 2E webhook dispatcher's `charge.succeeded` path
//       (after Stripe emits the balance_transaction id); OR
//   (b) a scheduled worker that scans for cycles in SETTLED but
//       with no PAYMENT_SETTLED reconciliation entry yet.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { resolveStripeAdapter } from "./stripe-adapter";
import type { BalanceTransactionResult } from "./stripe-adapter";

export interface ReconcileArgs {
  billingCycleId: string;
  balanceTransactionId: string;
  /** Maximum wall-clock budget before giving up (ms).  Default 6 hours. */
  budgetMs?: number;
  /** Initial backoff delay between polls (ms).  Default 30s. */
  baseDelayMs?: number;
  /** Backoff cap (ms).  Default 10 minutes. */
  capDelayMs?: number;
  /** Deadline override for testing — if present, uses this clock. */
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
      reason: "budget_exhausted" | "already_reversed" | "cycle_not_found" | "stripe_error";
      detail: string;
    };

export async function reconcileBalanceTransaction(args: ReconcileArgs): Promise<ReconcileOutcome> {
  const budget = args.budgetMs ?? 6 * 60 * 60 * 1000;
  const baseDelay = args.baseDelayMs ?? 30_000;
  const capDelay = args.capDelayMs ?? 600_000;
  const now = args._nowOverride ?? Date.now;

  const cycle = await prisma.billingCycle.findUnique({
    where: { id: args.billingCycleId },
    select: { id: true, clubId: true, reversedAt: true, settlementConfirmedAt: true },
  });
  if (!cycle) {
    return { ok: false, reason: "cycle_not_found", detail: `BillingCycle ${args.billingCycleId.slice(-6)} not found` };
  }
  if (cycle.reversedAt) {
    return { ok: false, reason: "already_reversed", detail: `BillingCycle ${cycle.id.slice(-6)} already reversed at ${cycle.reversedAt.toISOString()}` };
  }

  // Idempotency: if we already recorded a PAYMENT_SETTLED entry for this cycle, return it.
  const existing = await prisma.paymentReconciliationEntry.findFirst({
    where: {
      billingCycleId: cycle.id,
      entryType: "PAYMENT_SETTLED",
    },
    select: { id: true, providerBalanceTransactionId: true, amountMinorUnits: true, currency: true, occurredAt: true },
  });
  if (existing) {
    return {
      ok: true,
      status: "available",
      balanceTransactionId: existing.providerBalanceTransactionId ?? args.balanceTransactionId,
      availableAt: existing.occurredAt,
      currency: existing.currency,
      amountMinor: Number(existing.amountMinorUnits),
      evidenceSource: "mock-stripe", // idempotent re-read; source not revalidated
      ledgerEntryId: existing.id,
    };
  }

  const stripe = resolveStripeAdapter();
  const started = now();
  let attempt = 0;
  let lastResult: BalanceTransactionResult | null = null;
  while (now() - started < budget) {
    attempt++;
    let bt: BalanceTransactionResult;
    try {
      bt = await stripe.retrieveBalanceTransaction(args.balanceTransactionId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn("signup-2m2.reconcile.stripe_error", {
        cycleIdTail: cycle.id.slice(-6),
        balanceTransactionIdTail: args.balanceTransactionId.slice(-6),
        attempt,
        detail: msg,
      });
      return { ok: false, reason: "stripe_error", detail: msg };
    }
    lastResult = bt;
    if (bt.status === "available" && bt.availableAt.getTime() <= now()) {
      // Terminal success -- write the ledger entry + flip the cycle.
      const entry = await prisma.paymentReconciliationEntry.create({
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
        await prisma.billingCycle.update({
          where: { id: cycle.id },
          data: { settlementConfirmedAt: bt.availableAt, subscriptionStatus: "SETTLED" },
        });
      }
      logger.info("signup-2m2.reconcile.settled", {
        cycleIdTail: cycle.id.slice(-6),
        balanceTransactionIdTail: bt.balanceTransactionId.slice(-6),
        attempts: attempt,
        evidenceSource: bt.evidenceSource,
      });
      return {
        ok: true,
        status: "available",
        balanceTransactionId: bt.balanceTransactionId,
        availableAt: bt.availableAt,
        currency: bt.currency,
        amountMinor: bt.amountMinor,
        evidenceSource: bt.evidenceSource,
        ledgerEntryId: entry.id,
      };
    }
    // Still pending.  Compute next backoff.
    const delay = Math.min(capDelay, baseDelay * Math.pow(1.5, attempt - 1)) + (Math.random() * 2000);
    const elapsed = now() - started;
    if (elapsed + delay >= budget) break;
    await new Promise((r) => setTimeout(r, delay));
  }
  return {
    ok: false,
    reason: "budget_exhausted",
    detail:
      `Reconciliation budget exhausted after ${attempt} attempts; ` +
      `last status=${lastResult?.status ?? "unknown"}, available_at=${lastResult?.availableAt.toISOString() ?? "unknown"}`,
  };
}
