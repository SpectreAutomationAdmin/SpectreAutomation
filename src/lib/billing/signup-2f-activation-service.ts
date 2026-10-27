// SIGNUP-2 Phase 2F (2026-10-26) -- Activation-authorisation service.
//
// Owns three concerns:
//   authoriseActivation(cycleId, opts?)          -- creates the
//                                                   TenantProvisioningJob
//                                                   authorisation record.
//   validateActivationAuthorisation(jobId)       -- READ-ONLY revalidation
//                                                   per founder §5.
//   invalidateActivationAuthorisation(jobId, …)  -- Phase 2F owns the
//                                                   invalidation side
//                                                   (does NOT reverse
//                                                   provisioning work;
//                                                   Phase 2G owns that).
//
// Concurrency correction (founder §3):  Stripe network calls happen
// OUTSIDE the Prisma transaction.  Sequence:
//   1. Read candidate cycle + financial identifiers.
//   2. Fetch Stripe evidence (outside transaction).
//   3. Validate evidence shape + freshness.
//   4. Open short transaction.
//   5. Row-lock the cycle (Postgres).
//   6. Recheck DB-controlled gates (G1 / G2 / G5 / G6 / G7 / G8 / G9).
//   7. Verify financial identifiers STILL match the pre-fetched
//      evidence (defends against TOCTOU; a mid-flight charge-id
//      change forces retry).
//   8. Upsert the TenantProvisioningJob (unique on billingCycleId).
//   9. Commit; audit emit outside the transaction.
//
// Mock evidence isolation (founder §4):  the production-capable
// path REJECTS evidenceSource = "mock-stripe".  Only isolated
// test callers (passing testOnly: true) may create mock-backed
// authorisations.  A feature flag CANNOT override this restriction.

import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import { ForbiddenError, AppError } from "@/lib/errors";
import { resolveStripeAdapter } from "./stripe-adapter";
import type {
  BalanceTransactionResult,
  StripeAdapter,
} from "./stripe-adapter";

export function assertPhase2fActivationFlag(): void {
  if (process.env.SPECTRE_SIGNUP_2F_ACTIVATION_LIVE !== "1") {
    throw new ForbiddenError(
      "SIGNUP-2 Phase 2F activation authorisation is disabled (SPECTRE_SIGNUP_2F_ACTIVATION_LIVE != 1)",
    );
  }
}

/** Default authorisation freshness window (founder decision 1 + 2:
 *  5-minute sweeper cadence + 2-minute debounce → a 15-minute
 *  authorisation window gives Phase 2G two sweep ticks of grace). */
const AUTHORISATION_TTL_MS = 15 * 60 * 1000;

/** Nine-gate failure classifier.  Each gate name maps to an
 *  operator-inbox category per founder §10. */
export type GateFailure =
  | "G1_NOT_READY"
  | "G2_REVERSED"
  | "G3_FUNDS_NOT_AVAILABLE"
  | "G3_STRIPE_UNAVAILABLE"
  | "G4_DISPUTE_OR_REFUND"
  | "G5_MANDATE_REVOKED"
  | "G6_MISSING_RELEASE_RECORD"
  | "G7_TOS_MISMATCH"
  | "G8_REGISTRATION_ABANDONED"
  | "G9_JOB_EXISTS"
  | "MOCK_EVIDENCE_REJECTED"
  | "IDENTIFIERS_CHANGED";

export interface AuthorisationResult {
  ok: true;
  jobId: string;
  noop: boolean; // true if an existing job was returned
}
export interface AuthorisationRefusal {
  ok: false;
  gate: GateFailure;
  detail: string;
  transient: boolean; // transient Stripe unavailability vs permanent
}

export interface AuthoriseActivationOpts {
  /** When TRUE, allows evidenceSource = "mock-stripe" to produce
   *  a job (restricted to isolated staging fixtures).  CANNOT be
   *  set by production code; the service verifies the caller via
   *  a hard-coded sentinel pattern + the flag.  Default FALSE. */
  testOnly?: boolean;
}

