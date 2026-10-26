// SIGNUP-2 Phase 2G (2026-10-26) -- Durable tenant provisioning.
//
// Consumes Phase 2F's `TenantProvisioningJob(state=CREATED)` row + walks
// the 9-step state machine defined in Phase 2A
// (tenant-provisioning-workflow.ts).  Each step:
//   1. Is preceded by a revalidation of the Phase 2F authorisation
//      (`validateActivationAuthorisation`).  Any non-ok outcome
//      cancels the job -- it does NOT retry.
//   2. Is idempotent on its anchor column.
//   3. Runs under a short `prisma.$transaction` where the write is
//      domain-level sensitive.
//   4. Writes an `audit()` row with tails only.
//
// The final `WELCOME_EMAIL_SENT -> COMPLETED` transition is executed
// in a SINGLE transaction that:
//   - Row-locks BillingCycle (Postgres `FOR UPDATE`).
//   - Row-locks TenantProvisioningJob.
//   - Re-runs validateActivationAuthorisation INSIDE the locks.
//   - Flips ClubSubscription.subscriptionStatus = ACTIVE +
//     accessTier = FULL + TenantProvisioningJob.state = COMPLETED.
//   - Writes one PaymentReconciliationEntry
//     (entryType = ACTIVATION_COMPLETED).
//
// Mock-isolation (founder §4): Phase 2G independently refuses to
// provision a job whose `authorisationEvidenceSource = "mock-stripe"`
// unless the staging-only env var
// `SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING = "1"` is set.  This
// check is independent of Phase 2F's gate; both must fail open
// simultaneously (impossible on production) for a mock job to
// provision.
//
// Collision policy (founder §3 + §4): Phase 2G REFUSES on any Club
// slug collision + any email collision.  There is no automatic
// Club reuse and no automatic User reuse.  The platform-admin
// surface for operator-driven collision remediation lives in the
// future Phase 2H slice.

import { prisma } from "@/lib/prisma";
import { ForbiddenError, AppError } from "@/lib/errors";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import { validateActivationAuthorisation } from "./signup-2f-activation-service";
import {
  advanceOneStep,
  FORWARD_SEQUENCE,
  PROVISIONING_TERMINAL_STATES,
  type ProvisioningState,
  type StepHandler,
  type StepHandlerContext,
} from "./tenant-provisioning-workflow";

const PHASE_2G_FLAG = "SPECTRE_SIGNUP_2G_PROVISIONING_LIVE";
const PHASE_2G_TESTONLY_ENV = "SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING";

/** Fail-closed Phase 2G activation flag.  Default OFF. */
export function assertPhase2gFlag(): void {
  if (process.env[PHASE_2G_FLAG] !== "1") {
    throw new ForbiddenError(
      "SIGNUP-2 Phase 2G provisioning is disabled (SPECTRE_SIGNUP_2G_PROVISIONING_LIVE != 1)",
    );
  }
}

/** Phase 2G mock-isolation gate.  Independent of Phase 2F; both
 *  Phase 2F AND Phase 2G must fail open simultaneously for a
 *  mock-backed job to reach the provisioning path.  Production
 *  containers never set the test-only env var. */
export function isMockEvidencePermitted(evidenceSource: string | null): boolean {
  if (evidenceSource !== "mock-stripe") return true;
  return process.env[PHASE_2G_TESTONLY_ENV] === "1";
}

export type Phase2gRefusal =
  | { ok: false; reason: "FLAG_OFF"; detail: string }
  | { ok: false; reason: "JOB_NOT_FOUND"; detail: string }
  | { ok: false; reason: "JOB_TERMINAL"; detail: string; state: ProvisioningState }
  | { ok: false; reason: "MOCK_EVIDENCE_REJECTED"; detail: string }
  | { ok: false; reason: "REVALIDATION_FAILED"; detail: string; gate: string }
  | { ok: false; reason: "COLLISION"; detail: string; collisionKind: string }
  | { ok: false; reason: "HANDLER_FAILED"; detail: string; transient: boolean };

export type Phase2gAdvance =
  | { ok: true; jobId: string; previousState: ProvisioningState; newState: ProvisioningState; completed: boolean }
  | Phase2gRefusal;

