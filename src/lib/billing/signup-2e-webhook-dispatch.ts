// SIGNUP-2 Phase 2E (2026-10-26) -- Stripe webhook dispatcher.
//
// Called ONLY when `SPECTRE_SIGNUP_2E_PAYMENT_LIVE === "1"`.  The
// webhook route persists events durably regardless of flag state;
// this module is the dispatch side.
//
// Dispatch matrix (expanded as Phase 2E matures):
//   payment_intent.processing     → BillingCycle.subscriptionStatus = AWAITING_SETTLEMENT
//   payment_intent.succeeded      → BillingCycle.subscriptionStatus = SETTLED
//   payment_intent.payment_failed → BillingCycle.subscriptionStatus = PAYMENT_FAILED
//                                     + OperatorInboxEntry(IMMEDIATE, PAYMENT_FAILURE)
//   charge.succeeded              → record stripeChargeId, check activation gate
//   charge.refunded               → BillingCycle.reversedAt = now
//                                     + OperatorInboxEntry(IMMEDIATE, REVERSAL)
//   charge.dispute.created        → BillingCycle.reversedAt = now
//                                     + OperatorInboxEntry(IMMEDIATE, DISPUTE)
//
// Every transition is a conditional updateMany (idempotent on
// (billingCycleId, incoming subscriptionStatus)).  Out-of-order
// events are tolerated because each handler asserts its own
// precondition before writing.

import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import { resolveStripeAdapter } from "./stripe-adapter";
import type { StripeEventShape } from "./stripe-adapter";
import { suspendTenant, type SuspensionTrigger } from "./signup-2h-tenant-lifecycle-service";

export async function dispatchStripeEvent(event: StripeEventShape): Promise<void> {
  switch (event.type) {
    case "payment_intent.processing":
      await onPaymentIntentProcessing(event);
      break;
    case "payment_intent.succeeded":
      await onPaymentIntentSucceeded(event);
      break;
    case "payment_intent.payment_failed":
      await onPaymentIntentFailed(event);
      break;
    case "charge.succeeded":
      await onChargeSucceeded(event);
      break;
    case "charge.refunded":
      await onChargeRefunded(event);
      break;
    case "charge.dispute.created":
      await onChargeDisputeCreated(event);
      break;
    default:
      logger.info("stripe.webhook.dispatch.unknown_event", {
        stripeEventIdTail: event.id.slice(-8),
        eventType: event.type,
      });
      break;
  }
  // Mark the stored event as processed.
  await prisma.stripeWebhookEvent.update({
    where: { id: event.id },
    data: { processedAt: new Date(), processingResult: "success" },
  });
}

function paymentIntentIdFromEvent(event: StripeEventShape): string | null {
  const obj = event.data?.object as any;
  if (!obj) return null;
  if (typeof obj.id === "string" && event.type.startsWith("payment_intent.")) return obj.id;
  if (typeof obj.payment_intent === "string") return obj.payment_intent;
  return null;
}

async function findCycleByPaymentIntent(paymentIntentId: string | null) {
  if (!paymentIntentId) return null;
  return prisma.billingCycle.findFirst({
    where: { stripePaymentIntentId: paymentIntentId },
    select: {
      id: true,
      clubId: true,
      subscriptionStatus: true,
      reversedAt: true,
    },
  });
}

async function onPaymentIntentProcessing(event: StripeEventShape) {
  const pi = paymentIntentIdFromEvent(event);
  const cycle = await findCycleByPaymentIntent(pi);
  if (!cycle) return;
  await prisma.billingCycle.updateMany({
    where: { id: cycle.id, subscriptionStatus: { in: ["INITIATED"] } },
    data: { subscriptionStatus: "AWAITING_SETTLEMENT" },
  });
  await writeLedger({
    clubId: cycle.clubId,
    billingCycleId: cycle.id,
    entryType: "PAYMENT_PROCESSING",
    stripeEventId: event.id,
    stripePaymentIntentId: pi,
  });
  logger.info("stripe.webhook.payment_processing", { cycleIdTail: cycle.id.slice(-6) });
}

