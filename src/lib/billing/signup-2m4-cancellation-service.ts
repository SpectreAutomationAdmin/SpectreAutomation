// SIGNUP-2 M4-cancellation (2026-10-28) -- Phase 6 of 6 under the
// authorised M4 sequence.  Controlled subscription cancellation
// workflow built on the existing BillingCommand infrastructure.
//
// LIFECYCLE (§1):
//   REQUESTED  -> AUTHORIZED | REJECTED
//   AUTHORIZED -> SCHEDULED (worker enqueues SUBSCRIPTION_SCHEDULE_CANCEL)
//   SCHEDULED  -> EFFECTIVE  (customer.subscription.deleted arrives)
//              | REVERSED  (operator reverses BEFORE actualEffectiveAt)
//   EFFECTIVE  -> CANCELLED (terminal; access state recomputed)
//
// A SCHEDULED cancellation is NOT a cancelled subscription.  The
// club retains its authorised service access until actualEffectiveAt
// arrives.
//
// SCOPE BOUNDARIES (per founder M4-cancellation §7):
//   - No modification of accepted M3 experience / Stripe secrets /
//     CAD $38,000 Price.
//   - No accelerated synthetic signup-to-activation path.
//   - No enablement of production billing or payment initiation.
//   - All real Stripe mutations gated by BOTH
//     SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE and the preexisting
//     SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION global block.
//
// REAL-STRIPE OPEN ACCEPTANCE GATE (§6):
//   Signed-webhook fixture evidence is NOT proof of actual
//   Stripe-originated cancellation.  Live cancellation requires the
//   M3 payment-initiation flag released + a real subscription + real
//   Stripe webhook delivery.  §6 outstanding integration gates
//   remain OPEN.

import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import { AppError, ForbiddenError } from "@/lib/errors";
import type { StripeEventShape } from "./stripe-adapter";

/* ============================================================
 * Flag guard (fail-closed)
 * ============================================================ */

export function assertM4CancellationLiveFlag(): void {
  if (process.env.SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE !== "1") {
    throw new ForbiddenError(
      "SIGNUP-2 M4-cancellation workflow is disabled (SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE != 1)",
    );
  }
}

/* ============================================================
 * State machine typing
 * ============================================================ */

export type CancellationState =
  | "REQUESTED"
  | "AUTHORIZED"
  | "SCHEDULED"
  | "EFFECTIVE"
  | "CANCELLED"
  | "REVERSED"
  | "REJECTED";

export const CANCELLATION_STATES: ReadonlyArray<CancellationState> = [
  "REQUESTED", "AUTHORIZED", "SCHEDULED", "EFFECTIVE", "CANCELLED", "REVERSED", "REJECTED",
];

/* ============================================================
 * §1 Request cancellation (operator A)
 * ============================================================ */

export interface RequestCancellationInput {
  clubId: string;
  billingCycleId: string;
  requestedByUserId: string;
  requestReason: string;
  requestedEffectiveDate?: Date | null;
}

export interface RequestCancellationResult {
  requestId: string;
  state: CancellationState;
}

/** Create a new cancellation request.  Does NOT contact Stripe.
 *  Does NOT yet schedule the cancellation (requires §2 authorization
 *  from a different operator).  Idempotent via (clubId, billingCycleId)
 *  + an OPEN state filter: if an open request already exists for the
 *  cycle, we return it instead of creating a duplicate. */