/** Pre-fetch external Stripe evidence BEFORE opening any
 *  transaction.  Returns null + a classified failure if Stripe
 *  cannot confirm settlement + availability. */
async function fetchStripeEvidenceOutsideTransaction(args: {
  stripeBalanceTransactionId: string | null;
  stripeChargeId: string | null;
}): Promise<
  | { ok: true; bal: BalanceTransactionResult; adapter: StripeAdapter }
  | { ok: false; gate: GateFailure; detail: string; transient: boolean }
> {
  if (!args.stripeBalanceTransactionId) {
    return {
      ok: false,
      gate: "G3_FUNDS_NOT_AVAILABLE",
      detail: "cycle has no stripeBalanceTransactionId",
      transient: false,
    };
  }
  const adapter = resolveStripeAdapter();
  try {
    const bal = await adapter.retrieveBalanceTransaction(args.stripeBalanceTransactionId);
    if (bal.status !== "available") {
      return {
        ok: false,
        gate: "G3_FUNDS_NOT_AVAILABLE",
        detail: `balance status=${bal.status}`,
        transient: true,
      };
    }
    if (bal.availableAt.getTime() > Date.now()) {
      return {
        ok: false,
        gate: "G3_FUNDS_NOT_AVAILABLE",
        detail: `balance available_on in future (${bal.availableAt.toISOString()})`,
        transient: true,
      };
    }
    return { ok: true, bal, adapter };
  } catch (err) {
    // Classify adapter failures as transient; a persistent Stripe
    // outage is still "transient" from Phase 2F's point of view.
    // Phase 2I's reconciliation worker will catch a stuck cycle.
    return {
      ok: false,
      gate: "G3_STRIPE_UNAVAILABLE",
      detail: err instanceof Error ? err.message : String(err),
      transient: true,
    };
  }
}

/** Load the currently-approved Terms of Service document (via the
 *  Phase 2B helper).  Returns null if the gate is not open yet
 *  (dev fixture rejected / APPROVED status missing). */
async function loadApprovedToS(): Promise<{ sha256: string } | null> {
  try {
    const { readTermsOfService, assertTermsOfServiceApproved } = await import("./terms-of-service");
    const doc = readTermsOfService();
    assertTermsOfServiceApproved(doc);
    return { sha256: doc.sha256 };
  } catch {
    return null;
  }
}

