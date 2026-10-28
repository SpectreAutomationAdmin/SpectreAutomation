// SIGNUP-2 M4-settlement (2026-10-28) -- Settlement + reconciliation of
// annual ACSS Debit subscriptions.  Phase 3 of 6 under the authorised
// M4 sequence.
//
// Scope boundaries (per founder authorisation):
//   - No M4-retries business policy here (invoice.payment_failed records
//     the attempt + exception + routes to operator; it does NOT schedule
//     an automatic retry -- that is M4-retries).
//   - No M4-renewal (customer.subscription.* events are not subscribed
//     in this slice).
//   - No M4-cancellation.
//   - No accelerated synthetic signup-to-activation pathway.
//
// Preserved verbatim:
//   - Phase 2E webhook signature verification + dedup
//   - M1b 7-signal classifier on payment_intent.payment_failed
//   - M3 bank-verification state writers
//   - M2F/M2G activation + provisioning gates
//   - Phase 2A evaluateActivationGate predicate (settled-funds gate)
//   - Settled-funds gate: balance_transaction.status === "available"
//     AND balance_transaction.available_on <= now BEFORE
//     ACTIVATION_READY transition
//
// Flag gating:
//   SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE  -- gates the new 6 handlers
//   Both this flag AND one of the pre-existing dispatch flags
//   (SPECTRE_SIGNUP_2E_PAYMENT_LIVE or SPECTRE_SIGNUP_2M3_WEBHOOK_DISPATCH)
//   must be ON for an actual settlement write to fire.
//
// M4-renewal §5 correction #3 (OPEN ACCEPTANCE GATE):
//   Settlement events exercised in staging via the signed-webhook
//   fixture runner (scripts/signup-2-m4-settlement-signed-webhook-
//   runner.mjs) are HMAC-signed Stripe-SHAPED fixtures injected into
//   this service's webhook endpoint.  They are NOT proof of actual
//   funds settlement at the Stripe clearinghouse.  Real Stripe-
//   originated settlement remains an explicitly OPEN acceptance gate
//   that requires:
//     1. Phase 2E PAYMENT_INITIATION flag released (currently blocked
//        at the global level by SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION)
//     2. A real subscription create call against the staging Stripe
//        test environment
//     3. A real ACSS Debit payment flowing through the real Stripe
//        webhook signing path
//   Nothing in this module is to be read as representing fixture
//   evidence as production-grade settlement proof.
//
// Correction #8 reflected in every correlation lookup:
//   NEVER assumes webhook event ordering.  Each handler re-derives
//   state from authoritative Stripe identifiers (invoice.id,
//   payment_intent.id, subscription.id, charge.id, balance_transaction.id)
//   rather than from arrival sequence.
//
// Correction #9 reflected in balance-transaction handling:
//   NEVER hardcodes settlement/dispute windows.  Uses Stripe's actual
//   balance_transaction.status + available_on fields.

import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import { ForbiddenError } from "@/lib/errors";
import { resolveStripeAdapter } from "./stripe-adapter";
import type { StripeEventShape } from "./stripe-adapter";

/* ============================================================
 * Flag guard (fail-closed)
 * ============================================================ */

/** M4-settlement (2026-10-28): gates the 6 new event handlers.
 *  Independent of M3 flags; both must be ON for actual state writes
 *  (plus the dispatcher's own gate). */
export function assertM4SettlementLiveFlag(): void {
  if (process.env.SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE !== "1") {
    throw new ForbiddenError(
      "SIGNUP-2 M4-settlement workflow is disabled (SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE != 1)",
    );
  }
}

/* ============================================================
 * Cycle correlation (correction #8)
 * ============================================================ */

/** Correlate a BillingCycle from the authoritative Stripe identifiers
 *  on an invoice-level event payload.  No webhook ordering assumed.
 *
 *  Lookup priority:
 *   1. invoice.payment_intent -> BillingCycle.stripePaymentIntentId
 *      (works for first-cycle invoice created by M4-triggering)
 *   2. invoice.subscription   -> BillingCommand.stripeResourceId
 *      (future renewal invoices; M4-renewal will create new cycles
 *      with their own subscription id after it ships)
 *   3. invoice.charge         -> BillingCycle.stripeChargeId
 *      (post-charge events, if we somehow missed the invoice path)
 *
 *  Returns `{ cycleId, correlationPath }` or `null` for orphan
 *  (persist event, leave processedAt=null, replay later). */