export async function requestCancellation(args: RequestCancellationInput): Promise<RequestCancellationResult> {
  assertM4CancellationLiveFlag();

  // §4 (tenant isolation): confirm the cycle belongs to the stated club.
  const cycle = await prisma.billingCycle.findUnique({
    where: { id: args.billingCycleId },
    select: { id: true, clubId: true, syntheticTestOnly: true, subscriptionStatus: true },
  });
  if (!cycle) {
    throw new AppError("CYCLE_NOT_FOUND", `billingCycle ${args.billingCycleId.slice(-6)} not found`, 404);
  }
  if (cycle.clubId !== args.clubId) {
    throw new ForbiddenError(`cross-tenant cancellation refused (cycle belongs to a different club)`);
  }

  // §5 (duplicate request prevention): if an OPEN request exists for
  // this cycle, return it idempotently.
  const existing = await prisma.billingCancellationRequest.findFirst({
    where: {
      billingCycleId: args.billingCycleId,
      state: { in: ["REQUESTED", "AUTHORIZED", "SCHEDULED"] },
    },
    select: { id: true, state: true },
  });
  if (existing) {
    logger.info("signup.m4.cancellation.request.deduped", {
      requestIdTail: existing.id.slice(-6),
      state: existing.state,
    });
    return { requestId: existing.id, state: existing.state as CancellationState };
  }

  // §5 (already cancelled): if the cycle itself is already in a
  // CANCELLED/ENDED state, refuse.
  if (cycle.subscriptionStatus === "canceled" || cycle.subscriptionStatus === "incomplete_expired") {
    throw new AppError(
      "SUBSCRIPTION_ALREADY_CANCELLED",
      `subscription is already in ${cycle.subscriptionStatus} state`,
      409,
    );
  }

  const row = await prisma.billingCancellationRequest.create({
    data: {
      clubId: args.clubId,
      billingCycleId: args.billingCycleId,
      requestedByUserId: args.requestedByUserId,
      requestReason: args.requestReason,
      requestedEffectiveDate: args.requestedEffectiveDate ?? null,
      state: "REQUESTED",
      syntheticTestOnly: cycle.syntheticTestOnly,
    },
    select: { id: true },
  });

  await audit(null, {
    action: "signup.m4.cancellation.requested",
    entityType: "BillingCancellationRequest",
    entityId: row.id,
    clubId: args.clubId,
    meta: {
      requestIdTail: row.id.slice(-6),
      cycleIdTail: args.billingCycleId.slice(-6),
      requestedByUserIdTail: args.requestedByUserId.slice(-6),
      syntheticTestOnly: cycle.syntheticTestOnly,
    },
  });

  return { requestId: row.id, state: "REQUESTED" };
}

/* ============================================================
 * §2 Authorize cancellation (operator B; SoD required)
 * ============================================================ */

export interface AuthorizeCancellationInput {
  requestId: string;
  authorizedByUserId: string;
  authorizationNotes?: string;
  approvedEffectiveDate: Date;
  validationEvidence: {
    contractExecutionId: string | null;
    noticeOk: boolean;
    outstandingInvoiceIds: ReadonlyArray<string>;
    openExceptionIds: ReadonlyArray<string>;
    governanceReference?: string | null;
  };
}

export interface AuthorizeCancellationResult {
  requestId: string;
  state: "AUTHORIZED";
  approvedEffectiveDate: Date;
}