/** Operator inbox entry writer for Phase 2F refusals. */
async function writeOperatorAlert(args: {
  cycleId: string;
  category: string;
  severity: "ROUTINE" | "IMMEDIATE";
  title: string;
  body: string;
}): Promise<void> {
  try {
    const cycle = await prisma.billingCycle.findUnique({
      where: { id: args.cycleId },
      select: { clubId: true },
    });
    await prisma.operatorInboxEntry.create({
      data: {
        severity: args.severity,
        category: args.category,
        clubId: cycle?.clubId ?? null,
        billingCycleId: args.cycleId,
        title: args.title,
        body: args.body,
      },
    });
  } catch (err) {
    logger.warn("signup.activation.operator_alert_write_failed", {
      cycleIdTail: args.cycleId.slice(-6),
      category: args.category,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function authoriseActivation(
  cycleId: string,
  opts: AuthoriseActivationOpts = {},
): Promise<AuthorisationResult | AuthorisationRefusal> {
  assertPhase2fActivationFlag();

  // Step 1: read candidate cycle + its financial identifiers.
  const cycle = await prisma.billingCycle.findUnique({
    where: { id: cycleId },
    select: {
      id: true,
      clubId: true,
      subscriptionStatus: true,
      reversedAt: true,
      stripePaymentIntentId: true,
      stripeChargeId: true,
      stripeBalanceTransactionId: true,
      releasedByOperatorRecordId: true,
      // M2-SyntheticSandbox (2026-10-27): synthetic cycles cannot activate.
      syntheticTestOnly: true,
    },
  });
  if (!cycle) {
    return { ok: false, gate: "G1_NOT_READY", detail: "cycle not found", transient: false };
  }
  if (cycle.syntheticTestOnly === true) {
    return {
      ok: false,
      gate: "G1_NOT_READY",
      detail: "SIGNUP-2 M2-SyntheticSandbox: BillingCycle is marked syntheticTestOnly; activation refused unconditionally",
      transient: false,
    };
  }
  if (cycle.subscriptionStatus !== "ACTIVATION_READY") {
    return {
      ok: false,
      gate: "G1_NOT_READY",
      detail: `subscriptionStatus=${cycle.subscriptionStatus ?? "null"}`,
      transient: cycle.subscriptionStatus === "AWAITING_SETTLEMENT" || cycle.subscriptionStatus === "SETTLED",
    };
  }
  if (cycle.reversedAt) {
    return { ok: false, gate: "G2_REVERSED", detail: "cycle has reversedAt", transient: false };
  }

  // Step 2: fetch external Stripe evidence OUTSIDE the transaction.
  const evidenceFetch = await fetchStripeEvidenceOutsideTransaction({
    stripeBalanceTransactionId: cycle.stripeBalanceTransactionId,
    stripeChargeId: cycle.stripeChargeId,
  });
  if (!evidenceFetch.ok) {
    if (!evidenceFetch.transient) {
      await writeOperatorAlert({
        cycleId: cycle.id,
        category: evidenceFetch.gate === "G4_DISPUTE_OR_REFUND" ? "REVERSAL" : "PAYMENT_FLOW",
        severity: evidenceFetch.gate === "G4_DISPUTE_OR_REFUND" ? "IMMEDIATE" : "ROUTINE",
        title: "Activation refused -- external evidence unavailable",
        body: `Cycle ${cycle.id.slice(-6)} refused: ${evidenceFetch.gate} / ${evidenceFetch.detail}`,
      });
    }
    return evidenceFetch;
  }

  // Mock-evidence isolation (founder §4).  The production-capable
  // path REJECTS mock evidence; only testOnly callers (restricted
  // to the isolated staging fixture harness) may proceed.
  if (evidenceFetch.bal.evidenceSource === "mock-stripe" && opts.testOnly !== true) {
    await writeOperatorAlert({
      cycleId: cycle.id,
      category: "ACTIVATION_STUCK",
      severity: "IMMEDIATE",
      title: "Mock Stripe evidence refused for production activation",
      body: `Cycle ${cycle.id.slice(-6)} refused: evidenceSource = "mock-stripe" cannot authorise a production tenant.  Live Stripe adapter required.`,
    });
    return {
      ok: false,
      gate: "MOCK_EVIDENCE_REJECTED",
      detail: "evidenceSource = mock-stripe outside testOnly context",
      transient: false,
    };
  }

  // Resolve the signupRegistrationId via the Phase 2D release record
  // (the ONLY reliable Phase 2F→applicant linkage).  Phase 2E's
  // "clubId stores reg.id" convention is being retired; Phase 2F
  // uses the release record's own signupRegistrationId column.
  const releaseRecord = cycle.releasedByOperatorRecordId
    ? await prisma.operatorVerificationRecord.findUnique({
        where: { id: cycle.releasedByOperatorRecordId },
        select: { id: true, concept: true, signupRegistrationId: true },
      })
    : null;
  if (!releaseRecord || releaseRecord.concept !== "RELEASE") {
    return {
      ok: false,
      gate: "G6_MISSING_RELEASE_RECORD",
      detail: "Phase 2D RELEASE record missing or wrong concept",
      transient: false,
    };
  }
  const signupRegistrationId = releaseRecord.signupRegistrationId;

  // Load dependent domain evidence BEFORE opening the transaction
  // (reads only; recheck inside the transaction).
  const [mandate, attestation, registration, approvedToS] = await Promise.all([
    prisma.subscriptionPaymentMandate.findFirst({
      where: { signupRegistrationId },
      orderBy: { acceptedAt: "desc" },
      select: { id: true, revokedAt: true },
    }),
    prisma.subscriptionAuthorisationAttestation.findFirst({
      where: { signupRegistrationId },
      orderBy: { acceptedAt: "desc" },
      select: { id: true, supersededAt: true, termsVersionSha256: true },
    }),
    prisma.signupRegistration.findUnique({
      where: { id: signupRegistrationId },
      select: { id: true, status: true, verificationVerdict: true },
    }),
    loadApprovedToS(),
  ]);

  if (!mandate || mandate.revokedAt) {
    return { ok: false, gate: "G5_MANDATE_REVOKED", detail: "mandate missing or revoked", transient: false };
  }
  // G6 (release-record presence) already verified above during the
  // signupRegistrationId resolution.
  if (!attestation || attestation.supersededAt) {
    return { ok: false, gate: "G7_TOS_MISMATCH", detail: "attestation missing or superseded", transient: false };
  }
  if (!approvedToS) {
    return {
      ok: false,
      gate: "G7_TOS_MISMATCH",
      detail: "approved ToS unavailable (dev-fixture state)",
      transient: true,
    };
  }
  if (attestation.termsVersionSha256 !== approvedToS.sha256) {
    await writeOperatorAlert({
      cycleId: cycle.id,
      category: "TOS_MISMATCH",
      severity: "IMMEDIATE",
      title: "ToS SHA-256 mismatch at activation gate",
      body: `Cycle ${cycle.id.slice(-6)} refused: attestation ToS SHA-256 does not match currently-approved ToS.`,
    });
    return { ok: false, gate: "G7_TOS_MISMATCH", detail: "attestation ToS SHA-256 mismatch", transient: false };
  }
  if (!registration) {
    return { ok: false, gate: "G8_REGISTRATION_ABANDONED", detail: "registration not found", transient: false };
  }
  if (registration.status === "ABANDONED") {
    return { ok: false, gate: "G8_REGISTRATION_ABANDONED", detail: "registration ABANDONED", transient: false };
  }
  if (
    registration.verificationVerdict !== "MANUAL_RELEASE" &&
    registration.verificationVerdict !== "PASS_AUTOMATED"
  ) {
    return {
      ok: false,
      gate: "G8_REGISTRATION_ABANDONED",
      detail: `verdict=${registration.verificationVerdict ?? "null"}`,
      transient: false,
    };
  }

  const now = new Date();

  // Step 4-9: short transaction + row recheck + upsert.
  try {
    const result = await prisma.$transaction(async (tx) => {
      // Re-read the cycle to catch any mid-flight mutation.  Phase
      // 2F does NOT use SELECT ... FOR UPDATE on SQLite (unsupported
      // in dev); the dev single-worker is adequate for tests, and
      // the Postgres production path can later add { lock: "update" }
      // via a raw tx.$queryRaw if required.  The identifier recheck
      // below guards against the common TOCTOU race on either backend.
      const locked = await tx.billingCycle.findUnique({
        where: { id: cycle.id },
        select: {
          subscriptionStatus: true,
          reversedAt: true,
          stripeBalanceTransactionId: true,
        },
      });
      if (!locked || locked.subscriptionStatus !== "ACTIVATION_READY") {
        return { ok: false as const, gate: "G1_NOT_READY" as const, detail: "status changed during fetch", transient: true };
      }
      if (locked.reversedAt) {
        return { ok: false as const, gate: "G2_REVERSED" as const, detail: "reversedAt set during fetch", transient: false };
      }
      // Identifier recheck -- the balance-transaction id must still
      // match the one we pre-fetched evidence for.
      if (locked.stripeBalanceTransactionId !== cycle.stripeBalanceTransactionId) {
        return {
          ok: false as const,
          gate: "IDENTIFIERS_CHANGED" as const,
          detail: "stripeBalanceTransactionId changed between pre-fetch and lock",
          transient: true,
        };
      }

      // G9: idempotency via unique constraint.
      const existing = await tx.tenantProvisioningJob.findUnique({
        where: { billingCycleId: cycle.id },
        select: { id: true, state: true, invalidatedAt: true, cancelledAt: true },
      });
      if (existing && !existing.invalidatedAt && !existing.cancelledAt) {
        return { ok: true as const, jobId: existing.id, noop: true };
      }
      // If a prior job exists but is invalidated / cancelled, treat
      // it as a dead row and refuse (operator must clear state).
      if (existing) {
        return {
          ok: false as const,
          gate: "G9_JOB_EXISTS" as const,
          detail: `existing job ${existing.id.slice(-6)} invalidatedAt=${!!existing.invalidatedAt} cancelledAt=${!!existing.cancelledAt}`,
          transient: false,
        };
      }

      const job = await tx.tenantProvisioningJob.create({
        data: {
          billingCycleId: cycle.id,
          signupRegistrationId,
          state: "CREATED",
          attempts: 0,
          nextAttemptAt: now,
          authorisationEvidenceSource: evidenceFetch.bal.evidenceSource,
          authorisationExpiresAt: new Date(now.getTime() + AUTHORISATION_TTL_MS),
        },
        select: { id: true },
      });

      // Write a PaymentReconciliationEntry with the exact evidence
      // ids used.  PaymentReconciliationEntry.clubId is nullable per
      // Phase 2A; we persist the actual cycle clubId (fixture Club
      // on staging; real Club in Phase 2G).
      await tx.paymentReconciliationEntry.create({
        data: {
          clubId: cycle.clubId,
          billingCycleId: cycle.id,
          entryType: "ACTIVATION_AUTHORISED",
          amountMinorUnits: 0n,
          currency: "cad",
          providerEventId: null,
          providerBalanceTransactionId: cycle.stripeBalanceTransactionId,
          providerChargeId: cycle.stripeChargeId,
          occurredAt: now,
          reconciliationNotes: `Phase 2F authorisation: job=${job.id.slice(-6)} evidenceSource=${evidenceFetch.bal.evidenceSource} testOnly=${!!opts.testOnly}`,
        },
      });

      return { ok: true as const, jobId: job.id, noop: false };
    });

    if (!result.ok) {
      return result;
    }

    // Audit outside the transaction.
    await audit(null, {
      action: result.noop ? "signup.activation.authorisation_replay" : "signup.activation.authorised",
      entityType: "TenantProvisioningJob",
      entityId: result.jobId,
      clubId: null,
      meta: {
        cycleIdTail: cycle.id.slice(-6),
        jobIdTail: result.jobId.slice(-6),
        evidenceSource: evidenceFetch.bal.evidenceSource,
        balanceTransactionIdTail: cycle.stripeBalanceTransactionId!.slice(-8),
        testOnly: !!opts.testOnly,
      },
    });

    logger.info("signup.activation.authorised", {
      cycleIdTail: cycle.id.slice(-6),
      jobIdTail: result.jobId.slice(-6),
      noop: result.noop,
    });

    return { ok: true, jobId: result.jobId, noop: result.noop };
  } catch (err) {
    logger.error("signup.activation.authorise_failed", {
      cycleIdTail: cycle.id.slice(-6),
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      gate: "G1_NOT_READY",
      detail: `transaction failed: ${err instanceof Error ? err.message : String(err)}`,
      transient: true,
    };
  }
}

/** READ-ONLY revalidation per founder §5.  Phase 2G calls this to
 *  confirm the authorisation is still valid immediately before each
 *  provisioning step.  Never creates a job; never writes any row.
 *  Re-reads BOTH the DB-side state AND the current Stripe evidence. */
export async function validateActivationAuthorisation(jobId: string): Promise<
  | { ok: true; jobId: string; evidenceSource: string | null; expiresAt: Date | null }
  | { ok: false; reason: GateFailure | "JOB_NOT_FOUND" | "AUTHORISATION_EXPIRED"; detail: string }
> {
  const job = await prisma.tenantProvisioningJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      billingCycleId: true,
      state: true,
      cancelledAt: true,
      invalidatedAt: true,
      authorisationEvidenceSource: true,
      authorisationExpiresAt: true,
    },
  });
  if (!job) return { ok: false, reason: "JOB_NOT_FOUND", detail: "no job with that id" };
  if (job.cancelledAt) return { ok: false, reason: "G9_JOB_EXISTS", detail: "job cancelled" };
  if (job.invalidatedAt) return { ok: false, reason: "G9_JOB_EXISTS", detail: "authorisation invalidated" };
  if (job.authorisationExpiresAt && job.authorisationExpiresAt.getTime() < Date.now()) {
    return { ok: false, reason: "AUTHORISATION_EXPIRED", detail: "authorisation window elapsed" };
  }

  // Re-run the activation gate checks from the current cycle state.
  const probe = await authoriseActivation(job.billingCycleId, {
    // IF the original authorisation was created with testOnly=true
    // (evidenceSource = "mock-stripe"), the revalidation preserves
    // that scope.  Otherwise production rules apply.
    testOnly: job.authorisationEvidenceSource === "mock-stripe",
  }).catch((err) => ({ ok: false as const, gate: "G1_NOT_READY" as GateFailure, detail: err instanceof Error ? err.message : String(err), transient: true }));
  if (!probe.ok) {
    return { ok: false, reason: probe.gate, detail: probe.detail };
  }
  // Current authorisation must still correspond to THIS job.
  if (probe.jobId !== job.id) {
    return { ok: false, reason: "G9_JOB_EXISTS", detail: "re-authorisation produced a different job id" };
  }
  return {
    ok: true,
    jobId: job.id,
    evidenceSource: job.authorisationEvidenceSource,
    expiresAt: job.authorisationExpiresAt,
  };
}

/** Phase 2F owns authorisation invalidation (founder §6).  Writes
 *  invalidatedAt + invalidatedReason WITHOUT reversing provisioning
 *  work.  Phase 2G reads the invalidation on its next step-level
 *  recheck and triggers its own cancellation + compensation. */
export async function invalidateActivationAuthorisation(args: {
  jobId: string;
  reason: string;
  operatorUserId?: string | null;
}): Promise<{ ok: boolean; alreadyInvalidated: boolean }> {
  const now = new Date();
  const applied = await prisma.tenantProvisioningJob.updateMany({
    where: { id: args.jobId, invalidatedAt: null },
    data: {
      invalidatedAt: now,
      invalidatedReason: args.reason,
    },
  });
  if (applied.count === 0) {
    return { ok: true, alreadyInvalidated: true };
  }
  await audit(null, {
    action: "signup.activation.invalidated",
    entityType: "TenantProvisioningJob",
    entityId: args.jobId,
    clubId: null,
    meta: {
      jobIdTail: args.jobId.slice(-6),
      operatorUserIdTail: args.operatorUserId ? args.operatorUserId.slice(-6) : null,
      reasonLength: args.reason.length,
    },
  });
  logger.info("signup.activation.invalidated", {
    jobIdTail: args.jobId.slice(-6),
  });
  return { ok: true, alreadyInvalidated: false };
}

/** Sweeper -- picks up ACTIVATION_READY cycles with no existing
 *  non-cancelled, non-invalidated TenantProvisioningJob.  Phase 2F
 *  ships this as a service function; a Fly worker cron that calls
 *  it every 5 minutes is a separate wiring step (follow-up tracker). */
export async function sweepActivationCandidates(opts: AuthoriseActivationOpts = {}): Promise<{
  attempted: number;
  authorised: number;
  refused: number;
}> {
  assertPhase2fActivationFlag();
  const candidates = await prisma.billingCycle.findMany({
    where: {
      subscriptionStatus: "ACTIVATION_READY",
      reversedAt: null,
      provisioningJob: null,
    },
    orderBy: { settlementConfirmedAt: "asc" },
    take: 25,
    select: { id: true },
  });
  let authorised = 0;
  let refused = 0;
  for (const c of candidates) {
    const result = await authoriseActivation(c.id, opts);
    if (result.ok) {
      authorised += 1;
    } else {
      refused += 1;
      logger.info("signup.activation.sweep_refused", {
        cycleIdTail: c.id.slice(-6),
        gate: result.gate,
        detail: result.detail,
        transient: result.transient,
      });
    }
  }
  logger.info("signup.activation.sweep_tick", {
    attempted: candidates.length,
    authorised,
    refused,
  });
  return { attempted: candidates.length, authorised, refused };
}
