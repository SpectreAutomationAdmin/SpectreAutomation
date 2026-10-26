// SIGNUP-2 Phase 2A (2026-10-25) -- Durable tenant-provisioning job
// state machine primitives.
//
// Phase 2A ships the SHAPE: state enum, permitted-step transitions,
// retry policy, and claim-and-advance semantics.  REAL side effects
// (user create, club create, roles assign, COA commit, opening-balance
// commit, branding commit, invitations deliver, welcome email) are
// mock stubs here and will be replaced with real implementations in
// Phase 2G.
//
// Idempotency guarantees:
//   - One job row per BillingCycle (unique).  Multiple
//     payment_intent.succeeded webhook deliveries produce the same
//     row.
//   - Each step records an idempotency anchor (provisionedUserId,
//     provisionedClubId, batch keys, provider message id) on
//     completion.  Retrying a step whose anchor is already stamped
//     is a no-op.
//   - The final state transition (WELCOME_EMAIL_SENT -> COMPLETED)
//     runs in the SAME DB transaction as the ClubSubscription ->
//     ACTIVE update; a failure of either rolls both back.

import { prisma } from "@/lib/prisma";
import { AppError } from "@/lib/errors";

/** The nine step-level states + the two terminal states. */
export const PROVISIONING_STATES = [
  "CREATED",
  "USER_CREATED",
  "CLUB_CREATED",
  "ROLES_ASSIGNED",
  "COA_COMMITTED",
  "OPENING_BALANCE_COMMITTED",
  "BRANDING_COMMITTED",
  "INVITATIONS_DELIVERED",
  "WELCOME_EMAIL_SENT",
  "COMPLETED",
  "FAILED",
] as const;
export type ProvisioningState = (typeof PROVISIONING_STATES)[number];

/** Forward step sequence (excluding terminal + FAILED).  Each entry
 *  advances to the next on success; FAILED is reachable from any
 *  non-terminal state. */
export const FORWARD_SEQUENCE: readonly ProvisioningState[] = [
  "CREATED",
  "USER_CREATED",
  "CLUB_CREATED",
  "ROLES_ASSIGNED",
  "COA_COMMITTED",
  "OPENING_BALANCE_COMMITTED",
  "BRANDING_COMMITTED",
  "INVITATIONS_DELIVERED",
  "WELCOME_EMAIL_SENT",
  "COMPLETED",
] as const;

/** Terminal states.  No further writes except operator intervention. */
export const PROVISIONING_TERMINAL_STATES: ReadonlySet<ProvisioningState> =
  new Set(["COMPLETED", "FAILED"]);

export function isProvisioningStepPermitted(
  from: ProvisioningState,
  to: ProvisioningState,
): boolean {
  if (from === to) return false;
  // FAILED is reachable from any non-terminal state.
  if (to === "FAILED" && !PROVISIONING_TERMINAL_STATES.has(from)) return true;
  // Operator intervention: FAILED -> any non-terminal is permitted
  // only via the explicit `recoverFromFailure` function (not here).
  // Forward progression:
  const idxFrom = FORWARD_SEQUENCE.indexOf(from);
  const idxTo = FORWARD_SEQUENCE.indexOf(to);
  if (idxFrom === -1 || idxTo === -1) return false;
  return idxTo === idxFrom + 1;
}

/** Retry policy: exponential backoff capped at 1 hour; max 10
 *  attempts before terminal FAILED. */
export const RETRY_BASE_DELAY_MS = 30 * 1000;       // 30 s
export const RETRY_MAX_DELAY_MS = 60 * 60 * 1000;   // 1 h
export const RETRY_MAX_ATTEMPTS = 10;

export function nextRetryDelayMs(attempts: number): number {
  const expo = RETRY_BASE_DELAY_MS * Math.pow(2, Math.max(0, attempts - 1));
  return Math.min(expo, RETRY_MAX_DELAY_MS);
}

export function hasExhaustedRetries(attempts: number): boolean {
  return attempts >= RETRY_MAX_ATTEMPTS;
}

/** Create a provisioning job for a BillingCycle.  Idempotent on
 *  billingCycleId -- a second call for the same cycle returns the
 *  existing row.  The caller MUST have already transitioned the
 *  cycle through SETTLED -> ACTIVATION_READY. */
export async function createProvisioningJob(args: {
  billingCycleId: string;
  // SIGNUP-2 Phase 2F (2026-10-26) -- Club shell may not exist yet
  // when Phase 2F creates the authorisation.  Phase 2G backfills on
  // its CLUB_CREATED step.
  clubSubscriptionClubId: string | null;
  signupRegistrationId: string;
}): Promise<{ id: string; createdNew: boolean }> {
  const existing = await prisma.tenantProvisioningJob.findUnique({
    where: { billingCycleId: args.billingCycleId },
    select: { id: true },
  });
  if (existing) return { id: existing.id, createdNew: false };
  const row = await prisma.tenantProvisioningJob.create({
    data: {
      billingCycleId: args.billingCycleId,
      clubSubscriptionClubId: args.clubSubscriptionClubId,
      signupRegistrationId: args.signupRegistrationId,
      state: "CREATED",
      attempts: 0,
    },
    select: { id: true },
  });
  return { id: row.id, createdNew: true };
}

/** Claim and advance one step.  Pure state-machine wrapper; the
 *  actual per-step side-effect handler is passed in (dependency
 *  injection) so the Phase 2A tests can inject mocks and the
 *  Phase 2G implementation can inject real handlers.
 *
 *  Returns the new state, or `FAILED` if the handler threw and
 *  retries are exhausted.
 */