export async function correlateCycleFromInvoiceLikeIds(args: {
  invoiceId?: string | null;
  invoicePaymentIntentId?: string | null;
  invoiceSubscriptionId?: string | null;
  invoiceChargeId?: string | null;
}): Promise<{ cycleId: string; correlationPath: string } | null> {
  if (args.invoicePaymentIntentId) {
    const cycle = await prisma.billingCycle.findFirst({
      where: { stripePaymentIntentId: args.invoicePaymentIntentId },
      select: { id: true },
    });
    if (cycle) return { cycleId: cycle.id, correlationPath: "payment_intent_id" };
  }
  if (args.invoiceSubscriptionId) {
    const cmd = await prisma.billingCommand.findFirst({
      where: {
        stripeResourceId: args.invoiceSubscriptionId,
        stripeResourceType: "subscription",
        state: "SUCCEEDED",
      },
      select: { billingCycleId: true },
    });
    if (cmd) return { cycleId: cmd.billingCycleId, correlationPath: "subscription_id_via_command" };
  }
  if (args.invoiceChargeId) {
    const cycle = await prisma.billingCycle.findFirst({
      where: { stripeChargeId: args.invoiceChargeId },
      select: { id: true },
    });
    if (cycle) return { cycleId: cycle.id, correlationPath: "charge_id" };
  }
  return null;
}

/** Correlate from dispute-level event.  Disputes carry charge id
 *  which we match against BillingCycle.stripeChargeId. */
export async function correlateCycleFromDisputeIds(args: {
  disputeId?: string | null;
  chargeId?: string | null;
  paymentIntentId?: string | null;
}): Promise<{ cycleId: string; correlationPath: string } | null> {
  if (args.chargeId) {
    const cycle = await prisma.billingCycle.findFirst({
      where: { stripeChargeId: args.chargeId },
      select: { id: true },
    });
    if (cycle) return { cycleId: cycle.id, correlationPath: "charge_id" };
  }
  if (args.paymentIntentId) {
    const cycle = await prisma.billingCycle.findFirst({
      where: { stripePaymentIntentId: args.paymentIntentId },
      select: { id: true },
    });
    if (cycle) return { cycleId: cycle.id, correlationPath: "payment_intent_id" };
  }
  return null;
}

/* ============================================================
 * Payment attempt recording (financial-history preservation)
 * ============================================================ */

/** Upsert a BillingInvoicePaymentAttempt by (stripeInvoiceId,
 *  attemptNumber).  Preserves prior attempts (never overwrites).
 *  Returns the row id + whether this call created a new row. */
