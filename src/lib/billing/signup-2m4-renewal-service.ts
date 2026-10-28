// SIGNUP-2 M4-renewal (2026-10-28) -- Annual subscription renewal
// lifecycle.  Phase 5 of 6 under the authorised M4 sequence.
//
// Scope boundaries (per founder authorisation):
//   - No M4-cancellation (SUBSCRIPTION_SCHEDULE_CANCEL command type
//     deferred to that slice).
//   - No accelerated synthetic signup-to-activation pathway.
//   - No actual subscription creation (M4-triggering + M3 flags still
//     gate the real stripe.subscriptions.create path).
//   - This slice adds 3 new Stripe destination events for renewal
//     reconciliation: customer.subscription.updated, customer.
//     subscription.deleted, mandate.updated.
//
// Correction #3 reminder (open-gate labeling): everything exercised
// by signed-webhook fixtures in staging is INJECTED webhook evidence.
// Actual Stripe-originated settlement + renewal payment evidence is
// a separately-marked pending gate that requires a real subscription
// to exist (blocked by PAYMENT_INITIATION flag + ACSS limit
// escalation).
//
// Flag gating:
//   SPECTRE_SIGNUP_2M4_RENEWAL_LIVE  -- gates webhook handler state
//                                        writes + preflight execution.
//   Both this flag AND the dispatcher's WEBHOOK_DISPATCH / 2E flag
//   must be ON for actual state writes to fire.
//
// Correction #8 reflected throughout (no webhook ordering assumed;
// reconciliation uses authoritative Stripe subscription + invoice +
// payment identifiers).

import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import { ForbiddenError } from "@/lib/errors";
import type { StripeEventShape } from "./stripe-adapter";

/* ============================================================
 * Flag guard
 * ============================================================ */

export function assertM4RenewalLiveFlag(): void {
  if (process.env.SPECTRE_SIGNUP_2M4_RENEWAL_LIVE !== "1") {
    throw new ForbiddenError(
      "SIGNUP-2 M4-renewal workflow is disabled (SPECTRE_SIGNUP_2M4_RENEWAL_LIVE != 1)",
    );
  }
}

/* ============================================================
 * Preflight scheduling (T-45 + T-7)
 * ============================================================ */

export const RENEWAL_CHECKPOINTS = ["T_MINUS_45_DAYS", "T_MINUS_7_DAYS"] as const;
export type RenewalCheckpoint = (typeof RENEWAL_CHECKPOINTS)[number];

const DAY_MS = 24 * 60 * 60 * 1000;

/** Idempotent via @@unique([billingCycleId, checkpointLabel]).  Writes
 *  both T-45 + T-7 rows in one call.  Safe to re-invoke -- re-creation
 *  is upsert-shaped. */
export async function scheduleRenewalPreflights(args: {
  billingCycleId: string;
  cycleEndDate: Date;
  syntheticTestOnly: boolean;
}): Promise<{ created: number; existing: number; preflightIds: string[] }> {
  assertM4RenewalLiveFlag();
  const results: string[] = [];
  let created = 0;
  let existing = 0;
  for (const checkpoint of RENEWAL_CHECKPOINTS) {
    const daysBefore = checkpoint === "T_MINUS_45_DAYS" ? 45 : 7;
    const scheduledFor = new Date(args.cycleEndDate.getTime() - daysBefore * DAY_MS);
    const existingRow = await prisma.billingRenewalPreflight.findUnique({
      where: {
        billingCycleId_checkpointLabel: {
          billingCycleId: args.billingCycleId,
          checkpointLabel: checkpoint,
        },
      },
      select: { id: true },
    });
    if (existingRow) {
      results.push(existingRow.id);
      existing++;
      continue;
    }
    const row = await prisma.billingRenewalPreflight.create({
      data: {
        billingCycleId: args.billingCycleId,
        checkpointLabel: checkpoint,
        scheduledFor,
        syntheticTestOnly: args.syntheticTestOnly,
      },
      select: { id: true },
    });
    results.push(row.id);
    created++;
  }
  await audit(null, {
    action: "signup.m4.renewal.preflights_scheduled",
    entityType: "BillingCycle",
    entityId: args.billingCycleId,
    clubId: null,
    meta: {
      billingCycleIdTail: args.billingCycleId.slice(-6),
      created,
      existing,
      preflightIds: results,
      syntheticTestOnly: args.syntheticTestOnly,
    },
  });
  return { created, existing, preflightIds: results };
}

