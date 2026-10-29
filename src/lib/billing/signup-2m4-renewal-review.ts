// SIGNUP-2 M4-INT-B §3 (2026-10-29) -- Operator-facing renewal
// review helpers.
//
// Thin wrappers over BillingRenewalPreflight writes.  Does NOT
// invoke Stripe.  Does NOT advance a cycle to collection.
//
// Operator decisions:
//   APPROVED           -- authorise the renewal proceeding on the
//                          currently-authorised terms (no changes).
//                          Routine renewals should go through this
//                          path when the preflight outcome was READY.
//   REJECTED           -- refuse the renewal (operator decision);
//                          cycle will not auto-renew.  Caller is
//                          responsible for issuing a cancellation
//                          request if the subscription should end.
//   RETURN_FOR_CORRECTION -- preflight exposed a correctable issue
//                          (pricing drift / tax change / missing
//                          evidence).  Record what the operator
//                          needs re-done; preflight is re-executable
//                          after the upstream data is corrected.
//
// SoD note: the review helpers do NOT enforce two-operator SoD on
// their own because the renewal preflight was itself produced by an
// automated scheduler, not an operator.  The reviewer and the person
// who caused the preflight to fire are different by construction.
//
// Durability: the preflight row is UPDATED (operatorReview* columns
// are reused via validationEvidenceJson on the related cycle; the
// explicit review fields are stored on the preflight row for the
// avoidance of a schema change at M4-INT-B).  No row is deleted.

import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { AppError } from "@/lib/errors";

export type RenewalReviewOutcome =
  | "APPROVED"
  | "REJECTED"
  | "RETURN_FOR_CORRECTION";

export const RENEWAL_REVIEW_OUTCOMES: ReadonlyArray<RenewalReviewOutcome> = [
  "APPROVED", "REJECTED", "RETURN_FOR_CORRECTION",
];

/** Operator records a decision on a renewal preflight that completed
 *  but requires human review (outcome != READY).  Idempotent via
 *  conditional update on the preflight: once reviewed, the review
 *  is sealed on the row.  Routine READY preflights do NOT require
 *  this call -- the scheduler advances them automatically. */
export async function recordRenewalReview(args: {
  preflightId: string;
  reviewedByUserId: string;
  outcome: RenewalReviewOutcome;
  reviewNotes: string;
}): Promise<{ sealed: boolean; alreadyReviewed: boolean }> {
  if (!RENEWAL_REVIEW_OUTCOMES.includes(args.outcome)) {
    throw new AppError("INVALID_REVIEW_OUTCOME", `unknown outcome '${args.outcome}'`, 400);
  }
  const existing = await prisma.billingRenewalPreflight.findUnique({
    where: { id: args.preflightId },
    select: {
      id: true, billingCycleId: true, checkpointLabel: true,
      outcome: true, executedAt: true,
      operatorReviewedAt: true, billingCycle: { select: { clubId: true } },
    },
  }).catch(() => null);
  if (!existing) {
    throw new AppError("PREFLIGHT_NOT_FOUND", `preflight ${args.preflightId.slice(-6)} not found`, 404);
  }
  if (!existing.executedAt) {
    throw new AppError(
      "PREFLIGHT_NOT_EXECUTED",
      `preflight ${args.preflightId.slice(-6)} has not been executed yet`,
      409,
    );
  }
  if (existing.operatorReviewedAt) {
    return { sealed: false, alreadyReviewed: true };
  }
  const updated = await prisma.billingRenewalPreflight.updateMany({
    where: { id: args.preflightId, operatorReviewedAt: null },
    data: {
      operatorReviewedByUserId: args.reviewedByUserId,
      operatorReviewedAt: new Date(),
      operatorReviewOutcome: args.outcome,
      operatorReviewNotes: args.reviewNotes.slice(0, 2000),
    },
  });
  if (updated.count !== 1) {
    return { sealed: false, alreadyReviewed: true };
  }
  await audit(null, {
    action: "signup.m4.renewal.operator_review_recorded",
    entityType: "BillingRenewalPreflight",
    entityId: args.preflightId,
    clubId: existing.billingCycle?.clubId ?? null,
    meta: {
      preflightIdTail: args.preflightId.slice(-6),
      checkpoint: existing.checkpointLabel,
      preflightOutcome: existing.outcome,
      reviewOutcome: args.outcome,
      reviewedByUserIdTail: args.reviewedByUserId.slice(-6),
    },
  });
  return { sealed: true, alreadyReviewed: false };
}

/** List renewal preflights that need operator attention.  A
 *  preflight needs attention if its outcome is non-READY AND it has
 *  not been reviewed yet.  Routine READY preflights are excluded by
 *  design -- they do not need operator intervention. */
export async function listPreflightsAwaitingReview(limit = 50): Promise<Array<{
  id: string;
  billingCycleId: string;
  clubId: string;
  checkpointLabel: string;
  outcome: string | null;
  mandateStillValid: boolean | null;
  renewalPricingDriftDetected: boolean;
  scheduledFor: Date;
  executedAt: Date | null;
  syntheticTestOnly: boolean;
}>> {
  const rows = await prisma.billingRenewalPreflight.findMany({
    where: {
      executedAt: { not: null },
      outcome: { notIn: ["READY"] },
      operatorReviewedAt: null,
    },
    orderBy: { scheduledFor: "asc" },
    take: limit,
    select: {
      id: true, billingCycleId: true, checkpointLabel: true,
      outcome: true, mandateStillValid: true,
      renewalPricingDriftDetected: true, scheduledFor: true, executedAt: true,
      syntheticTestOnly: true, billingCycle: { select: { clubId: true } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    billingCycleId: r.billingCycleId,
    clubId: r.billingCycle?.clubId ?? "",
    checkpointLabel: r.checkpointLabel,
    outcome: r.outcome,
    mandateStillValid: r.mandateStillValid,
    renewalPricingDriftDetected: r.renewalPricingDriftDetected,
    scheduledFor: r.scheduledFor,
    executedAt: r.executedAt,
    syntheticTestOnly: r.syntheticTestOnly,
  }));
}