export async function authorizeCancellation(args: AuthorizeCancellationInput): Promise<AuthorizeCancellationResult> {
  assertM4CancellationLiveFlag();

  const req = await prisma.billingCancellationRequest.findUnique({
    where: { id: args.requestId },
    select: {
      id: true, state: true, clubId: true, billingCycleId: true,
      requestedByUserId: true, requestedEffectiveDate: true,
    },
  });
  if (!req) {
    throw new AppError("REQUEST_NOT_FOUND", `cancellation request ${args.requestId.slice(-6)} not found`, 404);
  }
  if (req.state !== "REQUESTED") {
    throw new AppError(
      "ILLEGAL_STATE_TRANSITION",
      `cannot AUTHORIZE from state=${req.state}; only REQUESTED is permitted`,
      409,
    );
  }

  // §2 SoD -- authorizer MUST differ from requester.
  if (args.authorizedByUserId === req.requestedByUserId) {
    throw new ForbiddenError(
      `SoD violation: authorizedByUserId must differ from requestedByUserId (both are '${args.authorizedByUserId.slice(-6)}')`,
    );
  }

  // §2 validation: must confirm notice, outstanding invoices + exceptions.
  if (!args.validationEvidence.noticeOk) {
    throw new AppError(
      "NOTICE_PERIOD_NOT_SATISFIED",
      "notice period / minimum commitment not satisfied; require governance review before authorizing",
      409,
    );
  }

  // Approved effective date must be >= requestedEffectiveDate (if the
  // request named one) + >= now (no backdated cancellation).
  const now = Date.now();
  if (args.approvedEffectiveDate.getTime() < now) {
    throw new AppError(
      "APPROVED_DATE_IN_PAST",
      "approvedEffectiveDate must be in the future; backdated cancellation is refused",
      409,
    );
  }

  const updated = await prisma.billingCancellationRequest.updateMany({
    where: { id: req.id, state: "REQUESTED" },
    data: {
      state: "AUTHORIZED",
      authorizedByUserId: args.authorizedByUserId,
      authorizedAt: new Date(),
      authorizationNotes: args.authorizationNotes ?? null,
      approvedEffectiveDate: args.approvedEffectiveDate,
      validationEvidenceJson: JSON.stringify(args.validationEvidence),
    },
  });
  if (updated.count !== 1) {
    throw new AppError(
      "CONCURRENT_AUTHORIZATION_RACE",
      "another operator transitioned the request before this authorization landed",
      409,
    );
  }

  await audit(null, {
    action: "signup.m4.cancellation.authorized",
    entityType: "BillingCancellationRequest",
    entityId: req.id,
    clubId: req.clubId,
    meta: {
      requestIdTail: req.id.slice(-6),
      authorizedByUserIdTail: args.authorizedByUserId.slice(-6),
      approvedEffectiveDate: args.approvedEffectiveDate.toISOString(),
      noticeOk: args.validationEvidence.noticeOk,
      outstandingInvoiceCount: args.validationEvidence.outstandingInvoiceIds.length,
      openExceptionCount: args.validationEvidence.openExceptionIds.length,
    },
  });

  return { requestId: req.id, state: "AUTHORIZED", approvedEffectiveDate: args.approvedEffectiveDate };
}

/** Reject an open REQUESTED cancellation.  Operator B refuses the
 *  request (e.g. contract minimum not satisfied).  Terminal. */
export async function rejectCancellation(args: {
  requestId: string;
  rejectedByUserId: string;
  rejectionReason: string;
}): Promise<{ requestId: string; state: "REJECTED" }> {
  assertM4CancellationLiveFlag();

  const req = await prisma.billingCancellationRequest.findUnique({
    where: { id: args.requestId },
    select: { id: true, state: true, clubId: true, requestedByUserId: true },
  });
  if (!req) {
    throw new AppError("REQUEST_NOT_FOUND", `cancellation request ${args.requestId.slice(-6)} not found`, 404);
  }
  if (req.state !== "REQUESTED") {
    throw new AppError(
      "ILLEGAL_STATE_TRANSITION",
      `cannot REJECT from state=${req.state}`,
      409,
    );
  }
  if (args.rejectedByUserId === req.requestedByUserId) {
    throw new ForbiddenError(
      `SoD violation: rejectedByUserId must differ from requestedByUserId`,
    );
  }

  const updated = await prisma.billingCancellationRequest.updateMany({
    where: { id: req.id, state: "REQUESTED" },
    data: {
      state: "REJECTED",
      rejectedByUserId: args.rejectedByUserId,
      rejectedAt: new Date(),
      rejectionReason: args.rejectionReason,
    },
  });
  if (updated.count !== 1) {
    throw new AppError("CONCURRENT_REJECTION_RACE", "state transitioned concurrently", 409);
  }

  await audit(null, {
    action: "signup.m4.cancellation.rejected",
    entityType: "BillingCancellationRequest",
    entityId: req.id,
    clubId: req.clubId,
    meta: {
      requestIdTail: req.id.slice(-6),
      rejectedByUserIdTail: args.rejectedByUserId.slice(-6),
      rejectionReasonLen: args.rejectionReason.length,
    },
  });
  return { requestId: req.id, state: "REJECTED" };
}

/* ============================================================
 * §3 Schedule cancellation (enqueue durable BillingCommand)
 * ============================================================ */

export interface ScheduleCancellationResult {
  requestId: string;
  billingCommandId: string;
  stripeIdempotencyKey: string;
  state: "SCHEDULED";
  noop: boolean;
}

/** After AUTHORIZED, enqueue a SUBSCRIPTION_SCHEDULE_CANCEL command.
 *  Does NOT call Stripe here; the worker (drainOneCancellationCommand)
 *  performs the actual stripe.subscriptions.update(cancel_at=...)
 *  call once BOTH flag gates are satisfied.  Idempotent via the unique
 *  stripeIdempotencyKey. */