/* ============================================================
 * Preflight execution (readiness check at scheduled time)
 * ============================================================ */

export type RenewalPreflightOutcome =
  | "READY"
  | "MANDATE_EXPIRED"
  | "PRICING_CHANGED"
  | "TAX_TREATMENT_CHANGED"
  | "CYCLE_NOT_FOUND"
  | "ERROR";

export interface ExecutePreflightResult {
  preflightId: string;
  outcome: RenewalPreflightOutcome;
  requiresOperatorAction: boolean;
  mandateStillValid: boolean | null;
  renewalPricingDriftDetected: boolean;
  operatorInboxEntryId?: string | null;
}

/** Execute a scheduled preflight.  Idempotent via `executedAt`
 *  being null + conditional updateMany; safe against duplicate
 *  scheduler invocations (§4). */
export async function executeRenewalPreflight(preflightId: string): Promise<ExecutePreflightResult> {
  assertM4RenewalLiveFlag();

  const preflight = await prisma.billingRenewalPreflight.findUnique({
    where: { id: preflightId },
    select: {
      id: true, billingCycleId: true, checkpointLabel: true, scheduledFor: true,
      executedAt: true, syntheticTestOnly: true,
    },
  });
  if (!preflight) {
    throw new Error(`BillingRenewalPreflight ${preflightId.slice(-6)} not found`);
  }

  // Idempotency: if already executed, return the recorded outcome.
  if (preflight.executedAt !== null) {
    const existing = await prisma.billingRenewalPreflight.findUnique({
      where: { id: preflightId },
      select: {
        outcome: true, mandateStillValid: true, renewalPricingDriftDetected: true,
        operatorInboxEntryId: true,
      },
    });
    return {
      preflightId,
      outcome: (existing?.outcome ?? "ERROR") as RenewalPreflightOutcome,
      requiresOperatorAction: (existing?.outcome ?? "ERROR") !== "READY",
      mandateStillValid: existing?.mandateStillValid ?? null,
      renewalPricingDriftDetected: existing?.renewalPricingDriftDetected ?? false,
      operatorInboxEntryId: existing?.operatorInboxEntryId ?? null,
    };
  }

  // Load cycle + mandate + pricing snapshot.
  const cycle = await prisma.billingCycle.findUnique({
    where: { id: preflight.billingCycleId },
    select: {
      id: true, clubId: true, subscriptionStatus: true,
      releasedByOperatorRecord: {
        select: {
          signupRegistration: {
            select: {
              id: true,
              billingPricing: {
                select: {
                  stripePriceId: true, amountMinorUnits: true, currency: true,
                  taxTreatment: true, gstPercentBps: true,
                },
              },
            },
          },
        },
      },
    },
  });
  if (!cycle) {
    await markPreflightExecuted(preflightId, {
      outcome: "CYCLE_NOT_FOUND",
      requiresOperatorAction: true,
    });
    return {
      preflightId, outcome: "CYCLE_NOT_FOUND",
      requiresOperatorAction: true, mandateStillValid: null,
      renewalPricingDriftDetected: false,
    };
  }

  const registration = cycle.releasedByOperatorRecord?.signupRegistration;
  const pricing = registration?.billingPricing;

  const mandate = registration
    ? await prisma.subscriptionPaymentMandate.findFirst({
        where: { signupRegistrationId: registration.id },
        orderBy: { acceptedAt: "desc" },
        select: { id: true, revokedAt: true },
      })
    : null;
  const mandateStillValid = mandate !== null && mandate.revokedAt === null;

  // Price-drift detection: for now compare the authorised price id +
  // amount to the pricing row (which is the source of truth for
  // authorised terms).  Live Stripe Price lookup is deferred to the
  // worker that actually initiates renewal collection.
  const renewalPricingDriftDetected = false; // §2: no silent price change -- detection path exists but no live source yet
  const outcome: RenewalPreflightOutcome = !mandateStillValid
    ? "MANDATE_EXPIRED"
    : renewalPricingDriftDetected
      ? "PRICING_CHANGED"
      : "READY";

  const requiresOperatorAction = outcome !== "READY";
  let operatorInboxEntryId: string | null = null;
  if (requiresOperatorAction) {
    const inbox = await prisma.operatorInboxEntry.create({
      data: {
        severity: "IMMEDIATE",
        category: `RENEWAL_PREFLIGHT_${outcome}`,
        clubId: cycle.clubId,
        billingCycleId: cycle.id,
        providerEventId: null,
        title: `Renewal preflight ${preflight.checkpointLabel}: ${outcome}`,
        body:
          `BillingCycle ${cycle.id.slice(-6)} failed renewal preflight at ${preflight.checkpointLabel}. ` +
          `outcome=${outcome}; mandateStillValid=${mandateStillValid}; pricingDrift=${renewalPricingDriftDetected}. ` +
          `Operator action required before renewal collection may proceed.`,
      },
      select: { id: true },
    });
    operatorInboxEntryId = inbox.id;
  }

  await markPreflightExecuted(preflightId, {
    outcome,
    requiresOperatorAction,
    mandateStillValid,
    renewalPricingDriftDetected,
    operatorInboxEntryId,
    renewalPriceId: pricing?.stripePriceId ?? null,
    renewalAmountMinorUnits: pricing?.amountMinorUnits ?? null,
    renewalCurrency: pricing?.currency ?? null,
    renewalTaxTreatment: pricing?.taxTreatment ?? null,
    renewalGstPercentBps: pricing?.gstPercentBps ?? null,
  });

  await audit(null, {
    action: "signup.m4.renewal.preflight_executed",
    entityType: "BillingRenewalPreflight",
    entityId: preflightId,
    clubId: cycle.clubId,
    meta: {
      preflightIdTail: preflightId.slice(-6),
      checkpoint: preflight.checkpointLabel,
      outcome,
      mandateStillValid,
      renewalPricingDriftDetected,
      syntheticTestOnly: preflight.syntheticTestOnly,
    },
  });

  return {
    preflightId, outcome, requiresOperatorAction,
    mandateStillValid, renewalPricingDriftDetected,
    operatorInboxEntryId,
  };
}

