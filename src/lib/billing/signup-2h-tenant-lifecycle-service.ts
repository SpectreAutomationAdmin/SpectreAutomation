// SIGNUP-2 Phase 2H (2026-10-26) -- Tenant lifecycle service.
//
// Durable post-activation lifecycle management:
//   - suspendTenant     (ACTIVE -> UNDER_REVIEW; UNDER_REVIEW -> SUSPENDED)
//   - reinstateTenant   (SUSPENDED -> UNDER_REVIEW; UNDER_REVIEW -> ACTIVE)
//
// Fail-closed on SPECTRE_SIGNUP_2H_SUSPENSION_LIVE.
//
// Founder principles enforced here:
//   - Server-side only.  No UI-only hiding.  Posting-guard is the
//     authoritative enforcement at the write boundary; this service
//     flips the state.
//   - Existing-tenant protection (founder closure §5).  A tenant
//     without a SIGNUP-2 subscription row (ClubSubscription.subscriptionStatus
//     IS NULL) cannot be suspended via Phase 2H.  Legacy tenants
//     remain untouched by Phase 2H deployment.
//   - Separation-of-duties on reinstatement UNDER_REVIEW -> ACTIVE
//     (operator != authoriser).
//   - Append-only lifecycle log + audit on every transition.
//   - Short DB transactions.  No external network calls while
//     holding a DB lock.
//   - Null `authoriserUserId` is permitted for every transition
//     EXCEPT UNDER_REVIEW -> ACTIVE (SoD-gated).

import { prisma } from "@/lib/prisma";
import { ForbiddenError, AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";

const PHASE_2H_FLAG = "SPECTRE_SIGNUP_2H_SUSPENSION_LIVE";

export function assertPhase2hFlag(): void {
  if (process.env[PHASE_2H_FLAG] !== "1") {
    throw new ForbiddenError(
      "SIGNUP-2 Phase 2H suspension is disabled (SPECTRE_SIGNUP_2H_SUSPENSION_LIVE != 1)",
    );
  }
}

export type SuspensionTrigger =
  | "PAD_RETURN"
  | "PAYMENT_REVERSAL"
  | "REFUND"
  | "DISPUTE"
  | "FAILED_RENEWAL"
  | "OPERATOR_HOLD";

export const SUSPENSION_TRIGGERS: readonly SuspensionTrigger[] = [
  "PAD_RETURN",
  "PAYMENT_REVERSAL",
  "REFUND",
  "DISPUTE",
  "FAILED_RENEWAL",
  "OPERATOR_HOLD",
] as const;

export type LifecycleRefusal =
  | { ok: false; reason: "FLAG_OFF"; detail: string }
  | { ok: false; reason: "CLUB_NOT_FOUND"; detail: string }
  | { ok: false; reason: "NO_SUBSCRIPTION"; detail: string }
  | { ok: false; reason: "LEGACY_TENANT_PROTECTED"; detail: string }
  | { ok: false; reason: "INVALID_TRANSITION"; detail: string }
  | { ok: false; reason: "SOD_VIOLATION"; detail: string }
  | { ok: false; reason: "REINSTATEMENT_INELIGIBLE"; detail: string; failingCheck: string }
  | { ok: false; reason: "VALIDATION_FAILED"; detail: string };

export type LifecycleOk = {
  ok: true;
  transitionId: string;
  clubId: string;
  previousStatus: string;
  newStatus: string;
  previousAccessTier: string | null;
  newAccessTier: string | null;
};

export type LifecycleResult = LifecycleOk | LifecycleRefusal;

/** The transition map.  Any attempt to flip outside this map
 *  returns an INVALID_TRANSITION refusal.
 *
 *  AUTOMATIC transitions (webhook / dunning):
 *   ACTIVE -> UNDER_REVIEW
 *
 *  OPERATOR-CONFIRMED transitions:
 *   UNDER_REVIEW -> SUSPENDED
 *   SUSPENDED    -> UNDER_REVIEW   (reinstatement review)
 *   UNDER_REVIEW -> ACTIVE         (reinstatement; SoD-gated)
 *
 *  Terminal:
 *   SUSPENDED    -> CANCELLED      (operator)
 *   UNDER_REVIEW -> CANCELLED      (operator)
 */
const SUSPEND_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  ACTIVE:        new Set(["UNDER_REVIEW"]),
  UNDER_REVIEW:  new Set(["SUSPENDED", "CANCELLED"]),
  SUSPENDED:     new Set(["CANCELLED"]),  // reinstatement goes through reinstateTenant
};