export async function recordPaymentAttempt(args: {
  billingCycleId: string;
  stripeInvoiceId: string;
  stripePaymentIntentId: string | null;
  stripeChargeId: string | null;
  stripeSubscriptionId: string | null;
  stripeInvoicePeriodStart: Date | null;
  stripeInvoicePeriodEnd: Date | null;
  attemptNumber: number;
  attemptScheduledAt: Date;
  attemptStartedAt?: Date | null;
  attemptSettledAt?: Date | null;
  outcome?: string | null;
  outcomeStripeCode?: string | null;
  outcomeMessage?: string | null;
  mandateValidAtAttemptTime?: boolean | null;
  syntheticTestOnly: boolean;
}): Promise<{ attemptId: string; created: boolean }> {
  // (stripeInvoiceId, attemptNumber) is unique; upsert.
  const existing = await prisma.billingInvoicePaymentAttempt.findUnique({
    where: {
      stripeInvoiceId_attemptNumber: {
        stripeInvoiceId: args.stripeInvoiceId,
        attemptNumber: args.attemptNumber,
      },
    },
    select: { id: true, outcome: true },
  });
  if (existing) {
    // Preserve prior outcome if set; only enrich null fields (no overwrite).
    await prisma.billingInvoicePaymentAttempt.update({
      where: { id: existing.id },
      data: {
        attemptStartedAt: args.attemptStartedAt ?? undefined,
        attemptSettledAt: args.attemptSettledAt ?? undefined,
        stripePaymentIntentId: args.stripePaymentIntentId ?? undefined,
        stripeChargeId: args.stripeChargeId ?? undefined,
        stripeSubscriptionId: args.stripeSubscriptionId ?? undefined,
        // Outcome fields: only write if previously null (preserve
        // first-recorded outcome; defensive against replay).
        ...(existing.outcome === null && args.outcome ? { outcome: args.outcome } : {}),
        ...(existing.outcome === null && args.outcomeStripeCode ? { outcomeStripeCode: args.outcomeStripeCode } : {}),
        ...(existing.outcome === null && args.outcomeMessage ? { outcomeMessage: args.outcomeMessage } : {}),
      },
    });
    return { attemptId: existing.id, created: false };
  }
  const row = await prisma.billingInvoicePaymentAttempt.create({
    data: {
      billingCycleId: args.billingCycleId,
      stripeInvoiceId: args.stripeInvoiceId,
      stripePaymentIntentId: args.stripePaymentIntentId,
      stripeChargeId: args.stripeChargeId,
      stripeSubscriptionId: args.stripeSubscriptionId,
      stripeInvoicePeriodStart: args.stripeInvoicePeriodStart,
      stripeInvoicePeriodEnd: args.stripeInvoicePeriodEnd,
      attemptNumber: args.attemptNumber,
      attemptScheduledAt: args.attemptScheduledAt,
      attemptStartedAt: args.attemptStartedAt ?? null,
      attemptSettledAt: args.attemptSettledAt ?? null,
      outcome: args.outcome ?? null,
      outcomeStripeCode: args.outcomeStripeCode ?? null,
      outcomeMessage: args.outcomeMessage ?? null,
      mandateValidAtAttemptTime: args.mandateValidAtAttemptTime ?? null,
      syntheticTestOnly: args.syntheticTestOnly,
    },
    select: { id: true },
  });
  return { attemptId: row.id, created: true };
}

/* ============================================================
 * Exception case recording (financial-history preservation)
 * ============================================================ */

export type BillingExceptionCategory =
  | "RETURNED_DEBIT"
  | "INVOICE_UNCOLLECTIBLE"
  | "DISPUTE_CLOSED_WON"
  | "DISPUTE_CLOSED_LOST"
  | "DISPUTE_FUNDS_WITHDRAWN"
  | "DISPUTE_FUNDS_REINSTATED"
  | "ATTEMPT_FAILURE";

export async function recordBillingException(args: {
  billingCycleId: string;
  category: BillingExceptionCategory;
  severity: "INFORMATIONAL" | "IMMEDIATE";
  stripeEventId: string | null;
  stripeResourceId: string | null;
  stripeResourceType: string | null;
  stripeBalanceTransactionId?: string | null;
  balanceEffectAmountMinor?: bigint | null;
  balanceEffectCurrency?: string | null;
  balanceAvailableAt?: Date | null;
  requiresOperatorAction: boolean;
  payloadJson?: string | null;
  syntheticTestOnly: boolean;
}): Promise<{ exceptionId: string }> {
  // De-dupe on (stripeEventId, category) if the event id is set.  Prior
  // exceptions are PRESERVED, not overwritten (financial-history rule).
  if (args.stripeEventId) {
    const existing = await prisma.billingExceptionCase.findFirst({
      where: {
        billingCycleId: args.billingCycleId,
        category: args.category,
        stripeEventId: args.stripeEventId,
      },
      select: { id: true },
    });
    if (existing) return { exceptionId: existing.id };
  }
  const row = await prisma.billingExceptionCase.create({
    data: {
      billingCycleId: args.billingCycleId,
      category: args.category,
      severity: args.severity,
      stripeEventId: args.stripeEventId,
      stripeResourceId: args.stripeResourceId,
      stripeResourceType: args.stripeResourceType,
      stripeBalanceTransactionId: args.stripeBalanceTransactionId ?? null,
      balanceEffectAmountMinor: args.balanceEffectAmountMinor ?? null,
      balanceEffectCurrency: args.balanceEffectCurrency ?? null,
      balanceAvailableAt: args.balanceAvailableAt ?? null,
      requiresOperatorAction: args.requiresOperatorAction,
      autoRecordedAt: new Date(),
      autoRecordedPayloadJson: args.payloadJson?.slice(0, 10_000) ?? null,
      syntheticTestOnly: args.syntheticTestOnly,
    },
    select: { id: true },
  });
  return { exceptionId: row.id };
}