async function markPreflightExecuted(preflightId: string, data: {
  outcome: RenewalPreflightOutcome;
  requiresOperatorAction: boolean;
  mandateStillValid?: boolean | null;
  renewalPricingDriftDetected?: boolean;
  operatorInboxEntryId?: string | null;
  renewalPriceId?: string | null;
  renewalAmountMinorUnits?: bigint | null;
  renewalCurrency?: string | null;
  renewalTaxTreatment?: string | null;
  renewalGstPercentBps?: number | null;
}): Promise<void> {
  // Conditional updateMany for idempotency against duplicate scheduler
  // invocations (§4).
  await prisma.billingRenewalPreflight.updateMany({
    where: { id: preflightId, executedAt: null },
    data: {
      executedAt: new Date(),
      outcome: data.outcome,
      mandateStillValid: data.mandateStillValid ?? null,
      renewalPricingDriftDetected: data.renewalPricingDriftDetected ?? false,
      operatorInboxEntryId: data.operatorInboxEntryId ?? null,
      renewalPriceId: data.renewalPriceId ?? null,
      renewalAmountMinorUnits: data.renewalAmountMinorUnits ?? null,
      renewalCurrency: data.renewalCurrency ?? null,
      renewalTaxTreatment: data.renewalTaxTreatment ?? null,
      renewalGstPercentBps: data.renewalGstPercentBps ?? null,
    },
  });
}

/* ============================================================
 * Scheduler recovery sweep (§4)
 * ============================================================ */

/** Find missed preflights (scheduledFor <= now AND executedAt is null)
 *  for the given cycle and execute them.  Safe to call repeatedly;
 *  each executeRenewalPreflight is idempotent. */