/** Operator inbox categories Phase 2G writes. */
const CATEGORY = {
  PROVISIONING_STUCK: "PROVISIONING_STUCK",
  EXISTING_USER_EMAIL_CONFLICT: "EXISTING_USER_EMAIL_CONFLICT",
  EXISTING_CLUB_SLUG_CONFLICT: "EXISTING_CLUB_SLUG_CONFLICT",
  EXISTING_SUBSCRIPTION_CONFLICT: "EXISTING_SUBSCRIPTION_CONFLICT",
  PROVISIONING_REVOCATION: "PROVISIONING_REVOCATION",
  MOCK_EVIDENCE_REJECTED_2G: "MOCK_EVIDENCE_REJECTED_2G",
  PROVISIONING_COMPLETED: "PROVISIONING_COMPLETED",
} as const;

async function writeOperatorAlert(args: {
  cycleId: string | null;
  clubId: string | null;
  category: string;
  severity: "ROUTINE" | "IMMEDIATE";
  title: string;
  body: string;
}): Promise<void> {
  try {
    await prisma.operatorInboxEntry.create({
      data: {
        severity: args.severity,
        category: args.category,
        clubId: args.clubId,
        billingCycleId: args.cycleId,
        title: args.title,
        body: args.body,
      },
    });
  } catch (err) {
    logger.warn("signup.provisioning.operator_alert_write_failed", {
      cycleIdTail: args.cycleId?.slice(-6) ?? null,
      category: args.category,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Cancellation: stamp cancelledAt + cancelReason + sentinel columns
 *  on any touched User/Club/ClubSubscription rows.  Preserves data. */
async function cancelJob(args: {
  jobId: string;
  reason: string;
  provisionedUserId: string | null;
  provisionedClubId: string | null;
  clubSubscriptionClubId: string | null;
}): Promise<void> {
  const now = new Date();
  await prisma.$transaction(async (tx) => {
    await tx.tenantProvisioningJob.update({
      where: { id: args.jobId },
      data: { cancelledAt: now, cancelReason: args.reason, nextAttemptAt: null },
    });
    if (args.provisionedUserId) {
      await tx.user.update({
        where: { id: args.provisionedUserId },
        data: { provisioningCancelledAt: now },
      });
    }
    if (args.provisionedClubId) {
      await tx.club.update({
        where: { id: args.provisionedClubId },
        data: { provisioningCancelledAt: now },
      });
    }
    if (args.clubSubscriptionClubId) {
      await tx.clubSubscription.updateMany({
        where: { clubId: args.clubSubscriptionClubId },
        data: { provisioningCancelledAt: now },
      });
    }
  });
  logger.info("signup.provisioning.cancelled", {
    jobIdTail: args.jobId.slice(-6),
    reason: args.reason,
  });
}

// ---------------------------------------------------------------
// Step handlers.  Each is idempotent on its anchor column.
// ---------------------------------------------------------------

/** STEP 1 -- USER_CREATED.
 *  Phase 2G baseline refuses on ANY email collision.  Microsoft-
 *  identity-based reuse requires a future `User.microsoftOid` column
 *  that is NOT shipped in this slice; it is tracked as a residual
 *  in docs/signup-2-phase-2g-acceptance.md. */
async function stepUserCreated(ctx: StepHandlerContext): Promise<{ idempotencyAnchor: Record<string, string | null> }> {
  // Idempotency: if the job already stamped a provisionedUserId,
  // reuse it (replay-safe).
  const job = await prisma.tenantProvisioningJob.findUnique({
    where: { id: ctx.jobId },
    select: { provisionedUserId: true },
  });
  if (job?.provisionedUserId) {
    return { idempotencyAnchor: { provisionedUserId: job.provisionedUserId } };
  }
  const reg = await prisma.signupRegistration.findUnique({
    where: { id: ctx.signupRegistrationId },
    select: {
      adminEmail: true,
      adminDisplayName: true,
      adminGivenName: true,
      adminSurname: true,
      adminPosition: true,
    },
  });
  if (!reg) {
    throw new AppError(
      "SIGNUP_2G_REGISTRATION_MISSING",
      `SignupRegistration ${ctx.signupRegistrationId.slice(-6)} not found for job ${ctx.jobId.slice(-6)}`,
      404,
    );
  }
  if (!reg.adminEmail) {
    throw new AppError(
      "SIGNUP_2G_REGISTRATION_INCOMPLETE",
      `SignupRegistration ${ctx.signupRegistrationId.slice(-6)} missing adminEmail`,
      400,
    );
  }
  const adminEmail = reg.adminEmail;
  const existing = await prisma.user.findUnique({
    where: { email: adminEmail },
    select: { id: true, status: true },
  });
  if (existing) {
    await writeOperatorAlert({
      cycleId: ctx.billingCycleId,
      clubId: null,
      category: CATEGORY.EXISTING_USER_EMAIL_CONFLICT,
      severity: "IMMEDIATE",
      title: "Phase 2G provisioning refused -- user email already in use",
      body: `Cycle ${ctx.billingCycleId.slice(-6)} refused: User with email tail '${adminEmail.slice(-10)}' already exists (id tail ${existing.id.slice(-6)}, status=${existing.status}).  Phase 2G baseline does NOT auto-reuse by email.`,
    });
    throw new AppError(
      "SIGNUP_2G_COLLISION_EMAIL",
      `email collision with existing user (status=${existing.status})`,
      409,
    );
  }
  const derivedName =
    reg.adminDisplayName ??
    ([reg.adminGivenName, reg.adminSurname].filter(Boolean).join(" ") || adminEmail);
  const u = await prisma.user.create({
    data: {
      email: adminEmail,
      name: derivedName,
      role: "CLUB_ADMIN",
      // Deterministic placeholder passwordHash: Phase 2G baseline
      // creates the user as ACTIVE with a non-login hash; actual
      // password set via SIGNUP-1G recovery link invitation.
      passwordHash: "signup-2g-pending-invitation-" + ctx.jobId.slice(-12),
      status: "ACTIVE",
    },
  });
  return { idempotencyAnchor: { provisionedUserId: u.id } };
}

function deriveClubSlug(legalName: string, registrationId: string): string {
  const base = legalName
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .slice(0, 40) || "club";
  return `${base}-${registrationId.slice(-6)}`;
}

/** STEP 2 -- CLUB_CREATED.
 *  Creates a NEW Club with deterministic slug + a ClubSubscription
 *  row with accessTier = STAGED.  Refuses on slug collision. */
async function stepClubCreated(ctx: StepHandlerContext): Promise<{ idempotencyAnchor: Record<string, string | null> }> {
  const job = await prisma.tenantProvisioningJob.findUnique({
    where: { id: ctx.jobId },
    select: { provisionedClubId: true, clubSubscriptionClubId: true },
  });
  if (job?.provisionedClubId) {
    return { idempotencyAnchor: { provisionedClubId: job.provisionedClubId, clubSubscriptionClubId: job.clubSubscriptionClubId ?? job.provisionedClubId } };
  }
  const reg = await prisma.signupRegistration.findUnique({
    where: { id: ctx.signupRegistrationId },
    select: { legalName: true, provinceState: true, country: true, legalNameNormalized: true },
  });
  if (!reg) {
    throw new AppError("SIGNUP_2G_REGISTRATION_MISSING", `registration not found`, 404);
  }
  const slug = deriveClubSlug(reg.legalName, ctx.signupRegistrationId);
  const existingClub = await prisma.club.findUnique({ where: { slug }, select: { id: true } });
  if (existingClub) {
    await writeOperatorAlert({
      cycleId: ctx.billingCycleId,
      clubId: existingClub.id,
      category: CATEGORY.EXISTING_CLUB_SLUG_CONFLICT,
      severity: "IMMEDIATE",
      title: "Phase 2G provisioning refused -- club slug collision",
      body: `Cycle ${ctx.billingCycleId.slice(-6)} refused: Club with slug '${slug}' already exists.  Phase 2G baseline does NOT auto-attach to existing clubs.`,
    });
    throw new AppError("SIGNUP_2G_COLLISION_CLUB_SLUG", `club slug collision: ${slug}`, 409);
  }
  const existingSubByClub = await prisma.clubSubscription.findFirst({
    where: { signupRegistrationId: ctx.signupRegistrationId },
    select: { id: true, clubId: true },
  });
  if (existingSubByClub) {
    await writeOperatorAlert({
      cycleId: ctx.billingCycleId,
      clubId: existingSubByClub.clubId,
      category: CATEGORY.EXISTING_SUBSCRIPTION_CONFLICT,
      severity: "IMMEDIATE",
      title: "Phase 2G provisioning refused -- subscription already linked",
      body: `Cycle ${ctx.billingCycleId.slice(-6)} refused: ClubSubscription already exists for registration ${ctx.signupRegistrationId.slice(-6)}.`,
    });
    throw new AppError("SIGNUP_2G_COLLISION_SUBSCRIPTION", `subscription already linked`, 409);
  }

  const result = await prisma.$transaction(async (tx) => {
    const club = await tx.club.create({
      data: {
        slug,
        name: reg.legalName,
        region: reg.provinceState,
        salesTaxRegion: reg.country === "CA" ? "GST" : "NONE",
        foundedYear: new Date().getFullYear(),
        timezone: reg.country === "CA" ? "America/Edmonton" : "UTC",
        // Phase 2G baseline tenants are production-shape; staging
        // acceptance explicitly sets stagingDataMode via fixture.
        stagingDataMode: "FOUNDER_REVIEW",
      },
      select: { id: true },
    });
    await tx.clubSubscription.create({
      data: {
        clubId: club.id,
        status: "ACTIVE",            // legacy "status" default moves to ACTIVE
        subscriptionStatus: "ACTIVATION_READY",
        accessTier: "STAGED",        // Tier 2 unlocks only on step 9
        signupRegistrationId: ctx.signupRegistrationId,
      },
    });
    // Backfill the Phase 2F authorisation's clubSubscription link.
    await tx.tenantProvisioningJob.update({
      where: { id: ctx.jobId },
      data: { clubSubscriptionClubId: club.id },
    });
    return { clubId: club.id };
  });

  return { idempotencyAnchor: { provisionedClubId: result.clubId, clubSubscriptionClubId: result.clubId } };
}

/** STEP 3 -- ROLES_ASSIGNED.
 *  Grants the founding admin CLUB_ADMIN on the new Club. */
async function stepRolesAssigned(ctx: StepHandlerContext): Promise<{ idempotencyAnchor: Record<string, string | null> }> {
  const job = await prisma.tenantProvisioningJob.findUnique({
    where: { id: ctx.jobId },
    select: {
      rolesAssignedBatchKey: true,
      provisionedUserId: true,
      provisionedClubId: true,
    },
  });
  if (job?.rolesAssignedBatchKey) {
    return { idempotencyAnchor: { rolesAssignedBatchKey: job.rolesAssignedBatchKey } };
  }
  if (!job?.provisionedUserId || !job?.provisionedClubId) {
    throw new AppError("SIGNUP_2G_MISSING_ANCHOR", "provisionedUserId or provisionedClubId missing before step 3", 500);
  }
  const existing = await prisma.userClubRole.findFirst({
    where: { userId: job.provisionedUserId, clubId: job.provisionedClubId, roleKey: "CLUB_ADMIN" },
    select: { id: true },
  });
  if (!existing) {
    await prisma.userClubRole.create({
      data: {
        userId: job.provisionedUserId,
        clubId: job.provisionedClubId,
        roleKey: "CLUB_ADMIN",
      },
    });
  }
  const batchKey = `rolesAssigned:${ctx.jobId.slice(-12)}`;
  return { idempotencyAnchor: { rolesAssignedBatchKey: batchKey } };
}

/** Mock-stub steps.  Phase 2G baseline stamps the per-step batch
 *  key so replay is a no-op; the live COA import / branding upload
 *  / invitation delivery / welcome-mail wiring is deferred to the
 *  live-tenant acceptance slice.
 *
 *  Production-safety (founder §4 of the Phase 2G closure, 2026-10-26):
 *  these stub handlers REFUSE to stamp a placeholder anchor unless
 *  BOTH (a) the job's evidence is mock-backed (`mock-stripe`) AND
 *  (b) the staging-only testOnly env var is set.  Any job on a
 *  production-capable path (live-stripe evidence, or mock-stripe
 *  without the testOnly env) is refused with
 *  `SIGNUP_2G_STUB_STEP_PRODUCTION_REFUSED` so a real tenant can
 *  never reach FULL / ACTIVE via a placeholder step completion.
 *  The real importer / mailer wiring will replace these stubs in
 *  a separately-authorised live-tenant slice. */
function makeStubStep(anchorField: string, label: string): StepHandler {
  return async (_state, ctx) => {
    const job = await prisma.tenantProvisioningJob.findUnique({
      where: { id: ctx.jobId },
      select: { authorisationEvidenceSource: true },
    });
    const isMockBacked = job?.authorisationEvidenceSource === "mock-stripe";
    const testOnlyEnabled = process.env[PHASE_2G_TESTONLY_ENV] === "1";
    if (!isMockBacked || !testOnlyEnabled) {
      throw new AppError(
        "SIGNUP_2G_STUB_STEP_PRODUCTION_REFUSED",
        `step ${label} is an acceptance-only stub; production provisioning requires the real implementation (deferred residual in Phase 2G acceptance doc)`,
        501,
      );
    }
    const batchKey = `${label}:${ctx.jobId.slice(-12)}`;
    return { idempotencyAnchor: { [anchorField]: batchKey } };
  };
}

const STEP_HANDLERS: Record<Exclude<ProvisioningState, "COMPLETED" | "FAILED">, StepHandler> = {
  // CREATED -> USER_CREATED
  CREATED: async (_state, ctx) => stepUserCreated(ctx),
  // USER_CREATED -> CLUB_CREATED
  USER_CREATED: async (_state, ctx) => stepClubCreated(ctx),
  // CLUB_CREATED -> ROLES_ASSIGNED
  CLUB_CREATED: async (_state, ctx) => stepRolesAssigned(ctx),
  // ROLES_ASSIGNED -> COA_COMMITTED
  ROLES_ASSIGNED: makeStubStep("committedCoaBatchKey", "coaCommitted"),
  // COA_COMMITTED -> OPENING_BALANCE_COMMITTED
  COA_COMMITTED: makeStubStep("committedOpeningBalanceBatchKey", "openingBalanceCommitted"),
  // OPENING_BALANCE_COMMITTED -> BRANDING_COMMITTED
  OPENING_BALANCE_COMMITTED: makeStubStep("committedBrandingBatchKey", "brandingCommitted"),
  // BRANDING_COMMITTED -> INVITATIONS_DELIVERED
  BRANDING_COMMITTED: makeStubStep("invitationsDeliveredBatchKey", "invitationsDelivered"),
  // INVITATIONS_DELIVERED -> WELCOME_EMAIL_SENT
  INVITATIONS_DELIVERED: makeStubStep("welcomeEmailProviderMessageId", "welcomeEmailSent"),
  // WELCOME_EMAIL_SENT -> COMPLETED  (atomic final grant below)
  WELCOME_EMAIL_SENT: async (_state, _ctx) => {
    // Final-grant handler is a special case: advanceOneStep's state
    // flip + ClubSubscription activation must happen in the SAME
    // transaction with an inside-tx revalidation.  We signal here
    // that no anchor is set; the orchestrator (tickProvisioningJob)
    // routes WELCOME_EMAIL_SENT -> COMPLETED through
    // `completeProvisioningAtomically` instead of advanceOneStep.
    throw new AppError(
      "SIGNUP_2G_FINAL_STEP_NOT_VIA_ADVANCE",
      "WELCOME_EMAIL_SENT -> COMPLETED must go through completeProvisioningAtomically, not advanceOneStep",
      500,
    );
  },
};

/** Atomic final grant.  Runs step 9 (WELCOME_EMAIL_SENT ->
 *  COMPLETED) with inside-transaction revalidation + Tier 2 flip. */
async function completeProvisioningAtomically(jobId: string): Promise<Phase2gAdvance> {
  const job = await prisma.tenantProvisioningJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      state: true,
      billingCycleId: true,
      provisionedClubId: true,
      clubSubscriptionClubId: true,
      authorisationEvidenceSource: true,
      cancelledAt: true,
      invalidatedAt: true,
    },
  });
  if (!job) {
    return { ok: false, reason: "JOB_NOT_FOUND", detail: "no job with that id" };
  }
  if (job.state !== "WELCOME_EMAIL_SENT") {
    return {
      ok: false,
      reason: "JOB_TERMINAL",
      detail: `expected state WELCOME_EMAIL_SENT, got ${job.state}`,
      state: job.state as ProvisioningState,
    };
  }
  if (!job.provisionedClubId) {
    return { ok: false, reason: "HANDLER_FAILED", detail: "provisionedClubId missing at final grant", transient: false };
  }

  // Pre-transaction revalidation (defensive first look).
  const preRevalidation = await validateActivationAuthorisation(jobId);
  if (!preRevalidation.ok) {
    await cancelJob({
      jobId,
      reason: `pre-final revalidation refused: ${preRevalidation.reason} / ${preRevalidation.detail}`,
      provisionedUserId: null,
      provisionedClubId: job.provisionedClubId,
      clubSubscriptionClubId: job.clubSubscriptionClubId,
    });
    await writeOperatorAlert({
      cycleId: job.billingCycleId,
      clubId: job.provisionedClubId,
      category: CATEGORY.PROVISIONING_REVOCATION,
      severity: "IMMEDIATE",
      title: "Phase 2G final grant refused by revalidation",
      body: `Job ${jobId.slice(-6)} refused at final grant: ${preRevalidation.reason} / ${preRevalidation.detail}`,
    });
    return { ok: false, reason: "REVALIDATION_FAILED", detail: preRevalidation.detail, gate: preRevalidation.reason };
  }

  const now = new Date();
  try {
    const txResult = await prisma.$transaction(async (tx) => {
      // Row-lock BillingCycle (Postgres) + TenantProvisioningJob.
      // Prisma does not expose SELECT ... FOR UPDATE directly; we
      // use `findUnique` inside the tx with the understanding that
      // the subsequent `update` participates in the same transaction
      // and serialises against the Phase 2E reversal handler's
      // `updateMany(where: { reversedAt: null })` conditional guard.
      const cycleRelock = await tx.billingCycle.findUnique({
        where: { id: job.billingCycleId },
        select: { id: true, reversedAt: true, subscriptionStatus: true },
      });
      if (!cycleRelock) {
        return { ok: false as const, gate: "G1_NOT_READY", detail: "cycle not found at final grant" };
      }
      if (cycleRelock.reversedAt) {
        return { ok: false as const, gate: "G2_REVERSED", detail: "cycle reversedAt set inside final-grant transaction" };
      }
      if (cycleRelock.subscriptionStatus !== "ACTIVATION_READY") {
        return {
          ok: false as const,
          gate: "G1_NOT_READY",
          detail: `cycle subscriptionStatus=${cycleRelock.subscriptionStatus} inside final-grant transaction`,
        };
      }
      const jobRelock = await tx.tenantProvisioningJob.findUnique({
        where: { id: jobId },
        select: {
          state: true,
          cancelledAt: true,
          invalidatedAt: true,
          authorisationExpiresAt: true,
          provisionedClubId: true,
        },
      });
      if (!jobRelock || jobRelock.state !== "WELCOME_EMAIL_SENT") {
        return { ok: false as const, gate: "G9_JOB_EXISTS", detail: `job state changed inside final-grant: ${jobRelock?.state}` };
      }
      if (jobRelock.cancelledAt) return { ok: false as const, gate: "G9_JOB_EXISTS", detail: "job cancelled inside tx" };
      if (jobRelock.invalidatedAt) return { ok: false as const, gate: "G9_JOB_EXISTS", detail: "job invalidated inside tx" };
      if (jobRelock.authorisationExpiresAt && jobRelock.authorisationExpiresAt.getTime() < Date.now()) {
        return { ok: false as const, gate: "AUTHORISATION_EXPIRED", detail: "authorisation expired inside tx" };
      }
      const sub = await tx.clubSubscription.findUnique({
        where: { clubId: jobRelock.provisionedClubId! },
        select: { subscriptionStatus: true, accessTier: true, provisioningCancelledAt: true },
      });
      if (!sub) {
        return { ok: false as const, gate: "G1_NOT_READY", detail: "ClubSubscription missing at final grant" };
      }
      if (sub.provisioningCancelledAt) {
        return { ok: false as const, gate: "G9_JOB_EXISTS", detail: "ClubSubscription provisioningCancelledAt set" };
      }

      // Atomic flip -- Tier 2 unlocks here, nowhere else.
      await tx.clubSubscription.update({
        where: { clubId: jobRelock.provisionedClubId! },
        data: {
          subscriptionStatus: "ACTIVE",
          accessTier: "FULL",
          activatedAt: now,
        },
      });
      await tx.tenantProvisioningJob.update({
        where: { id: jobId },
        data: {
          state: "COMPLETED",
          completedAt: now,
          nextAttemptAt: null,
        },
      });
      await tx.paymentReconciliationEntry.create({
        data: {
          clubId: jobRelock.provisionedClubId!,
          billingCycleId: job.billingCycleId,
          entryType: "ACTIVATION_COMPLETED",
          amountMinorUnits: 0n,
          currency: "cad",
          providerEventId: null,
          providerBalanceTransactionId: null,
          providerChargeId: null,
          occurredAt: now,
          reconciliationNotes: `Phase 2G final grant: job=${jobId.slice(-6)} evidenceSource=${job.authorisationEvidenceSource}`,
        },
      });
      return { ok: true as const };
    });

    if (!txResult.ok) {
      await cancelJob({
        jobId,
        reason: `final-grant inside-tx refused: ${txResult.gate} / ${txResult.detail}`,
        provisionedUserId: null,
        provisionedClubId: job.provisionedClubId,
        clubSubscriptionClubId: job.clubSubscriptionClubId,
      });
      await writeOperatorAlert({
        cycleId: job.billingCycleId,
        clubId: job.provisionedClubId,
        category: CATEGORY.PROVISIONING_REVOCATION,
        severity: "IMMEDIATE",
        title: "Phase 2G final grant refused inside transaction",
        body: `Job ${jobId.slice(-6)} refused at inside-tx revalidation: ${txResult.gate} / ${txResult.detail}`,
      });
      return { ok: false, reason: "REVALIDATION_FAILED", detail: txResult.detail, gate: txResult.gate };
    }

    await audit(null, {
      action: "signup.provisioning.completed",
      entityType: "TenantProvisioningJob",
      entityId: jobId,
      meta: {
        cycleIdTail: job.billingCycleId.slice(-6),
        clubIdTail: job.provisionedClubId.slice(-6),
        evidenceSource: job.authorisationEvidenceSource,
      },
    });
    await writeOperatorAlert({
      cycleId: job.billingCycleId,
      clubId: job.provisionedClubId,
      category: CATEGORY.PROVISIONING_COMPLETED,
      severity: "ROUTINE",
      title: "Phase 2G provisioning completed",
      body: `Job ${jobId.slice(-6)} reached COMPLETED; club shell activated at Tier 2 (clubIdTail=${job.provisionedClubId.slice(-6)}).`,
    });
    logger.info("signup.provisioning.completed", {
      jobIdTail: jobId.slice(-6),
      clubIdTail: job.provisionedClubId.slice(-6),
      evidenceSource: job.authorisationEvidenceSource,
    });

    return { ok: true, jobId, previousState: "WELCOME_EMAIL_SENT", newState: "COMPLETED", completed: true };
  } catch (err) {
    logger.error("signup.provisioning.final_grant_failed", {
      jobIdTail: jobId.slice(-6),
      detail: err instanceof Error ? err.message : String(err),
    });
    return {
      ok: false,
      reason: "HANDLER_FAILED",
      detail: err instanceof Error ? err.message : String(err),
      transient: true,
    };
  }
}

/** Advance one step of a job.  Pre-step revalidation + mock-isolation
 *  gate run OUTSIDE advanceOneStep. */
export async function tickProvisioningJob(jobId: string): Promise<Phase2gAdvance> {
  try {
    assertPhase2gFlag();
  } catch (err) {
    return { ok: false, reason: "FLAG_OFF", detail: err instanceof Error ? err.message : String(err) };
  }

  const job = await prisma.tenantProvisioningJob.findUnique({
    where: { id: jobId },
    select: {
      id: true,
      state: true,
      billingCycleId: true,
      signupRegistrationId: true,
      clubSubscriptionClubId: true,
      authorisationEvidenceSource: true,
      cancelledAt: true,
      invalidatedAt: true,
      provisionedUserId: true,
      provisionedClubId: true,
    },
  });
  if (!job) {
    return { ok: false, reason: "JOB_NOT_FOUND", detail: `no job ${jobId}` };
  }
  if (PROVISIONING_TERMINAL_STATES.has(job.state as ProvisioningState)) {
    return {
      ok: false,
      reason: "JOB_TERMINAL",
      detail: `job already terminal (${job.state})`,
      state: job.state as ProvisioningState,
    };
  }
  if (job.cancelledAt) {
    return { ok: false, reason: "JOB_TERMINAL", detail: "job cancelledAt set", state: job.state as ProvisioningState };
  }

  // Mock-isolation gate (independent of Phase 2F).
  if (!isMockEvidencePermitted(job.authorisationEvidenceSource)) {
    await writeOperatorAlert({
      cycleId: job.billingCycleId,
      clubId: job.provisionedClubId,
      category: CATEGORY.MOCK_EVIDENCE_REJECTED_2G,
      severity: "IMMEDIATE",
      title: "Phase 2G refuses to provision mock-backed job",
      body: `Job ${jobId.slice(-6)} refused: authorisationEvidenceSource=mock-stripe but ${PHASE_2G_TESTONLY_ENV} is not set on this container.`,
    });
    return {
      ok: false,
      reason: "MOCK_EVIDENCE_REJECTED",
      detail: `authorisationEvidenceSource=${job.authorisationEvidenceSource}; ${PHASE_2G_TESTONLY_ENV} not set`,
    };
  }

  // Pre-step revalidation.
  const revalidation = await validateActivationAuthorisation(jobId);
  if (!revalidation.ok) {
    await cancelJob({
      jobId,
      reason: `pre-step revalidation refused: ${revalidation.reason} / ${revalidation.detail}`,
      provisionedUserId: job.provisionedUserId,
      provisionedClubId: job.provisionedClubId,
      clubSubscriptionClubId: job.clubSubscriptionClubId,
    });
    await writeOperatorAlert({
      cycleId: job.billingCycleId,
      clubId: job.provisionedClubId,
      category: CATEGORY.PROVISIONING_REVOCATION,
      severity: "IMMEDIATE",
      title: "Phase 2G provisioning cancelled by revalidation",
      body: `Job ${jobId.slice(-6)} cancelled: ${revalidation.reason} / ${revalidation.detail}`,
    });
    return { ok: false, reason: "REVALIDATION_FAILED", detail: revalidation.detail, gate: revalidation.reason };
  }

  // Final-grant step is routed through the atomic completion path.
  if (job.state === "WELCOME_EMAIL_SENT") {
    return completeProvisioningAtomically(jobId);
  }

  // Dispatch to the step handler via Phase 2A's advanceOneStep.
  const currentState = job.state as Exclude<ProvisioningState, "COMPLETED" | "FAILED">;
  const handler = STEP_HANDLERS[currentState];
  if (!handler) {
    return { ok: false, reason: "HANDLER_FAILED", detail: `no handler for state ${currentState}`, transient: false };
  }

  const stepResult = await advanceOneStep({
    jobId,
    handler: async (_state, ctx) => handler(_state, ctx),
  });

  if (stepResult.newState === "FAILED") {
    await writeOperatorAlert({
      cycleId: job.billingCycleId,
      clubId: job.provisionedClubId,
      category: CATEGORY.PROVISIONING_STUCK,
      severity: "IMMEDIATE",
      title: "Phase 2G provisioning FAILED (retries exhausted)",
      body: `Job ${jobId.slice(-6)} stuck at state ${currentState}: ${stepResult.errorDetail ?? "unknown"}`,
    });
    return {
      ok: false,
      reason: "HANDLER_FAILED",
      detail: stepResult.errorDetail ?? "retries exhausted",
      transient: false,
    };
  }
  if (stepResult.retriable && stepResult.newState === currentState) {
    // Handler threw but retries remain; return the error signal so
    // the caller sees non-ok without advancing state.
    return {
      ok: false,
      reason: "HANDLER_FAILED",
      detail: stepResult.errorDetail ?? "unknown",
      transient: true,
    };
  }

  logger.info("signup.provisioning.step_advanced", {
    jobIdTail: jobId.slice(-6),
    previousState: currentState,
    newState: stepResult.newState,
  });
  await audit(null, {
    action: `signup.provisioning.${currentState.toLowerCase()}.advanced`,
    entityType: "TenantProvisioningJob",
    entityId: jobId,
    meta: { newState: stepResult.newState },
  });

  return {
    ok: true,
    jobId,
    previousState: currentState,
    newState: stepResult.newState,
    completed: stepResult.newState === "COMPLETED",
  };
}

/** Multi-step tick for a single job -- loops tickProvisioningJob
 *  until the job completes, fails, is cancelled, or returns a
 *  non-ok result.  Capped at `maxSteps` iterations to prevent
 *  runaway loops; the acceptance spec calls this with `maxSteps=9`
 *  to drive a happy-path job all the way to COMPLETED. */
export async function tickProvisioningJobToCompletion(
  jobId: string,
  maxSteps = 9,
): Promise<Phase2gAdvance[]> {
  const history: Phase2gAdvance[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const r = await tickProvisioningJob(jobId);
    history.push(r);
    if (!r.ok) break;
    if (r.completed) break;
  }
  return history;
}

/** Discover ticks + run them.  Phase 2G baseline is operator-tick
 *  only (see founder decision D6); this function is called by the
 *  provisioning-tick HTTP route.  Returns per-job outcomes. */
export async function sweepProvisioningCandidates(): Promise<{
  attempted: number;
  advanced: number;
  completed: number;
  refused: number;
  outcomes: Array<{ jobId: string; outcome: Phase2gAdvance }>;
}> {
  assertPhase2gFlag();
  const now = new Date();
  const candidates = await prisma.tenantProvisioningJob.findMany({
    where: {
      state: { notIn: ["COMPLETED", "FAILED"] },
      cancelledAt: null,
      OR: [
        { nextAttemptAt: null },
        { nextAttemptAt: { lte: now } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: 25,
    select: { id: true },
  });
  let advanced = 0;
  let completed = 0;
  let refused = 0;
  const outcomes: Array<{ jobId: string; outcome: Phase2gAdvance }> = [];
  for (const c of candidates) {
    const outcome = await tickProvisioningJob(c.id);
    outcomes.push({ jobId: c.id, outcome });
    if (!outcome.ok) {
      refused += 1;
      logger.info("signup.provisioning.sweep_refused", {
        jobIdTail: c.id.slice(-6),
        reason: outcome.reason,
        detail: outcome.detail,
      });
      continue;
    }
    advanced += 1;
    if (outcome.completed) completed += 1;
  }
  logger.info("signup.provisioning.sweep_tick", {
    attempted: candidates.length,
    advanced,
    completed,
    refused,
  });
  return { attempted: candidates.length, advanced, completed, refused, outcomes };
}