/* ============================================================
 * Event handlers (6 new events)
 * ============================================================ */

/** `invoice.paid` -- Stripe reports the invoice as paid.  This is NOT
 *  proof that funds are available; we only record the payment attempt
 *  as settled + leave the funds-availability gate (via actual Stripe
 *  balance_transaction retrieval) to the
 *  charge.succeeded + balance_transaction path (unchanged from Phase 2E).
 *
 *  Correction #8: no ordering assumed; this handler is idempotent and
 *  can arrive before OR after charge.succeeded. */
export async function handleInvoicePaid(event: StripeEventShape): Promise<{ skipped: boolean; reason?: string }> {
  assertM4SettlementLiveFlag();
  const invoice = event.data?.object as any;
  if (!invoice || typeof invoice.id !== "string") return { skipped: true, reason: "missing_invoice_id" };
  const cycle = await correlateCycleFromInvoiceLikeIds({
    invoiceId: invoice.id,
    invoicePaymentIntentId: typeof invoice.payment_intent === "string" ? invoice.payment_intent : null,
    invoiceSubscriptionId: typeof invoice.subscription === "string" ? invoice.subscription : null,
    invoiceChargeId: typeof invoice.charge === "string" ? invoice.charge : null,
  });
  if (!cycle) {
    logger.info("m4-settlement.invoice.paid.orphan", {
      stripeEventIdTail: event.id.slice(-8),
      invoiceIdTail: invoice.id.slice(-8),
    });
    return { skipped: true, reason: "orphan_no_cycle" };
  }
  const cycleRow = await prisma.billingCycle.findUnique({
    where: { id: cycle.cycleId },
    select: { syntheticTestOnly: true },
  });
  await recordPaymentAttempt({
    billingCycleId: cycle.cycleId,
    stripeInvoiceId: invoice.id,
    stripePaymentIntentId: typeof invoice.payment_intent === "string" ? invoice.payment_intent : null,
    stripeChargeId: typeof invoice.charge === "string" ? invoice.charge : null,
    stripeSubscriptionId: typeof invoice.subscription === "string" ? invoice.subscription : null,
    stripeInvoicePeriodStart: typeof invoice.period_start === "number" ? new Date(invoice.period_start * 1000) : null,
    stripeInvoicePeriodEnd: typeof invoice.period_end === "number" ? new Date(invoice.period_end * 1000) : null,
    attemptNumber: typeof invoice.attempt_count === "number" ? Math.max(1, invoice.attempt_count) : 1,
    attemptScheduledAt: new Date(event.created * 1000),
    attemptSettledAt: new Date(event.created * 1000),
    outcome: "SUCCEEDED",
    syntheticTestOnly: cycleRow?.syntheticTestOnly ?? false,
  });
  await audit(null, {
    action: "signup.m4.settlement.invoice_paid",
    entityType: "BillingCycle",
    entityId: cycle.cycleId,
    clubId: null,
    meta: {
      cycleIdTail: cycle.cycleId.slice(-6),
      invoiceIdTail: invoice.id.slice(-8),
      correlationPath: cycle.correlationPath,
      stripeEventIdTail: event.id.slice(-8),
    },
  });
  logger.info("m4-settlement.invoice.paid.recorded", {
    cycleIdTail: cycle.cycleId.slice(-6),
    invoiceIdTail: invoice.id.slice(-8),
  });
  return { skipped: false };
}

/** `invoice.payment_failed` -- settlement failure.  Records the attempt
 *  outcome + a BillingExceptionCase with requiresOperatorAction=true
 *  (M4-retries will later add the automated retry policy).  Does NOT
 *  retry here. */