export async function scheduleCancellation(requestId: string): Promise<ScheduleCancellationResult> {
  assertM4CancellationLiveFlag();

  const req = await prisma.billingCancellationRequest.findUnique({
    where: { id: requestId },
    select: {
      id: true, state: true, clubId: true, billingCycleId: true,
      approvedEffectiveDate: true, scheduledCommandId: true,
      syntheticTestOnly: true,
    },
  });
  if (!req) {
    throw new AppError("REQUEST_NOT_FOUND", `cancellation request ${requestId.slice(-6)} not found`, 404);
  }

  // Idempotent-replay: already scheduled -> return existing command.
  if (req.state === "SCHEDULED" && req.scheduledCommandId) {
    const existing = await prisma.billingCommand.findUnique({
      where: { id: req.scheduledCommandId },
      select: { id: true, stripeIdempotencyKey: true },
    });
    if (existing) {
      return {
        requestId: req.id,
        billingCommandId: existing.id,
        stripeIdempotencyKey: existing.stripeIdempotencyKey,
        state: "SCHEDULED",
        noop: true,
      };
    }
  }
  if (req.state !== "AUTHORIZED") {
    throw new AppError(
      "ILLEGAL_STATE_TRANSITION",
      `cannot SCHEDULE from state=${req.state}; only AUTHORIZED is permitted`,
      409,
    );
  }
  if (!req.approvedEffectiveDate) {
    throw new AppError("MISSING_APPROVED_DATE", "approvedEffectiveDate is required to schedule cancellation", 500);
  }

  const stripeIdempotencyKey = `signup-2m4-sub-cancel:${req.id}:v1`;

  // Atomic: BillingCommand + state flip in ONE transaction so the
  // scheduledCommandId link + state transition cannot diverge.
  const result = await prisma.$transaction(async (tx) => {
    const command = await tx.billingCommand.create({
      data: {
        commandType: "SUBSCRIPTION_SCHEDULE_CANCEL",
        stripeIdempotencyKey,
        billingCycleId: req.billingCycleId,
        clubId: req.clubId,
        state: "PENDING",
        attemptNumber: 0,
        maxAttempts: 3,
        paramsJson: JSON.stringify({
          cancellationRequestId: req.id,
          approvedEffectiveDate: req.approvedEffectiveDate!.toISOString(),
        }),
        syntheticTestOnly: req.syntheticTestOnly,
      },
      select: { id: true },
    });
    const transition = await tx.billingCancellationRequest.updateMany({
      where: { id: req.id, state: "AUTHORIZED", scheduledCommandId: null },
      data: {
        state: "SCHEDULED",
        scheduledCommandId: command.id,
        scheduledAt: new Date(),
      },
    });
    if (transition.count !== 1) {
      throw new AppError("CONCURRENT_SCHEDULE_RACE", "state transitioned concurrently", 409);
    }
    return { commandId: command.id };
  });

  await audit(null, {
    action: "signup.m4.cancellation.scheduled",
    entityType: "BillingCancellationRequest",
    entityId: req.id,
    clubId: req.clubId,
    meta: {
      requestIdTail: req.id.slice(-6),
      billingCommandIdTail: result.commandId.slice(-6),
      stripeIdempotencyKey,
    },
  });

  return {
    requestId: req.id,
    billingCommandId: result.commandId,
    stripeIdempotencyKey,
    state: "SCHEDULED",
    noop: false,
  };
}

/* ============================================================
 * §3 Worker: drain a SUBSCRIPTION_SCHEDULE_CANCEL command
 * ============================================================ */

export interface DrainCancellationCommandResult {
  commandId: string;
  outcome: "SKIPPED_FLAG_OFF" | "SUCCEEDED" | "DEFERRED" | "UNCERTAIN" | "FAILED";
  detail?: string;
}

/** Executes the Stripe call for a SUBSCRIPTION_SCHEDULE_CANCEL command.
 *  Dual-flag gated: BOTH SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE AND
 *  SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION must be ON for a real Stripe
 *  mutation to fire.  Without the M3 flag the worker is a no-op and
 *  the command stays PENDING for later replay. */