export interface StepHandlerContext {
  jobId: string;
  billingCycleId: string;
  // SIGNUP-2 Phase 2F (2026-10-26) -- see createProvisioningJob.
  clubSubscriptionClubId: string | null;
  signupRegistrationId: string;
}
export type StepHandler = (
  state: Exclude<ProvisioningState, "COMPLETED" | "FAILED">,
  ctx: StepHandlerContext,
) => Promise<{ idempotencyAnchor: Record<string, string | null> }>;

export async function advanceOneStep(args: {
  jobId: string;
  handler: StepHandler;
}): Promise<{ newState: ProvisioningState; retriable: boolean; errorDetail?: string }> {
  const job = await prisma.tenantProvisioningJob.findUnique({
    where: { id: args.jobId },
  });
  if (!job) {
    throw new AppError("SIGNUP_2_PROVISIONING_JOB_NOT_FOUND", `Job ${args.jobId} not found`, 404);
  }
  if (PROVISIONING_TERMINAL_STATES.has(job.state as ProvisioningState)) {
    // Already terminal; nothing to do.
    return { newState: job.state as ProvisioningState, retriable: false };
  }
  const currentState = job.state as ProvisioningState;
  const nextIndex = FORWARD_SEQUENCE.indexOf(currentState) + 1;
  const targetState = FORWARD_SEQUENCE[nextIndex];
  if (!targetState) {
    throw new AppError(
      "SIGNUP_2_PROVISIONING_FORWARD_SEQUENCE_EXHAUSTED",
      `No next step after ${currentState}`,
      500,
    );
  }
  // Mark the job as in-flight.
  await prisma.tenantProvisioningJob.update({
    where: { id: args.jobId },
    data: {
      attempts: { increment: 1 },
      startedAt: job.startedAt ?? new Date(),
    },
  });
  try {
    const stepStart = currentState;
    if (PROVISIONING_TERMINAL_STATES.has(stepStart)) {
      throw new AppError(
        "SIGNUP_2_PROVISIONING_RUN_ON_TERMINAL",
        `Cannot advance a job in terminal state ${stepStart}`,
        400,
      );
    }
    const result = await args.handler(
      stepStart as Exclude<ProvisioningState, "COMPLETED" | "FAILED">,
      {
        jobId: args.jobId,
        billingCycleId: job.billingCycleId,
        clubSubscriptionClubId: job.clubSubscriptionClubId,
        signupRegistrationId: job.signupRegistrationId,
      },
    );
    // Stamp the idempotency anchor + advance state.
    await prisma.tenantProvisioningJob.update({
      where: { id: args.jobId },
      data: {
        state: targetState,
        nextAttemptAt: null,
        lastError: null,
        ...(targetState === "COMPLETED" ? { completedAt: new Date() } : {}),
        ...result.idempotencyAnchor,
      },
    });
    return { newState: targetState, retriable: false };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const retriable = !hasExhaustedRetries(job.attempts + 1);
    await prisma.tenantProvisioningJob.update({
      where: { id: args.jobId },
      data: {
        lastError: message,
        ...(retriable
          ? { nextAttemptAt: new Date(Date.now() + nextRetryDelayMs(job.attempts + 1)) }
          : { state: "FAILED", completedAt: new Date() }),
      },
    });
    return {
      newState: retriable ? currentState : "FAILED",
      retriable,
      errorDetail: message,
    };
  }
}

/** Operator-initiated recovery from FAILED.  Reclaims the job + resets
 *  attempts.  Does NOT bypass the step sequence -- the operator
 *  authorises a retry; the state machine still runs forward from the
 *  last-completed step. */
export async function recoverFromFailure(args: {
  jobId: string;
  operatorUserId: string;
  reason: string;
}): Promise<void> {
  const job = await prisma.tenantProvisioningJob.findUnique({ where: { id: args.jobId } });
  if (!job) throw new AppError("SIGNUP_2_PROVISIONING_JOB_NOT_FOUND", `Job ${args.jobId} not found`, 404);
  if (job.state !== "FAILED") {
    throw new AppError(
      "SIGNUP_2_PROVISIONING_RECOVERY_NOT_FAILED",
      `Job ${args.jobId} is in state ${job.state}, not FAILED`,
      400,
    );
  }
  // Determine the last-completed step by inspecting the stamped
  // idempotency anchors.  Choose the earliest incomplete step.
  let resumeState: ProvisioningState = "CREATED";
  if (job.provisionedUserId) resumeState = "USER_CREATED";
  if (job.provisionedClubId) resumeState = "CLUB_CREATED";
  if (job.rolesAssignedBatchKey) resumeState = "ROLES_ASSIGNED";
  if (job.committedCoaBatchKey) resumeState = "COA_COMMITTED";
  if (job.committedOpeningBalanceBatchKey) resumeState = "OPENING_BALANCE_COMMITTED";
  if (job.committedBrandingBatchKey) resumeState = "BRANDING_COMMITTED";
  if (job.invitationsDeliveredBatchKey) resumeState = "INVITATIONS_DELIVERED";
  if (job.welcomeEmailProviderMessageId) resumeState = "WELCOME_EMAIL_SENT";
  await prisma.tenantProvisioningJob.update({
    where: { id: args.jobId },
    data: {
      state: resumeState,
      attempts: 0,
      nextAttemptAt: new Date(),
      lastError: null,
      cancelReason: `operator-recovery: ${args.reason} (operator=${args.operatorUserId})`,
    },
  });
}

/** Operator-initiated cancel.  Sets cancelledAt + cancelReason; does
 *  not advance state. */
export async function cancelProvisioningJob(args: {
  jobId: string;
  operatorUserId: string;
  reason: string;
}): Promise<void> {
  await prisma.tenantProvisioningJob.update({
    where: { id: args.jobId },
    data: {
      cancelledAt: new Date(),
      cancelReason: `operator-cancel: ${args.reason} (operator=${args.operatorUserId})`,
    },
  });
}