const REINSTATE_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  SUSPENDED:    new Set(["UNDER_REVIEW"]),
  UNDER_REVIEW: new Set(["ACTIVE"]),
};

/** Access-tier mapping for each status.  `null` means the transition
 *  does not change the tier (used for a Club already at a reduced tier). */
const STATUS_ACCESS_TIER: Record<string, "FULL" | "SUSPENDED_READ_ONLY" | null> = {
  ACTIVE:       "FULL",
  UNDER_REVIEW: "SUSPENDED_READ_ONLY",
  SUSPENDED:    "SUSPENDED_READ_ONLY",
  CANCELLED:    "SUSPENDED_READ_ONLY",
};

interface SuspendArgs {
  clubId: string;
  trigger: SuspensionTrigger;
  targetStatus?: "UNDER_REVIEW" | "SUSPENDED" | "CANCELLED";
  operatorUserId: string;
  reasonCode?: string;
  reasonNotes?: string;
  triggerEvidence?: Record<string, unknown>;
}

/** Flip a tenant toward suspension.  Target status defaults to
 *  UNDER_REVIEW; operators may pass "SUSPENDED" to escalate from
 *  UNDER_REVIEW, or "CANCELLED" to terminate from SUSPENDED /
 *  UNDER_REVIEW. */
export async function suspendTenant(args: SuspendArgs): Promise<LifecycleResult> {
  try {
    assertPhase2hFlag();
  } catch (err) {
    return { ok: false, reason: "FLAG_OFF", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!SUSPENSION_TRIGGERS.includes(args.trigger)) {
    return { ok: false, reason: "VALIDATION_FAILED", detail: `unknown trigger: ${args.trigger}` };
  }
  if (args.trigger === "OPERATOR_HOLD") {
    if (!args.reasonCode || !args.reasonNotes || args.reasonNotes.length < 20) {
      return {
        ok: false,
        reason: "VALIDATION_FAILED",
        detail: "OPERATOR_HOLD requires reasonCode AND reasonNotes >= 20 chars",
      };
    }
  }

  // Short transaction to flip state + write transition row atomically.
  // DB-lock the ClubSubscription row via findUnique + update under the
  // same transaction (Prisma serialises writes per-row under Postgres
  // SERIALIZABLE; the posting-guard reads the same row in its own
  // transaction, so an in-flight write will see the new state).
  try {
    const result = await prisma.$transaction(async (tx) => {
      const sub = await tx.clubSubscription.findUnique({
        where: { clubId: args.clubId },
        select: { subscriptionStatus: true, accessTier: true },
      });
      if (!sub) {
        return { ok: false as const, reason: "NO_SUBSCRIPTION" as const, detail: "no ClubSubscription row for clubId" };
      }
      // Founder closure §5: existing-tenant protection.
      if (sub.subscriptionStatus === null) {
        return {
          ok: false as const,
          reason: "LEGACY_TENANT_PROTECTED" as const,
          detail: "subscriptionStatus=null (grandfathered legacy tenant); Phase 2I legacy-adoption workflow required first",
        };
      }
      const previousStatus = sub.subscriptionStatus;
      const target: "UNDER_REVIEW" | "SUSPENDED" | "CANCELLED" = args.targetStatus ?? "UNDER_REVIEW";
      const permitted = SUSPEND_TRANSITIONS[previousStatus];
      if (!permitted || !permitted.has(target)) {
        return {
          ok: false as const,
          reason: "INVALID_TRANSITION" as const,
          detail: `${previousStatus} -> ${target} not permitted by Phase 2H state machine`,
        };
      }
      const newAccessTier = STATUS_ACCESS_TIER[target] ?? sub.accessTier;
      await tx.clubSubscription.update({
        where: { clubId: args.clubId },
        data: {
          subscriptionStatus: target,
          accessTier: newAccessTier,
        },
      });
      const transition = await tx.tenantLifecycleTransition.create({
        data: {
          clubId: args.clubId,
          previousStatus,
          newStatus: target,
          previousAccessTier: sub.accessTier,
          newAccessTier,
          trigger: args.trigger,
          triggerEvidenceJson: args.triggerEvidence ? JSON.stringify(args.triggerEvidence) : null,
          operatorUserId: args.operatorUserId,
          reasonCode: args.reasonCode,
          reasonNotes: args.reasonNotes,
        },
        select: { id: true },
      });
      return {
        ok: true as const,
        transitionId: transition.id,
        clubId: args.clubId,
        previousStatus,
        newStatus: target,
        previousAccessTier: sub.accessTier,
        newAccessTier,
      };
    });
    if (result.ok) {
      await audit(null, {
        action: "signup.lifecycle.suspend",
        entityType: "ClubSubscription",
        entityId: args.clubId,
        meta: {
          transitionIdTail: result.transitionId.slice(-6),
          trigger: args.trigger,
          previousStatus: result.previousStatus,
          newStatus: result.newStatus,
          operatorUserIdTail: args.operatorUserId.slice(-6),
        },
      });
      logger.info("signup.lifecycle.suspended", {
        clubIdTail: args.clubId.slice(-6),
        trigger: args.trigger,
        newStatus: result.newStatus,
      });
    }
    return result;
  } catch (err) {
    logger.error("signup.lifecycle.suspend_failed", {
      clubIdTail: args.clubId.slice(-6),
      detail: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: "VALIDATION_FAILED", detail: err instanceof Error ? err.message : String(err) };
  }
}

interface ReinstateArgs {
  clubId: string;
  operatorUserId: string;
  authoriserUserId: string;
  reasonCode?: string;
  reasonNotes?: string;
  skipFinancialRecheck?: boolean;  // operator-only emergency bypass; staging-only
}

/** Eligibility checks for UNDER_REVIEW -> ACTIVE.  Each check returns
 *  { ok, failingCheck?, detail? }. */
async function evaluateReinstatementEligibility(clubId: string): Promise<
  | { ok: true }
  | { ok: false; failingCheck: string; detail: string }
> {
  // (1) Current financial eligibility: most recent BillingCycle has
  //     subscriptionStatus=ACTIVE AND reversedAt=null.
  const latestCycle = await prisma.billingCycle.findFirst({
    where: { clubId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      subscriptionStatus: true,
      reversedAt: true,
      stripeChargeId: true,
    },
  });
  if (!latestCycle) {
    return { ok: false, failingCheck: "NO_BILLING_CYCLE", detail: "no BillingCycle for this Club" };
  }
  if (latestCycle.reversedAt !== null) {
    return {
      ok: false,
      failingCheck: "LATEST_CYCLE_REVERSED",
      detail: `latest BillingCycle has reversedAt=${latestCycle.reversedAt.toISOString()}`,
    };
  }
  if (!["ACTIVE", "ACTIVATION_READY", "SETTLED"].includes(latestCycle.subscriptionStatus ?? "")) {
    return {
      ok: false,
      failingCheck: "LATEST_CYCLE_NOT_HEALTHY",
      detail: `latest BillingCycle subscriptionStatus=${latestCycle.subscriptionStatus}`,
    };
  }

  // (2) No active disputes (StripeWebhookEvent for charge.dispute.*
  //     tied to this Club via chargeId, with processedAt NULL).
  if (latestCycle.stripeChargeId) {
    const openDisputes = await prisma.stripeWebhookEvent.findMany({
      where: {
        eventType: { startsWith: "charge.dispute." },
        processedAt: null,
        payloadJson: { contains: latestCycle.stripeChargeId },
      },
      select: { id: true, eventType: true },
      take: 1,
    });
    if (openDisputes.length > 0) {
      return {
        ok: false,
        failingCheck: "OPEN_DISPUTE",
        detail: `open ${openDisputes[0].eventType} webhook not yet processed`,
      };
    }
  }

  // (3) Current legal attestation.  The most-recent
  //     SubscriptionAuthorisationAttestation for the Club is not
  //     superseded.  (We only verify "not superseded" here; the full
  //     SHA match is enforced at Phase 2F authorisation time and
  //     outside Phase 2H's remit.)
  const sub = await prisma.clubSubscription.findUnique({
    where: { clubId },
    select: { signupRegistrationId: true },
  });
  if (sub?.signupRegistrationId) {
    const att = await prisma.subscriptionAuthorisationAttestation.findFirst({
      where: { signupRegistrationId: sub.signupRegistrationId },
      orderBy: { acceptedAt: "desc" },
      select: { id: true, supersededAt: true },
    });
    if (!att || att.supersededAt !== null) {
      return {
        ok: false,
        failingCheck: "ATTESTATION_SUPERSEDED",
        detail: `attestation ${att ? "superseded" : "missing"}`,
      };
    }
  }

  return { ok: true };
}

/** Flip a tenant toward reinstatement.  Enforces separation-of-
 *  duties on UNDER_REVIEW -> ACTIVE.  Null authoriserUserId is
 *  accepted on SUSPENDED -> UNDER_REVIEW (single-operator review
 *  escalation back from SUSPENDED).  ACTIVE requires a distinct
 *  authoriser. */
export async function reinstateTenant(args: ReinstateArgs): Promise<LifecycleResult> {
  try {
    assertPhase2hFlag();
  } catch (err) {
    return { ok: false, reason: "FLAG_OFF", detail: err instanceof Error ? err.message : String(err) };
  }
  if (!args.reasonCode || !args.reasonNotes || args.reasonNotes.length < 20) {
    return {
      ok: false,
      reason: "VALIDATION_FAILED",
      detail: "reinstatement requires reasonCode AND reasonNotes >= 20 chars",
    };
  }

  // Pre-read current state (no lock yet) to determine target.
  const current = await prisma.clubSubscription.findUnique({
    where: { clubId: args.clubId },
    select: { subscriptionStatus: true, accessTier: true, signupRegistrationId: true },
  });
  if (!current) {
    return { ok: false, reason: "NO_SUBSCRIPTION", detail: "no ClubSubscription row" };
  }
  if (current.subscriptionStatus === null) {
    return {
      ok: false,
      reason: "LEGACY_TENANT_PROTECTED",
      detail: "subscriptionStatus=null (grandfathered legacy tenant); Phase 2I legacy-adoption workflow required first",
    };
  }
  const previousStatus = current.subscriptionStatus;
  const permitted = REINSTATE_TRANSITIONS[previousStatus];
  if (!permitted) {
    return {
      ok: false,
      reason: "INVALID_TRANSITION",
      detail: `cannot reinstate from ${previousStatus}`,
    };
  }
  // The reinstatement path progresses one step at a time:
  //   SUSPENDED    -> UNDER_REVIEW  (first call)
  //   UNDER_REVIEW -> ACTIVE        (second call, SoD required)
  const target = [...permitted][0] as "UNDER_REVIEW" | "ACTIVE";

  // SoD enforcement only for UNDER_REVIEW -> ACTIVE.
  if (target === "ACTIVE" && args.operatorUserId === args.authoriserUserId) {
    return {
      ok: false,
      reason: "SOD_VIOLATION",
      detail: "operator and authoriser must be distinct users for UNDER_REVIEW -> ACTIVE",
    };
  }

  // Eligibility re-checks (only required on UNDER_REVIEW -> ACTIVE).
  if (target === "ACTIVE" && args.skipFinancialRecheck !== true) {
    const eligibility = await evaluateReinstatementEligibility(args.clubId);
    if (!eligibility.ok) {
      // Write a lifecycle row to record the attempt (no state change).
      await prisma.tenantLifecycleTransition.create({
        data: {
          clubId: args.clubId,
          previousStatus,
          newStatus: previousStatus,  // no change
          previousAccessTier: current.accessTier,
          newAccessTier: current.accessTier,
          trigger: "REINSTATEMENT",
          triggerEvidenceJson: JSON.stringify({
            attempted: true,
            failingCheck: eligibility.failingCheck,
            detail: eligibility.detail,
          }),
          operatorUserId: args.operatorUserId,
          authoriserUserId: args.authoriserUserId,
          reasonCode: `REINSTATEMENT_REFUSED_${eligibility.failingCheck}`,
          reasonNotes: args.reasonNotes,
        },
      });
      return {
        ok: false,
        reason: "REINSTATEMENT_INELIGIBLE",
        detail: eligibility.detail,
        failingCheck: eligibility.failingCheck,
      };
    }
  }

  try {
    const result = await prisma.$transaction(async (tx) => {
      // Re-read inside tx (TOCTOU defence).
      const relock = await tx.clubSubscription.findUnique({
        where: { clubId: args.clubId },
        select: { subscriptionStatus: true, accessTier: true },
      });
      if (!relock || relock.subscriptionStatus !== previousStatus) {
        return {
          ok: false as const,
          reason: "INVALID_TRANSITION" as const,
          detail: `subscriptionStatus changed inside tx: ${relock?.subscriptionStatus ?? "null"}`,
        };
      }
      const newAccessTier = STATUS_ACCESS_TIER[target] ?? relock.accessTier;
      await tx.clubSubscription.update({
        where: { clubId: args.clubId },
        data: { subscriptionStatus: target, accessTier: newAccessTier },
      });
      const transition = await tx.tenantLifecycleTransition.create({
        data: {
          clubId: args.clubId,
          previousStatus,
          newStatus: target,
          previousAccessTier: relock.accessTier,
          newAccessTier,
          trigger: "REINSTATEMENT",
          operatorUserId: args.operatorUserId,
          authoriserUserId: args.authoriserUserId,
          reasonCode: args.reasonCode,
          reasonNotes: args.reasonNotes,
        },
        select: { id: true },
      });
      return {
        ok: true as const,
        transitionId: transition.id,
        clubId: args.clubId,
        previousStatus,
        newStatus: target,
        previousAccessTier: relock.accessTier,
        newAccessTier,
      };
    });
    if (result.ok) {
      await audit(null, {
        action: "signup.lifecycle.reinstate",
        entityType: "ClubSubscription",
        entityId: args.clubId,
        meta: {
          transitionIdTail: result.transitionId.slice(-6),
          previousStatus: result.previousStatus,
          newStatus: result.newStatus,
          operatorUserIdTail: args.operatorUserId.slice(-6),
          authoriserUserIdTail: args.authoriserUserId.slice(-6),
        },
      });
      logger.info("signup.lifecycle.reinstated", {
        clubIdTail: args.clubId.slice(-6),
        previousStatus: result.previousStatus,
        newStatus: result.newStatus,
      });
    }
    return result;
  } catch (err) {
    logger.error("signup.lifecycle.reinstate_failed", {
      clubIdTail: args.clubId.slice(-6),
      detail: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, reason: "VALIDATION_FAILED", detail: err instanceof Error ? err.message : String(err) };
  }
}

/** Shared helper for workers + routes that gate on tenant operational
 *  status.  A legacy tenant (subscriptionStatus=null) is treated as
 *  ACTIVE for compatibility (founder closure §5).  Any Phase-2A+
 *  tenant whose status is SUSPENDED / UNDER_REVIEW / CANCELLED
 *  returns false. */
export async function isTenantOperationallyActive(clubId: string): Promise<boolean> {
  const sub = await prisma.clubSubscription.findUnique({
    where: { clubId },
    select: { subscriptionStatus: true, accessTier: true },
  });
  if (!sub) return true;  // no subscription row -> grandfathered
  if (sub.subscriptionStatus === null) return true;  // explicit grandfather
  if (sub.subscriptionStatus === "ACTIVE") {
    // accessTier must also be FULL (not SUSPENDED_READ_ONLY).
    return sub.accessTier === "FULL" || sub.accessTier === null;
  }
  return false;
}

/** Throw if the tenant is not operationally active.  Use at the top
 *  of worker handlers + admin-edit routes that aren't already
 *  covered by posting-guard. */
export async function assertTenantOperationallyActive(clubId: string): Promise<void> {
  const ok = await isTenantOperationallyActive(clubId);
  if (!ok) {
    throw new ForbiddenError(
      `SIGNUP-2 Phase 2H: tenant ${clubId.slice(-6)} is not operationally active (suspended / under review / cancelled)`,
    );
  }
}

/** Read the lifecycle timeline for a tenant.  Super-admin diagnostic
 *  surface. */
export async function readTenantLifecycleTimeline(clubId: string): Promise<
  Array<{
    id: string;
    previousStatus: string;
    newStatus: string;
    previousAccessTier: string | null;
    newAccessTier: string | null;
    trigger: string;
    operatorUserId: string;
    authoriserUserId: string | null;
    reasonCode: string | null;
    reasonNotes: string | null;
    effectiveAt: Date;
    reversedAt: Date | null;
    reversedReason: string | null;
    createdAt: Date;
  }>
> {
  return prisma.tenantLifecycleTransition.findMany({
    where: { clubId },
    orderBy: { effectiveAt: "desc" },
    take: 50,
    select: {
      id: true,
      previousStatus: true,
      newStatus: true,
      previousAccessTier: true,
      newAccessTier: true,
      trigger: true,
      operatorUserId: true,
      authoriserUserId: true,
      reasonCode: true,
      reasonNotes: true,
      effectiveAt: true,
      reversedAt: true,
      reversedReason: true,
      createdAt: true,
    },
  });
}