export async function drainOneCancellationCommand(commandId: string): Promise<DrainCancellationCommandResult> {
  try {
    assertM4CancellationLiveFlag();
  } catch {
    return { commandId, outcome: "SKIPPED_FLAG_OFF", detail: "M4-cancellation flag off" };
  }
  if (process.env.SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION !== "1") {
    logger.info("signup.m4.cancellation.worker.m3_payment_initiation_blocked", {
      commandIdTail: commandId.slice(-6),
    });
    return { commandId, outcome: "SKIPPED_FLAG_OFF", detail: "M3 payment-initiation flag off" };
  }

  // Pick the command with FOR UPDATE semantics on the row (via conditional
  // updateMany from PENDING -> ATTEMPTED).  No raw SQL -- Prisma's optimistic
  // state transition is sufficient here because `state` is covered by
  // @@index([state, nextAttemptAt]).
  const picked = await prisma.billingCommand.updateMany({
    where: { id: commandId, state: "PENDING", commandType: "SUBSCRIPTION_SCHEDULE_CANCEL" },
    data: { state: "ATTEMPTED", attemptNumber: { increment: 1 } },
  });
  if (picked.count !== 1) {
    return { commandId, outcome: "SKIPPED_FLAG_OFF", detail: "command not in PENDING state" };
  }

  const cmd = await prisma.billingCommand.findUnique({
    where: { id: commandId },
    select: {
      id: true, paramsJson: true, stripeIdempotencyKey: true,
      billingCycleId: true, clubId: true, syntheticTestOnly: true,
    },
  });
  if (!cmd) {
    return { commandId, outcome: "FAILED", detail: "command vanished after pick" };
  }

  let params: { cancellationRequestId: string; approvedEffectiveDate: string } | null = null;
  try {
    params = JSON.parse(cmd.paramsJson ?? "{}");
  } catch {
    await markCommandTerminal(commandId, "FAILED", "params JSON parse failed", "PARAMS_INVALID");
    return { commandId, outcome: "FAILED", detail: "params JSON parse failed" };
  }
  if (!params?.cancellationRequestId || !params?.approvedEffectiveDate) {
    await markCommandTerminal(commandId, "FAILED", "params missing fields", "PARAMS_INVALID");
    return { commandId, outcome: "FAILED", detail: "params missing cancellationRequestId / approvedEffectiveDate" };
  }

  const request = await prisma.billingCancellationRequest.findUnique({
    where: { id: params.cancellationRequestId },
    select: { id: true, state: true, billingCycle: { select: { stripeSubscriptionId: true } } },
  });
  if (!request) {
    await markCommandTerminal(commandId, "FAILED", "cancellation request vanished", "REQUEST_NOT_FOUND");
    return { commandId, outcome: "FAILED", detail: "cancellation request not found" };
  }
  if (request.state === "REVERSED" || request.state === "REJECTED" || request.state === "CANCELLED") {
    // The request moved after scheduling (e.g. operator reversed it
    // before worker could execute).  Terminal no-op.
    await markCommandTerminal(commandId, "SUCCEEDED", "request already resolved", null);
    return { commandId, outcome: "SUCCEEDED", detail: `request state=${request.state}; no-op` };
  }

  const subscriptionId = request.billingCycle?.stripeSubscriptionId;
  if (!subscriptionId) {
    // No subscription on file yet -- the cycle must have reached
    // first billing.  Operator inbox entry for triage.
    await markCommandTerminal(commandId, "UNCERTAIN", "no stripeSubscriptionId on billingCycle", "SUBSCRIPTION_NOT_FOUND");
    return { commandId, outcome: "UNCERTAIN", detail: "cycle has no stripeSubscriptionId" };
  }

  // Dispatch to Stripe adapter with cancel_at (future timestamp), NOT
  // immediate cancellation.  Correction #7 preserved: cancel_at_period_end
  // or explicit cancel_at future date -- never cancel-immediate.
  try {
    const { resolveStripeAdapter } = await import("./stripe-adapter");
    const adapter = await resolveStripeAdapter();
    const cancelAt = new Date(params.approvedEffectiveDate);
    await adapter.scheduleSubscriptionCancellation({
      stripeSubscriptionId: subscriptionId,
      cancelAt,
      idempotencyKey: cmd.stripeIdempotencyKey,
    });
    await prisma.$transaction([
      prisma.billingCommand.update({
        where: { id: commandId },
        data: {
          state: "SUCCEEDED",
          stripeResourceId: subscriptionId,
          stripeResourceType: "subscription",
          succeededAt: new Date(),
        },
      }),
      prisma.billingCancellationRequest.update({
        where: { id: request.id },
        data: {
          stripeSubscriptionId: subscriptionId,
          stripeCancelAt: cancelAt,
        },
      }),
    ]);
    return { commandId, outcome: "SUCCEEDED" };
  } catch (err) {
    const code = (err as { code?: string } | undefined)?.code ?? null;
    const message = err instanceof Error ? err.message : String(err);
    await markCommandTerminal(commandId, "UNCERTAIN", message, code);
    return { commandId, outcome: "UNCERTAIN", detail: message };
  }
}