export async function handleInvoicePaymentFailed(event: StripeEventShape): Promise<{ skipped: boolean; reason?: string }> {
  assertM4SettlementLiveFlag();
  const invoice = event.data?.object as any;
  if (!invoice || typeof invoice.id !== "string") return { skipped: true, reason: "missing_invoice_id" };
  const cycle = await correlateCycleFromInvoiceLikeIds({
    invoiceId: invoice.id,
    invoicePaymentIntentId: typeof invoice.payment_intent === "string" ? invoice.payment_intent : null,
    invoiceSubscriptionId: typeof invoice.subscription === "string" ? invoice.subscription : null,
    invoiceChargeId: typeof invoice.charge === "string" ? invoice.charge : null,
  });
  if (!cycle) return { skipped: true, reason: "orphan_no_cycle" };
  const cycleRow = await prisma.billingCycle.findUnique({
    where: { id: cycle.cycleId },
    select: { syntheticTestOnly: true },
  });
  const lastErr = invoice.last_payment_error as any | undefined;
  const outcomeCode = typeof lastErr?.code === "string" ? lastErr.code : null;
  const outcomeMessage = typeof lastErr?.message === "string" ? lastErr.message : null;
  await recordPaymentAttempt({
    billingCycleId: cycle.cycleId,
    stripeInvoiceId: invoice.id,
    stripePaymentIntentId: typeof invoice.payment_intent === "string" ? invoice.payment_intent : null,
    stripeChargeId: typeof invoice.charge === "string" ? invoice.charge : null,
    stripeSubscriptionId: typeof invoice.subscription === "string" ? invoice.subscription : null,
    stripeInvoicePeriodStart: typeof invoice.period_start === "number" ? new Date(invoice.period_start * 1000) : null,
    stripeInvoicePeriodEnd: typeof invoice.period_end === "number" ? new Date(invoice.period_end * 1000) : null,
    attemptNumber: typeof invoice.attempt_count === "number" ? Math.max(1, invoice.attempt_count) : 1,
    attemptScheduledAt: new Date(event.created * 1000),
    attemptSettledAt: new Date(event.created * 1000),
    outcome: outcomeCode === "insufficient_funds" ? "FAILED_INSUFFICIENT_FUNDS"
      : outcomeCode === "debit_not_authorized" ? "FAILED_MANDATE_INVALIDATED"
      : outcomeCode === "account_closed" ? "FAILED_MANDATE_INVALIDATED"
      : "FAILED_UNKNOWN",
    outcomeStripeCode: outcomeCode,
    outcomeMessage: outcomeMessage?.slice(0, 500) ?? null,
    syntheticTestOnly: cycleRow?.syntheticTestOnly ?? false,
  });
  await recordBillingException({
    billingCycleId: cycle.cycleId,
    category: "ATTEMPT_FAILURE",
    severity: "IMMEDIATE",
    stripeEventId: event.id,
    stripeResourceId: invoice.id,
    stripeResourceType: "invoice",
    requiresOperatorAction: true, // M4-retries will add auto-retry; M4-settlement escalates
    payloadJson: event.rawPayloadJson,
    syntheticTestOnly: cycleRow?.syntheticTestOnly ?? false,
  });
  await audit(null, {
    action: "signup.m4.settlement.invoice_payment_failed",
    entityType: "BillingCycle",
    entityId: cycle.cycleId,
    clubId: null,
    meta: {
      cycleIdTail: cycle.cycleId.slice(-6),
      invoiceIdTail: invoice.id.slice(-8),
      outcomeStripeCode: outcomeCode,
    },
  });
  return { skipped: false };
}

/** `invoice.marked_uncollectible` -- Stripe gave up after their own
 *  retry window.  Record exception; operator action required.  No auto-
 *  cancellation (that is M4-cancellation). */
export async function handleInvoiceMarkedUncollectible(event: StripeEventShape): Promise<{ skipped: boolean; reason?: string }> {
  assertM4SettlementLiveFlag();
  const invoice = event.data?.object as any;
  if (!invoice || typeof invoice.id !== "string") return { skipped: true, reason: "missing_invoice_id" };
  const cycle = await correlateCycleFromInvoiceLikeIds({
    invoiceId: invoice.id,
    invoicePaymentIntentId: typeof invoice.payment_intent === "string" ? invoice.payment_intent : null,
    invoiceSubscriptionId: typeof invoice.subscription === "string" ? invoice.subscription : null,
    invoiceChargeId: typeof invoice.charge === "string" ? invoice.charge : null,
  });
  if (!cycle) return { skipped: true, reason: "orphan_no_cycle" };
  const cycleRow = await prisma.billingCycle.findUnique({
    where: { id: cycle.cycleId },
    select: { syntheticTestOnly: true },
  });
  await recordBillingException({
    billingCycleId: cycle.cycleId,
    category: "INVOICE_UNCOLLECTIBLE",
    severity: "IMMEDIATE",
    stripeEventId: event.id,
    stripeResourceId: invoice.id,
    stripeResourceType: "invoice",
    requiresOperatorAction: true,
    payloadJson: event.rawPayloadJson,
    syntheticTestOnly: cycleRow?.syntheticTestOnly ?? false,
  });
  return { skipped: false };
}