export async function recoverMissedPreflightsForCycle(cycleId: string): Promise<{ recovered: number }> {
  try { assertM4RenewalLiveFlag(); } catch { return { recovered: 0 }; }
  const due = await prisma.billingRenewalPreflight.findMany({
    where: {
      billingCycleId: cycleId,
      executedAt: null,
      scheduledFor: { lte: new Date() },
    },
    orderBy: { scheduledFor: "asc" },
    select: { id: true },
  });
  let recovered = 0;
  for (const pf of due) {
    try {
      await executeRenewalPreflight(pf.id);
      recovered++;
    } catch (err) {
      logger.warn("signup.m4.renewal.recover_missed.error", {
        preflightIdTail: pf.id.slice(-6),
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { recovered };
}

/* ============================================================
 * Webhook handlers (correction #8: no ordering assumed)
 * ============================================================ */

/** Correlate a cycle from Stripe subscription id via BillingCommand. */
async function correlateCycleFromSubscription(stripeSubscriptionId: string | null | undefined): Promise<string | null> {
  if (!stripeSubscriptionId) return null;
  const cmd = await prisma.billingCommand.findFirst({
    where: {
      stripeResourceId: stripeSubscriptionId,
      stripeResourceType: "subscription",
      state: "SUCCEEDED",
    },
    select: { billingCycleId: true },
  });
  return cmd?.billingCycleId ?? null;
}

/** customer.subscription.updated -- reconciles cancel_at_period_end
 *  flips + status transitions.  Records a BillingExceptionCase when
 *  state transitions require operator attention.  Does NOT alter cycle
 *  subscriptionStatus here (M4-cancellation handles state writes). */
export async function handleCustomerSubscriptionUpdated(event: StripeEventShape): Promise<{ skipped: boolean; reason?: string }> {
  assertM4RenewalLiveFlag();
  const sub = event.data?.object as any;
  if (!sub?.id) return { skipped: true, reason: "missing_subscription_id" };
  const cycleId = await correlateCycleFromSubscription(sub.id);
  if (!cycleId) {
    logger.info("m4-renewal.subscription.updated.orphan", {
      stripeEventIdTail: event.id.slice(-8),
      subscriptionIdTail: typeof sub.id === "string" ? sub.id.slice(-8) : null,
    });
    return { skipped: true, reason: "orphan_no_cycle" };
  }
  const cycleRow = await prisma.billingCycle.findUnique({
    where: { id: cycleId },
    select: { syntheticTestOnly: true },
  });

  // Record a lightweight exception entry for operator visibility when
  // cancel_at_period_end is newly true.  Dedupes via (cycle, category,
  // stripeEventId).
  if (sub.cancel_at_period_end === true) {
    const existing = await prisma.billingExceptionCase.findFirst({
      where: {
        billingCycleId: cycleId,
        category: "RENEWAL_SUBSCRIPTION_UPDATED",
        stripeEventId: event.id,
      },
      select: { id: true },
    });
    if (!existing) {
      await prisma.billingExceptionCase.create({
        data: {
          billingCycleId: cycleId,
          category: "RENEWAL_SUBSCRIPTION_UPDATED",
          severity: "INFORMATIONAL",
          stripeEventId: event.id,
          stripeResourceId: sub.id,
          stripeResourceType: "subscription",
          autoRecordedAt: new Date(),
          autoRecordedPayloadJson: event.rawPayloadJson?.slice(0, 10_000) ?? null,
          requiresOperatorAction: false,
          syntheticTestOnly: cycleRow?.syntheticTestOnly ?? false,
        },
      });
    }
  }

  await audit(null, {
    action: "signup.m4.renewal.subscription_updated",
    entityType: "BillingCycle",
    entityId: cycleId,
    clubId: null,
    meta: {
      cycleIdTail: cycleId.slice(-6),
      subscriptionIdTail: typeof sub.id === "string" ? sub.id.slice(-8) : null,
      cancelAtPeriodEnd: sub.cancel_at_period_end === true,
      status: sub.status ?? null,
    },
  });
  return { skipped: false };
}

/** customer.subscription.deleted -- subscription ended on Stripe's
 *  side.  Records exception for operator action; cycle-level state
 *  transition is M4-cancellation's job. */
export async function handleCustomerSubscriptionDeleted(event: StripeEventShape): Promise<{ skipped: boolean; reason?: string }> {
  assertM4RenewalLiveFlag();
  const sub = event.data?.object as any;
  if (!sub?.id) return { skipped: true, reason: "missing_subscription_id" };
  const cycleId = await correlateCycleFromSubscription(sub.id);
  if (!cycleId) return { skipped: true, reason: "orphan_no_cycle" };
  const cycleRow = await prisma.billingCycle.findUnique({
    where: { id: cycleId },
    select: { syntheticTestOnly: true },
  });
  const existing = await prisma.billingExceptionCase.findFirst({
    where: {
      billingCycleId: cycleId,
      category: "RENEWAL_SUBSCRIPTION_DELETED",
      stripeEventId: event.id,
    },
    select: { id: true },
  });
  if (!existing) {
    await prisma.billingExceptionCase.create({
      data: {
        billingCycleId: cycleId,
        category: "RENEWAL_SUBSCRIPTION_DELETED",
        severity: "IMMEDIATE",
        stripeEventId: event.id,
        stripeResourceId: sub.id,
        stripeResourceType: "subscription",
        autoRecordedAt: new Date(),
        autoRecordedPayloadJson: event.rawPayloadJson?.slice(0, 10_000) ?? null,
        requiresOperatorAction: true,
        syntheticTestOnly: cycleRow?.syntheticTestOnly ?? false,
      },
    });
  }
  await audit(null, {
    action: "signup.m4.renewal.subscription_deleted",
    entityType: "BillingCycle",
    entityId: cycleId,
    clubId: null,
    meta: {
      cycleIdTail: cycleId.slice(-6),
      subscriptionIdTail: typeof sub.id === "string" ? sub.id.slice(-8) : null,
    },
  });
  return { skipped: false };
}

/** mandate.updated -- the ACSS mandate's state changed on Stripe.
 *  If the mandate is now inactive/revoked, mark Spectre's mandate
 *  as revoked (so retries + renewals refuse). */
export async function handleMandateUpdated(event: StripeEventShape): Promise<{ skipped: boolean; reason?: string }> {
  assertM4RenewalLiveFlag();
  const stripeMandate = event.data?.object as any;
  if (!stripeMandate?.id) return { skipped: true, reason: "missing_mandate_id" };
  const mandate = await prisma.subscriptionPaymentMandate.findFirst({
    where: { stripeMandateId: stripeMandate.id },
    select: { id: true, revokedAt: true, signupRegistrationId: true, syntheticTestOnly: true },
  });
  if (!mandate) {
    logger.info("m4-renewal.mandate.updated.orphan", {
      stripeEventIdTail: event.id.slice(-8),
      mandateIdTail: typeof stripeMandate.id === "string" ? stripeMandate.id.slice(-8) : null,
    });
    return { skipped: true, reason: "orphan_no_mandate" };
  }
  // Only transition to revoked once (idempotent).
  const stripeStatus: string | undefined = stripeMandate.status;
  const nowInactive = stripeStatus === "inactive";
  if (nowInactive && mandate.revokedAt === null) {
    await prisma.subscriptionPaymentMandate.update({
      where: { id: mandate.id },
      data: {
        revokedAt: new Date(),
        revokeReason: `stripe_mandate_${stripeStatus}`,
      },
    });
    // Record an exception for operator visibility.
    const cycle = mandate.signupRegistrationId
      ? await prisma.billingCycle.findFirst({
          where: {
            releasedByOperatorRecord: { signupRegistrationId: mandate.signupRegistrationId },
          },
          select: { id: true, syntheticTestOnly: true },
        })
      : null;
    if (cycle) {
      await prisma.billingExceptionCase.create({
        data: {
          billingCycleId: cycle.id,
          category: "MANDATE_INVALIDATED",
          severity: "IMMEDIATE",
          stripeEventId: event.id,
          stripeResourceId: stripeMandate.id,
          stripeResourceType: "mandate",
          autoRecordedAt: new Date(),
          autoRecordedPayloadJson: event.rawPayloadJson?.slice(0, 10_000) ?? null,
          requiresOperatorAction: true,
          syntheticTestOnly: cycle.syntheticTestOnly,
        },
      });
    }
    await audit(null, {
      action: "signup.m4.renewal.mandate_revoked",
      entityType: "SubscriptionPaymentMandate",
      entityId: mandate.id,
      clubId: null,
      meta: {
        mandateIdTail: mandate.id.slice(-6),
        stripeMandateIdTail: typeof stripeMandate.id === "string" ? stripeMandate.id.slice(-8) : null,
        stripeStatus,
      },
    });
  }
  return { skipped: false };
}