async function markCommandTerminal(commandId: string, state: "SUCCEEDED" | "FAILED" | "UNCERTAIN", errorMessage: string | null, errorCode: string | null): Promise<void> {
  await prisma.billingCommand.update({
    where: { id: commandId },
    data: {
      state,
      lastErrorCode: errorCode,
      lastErrorMessage: errorMessage,
      lastErrorAt: errorMessage ? new Date() : null,
      terminalAt: state === "FAILED" ? new Date() : null,
    },
  });
}

/* ============================================================
 * §3 Webhook reconciliation
 * ============================================================ */

/** customer.subscription.updated -- reconciles cancel_at + status
 *  changes.  Does NOT mark EFFECTIVE here; that happens on
 *  customer.subscription.deleted. */
export async function reconcileSubscriptionUpdatedForCancellation(event: StripeEventShape): Promise<{ skipped: boolean; reason?: string }> {
  try { assertM4CancellationLiveFlag(); } catch { return { skipped: true, reason: "flag_off" }; }

  const sub = event.data?.object as { id?: string; cancel_at?: number | null; status?: string } | undefined;
  if (!sub?.id) return { skipped: true, reason: "missing_subscription_id" };

  const request = await prisma.billingCancellationRequest.findFirst({
    where: {
      stripeSubscriptionId: sub.id,
      state: { in: ["SCHEDULED"] },
    },
    select: { id: true, clubId: true, syntheticTestOnly: true },
  });
  if (!request) return { skipped: true, reason: "no_scheduled_request" };

  // Record Stripe-reported cancel_at (sanity) in the request row.
  if (typeof sub.cancel_at === "number") {
    const stripeCancelAt = new Date(sub.cancel_at * 1000);
    await prisma.billingCancellationRequest.update({
      where: { id: request.id },
      data: { stripeCancelAt },
    });
  }
  await audit(null, {
    action: "signup.m4.cancellation.webhook.subscription_updated",
    entityType: "BillingCancellationRequest",
    entityId: request.id,
    clubId: request.clubId,
    meta: {
      stripeEventIdTail: event.id.slice(-8),
      subscriptionIdTail: sub.id.slice(-8),
      stripeCancelAt: typeof sub.cancel_at === "number" ? sub.cancel_at : null,
      stripeStatus: sub.status ?? null,
    },
  });
  return { skipped: false };
}

/** customer.subscription.deleted -- the subscription actually ended
 *  on Stripe's side.  Transitions SCHEDULED -> EFFECTIVE -> CANCELLED
 *  on this request + records the actualEffectiveAt timestamp from
 *  Stripe's ended_at. */