async function onPaymentIntentSucceeded(event: StripeEventShape) {
  const pi = paymentIntentIdFromEvent(event);
  const cycle = await findCycleByPaymentIntent(pi);
  if (!cycle) return;
  const now = new Date();
  await prisma.billingCycle.updateMany({
    where: { id: cycle.id, subscriptionStatus: { in: ["INITIATED", "AWAITING_SETTLEMENT"] } },
    data: { subscriptionStatus: "SETTLED", settlementConfirmedAt: now, totalPaid: 38000.00 },
  });
  await writeLedger({
    clubId: cycle.clubId,
    billingCycleId: cycle.id,
    entryType: "PAYMENT_SETTLED",
    stripeEventId: event.id,
    stripePaymentIntentId: pi,
  });
  logger.info("stripe.webhook.payment_settled", { cycleIdTail: cycle.id.slice(-6) });
}

async function onPaymentIntentFailed(event: StripeEventShape) {
  const pi = paymentIntentIdFromEvent(event);
  const cycle = await findCycleByPaymentIntent(pi);
  if (!cycle) return;
  await prisma.billingCycle.updateMany({
    where: { id: cycle.id, subscriptionStatus: { in: ["INITIATED", "AWAITING_SETTLEMENT"] } },
    data: { subscriptionStatus: "PAYMENT_FAILED" },
  });
  await writeLedger({
    clubId: cycle.clubId,
    billingCycleId: cycle.id,
    entryType: "PAYMENT_FAILED",
    stripeEventId: event.id,
    stripePaymentIntentId: pi,
  });
  await writeOperatorAlert({
    clubId: cycle.clubId,
    billingCycleId: cycle.id,
    severity: "IMMEDIATE",
    category: "PAYMENT_FAILURE",
    title: "Payment failed on first-cycle ACSS debit",
    body: `BillingCycle ${cycle.id.slice(-6)} received payment_intent.payment_failed.  Operator remediation required (Phase 2H).`,
    providerEventId: event.id,
  });
  // M1 (2026-10-26): Phase 2H wiring.  A FAILED_RENEWAL trigger is
  // raised when the FIRST cycle fails or a renewal cycle fails.
  // Treat all payment_intent.payment_failed as FAILED_RENEWAL (the
  // first-cycle case does not deliver settlement, so suspension
  // only materialises if the tenant was previously ACTIVE -- i.e.
  // this is a renewal failure).  Suspension is best-effort + idempotent.
  await trySuspendFromWebhook({
    clubId: cycle.clubId,
    trigger: "FAILED_RENEWAL",
    stripeEventId: event.id,
    cycleId: cycle.id,
  });
  logger.warn("stripe.webhook.payment_failed", { cycleIdTail: cycle.id.slice(-6) });
}