/** Dispute lifecycle events.  All three preserve prior financial
 *  history (never overwrite); each creates a distinct exception row. */
export async function handleChargeDisputeClosed(event: StripeEventShape): Promise<{ skipped: boolean; reason?: string }> {
  assertM4SettlementLiveFlag();
  return _handleDisputeEvent(event, "DISPUTE_CLOSED", /* requiresOperatorAction */ true);
}
export async function handleChargeDisputeFundsWithdrawn(event: StripeEventShape): Promise<{ skipped: boolean; reason?: string }> {
  assertM4SettlementLiveFlag();
  return _handleDisputeEvent(event, "DISPUTE_FUNDS_WITHDRAWN", /* requiresOperatorAction */ true);
}
export async function handleChargeDisputeFundsReinstated(event: StripeEventShape): Promise<{ skipped: boolean; reason?: string }> {
  assertM4SettlementLiveFlag();
  return _handleDisputeEvent(event, "DISPUTE_FUNDS_REINSTATED", /* requiresOperatorAction */ false);
}

async function _handleDisputeEvent(
  event: StripeEventShape,
  categoryPrefix: "DISPUTE_CLOSED" | "DISPUTE_FUNDS_WITHDRAWN" | "DISPUTE_FUNDS_REINSTATED",
  requiresOperatorAction: boolean,
): Promise<{ skipped: boolean; reason?: string }> {
  const dispute = event.data?.object as any;
  if (!dispute) return { skipped: true, reason: "missing_dispute" };
  const chargeId = typeof dispute.charge === "string" ? dispute.charge : null;
  const paymentIntentId = typeof dispute.payment_intent === "string" ? dispute.payment_intent : null;
  const cycle = await correlateCycleFromDisputeIds({ disputeId: dispute.id, chargeId, paymentIntentId });
  if (!cycle) {
    logger.info("m4-settlement.dispute.orphan", {
      stripeEventIdTail: event.id.slice(-8),
      disputeIdTail: dispute.id?.slice(-8) ?? null,
    });
    return { skipped: true, reason: "orphan_no_cycle" };
  }
  const cycleRow = await prisma.billingCycle.findUnique({
    where: { id: cycle.cycleId },
    select: { syntheticTestOnly: true },
  });
  // Resolve outcome category.  For "closed", use dispute.status.
  let category: BillingExceptionCategory = categoryPrefix as BillingExceptionCategory;
  if (categoryPrefix === "DISPUTE_CLOSED") {
    category = dispute.status === "won" ? "DISPUTE_CLOSED_WON" : "DISPUTE_CLOSED_LOST";
  }
  // Correction #9: use actual balance_transaction fields when the
  // dispute carries one.
  const balanceTxId = typeof dispute.balance_transaction === "string" ? dispute.balance_transaction : null;
  let balanceInfo: {
    stripeBalanceTransactionId: string | null;
    balanceEffectAmountMinor: bigint | null;
    balanceEffectCurrency: string | null;
    balanceAvailableAt: Date | null;
  } = { stripeBalanceTransactionId: null, balanceEffectAmountMinor: null, balanceEffectCurrency: null, balanceAvailableAt: null };
  if (balanceTxId) {
    try {
      const stripe = resolveStripeAdapter();
      const bal = await stripe.retrieveBalanceTransaction(balanceTxId);
      balanceInfo = {
        stripeBalanceTransactionId: bal.balanceTransactionId,
        balanceEffectAmountMinor: BigInt(bal.amountMinor),
        balanceEffectCurrency: bal.currency,
        balanceAvailableAt: bal.availableAt,
      };
    } catch (err) {
      logger.warn("m4-settlement.dispute.balance_lookup_failed", {
        balanceTxIdTail: balanceTxId.slice(-8),
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await recordBillingException({
    billingCycleId: cycle.cycleId,
    category,
    severity: requiresOperatorAction ? "IMMEDIATE" : "INFORMATIONAL",
    stripeEventId: event.id,
    stripeResourceId: dispute.id,
    stripeResourceType: "dispute",
    stripeBalanceTransactionId: balanceInfo.stripeBalanceTransactionId,
    balanceEffectAmountMinor: balanceInfo.balanceEffectAmountMinor,
    balanceEffectCurrency: balanceInfo.balanceEffectCurrency,
    balanceAvailableAt: balanceInfo.balanceAvailableAt,
    requiresOperatorAction,
    payloadJson: event.rawPayloadJson,
    syntheticTestOnly: cycleRow?.syntheticTestOnly ?? false,
  });
  await audit(null, {
    action: `signup.m4.settlement.${category.toLowerCase()}`,
    entityType: "BillingCycle",
    entityId: cycle.cycleId,
    clubId: null,
    meta: {
      cycleIdTail: cycle.cycleId.slice(-6),
      disputeIdTail: dispute.id?.slice(-8) ?? null,
      correlationPath: cycle.correlationPath,
      stripeEventIdTail: event.id.slice(-8),
    },
  });
  return { skipped: false };
}

/* ============================================================
 * Orphan replay (recovery for missed webhooks)
 * ============================================================ */

/** Replay orphan M4-settlement events for a given billing cycle.
 *  Called by M4-triggering immediately after a successful
 *  advanceToPaymentInitiated populates stripePaymentIntentId -- any
 *  invoice/dispute events that arrived before correlation existed
 *  can now be processed.  Idempotent via event.id de-dupe + attempt
 *  upsert. */
export async function replayDeferredM4Events(args: {
  billingCycleId: string;
  stripePaymentIntentId: string;
  stripeSubscriptionId: string | null;
  stripeChargeId?: string | null;
}): Promise<{ replayed: number }> {
  try { assertM4SettlementLiveFlag(); } catch { return { replayed: 0 }; }
  const needles = [args.stripePaymentIntentId, args.stripeSubscriptionId, args.stripeChargeId]
    .filter((x): x is string => typeof x === "string" && x.length > 0);
  if (needles.length === 0) return { replayed: 0 };
  const events = await prisma.stripeWebhookEvent.findMany({
    where: {
      eventType: {
        in: [
          "invoice.paid",
          "invoice.payment_failed",
          "invoice.marked_uncollectible",
          "charge.dispute.closed",
          "charge.dispute.funds_withdrawn",
          "charge.dispute.funds_reinstated",
        ],
      },
      processedAt: null,
      OR: needles.map((n) => ({ payloadJson: { contains: n } })),
    },
    orderBy: { receivedAt: "asc" },
    select: { id: true, eventType: true, payloadJson: true, receivedAt: true },
    take: 50,
  });
  let replayed = 0;
  for (const e of events) {
    try {
      const parsed = JSON.parse(e.payloadJson);
      const stripeEvent: StripeEventShape = {
        id: parsed.id ?? e.id,
        type: e.eventType,
        created: parsed.created ?? Math.floor(e.receivedAt.getTime() / 1000),
        livemode: parsed.livemode === true,
        data: parsed.data ?? { object: {} },
        rawPayloadJson: e.payloadJson,
      };
      switch (e.eventType) {
        case "invoice.paid":                      await handleInvoicePaid(stripeEvent); break;
        case "invoice.payment_failed":            await handleInvoicePaymentFailed(stripeEvent); break;
        case "invoice.marked_uncollectible":      await handleInvoiceMarkedUncollectible(stripeEvent); break;
        case "charge.dispute.closed":             await handleChargeDisputeClosed(stripeEvent); break;
        case "charge.dispute.funds_withdrawn":    await handleChargeDisputeFundsWithdrawn(stripeEvent); break;
        case "charge.dispute.funds_reinstated":   await handleChargeDisputeFundsReinstated(stripeEvent); break;
      }
      await prisma.stripeWebhookEvent.update({
        where: { id: e.id },
        data: { processedAt: new Date(), processingResult: "m4-settlement-replay" },
      });
      replayed++;
    } catch (err) {
      logger.warn("m4-settlement.orphan_replay.error", {
        eventIdTail: e.id.slice(-8),
        eventType: e.eventType,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (replayed > 0) {
    logger.info("m4-settlement.orphan_replay.count", {
      cycleIdTail: args.billingCycleId.slice(-6),
      replayed,
    });
  }
  return { replayed };
}