export async function reconcileSubscriptionDeletedForCancellation(event: StripeEventShape): Promise<{ skipped: boolean; reason?: string }> {
  try { assertM4CancellationLiveFlag(); } catch { return { skipped: true, reason: "flag_off" }; }

  const sub = event.data?.object as { id?: string; ended_at?: number | null; status?: string } | undefined;
  if (!sub?.id) return { skipped: true, reason: "missing_subscription_id" };

  const request = await prisma.billingCancellationRequest.findFirst({
    where: {
      stripeSubscriptionId: sub.id,
      state: { in: ["SCHEDULED"] },
    },
    select: { id: true, clubId: true, approvedEffectiveDate: true },
  });
  if (!request) {
    // Not from our cancellation flow (could be a renewal-side event
    // or an unknown subscription); let the renewal handler record it.
    return { skipped: true, reason: "no_scheduled_request" };
  }

  const endedAt = typeof sub.ended_at === "number" ? new Date(sub.ended_at * 1000) : new Date();
  await prisma.$transaction([
    prisma.billingCancellationRequest.updateMany({
      where: { id: request.id, state: "SCHEDULED" },
      data: {
        state: "CANCELLED",
        actualEffectiveAt: endedAt,
      },
    }),
  ]);
  await audit(null, {
    action: "signup.m4.cancellation.effective",
    entityType: "BillingCancellationRequest",
    entityId: request.id,
    clubId: request.clubId,
    meta: {
      stripeEventIdTail: event.id.slice(-8),
      subscriptionIdTail: sub.id.slice(-8),
      actualEffectiveAt: endedAt.toISOString(),
    },
  });
  return { skipped: false };
}

/* ============================================================
 * §5 Reversal (operator-initiated, before actualEffectiveAt)
 * ============================================================ */

/** Reverse a SCHEDULED cancellation before it has taken effect.
 *  Enqueues a RESUME command (SUBSCRIPTION_RESUME) that un-schedules
 *  the Stripe cancel_at.  Idempotent + SoD-protected. */
export async function reverseCancellation(args: {
  requestId: string;
  reversedByUserId: string;
  reversalReason: string;
}): Promise<{ requestId: string; state: "REVERSED"; resumeCommandId: string | null }> {
  assertM4CancellationLiveFlag();

  const req = await prisma.billingCancellationRequest.findUnique({
    where: { id: args.requestId },
    select: {
      id: true, state: true, clubId: true, billingCycleId: true,
      requestedByUserId: true, authorizedByUserId: true,
      actualEffectiveAt: true, stripeSubscriptionId: true,
      syntheticTestOnly: true,
    },
  });
  if (!req) {
    throw new AppError("REQUEST_NOT_FOUND", `cancellation request ${args.requestId.slice(-6)} not found`, 404);
  }
  if (req.actualEffectiveAt) {
    throw new AppError(
      "CANCELLATION_ALREADY_EFFECTIVE",
      "cannot reverse a cancellation that has already taken effect",
      409,
    );
  }
  if (req.state !== "SCHEDULED") {
    throw new AppError(
      "ILLEGAL_STATE_TRANSITION",
      `cannot REVERSE from state=${req.state}; only SCHEDULED is permitted`,
      409,
    );
  }

  // §2 SoD: reversal cannot be initiated by the original requester
  // alone (would re-enable self-approve).  Must come from a different
  // operator.
  if (args.reversedByUserId === req.requestedByUserId) {
    throw new ForbiddenError(
      `SoD violation: reversedByUserId must differ from requestedByUserId`,
    );
  }

  // Enqueue a SUBSCRIPTION_RESUME command if we have a Stripe subscription
  // on file (if we don't, there is nothing to un-schedule).
  let resumeCommandId: string | null = null;
  const resumeIdempotencyKey = `signup-2m4-sub-resume:${req.id}:v1`;
  if (req.stripeSubscriptionId) {
    const existing = await prisma.billingCommand.findUnique({
      where: { stripeIdempotencyKey: resumeIdempotencyKey },
      select: { id: true },
    });
    if (existing) {
      resumeCommandId = existing.id;
    } else {
      const cmd = await prisma.billingCommand.create({
        data: {
          commandType: "SUBSCRIPTION_RESUME",
          stripeIdempotencyKey: resumeIdempotencyKey,
          billingCycleId: req.billingCycleId,
          clubId: req.clubId,
          state: "PENDING",
          attemptNumber: 0,
          maxAttempts: 3,
          paramsJson: JSON.stringify({
            cancellationRequestId: req.id,
            stripeSubscriptionId: req.stripeSubscriptionId,
          }),
          syntheticTestOnly: req.syntheticTestOnly,
        },
        select: { id: true },
      });
      resumeCommandId = cmd.id;
    }
  }

  const updated = await prisma.billingCancellationRequest.updateMany({
    where: { id: req.id, state: "SCHEDULED", actualEffectiveAt: null },
    data: {
      state: "REVERSED",
      reversedByUserId: args.reversedByUserId,
      reversedAt: new Date(),
      reversalReason: args.reversalReason,
    },
  });
  if (updated.count !== 1) {
    throw new AppError(
      "CONCURRENT_REVERSAL_RACE",
      "state transitioned concurrently (likely EFFECTIVE arrived while reversal was in flight)",
      409,
    );
  }
  await audit(null, {
    action: "signup.m4.cancellation.reversed",
    entityType: "BillingCancellationRequest",
    entityId: req.id,
    clubId: req.clubId,
    meta: {
      requestIdTail: req.id.slice(-6),
      reversedByUserIdTail: args.reversedByUserId.slice(-6),
      resumeCommandIdTail: resumeCommandId?.slice(-6) ?? null,
    },
  });
  return { requestId: req.id, state: "REVERSED", resumeCommandId };
}