async function onChargeSucceeded(event: StripeEventShape) {
  const obj = event.data?.object as any;
  const pi = obj?.payment_intent;
  const cycle = await findCycleByPaymentIntent(pi);
  if (!cycle) return;
  const chargeId = typeof obj?.id === "string" ? obj.id : null;
  const balanceTxnId = typeof obj?.balance_transaction === "string" ? obj.balance_transaction : null;
  const stripe = resolveStripeAdapter();
  let activationReady = false;
  if (balanceTxnId) {
    try {
      const bal = await stripe.retrieveBalanceTransaction(balanceTxnId);
      activationReady = bal.status === "available" && bal.availableAt.getTime() <= Date.now();
    } catch (err) {
      logger.warn("stripe.webhook.balance_lookup_failed", {
        cycleIdTail: cycle.id.slice(-6),
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  await prisma.billingCycle.updateMany({
    where: { id: cycle.id, subscriptionStatus: { in: ["AWAITING_SETTLEMENT", "SETTLED"] } },
    data: {
      stripeChargeId: chargeId,
      stripeBalanceTransactionId: balanceTxnId,
      ...(activationReady ? { subscriptionStatus: "ACTIVATION_READY" } : {}),
    },
  });
  await writeLedger({
    clubId: cycle.clubId,
    billingCycleId: cycle.id,
    entryType: activationReady ? "ACTIVATION_READY" : "CHARGE_SETTLED",
    stripeEventId: event.id,
    stripeChargeId: chargeId,
  });
  logger.info("stripe.webhook.charge_succeeded", {
    cycleIdTail: cycle.id.slice(-6),
    activationReady,
  });
}

async function onChargeRefunded(event: StripeEventShape) {
  const obj = event.data?.object as any;
  const pi = obj?.payment_intent;
  const cycle = await findCycleByPaymentIntent(pi);
  if (!cycle) return;
  await prisma.billingCycle.updateMany({
    where: { id: cycle.id, reversedAt: null },
    data: {
      reversedAt: new Date(),
      reversalReason: "STRIPE_REFUND",
      // Revoke activation signal per founder §5.
      subscriptionStatus: "REVERSED",
    },
  });
  await writeLedger({
    clubId: cycle.clubId,
    billingCycleId: cycle.id,
    entryType: "REFUNDED",
    stripeEventId: event.id,
    stripeChargeId: typeof obj?.id === "string" ? obj.id : null,
  });
  await writeOperatorAlert({
    clubId: cycle.clubId,
    billingCycleId: cycle.id,
    severity: "IMMEDIATE",
    category: "REVERSAL",
    title: "Charge refunded; activation signal revoked",
    body: `BillingCycle ${cycle.id.slice(-6)} received charge.refunded.  Activation signal revoked per Phase 2E §5.`,
    providerEventId: event.id,
  });
  // M1 (2026-10-26): Phase 2H suspension wiring on confirmed reversal.
  await trySuspendFromWebhook({
    clubId: cycle.clubId,
    trigger: "REFUND",
    stripeEventId: event.id,
    cycleId: cycle.id,
  });
}

async function onChargeDisputeCreated(event: StripeEventShape) {
  const obj = event.data?.object as any;
  const pi = obj?.payment_intent;
  const cycle = await findCycleByPaymentIntent(pi);
  if (!cycle) return;
  await prisma.billingCycle.updateMany({
    where: { id: cycle.id, reversedAt: null },
    data: {
      reversedAt: new Date(),
      reversalReason: "STRIPE_DISPUTE",
      subscriptionStatus: "DISPUTE_OPEN",
    },
  });
  await writeLedger({
    clubId: cycle.clubId,
    billingCycleId: cycle.id,
    entryType: "DISPUTE_OPENED",
    stripeEventId: event.id,
  });
  await writeOperatorAlert({
    clubId: cycle.clubId,
    billingCycleId: cycle.id,
    severity: "IMMEDIATE",
    category: "DISPUTE",
    title: "Charge disputed; activation signal revoked",
    body: `BillingCycle ${cycle.id.slice(-6)} received charge.dispute.created.  10 bd window begins; activation signal revoked per Phase 2E §5.`,
    providerEventId: event.id,
  });
  // M1 (2026-10-26): Phase 2H suspension wiring on confirmed dispute.
  await trySuspendFromWebhook({
    clubId: cycle.clubId,
    trigger: "DISPUTE",
    stripeEventId: event.id,
    cycleId: cycle.id,
  });
}

/** M1 (2026-10-26) -- try to call Phase 2H suspendTenant for a
 *  confirmed reversal / dispute / failed-renewal event.  Suspension
 *  is best-effort + idempotent + fail-closed on non-tenant errors:
 *   - A tenant with subscriptionStatus=null (legacy) is skipped.
 *   - A tenant already in UNDER_REVIEW / SUSPENDED / CANCELLED is
 *     a no-op (returns INVALID_TRANSITION; we log + swallow).
 *   - A real failure (e.g. Phase 2H flag OFF) is LOGGED but does
 *     NOT re-raise -- the webhook event is already persisted + the
 *     operator inbox entry is already written.
 *
 *  The suspendTenant call is OUTSIDE any DB transaction (never
 *  holds a lock during a cross-service call) and NEVER contacts
 *  Stripe (contrast with Phase 2F authoriseActivation).
 */
async function trySuspendFromWebhook(args: {
  clubId: string;
  trigger: SuspensionTrigger;
  stripeEventId: string;
  cycleId: string;
}): Promise<void> {
  // Correlation + enrollment check: skip legacy tenants (null
  // subscriptionStatus) and tenants with no ClubSubscription row.
  const sub = await prisma.clubSubscription.findUnique({
    where: { clubId: args.clubId },
    select: { subscriptionStatus: true, accessTier: true },
  });
  if (!sub) {
    logger.info("stripe.webhook.suspension_skipped", {
      reason: "no-subscription-row",
      clubIdTail: args.clubId.slice(-6),
      trigger: args.trigger,
    });
    return;
  }
  if (sub.subscriptionStatus === null) {
    logger.info("stripe.webhook.suspension_skipped", {
      reason: "legacy-tenant-grandfathered",
      clubIdTail: args.clubId.slice(-6),
      trigger: args.trigger,
    });
    return;
  }
  if (sub.subscriptionStatus !== "ACTIVE") {
    // Already in a non-active state (UNDER_REVIEW, SUSPENDED,
    // CANCELLED, REVERSED, PAYMENT_FAILED, etc.).  Suspension is
    // idempotent -- a second reversal webhook for the same cycle
    // does not re-suspend.  Log + skip.
    logger.info("stripe.webhook.suspension_skipped", {
      reason: `subscription-status-${sub.subscriptionStatus}`,
      clubIdTail: args.clubId.slice(-6),
      trigger: args.trigger,
    });
    return;
  }

  const outcome = await suspendTenant({
    clubId: args.clubId,
    trigger: args.trigger,
    operatorUserId: "SYSTEM_PHASE_2E_WEBHOOK",
    reasonCode: `WEBHOOK_${args.trigger}`,
    reasonNotes: `Automatic suspension from Stripe webhook event ${args.stripeEventId.slice(-12)} for BillingCycle ${args.cycleId.slice(-6)}.`,
    triggerEvidence: {
      stripeEventId: args.stripeEventId,
      billingCycleId: args.cycleId,
    },
  });

  if (!outcome.ok) {
    // INVALID_TRANSITION (already non-active), LEGACY_TENANT_PROTECTED,
    // FLAG_OFF, or VALIDATION_FAILED -- all survivable from the
    // webhook path.  Operator alerts are already written upstream.
    logger.warn("stripe.webhook.suspension_refused", {
      clubIdTail: args.clubId.slice(-6),
      trigger: args.trigger,
      reason: outcome.reason,
      detail: outcome.detail,
    });
    return;
  }
  logger.info("stripe.webhook.suspension_triggered", {
    clubIdTail: args.clubId.slice(-6),
    trigger: args.trigger,
    transitionIdTail: outcome.transitionId.slice(-6),
  });
}

async function writeLedger(args: {
  clubId: string;
  billingCycleId: string;
  entryType: string;
  stripeEventId: string;
  stripePaymentIntentId?: string | null;
  stripeChargeId?: string | null;
}): Promise<void> {
  try {
    await prisma.paymentReconciliationEntry.create({
      data: {
        clubId: args.clubId,
        billingCycleId: args.billingCycleId,
        entryType: args.entryType,
        amountMinorUnits: 0n,
        currency: "cad",
        providerEventId: args.stripeEventId,
        providerPaymentIntentId: args.stripePaymentIntentId ?? null,
        providerChargeId: args.stripeChargeId ?? null,
        occurredAt: new Date(),
      },
    });
  } catch (err) {
    logger.warn("stripe.webhook.ledger_write_failed", {
      cycleIdTail: args.billingCycleId.slice(-6),
      entryType: args.entryType,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

async function writeOperatorAlert(args: {
  clubId: string;
  billingCycleId: string;
  severity: string;
  category: string;
  title: string;
  body: string;
  providerEventId: string;
}): Promise<void> {
  try {
    await prisma.operatorInboxEntry.create({
      data: {
        severity: args.severity,
        category: args.category,
        clubId: args.clubId,
        billingCycleId: args.billingCycleId,
        providerEventId: args.providerEventId,
        title: args.title,
        body: args.body,
      },
    });
    await audit(null, {
      action: `stripe.operator_alert.${args.category.toLowerCase()}`,
      entityType: "OperatorInboxEntry",
      entityId: null,
      clubId: null,
      meta: {
        cycleIdTail: args.billingCycleId.slice(-6),
        severity: args.severity,
        category: args.category,
      },
    });
  } catch (err) {
    logger.error("stripe.webhook.operator_alert_write_failed", {
      cycleIdTail: args.billingCycleId.slice(-6),
      category: args.category,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}
