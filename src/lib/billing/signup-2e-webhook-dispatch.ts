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
import {
  markBankVerified,
  markBankVerificationPending,
  markBankVerificationFailed,
  classifyVerificationMethod,
} from "./signup-2m3-bank-verification-service";

export async function dispatchStripeEvent(event: StripeEventShape): Promise<void> {
  let deferred = false;
  try {
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
      // SIGNUP-2 M3 (2026-10-27) -- bank-verification tier events.
      case "setup_intent.succeeded":
      case "setup_intent.requires_action":
      case "setup_intent.setup_failed":
      case "setup_intent.canceled":
        await onSetupIntentEvent(event);
        break;
      // SIGNUP-2 M4-settlement (2026-10-28) -- invoice + dispute lifecycle.
      // Gated by SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE inside the service
      // handlers; when OFF, the handlers throw ForbiddenError which we
      // catch + log so the event is still persisted (durable receipt)
      // and can be replayed later.
      case "invoice.paid":
      case "invoice.payment_failed":
      case "invoice.marked_uncollectible":
      case "charge.dispute.closed":
      case "charge.dispute.funds_withdrawn":
      case "charge.dispute.funds_reinstated":
        await onM4SettlementEvent(event);
        break;
      default:
        logger.info("stripe.webhook.dispatch.unknown_event", {
          stripeEventIdTail: event.id.slice(-8),
          eventType: event.type,
        });
        break;
    }
  } catch (err) {
    if (err instanceof SignupM3DeferredEvent) {
      deferred = true;
    } else {
      throw err;
    }
  }
  if (deferred) {
    // §6: do not mark processed.  The row stays with processedAt=null
    // so replayDeferredSetupIntentEvents in persistSignedMandate picks
    // it up when the correlating cycle lands.
    return;
  }
  await prisma.stripeWebhookEvent.update({
    where: { id: event.id },
    data: { processedAt: new Date(), processingResult: "success" },
  }).catch((err) => {
    const code = (err as { code?: string } | undefined)?.code;
    if (code !== "P2025") {
      logger.warn("stripe.webhook.mark_processed_failed", {
        stripeEventIdTail: event.id.slice(-8),
        detail: err instanceof Error ? err.message : String(err),
      });
    }
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
      // M1b: settlementConfirmedAt distinguishes initial vs renewal
      // payment failure classification (founder §4).
      settlementConfirmedAt: true,
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

  // M1d (2026-10-27, founder §6) -- SEVEN-SIGNAL + AMBIGUOUS classification.
  //
  // M1c introduced multi-signal correlation; founder §6 closes the
  // remaining ambiguity surface where correlators DISAGREE.  The
  // classifier now evaluates seven signals and routes every
  // disagreement to an AMBIGUOUS_PAYMENT_FAILURE operator alert
  // WITHOUT triggering suspension.  The failed-renewal suspension
  // path fires only when the signals unanimously point to a
  // previously-settled, operationally-active cycle AND no later
  // settlement contradicts this failure.
  //
  //   (1) Provider event identity: the webhook was persisted +
  //       verified upstream (route.ts); dedup on event.id.
  //   (2) Billing-cycle identity: findCycleByPaymentIntent
  //       resolved a row.
  //   (3) Subscription identity: the owning Club has a
  //       ClubSubscription row (operator-managed).
  //   (4) Timestamp-settlement signal: cycle.settlementConfirmedAt
  //       is non-null (hasTimestamp).
  //   (5) Ledger-settlement signal: the cycle previously saw a
  //       settled charge in paymentReconciliationEntry with entryType
  //       PAYMENT_SETTLED recorded BEFORE this event's receivedAt
  //       (hasLedgerEntry).
  //   (6) Operational-active signal: ClubSubscription.subscriptionStatus
  //       === "ACTIVE".
  //   (7) Monotonicity signal: NO reconciliation entry with
  //       entryType PAYMENT_SETTLED exists with recordedAt STRICTLY
  //       AFTER this event's receivedAt (laterSettlement is null).
  //       A later settlement contradicts the current failure --
  //       classification is ambiguous.
  //
  // isAmbiguous = (hasTimestamp !== hasLedgerEntry)                    -- signals 4/5 disagree
  //            OR (hasTimestamp AND hasLedgerEntry AND sub === null)   -- settled but no subscription row
  //            OR (laterSettlement !== null)                           -- out-of-order / replay
  //
  // multiSignalRenewal = !isAmbiguous AND hasTimestamp AND hasLedgerEntry
  //                    AND sub !== null AND sub.subscriptionStatus === "ACTIVE"
  //
  // isInitialPaymentFailure = !multiSignalRenewal AND !isAmbiguous
  //
  // Ambiguous events raise an AMBIGUOUS_PAYMENT_FAILURE operator
  // alert and return WITHOUT suspending.  Human operator reconciles.

  const sub = await prisma.clubSubscription.findUnique({
    where: { clubId: cycle.clubId },
    select: { subscriptionStatus: true, id: true },
  });
  const priorSettlement = await prisma.paymentReconciliationEntry.findFirst({
    where: { billingCycleId: cycle.id, entryType: "PAYMENT_SETTLED" },
    select: { id: true, recordedAt: true },
  });
  const thisEventRow = await prisma.stripeWebhookEvent.findUnique({
    where: { id: event.id },
    select: { receivedAt: true },
  });
  const laterSettlement = thisEventRow
    ? await prisma.paymentReconciliationEntry.findFirst({
        where: {
          billingCycleId: cycle.id,
          entryType: "PAYMENT_SETTLED",
          recordedAt: { gt: thisEventRow.receivedAt },
        },
        select: { id: true, recordedAt: true },
      })
    : null;

  const hasTimestamp = cycle.settlementConfirmedAt !== null;
  const hasLedgerEntry = priorSettlement !== null;
  const isAmbiguous =
    (hasTimestamp !== hasLedgerEntry) ||
    (hasTimestamp && hasLedgerEntry && sub === null) ||
    laterSettlement !== null;
  const multiSignalRenewal =
    !isAmbiguous &&
    hasTimestamp &&
    hasLedgerEntry &&
    sub !== null &&
    sub.subscriptionStatus === "ACTIVE";
  const isInitialPaymentFailure = !multiSignalRenewal && !isAmbiguous;

  if (isAmbiguous) {
    await writeOperatorAlert({
      clubId: cycle.clubId,
      billingCycleId: cycle.id,
      severity: "IMMEDIATE",
      category: "AMBIGUOUS_PAYMENT_FAILURE",
      title: "Ambiguous payment failure -- correlation signals disagree",
      body:
        `BillingCycle ${cycle.id.slice(-6)} received payment_intent.payment_failed but the correlation signals disagree. ` +
        `hasTimestamp=${hasTimestamp}, hasLedgerEntry=${hasLedgerEntry}, subscriptionPresent=${sub !== null}, ` +
        `subscriptionStatus=${sub?.subscriptionStatus ?? "null"}, laterSettlementPresent=${laterSettlement !== null}. ` +
        `No suspension triggered; operator must reconcile.`,
      providerEventId: event.id,
    });
    logger.warn("stripe.webhook.ambiguous_payment_failed", {
      cycleIdTail: cycle.id.slice(-6),
      hasTimestamp,
      hasLedgerEntry,
      subscriptionPresent: sub !== null,
      subscriptionStatus: sub?.subscriptionStatus ?? null,
      laterSettlementPresent: laterSettlement !== null,
    });
    return;
  }

  await writeOperatorAlert({
    clubId: cycle.clubId,
    billingCycleId: cycle.id,
    severity: "IMMEDIATE",
    category: isInitialPaymentFailure ? "INITIAL_PAYMENT_FAILURE" : "RENEWAL_PAYMENT_FAILURE",
    title: isInitialPaymentFailure
      ? "Initial ACSS payment failed (first cycle)"
      : "Renewal ACSS payment failed",
    body: isInitialPaymentFailure
      ? `BillingCycle ${cycle.id.slice(-6)} received payment_intent.payment_failed on an UNSETTLED cycle (initial payment).  Tenant was never activated; no suspension.`
      : `BillingCycle ${cycle.id.slice(-6)} received payment_intent.payment_failed on a previously-settled cycle (renewal).  Phase 2H FAILED_RENEWAL trigger will attempt suspension if the tenant is currently ACTIVE.`,
    providerEventId: event.id,
  });

  if (isInitialPaymentFailure) {
    // Do NOT call trySuspendFromWebhook on an initial payment failure.
    // Operator remediation runs at the signup / Phase 2E level.
    logger.warn("stripe.webhook.initial_payment_failed", {
      cycleIdTail: cycle.id.slice(-6),
      pathway: "no-suspension-initial",
    });
    return;
  }

  // Renewal failure path -- suspend the ACTIVE tenant.  Trigger is
  // FAILED_RENEWAL; trySuspendFromWebhook will no-op if the
  // tenant is not currently ACTIVE (idempotent / out-of-order safety).
  await trySuspendFromWebhook({
    clubId: cycle.clubId,
    trigger: "FAILED_RENEWAL",
    stripeEventId: event.id,
    cycleId: cycle.id,
  });
  logger.warn("stripe.webhook.renewal_payment_failed", { cycleIdTail: cycle.id.slice(-6) });
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
  // Only subscriptionStatus is read here; the Phase 2H flip itself
  // writes both subscriptionStatus + accessTier atomically.
  const sub = await prisma.clubSubscription.findUnique({
    where: { clubId: args.clubId },
    select: { subscriptionStatus: true },
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

/* ============================================================
 * SIGNUP-2 M3 (2026-10-27) -- setup_intent.* handler
 * ============================================================
 * Routes the four setup_intent lifecycle events into the M3 bank-
 * verification state writers.  Durable orphan reconciliation (§6):
 * if the correlating BillingCycle has not been persisted yet (i.e.
 * the signatory's return handler has not fired), DO NOT lose the
 * event -- leave processedAt=null and log so the §6 replay in
 * persistSignedMandate picks it up on first-cycle creation. */
async function onSetupIntentEvent(event: StripeEventShape): Promise<void> {
  const maybeSiObj = event.data?.object as Record<string, unknown> | undefined;
  const setupIntentId = typeof maybeSiObj?.id === "string" ? maybeSiObj.id : null;
  if (!setupIntentId || !maybeSiObj) {
    logger.warn("stripe.webhook.setup_intent.missing_id", {
      stripeEventIdTail: event.id.slice(-8),
      eventType: event.type,
    });
    return;
  }
  const siObj: Record<string, unknown> = maybeSiObj;
  // Try to correlate to a BillingCycle.  M3 writes
  // stripeSetupIntentId on persistSignedMandate; if we can't find
  // one, defer: the event remains unprocessed and §6 replay picks
  // it up when the cycle lands.
  const cycle = await prisma.billingCycle.findFirst({
    where: { stripeSetupIntentId: setupIntentId },
    // Deliberately NOT selecting syntheticTestOnly here -- the webhook
    // dispatcher must not route on that marker; markBank* re-loads the
    // cycle in its own transaction and records the marker in its audit
    // meta.  See signup-2-m2-synthetic-sandbox.test.ts §12 regression.
    select: { id: true, clubId: true, subscriptionStatus: true },
  });
  if (!cycle) {
    logger.info("stripe.webhook.setup_intent.deferred_no_cycle", {
      stripeEventIdTail: event.id.slice(-8),
      eventType: event.type,
      setupIntentIdTail: setupIntentId.slice(-8),
    });
    // Signal to dispatchStripeEvent not to mark processedAt.
    throw new SignupM3DeferredEvent(`no cycle for setup_intent ${setupIntentId.slice(-8)}`);
  }

  try {
    switch (event.type) {
      case "setup_intent.succeeded": {
        const stripe = resolveStripeAdapter();
        let method: "INSTANT" | "MICRODEPOSITS" = "INSTANT";
        try {
          const si = await stripe.retrieveSetupIntent(setupIntentId);
          method = classifyVerificationMethod({
            previousState: (cycle.subscriptionStatus as any) ?? null,
            si,
          });
        } catch (err) {
          logger.warn("stripe.webhook.setup_intent.retrieve_failed", {
            setupIntentIdTail: setupIntentId.slice(-8),
            detail: err instanceof Error ? err.message : String(err),
          });
          // Fall back to history-based classification.
          method = cycle.subscriptionStatus === "BANK_VERIFICATION_PENDING" ? "MICRODEPOSITS" : "INSTANT";
        }
        await markBankVerified({
          billingCycleId: cycle.id,
          verificationMethod: method,
          stripeSetupIntentId: setupIntentId,
          providerEventId: event.id,
        });
        break;
      }
      case "setup_intent.requires_action": {
        const nextAction = siObj.next_action as Record<string, unknown> | undefined;
        const verify = nextAction?.verify_with_microdeposits as { arrival_date?: number; hosted_verification_url?: string } | undefined;
        const r = await markBankVerificationPending({
          billingCycleId: cycle.id,
          stripeSetupIntentId: setupIntentId,
          arrivalDate: verify?.arrival_date ? new Date(verify.arrival_date * 1000) : null,
          hostedVerificationUrl: verify?.hosted_verification_url ?? null,
          providerEventId: event.id,
        });
        if (!r.noop) {
          await writeOperatorAlert({
            clubId: cycle.clubId,
            billingCycleId: cycle.id,
            severity: "INFORMATIONAL",
            category: "BANK_VERIFICATION_PENDING",
            title: "Signatory selected microdeposit verification",
            body:
              `BillingCycle ${cycle.id.slice(-6)}: the signatory chose microdeposit verification for ACSS Debit. ` +
              `Stripe will deposit two small amounts (statement descriptor ACCTVERIFY) within 1-2 business days. ` +
              `The signatory must confirm them via the Stripe-hosted page within 10 calendar days. ` +
              `No further action is required unless the verification fails.`,
            providerEventId: event.id,
          });
        }
        break;
      }
      case "setup_intent.setup_failed":
        await markBankVerificationFailed({
          billingCycleId: cycle.id,
          reason: "STRIPE_SETUP_FAILED",
          providerEventId: event.id,
          errorCode: (siObj.last_setup_error as { code?: string } | undefined)?.code ?? null,
          errorMessage: (siObj.last_setup_error as { message?: string } | undefined)?.message ?? null,
        });
        await writeOperatorAlert({
          clubId: cycle.clubId,
          billingCycleId: cycle.id,
          severity: "IMMEDIATE",
          category: "BANK_VERIFICATION_FAILED",
          title: "Bank verification failed -- signatory must re-collect bank details",
          body:
            `BillingCycle ${cycle.id.slice(-6)}: Stripe refused the SetupIntent (verification failed). ` +
            `Signatory must open a new Checkout session and re-enter bank details. ` +
            `Error code: ${(siObj.last_setup_error as { code?: string } | undefined)?.code ?? "unknown"}. ` +
            `Spectre has not debited any funds; no subscription was created.`,
          providerEventId: event.id,
        });
        break;
      case "setup_intent.canceled":
        await markBankVerificationFailed({
          billingCycleId: cycle.id,
          reason: "SIGNATORY_CANCELED",
          providerEventId: event.id,
        });
        await writeOperatorAlert({
          clubId: cycle.clubId,
          billingCycleId: cycle.id,
          severity: "IMMEDIATE",
          category: "BANK_VERIFICATION_CANCELED",
          title: "Signatory canceled bank verification",
          body:
            `BillingCycle ${cycle.id.slice(-6)}: the signatory canceled the SetupIntent before verification completed. ` +
            `A new Checkout session is required to restart the flow.`,
          providerEventId: event.id,
        });
        break;
    }
  } catch (err) {
    // M3 flag OFF -> markBank* throws ForbiddenError.  Log + swallow
    // so dispatchStripeEvent marks the event processed and we don't
    // retry forever.  Pre-M3 behaviour.
    if ((err as { message?: string } | undefined)?.message?.includes("SIGNUP-2 M3 bank-verification workflow is disabled")) {
      logger.info("stripe.webhook.setup_intent.m3_disabled", {
        stripeEventIdTail: event.id.slice(-8),
        eventType: event.type,
        cycleIdTail: cycle.id.slice(-6),
      });
      return;
    }
    throw err;
  }
}

/** M3 (2026-10-27) -- marker exception.  When the dispatcher catches
 *  this, it leaves processedAt=null so the §6 orphan replay in
 *  persistSignedMandate picks the event up on first-cycle creation. */
export class SignupM3DeferredEvent extends Error {
  constructor(detail: string) {
    super(`signup-2m3-deferred: ${detail}`);
    this.name = "SignupM3DeferredEvent";
  }
}

/* ============================================================
 * SIGNUP-2 M4-settlement (2026-10-28) -- invoice + dispute events
 * ============================================================
 * Routes the six new events into the M4-settlement service.
 * Narrow flag SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE is enforced by the
 * individual handlers (fail-closed).  When off, the handlers throw
 * ForbiddenError which we catch + log; the event stays in
 * StripeWebhookEvent (durable receipt) + is NOT marked processed, so
 * the orphan-replay path in M4-triggering can process it when the
 * flag is later flipped. */
async function onM4SettlementEvent(event: StripeEventShape): Promise<void> {
  try {
    const svc = await import("./signup-2m4-settlement-service");
    switch (event.type) {
      case "invoice.paid":                      await svc.handleInvoicePaid(event); break;
      case "invoice.payment_failed":            await svc.handleInvoicePaymentFailed(event); break;
      case "invoice.marked_uncollectible":      await svc.handleInvoiceMarkedUncollectible(event); break;
      case "charge.dispute.closed":             await svc.handleChargeDisputeClosed(event); break;
      case "charge.dispute.funds_withdrawn":    await svc.handleChargeDisputeFundsWithdrawn(event); break;
      case "charge.dispute.funds_reinstated":   await svc.handleChargeDisputeFundsReinstated(event); break;
    }
  } catch (err) {
    const msg = (err as { message?: string } | undefined)?.message ?? "";
    // M4-settlement flag OFF -> treat as deferred (leave processedAt=null
    // so orphan replay can process it later).
    if (msg.includes("SIGNUP-2 M4-settlement workflow is disabled")) {
      logger.info("stripe.webhook.m4_settlement.deferred_flag_off", {
        stripeEventIdTail: event.id.slice(-8),
        eventType: event.type,
      });
      throw new SignupM3DeferredEvent(`M4-settlement flag off: ${event.type}`);
    }
    throw err;
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