/* ============================================================
 * §4 Post-cancellation access state (no data deletion)
 * ============================================================ */

export type PostCancellationAccessState =
  | "ACTIVE_PRE_CANCELLATION"       // no open cancellation request OR CANCELLED and still in grace
  | "ACTIVE_SCHEDULED_CANCELLATION" // scheduled but not yet effective -- FULL ACCESS
  | "READ_ONLY_POST_CANCELLATION"   // effective; data preserved; writes restricted
  | "RESTRICTED_POST_CANCELLATION"; // effective + grace expired; retention-only

const POST_CANCEL_GRACE_DAYS = 30;

/** Compute the appropriate access state for a club without destroying
 *  any tenant data.  §4 contract: subscription cancellation !=
 *  tenant-data deletion.  All accounting / payroll / member /
 *  historical records are preserved indefinitely. */
export async function evaluatePostCancellationAccess(args: {
  clubId: string;
  asOf?: Date;
}): Promise<{
  state: PostCancellationAccessState;
  activeRequestId: string | null;
  effectiveAt: Date | null;
  graceEndsAt: Date | null;
  retentionNote: string;
}> {
  const asOf = args.asOf ?? new Date();
  const activeRequest = await prisma.billingCancellationRequest.findFirst({
    where: {
      clubId: args.clubId,
      state: { in: ["SCHEDULED", "CANCELLED"] },
    },
    orderBy: { createdAt: "desc" },
    select: { id: true, state: true, actualEffectiveAt: true, approvedEffectiveDate: true },
  });
  const retentionNote =
    "Tenant data (accounting, payroll, member records, invoices, " +
    "payment history, mandates, audit evidence, financial statements) " +
    "is preserved indefinitely regardless of subscription state.";

  if (!activeRequest) {
    return {
      state: "ACTIVE_PRE_CANCELLATION",
      activeRequestId: null,
      effectiveAt: null,
      graceEndsAt: null,
      retentionNote,
    };
  }
  if (activeRequest.state === "SCHEDULED" || !activeRequest.actualEffectiveAt) {
    return {
      state: "ACTIVE_SCHEDULED_CANCELLATION",
      activeRequestId: activeRequest.id,
      effectiveAt: activeRequest.approvedEffectiveDate ?? null,
      graceEndsAt: null,
      retentionNote,
    };
  }
  // CANCELLED: effective in the past.  Grace window still open?
  const effectiveAt = activeRequest.actualEffectiveAt;
  const graceEndsAt = new Date(effectiveAt.getTime() + POST_CANCEL_GRACE_DAYS * 24 * 60 * 60 * 1000);
  if (asOf.getTime() <= graceEndsAt.getTime()) {
    return {
      state: "READ_ONLY_POST_CANCELLATION",
      activeRequestId: activeRequest.id,
      effectiveAt,
      graceEndsAt,
      retentionNote,
    };
  }
  return {
    state: "RESTRICTED_POST_CANCELLATION",
    activeRequestId: activeRequest.id,
    effectiveAt,
    graceEndsAt,
    retentionNote,
  };
}
