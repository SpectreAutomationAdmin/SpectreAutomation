// SIGNUP-2 M4-triggering (2026-10-28) -- Commercial authorization +
// final payment release + durable billing command creation.
//
// This is the AUTHORISATION side.  No stripe.subscriptions.create
// fires from this file.  The queue-draining worker (also in this file:
// drainOneBillingCommand) is the executor side; it is additionally
// gated by SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION (M3 §7 global block)
// AND SPECTRE_SIGNUP_2M4_TRIGGER_LIVE (this slice's flag).  Both must
// be ON for a real subscription to be attempted.
//
// Decision #1 (two-operator SoD): commercialApprovedByUserId must
// differ from releaseApprovedByUserId.  Enforced in-service.
// Decision #5 (explicit evidence): validates ClubContractExecution +
// ClubBillingPricing + ClubPaymentAuthorisation rows are complete
// before releasing.
// Correction #10 (durable idempotent command): the release writes
// ClubBillingRelease + BillingCommand in ONE $transaction with
// release.consumedByBillingCommandId linking the two.  No external
// Stripe call happens in the authorisation path.
//
// Scope boundaries (per founder M4-triggering authorisation):
//   - No M4-settlement, M4-retries, M4-renewal, M4-cancellation.
//   - No accelerated synthetic signup-to-activation path.
//   - No bypass of M3's payment-initiation flag.

import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import { AppError, ForbiddenError } from "@/lib/errors";
import { resolveStripeAdapter, resolveAcssPriceId } from "./stripe-adapter";

/* ============================================================
 * Flag guard (fail-closed)
 * ============================================================ */

/** M4-triggering (2026-10-28): gates authoriseAndReleaseFirstBilling +
 *  drainOneBillingCommand.  OFF by default.  Independent of M3's
 *  payment-initiation flag -- subscription creation requires BOTH
 *  flags ON. */
export function assertM4TriggerLiveFlag(): void {
  if (process.env.SPECTRE_SIGNUP_2M4_TRIGGER_LIVE !== "1") {
    throw new ForbiddenError(
      "SIGNUP-2 M4-triggering workflow is disabled (SPECTRE_SIGNUP_2M4_TRIGGER_LIVE != 1)",
    );
  }
}

/* ============================================================
 * Preflight validation (§C 6 items)
 * ============================================================ */

export type PreflightRefusalReason =
  | "REGISTRATION_NOT_FOUND"
  | "REGISTRATION_NOT_VERIFIED"
  | "REGISTRATION_SYNTHETIC_LEAKED_TO_PRODUCTION_PATH"
  | "CYCLE_NOT_FOUND"
  | "CYCLE_NOT_BANK_VERIFIED"
  | "MANDATE_NOT_FOUND"
  | "MANDATE_REVOKED"
  | "CONTRACT_EXECUTION_MISSING"
  | "GOVERNANCE_REQUIRED_BUT_MISSING"
  | "PRICING_MISSING"
  | "PRICING_CONTRACT_MISMATCH"
  | "COMMERCIAL_AUTHORISATION_MISSING"
  | "COMMERCIAL_AUTHORISATION_PRICING_MISMATCH"
  | "AUTHORISED_AMOUNT_MISMATCH_PRICING"
  | "AUTHORISED_CURRENCY_MISMATCH_PRICING"
  | "DUPLICATE_RELEASE_ALREADY_EXISTS"
  | "DUPLICATE_PENDING_COMMAND"
  | "SUBSCRIPTION_ALREADY_INITIATED";

export interface PreflightInput {
  signupRegistrationId: string;
  billingCycleId: string;
}

export interface PreflightResult {
  ok: boolean;
  reason?: PreflightRefusalReason;
  detail?: string;
  // When ok=true, the loaded set of rows the release step will use.
  context?: {
    registrationId: string;
    syntheticTestOnly: boolean;
    cycleId: string;
    cycleClubId: string;
    mandateId: string;
    stripeMandateId: string;
    stripePaymentMethodId: string;
    contractExecutionId: string;
    governanceRequired: boolean;
    pricingId: string;
    pricingAmountMinorUnits: bigint;
    pricingCurrency: string;
    authorisationId: string;
    commercialApprovedByUserId: string;
  };
}

/** Pure-ish preflight: database reads + business-rule validation.
 *  Does NOT consume anything; safe to call repeatedly. */
export async function evaluatePreflight(
  args: PreflightInput,
): Promise<PreflightResult> {
  // 1. Registration + 2. VERIFIED state
  const reg = await prisma.signupRegistration.findUnique({
    where: { id: args.signupRegistrationId },
    select: {
      id: true,
      status: true,
      syntheticTestOnly: true,
      verificationVerdict: true,
    },
  });
  if (!reg) return { ok: false, reason: "REGISTRATION_NOT_FOUND" };
  if (reg.status !== "VERIFIED") {
    return { ok: false, reason: "REGISTRATION_NOT_VERIFIED", detail: `status=${reg.status}` };
  }

  // 3. BillingCycle BANK_VERIFIED
  const cycle = await prisma.billingCycle.findUnique({
    where: { id: args.billingCycleId },
    select: {
      id: true, clubId: true, subscriptionStatus: true, stripePaymentIntentId: true,
      syntheticTestOnly: true,
      releasedByOperatorRecord: { select: { signupRegistrationId: true } },
    },
  });
  if (!cycle) return { ok: false, reason: "CYCLE_NOT_FOUND" };
  if (cycle.releasedByOperatorRecord?.signupRegistrationId !== args.signupRegistrationId) {
    return { ok: false, reason: "CYCLE_NOT_FOUND", detail: "cycle not linked to this registration" };
  }
  if (cycle.subscriptionStatus !== "BANK_VERIFIED") {
    return { ok: false, reason: "CYCLE_NOT_BANK_VERIFIED", detail: `cycle status=${cycle.subscriptionStatus}` };
  }
  if (cycle.stripePaymentIntentId !== null) {
    return { ok: false, reason: "SUBSCRIPTION_ALREADY_INITIATED", detail: "cycle already has a payment intent" };
  }
  // Enforce isolation: synthetic registrations have syntheticTestOnly=true
  // cycles.  Production registrations must have syntheticTestOnly=false.
  if (reg.syntheticTestOnly !== cycle.syntheticTestOnly) {
    return {
      ok: false,
      reason: "REGISTRATION_SYNTHETIC_LEAKED_TO_PRODUCTION_PATH",
      detail: `reg.syntheticTestOnly=${reg.syntheticTestOnly} vs cycle.syntheticTestOnly=${cycle.syntheticTestOnly}`,
    };
  }

  // 4. Mandate present + not revoked
  const mandate = await prisma.subscriptionPaymentMandate.findFirst({
    where: { signupRegistrationId: args.signupRegistrationId },
    orderBy: { acceptedAt: "desc" },
    select: {
      id: true, stripeMandateId: true, stripePaymentMethodId: true,
      revokedAt: true, syntheticTestOnly: true,
    },
  });
  if (!mandate) return { ok: false, reason: "MANDATE_NOT_FOUND" };
  if (mandate.revokedAt !== null) {
    return { ok: false, reason: "MANDATE_REVOKED", detail: `revoked at ${mandate.revokedAt.toISOString()}` };
  }

  // 5. Contract execution evidence present
  const contract = await prisma.clubContractExecution.findUnique({
    where: { signupRegistrationId: args.signupRegistrationId },
    select: { id: true, governanceRequired: true, governanceApprovedAt: true },
  });
  if (!contract) return { ok: false, reason: "CONTRACT_EXECUTION_MISSING" };
  if (contract.governanceRequired && contract.governanceApprovedAt === null) {
    return { ok: false, reason: "GOVERNANCE_REQUIRED_BUT_MISSING" };
  }

  // 6. Pricing present + linked to the contract
  const pricing = await prisma.clubBillingPricing.findUnique({
    where: { signupRegistrationId: args.signupRegistrationId },
    select: {
      id: true, contractExecutionId: true, stripePriceId: true,
      amountMinorUnits: true, currency: true, taxTreatment: true, billingInterval: true,
    },
  });
  if (!pricing) return { ok: false, reason: "PRICING_MISSING" };
  if (pricing.contractExecutionId !== contract.id) {
    return { ok: false, reason: "PRICING_CONTRACT_MISMATCH" };
  }

  // 7. Commercial authorisation present + linked to pricing
  const auth = await prisma.clubPaymentAuthorisation.findUnique({
    where: { signupRegistrationId: args.signupRegistrationId },
    select: {
      id: true, pricingId: true, contractExecutionId: true,
      commercialApprovedByUserId: true, commercialApprovedAt: true,
      authorisedAmountMinorUnits: true, authorisedCurrency: true,
    },
  });
  if (!auth) return { ok: false, reason: "COMMERCIAL_AUTHORISATION_MISSING" };
  if (auth.pricingId !== pricing.id) {
    return { ok: false, reason: "COMMERCIAL_AUTHORISATION_PRICING_MISMATCH" };
  }
  // Amount + currency the operator A authorised MUST match the current pricing.
  if (auth.authorisedAmountMinorUnits !== pricing.amountMinorUnits) {
    return {
      ok: false,
      reason: "AUTHORISED_AMOUNT_MISMATCH_PRICING",
      detail: `authorised=${auth.authorisedAmountMinorUnits} vs pricing=${pricing.amountMinorUnits}`,
    };
  }
  if (auth.authorisedCurrency !== pricing.currency) {
    return {
      ok: false,
      reason: "AUTHORISED_CURRENCY_MISMATCH_PRICING",
      detail: `authorised=${auth.authorisedCurrency} vs pricing=${pricing.currency}`,
    };
  }

  // 8. No existing release for this cycle (prevent duplicate billing).
  const existingRelease = await prisma.clubBillingRelease.findUnique({
    where: { billingCycleId: args.billingCycleId },
    select: { id: true },
  });
  if (existingRelease) {
    return {
      ok: false,
      reason: "DUPLICATE_RELEASE_ALREADY_EXISTS",
      detail: `release id ${existingRelease.id.slice(-6)}`,
    };
  }

  // 9. No pending/attempted command for this cycle (prevent duplicate collection).
  const existingPendingCommand = await prisma.billingCommand.findFirst({
    where: {
      billingCycleId: args.billingCycleId,
      commandType: "SUBSCRIPTION_CREATE_FIRST",
      state: { in: ["PENDING", "ATTEMPTED", "UNCERTAIN", "SUCCEEDED"] },
    },
    select: { id: true, state: true },
  });
  if (existingPendingCommand) {
    return {
      ok: false,
      reason: "DUPLICATE_PENDING_COMMAND",
      detail: `command ${existingPendingCommand.id.slice(-6)} state=${existingPendingCommand.state}`,
    };
  }

  return {
    ok: true,
    context: {
      registrationId: reg.id,
      syntheticTestOnly: reg.syntheticTestOnly,
      cycleId: cycle.id,
      cycleClubId: cycle.clubId,
      mandateId: mandate.id,
      stripeMandateId: mandate.stripeMandateId,
      stripePaymentMethodId: mandate.stripePaymentMethodId,
      contractExecutionId: contract.id,
      governanceRequired: contract.governanceRequired,
      pricingId: pricing.id,
      pricingAmountMinorUnits: pricing.amountMinorUnits,
      pricingCurrency: pricing.currency,
      authorisationId: auth.id,
      commercialApprovedByUserId: auth.commercialApprovedByUserId,
    },
  };
}

/* ============================================================
 * authoriseAndReleaseFirstBilling
 * ============================================================ */

export interface AuthoriseAndReleaseInput {
  signupRegistrationId: string;
  billingCycleId: string;
  releaseApprovedByUserId: string;
  releaseApprovalNotes?: string;
  /** Idempotency scope.  Pass a stable token derived from the operator
   *  action id (e.g. UI form submission).  Reused call-sites get the
   *  same release + command. */
  idempotencyScope: string;
}

export interface AuthoriseAndReleaseResult {
  releaseId: string;
  billingCommandId: string;
  stripeIdempotencyKey: string;
  noop: boolean;
}

/** Decision #1 + Correction #10: operator B records the final payment
 *  release and the system atomically enqueues a durable BillingCommand.
 *  SoD enforced here (operator B MUST != operator A).  No Stripe call
 *  happens from this function. */
export async function authoriseAndReleaseFirstBilling(
  args: AuthoriseAndReleaseInput,
): Promise<AuthoriseAndReleaseResult> {
  assertM4TriggerLiveFlag();

  // §C preflight check (all 6 items + extras).
  const pf = await evaluatePreflight({
    signupRegistrationId: args.signupRegistrationId,
    billingCycleId: args.billingCycleId,
  });
  if (!pf.ok || !pf.context) {
    throw new AppError(
      "SIGNUP_2M4_TRIGGER_PREFLIGHT_FAILED",
      `preflight refused: ${pf.reason ?? "unknown"}${pf.detail ? ` -- ${pf.detail}` : ""}`,
      409,
    );
  }
  const ctx = pf.context;

  // Decision #1: SoD -- operator B MUST != operator A.
  if (args.releaseApprovedByUserId === ctx.commercialApprovedByUserId) {
    throw new ForbiddenError(
      `SoD violation: releaseApprovedByUserId must differ from commercialApprovedByUserId (both are '${args.releaseApprovedByUserId.slice(-6)}')`,
    );
  }

  // Idempotent-replay: if a release already exists via the scope key
  // (deterministic over cycle + idempotencyScope), return existing.
  // We use a sha256 of the inputs as the releaseToken value so a retry
  // from the same UI form submission maps to the same row.
  const { createHash } = await import("node:crypto");
  const releaseToken = createHash("sha256")
    .update(`m4-release:${args.billingCycleId}:${args.idempotencyScope}`)
    .digest("hex");
  const stripeIdempotencyKey = `signup-2m4-sub-create:${args.billingCycleId}:v1`;

  const existing = await prisma.clubBillingRelease.findUnique({
    where: { releaseToken },
    select: { id: true, consumedByBillingCommandId: true },
  });
  if (existing && existing.consumedByBillingCommandId) {
    logger.info("signup.m4.triggering.authorise.replay", {
      registrationIdTail: args.signupRegistrationId.slice(-6),
      releaseIdTail: existing.id.slice(-6),
      commandIdTail: existing.consumedByBillingCommandId.slice(-6),
    });
    return {
      releaseId: existing.id,
      billingCommandId: existing.consumedByBillingCommandId,
      stripeIdempotencyKey,
      noop: true,
    };
  }

  // Atomic: ClubBillingRelease + BillingCommand in ONE transaction.
  const result = await prisma.$transaction(async (tx) => {
    const release = await tx.clubBillingRelease.create({
      data: {
        signupRegistrationId: args.signupRegistrationId,
        billingCycleId: args.billingCycleId,
        authorisationId: ctx.authorisationId,
        releaseApprovedByUserId: args.releaseApprovedByUserId,
        releaseApprovedAt: new Date(),
        releaseApprovalNotes: args.releaseApprovalNotes ?? null,
        releaseToken,
        syntheticTestOnly: ctx.syntheticTestOnly,
      },
      select: { id: true },
    });

    const command = await tx.billingCommand.create({
      data: {
        commandType: "SUBSCRIPTION_CREATE_FIRST",
        stripeIdempotencyKey,
        billingCycleId: args.billingCycleId,
        clubId: ctx.cycleClubId,
        state: "PENDING",
        attemptNumber: 0,
        maxAttempts: 3,
        paramsJson: JSON.stringify({
          signupRegistrationId: args.signupRegistrationId,
          mandateId: ctx.mandateId,
          stripeMandateId: ctx.stripeMandateId,
          stripePaymentMethodId: ctx.stripePaymentMethodId,
          pricingAmountMinorUnits: ctx.pricingAmountMinorUnits.toString(),
          pricingCurrency: ctx.pricingCurrency,
          authorisationId: ctx.authorisationId,
          releaseId: release.id,
        }),
        releaseId: release.id,
        syntheticTestOnly: ctx.syntheticTestOnly,
      },
      select: { id: true },
    });

    // §B: the release authorization MUST be durably associated with the
    // command before any external Stripe mutation.  Linking happens in
    // the same transaction.
    await tx.clubBillingRelease.update({
      where: { id: release.id },
      data: {
        releaseTokenConsumedAt: new Date(),
        consumedByBillingCommandId: command.id,
      },
    });
    return { releaseId: release.id, commandId: command.id };
  });

  await audit(null, {
    action: "signup.m4.triggering.authorised",
    entityType: "ClubBillingRelease",
    entityId: result.releaseId,
    clubId: null,
    meta: {
      registrationIdTail: args.signupRegistrationId.slice(-6),
      cycleIdTail: args.billingCycleId.slice(-6),
      releaseIdTail: result.releaseId.slice(-6),
      commandIdTail: result.commandId.slice(-6),
      stripeIdempotencyKey,
      commercialApprovedByUserIdTail: ctx.commercialApprovedByUserId.slice(-6),
      releaseApprovedByUserIdTail: args.releaseApprovedByUserId.slice(-6),
      syntheticTestOnly: ctx.syntheticTestOnly,
    },
  });
  logger.info("signup.m4.triggering.authorised", {
    registrationIdTail: args.signupRegistrationId.slice(-6),
    cycleIdTail: args.billingCycleId.slice(-6),
    releaseIdTail: result.releaseId.slice(-6),
    commandIdTail: result.commandId.slice(-6),
  });

  return {
    releaseId: result.releaseId,
    billingCommandId: result.commandId,
    stripeIdempotencyKey,
    noop: false,
  };
}

/* ============================================================
 * Billing command worker (drains one command)
 * ============================================================ */

export type CommandDrainOutcome =
  | "SUCCEEDED"
  | "FAILED"
  | "UNCERTAIN"
  | "DEFERRED"
  | "TERMINAL"
  | "NOOP_WRONG_STATE"
  | "NOOP_PAYMENT_INITIATION_DISABLED";

export interface CommandDrainResult {
  commandId: string;
  previousState: string;
  outcome: CommandDrainOutcome;
  attemptNumber: number;
  stripeResourceId?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/** M4-triggering (2026-10-28) -- worker entry point for one command.
 *  Loads the command FOR UPDATE, transitions state, and (if the
 *  payment-initiation flag ON) delegates to advanceToPaymentInitiated.
 *
 *  Correction #10 recovery semantics:
 *    - Each attempt uses the SAME stripeIdempotencyKey.  Stripe
 *      returns the existing subscription on replay.
 *    - On timeout / network error: state=UNCERTAIN; the next attempt
 *      re-sends with the same key.  Stripe de-dupes.
 *    - On explicit 4xx error from Stripe: state=FAILED; operator
 *      triage required.
 *    - Attempts beyond maxAttempts: state=TERMINAL.
 */
export async function drainOneBillingCommand(commandId: string): Promise<CommandDrainResult> {
  assertM4TriggerLiveFlag();

  // Load the command.  Postgres FOR UPDATE lock the row for the
  // duration of this call to prevent two workers from racing.
  const result = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<{
      id: string; commandType: string; state: string; attemptNumber: number;
      maxAttempts: number; stripeIdempotencyKey: string; billingCycleId: string;
      clubId: string; paramsJson: string | null; syntheticTestOnly: boolean;
    }>>(
      `SELECT id, "commandType", state, "attemptNumber", "maxAttempts", "stripeIdempotencyKey",
              "billingCycleId", "clubId", "paramsJson", "syntheticTestOnly"
       FROM "BillingCommand" WHERE id = $1 FOR UPDATE`,
      commandId,
    );
    if (!rows || rows.length === 0) {
      throw new AppError("SIGNUP_2M4_COMMAND_NOT_FOUND", `BillingCommand ${commandId.slice(-6)} not found`, 404);
    }
    const cmd = rows[0];
    const prevState = cmd.state;

    // Terminal/success states don't retry.
    if (cmd.state === "SUCCEEDED" || cmd.state === "TERMINAL") {
      return { prevState, outcome: "NOOP_WRONG_STATE" as const, attemptNumber: cmd.attemptNumber };
    }
    // Only PENDING / UNCERTAIN / DEFERRED / FAILED may advance here.
    const allowedStates = new Set(["PENDING", "UNCERTAIN", "DEFERRED", "FAILED"]);
    if (!allowedStates.has(cmd.state)) {
      return { prevState, outcome: "NOOP_WRONG_STATE" as const, attemptNumber: cmd.attemptNumber };
    }

    // Exceeded max attempts -> TERMINAL.
    const nextAttempt = cmd.attemptNumber + 1;
    if (nextAttempt > cmd.maxAttempts) {
      await tx.billingCommand.update({
        where: { id: cmd.id },
        data: { state: "TERMINAL", terminalAt: new Date() },
      });
      return { prevState, outcome: "TERMINAL" as const, attemptNumber: cmd.attemptNumber };
    }

    // Transition to ATTEMPTED + bump counter in the same transaction.
    await tx.billingCommand.update({
      where: { id: cmd.id },
      data: { state: "ATTEMPTED", attemptNumber: nextAttempt },
    });

    return { prevState, cmd, attemptNumber: nextAttempt };
  });

  if (result.outcome === "NOOP_WRONG_STATE" || result.outcome === "TERMINAL") {
    return {
      commandId,
      previousState: result.prevState,
      outcome: result.outcome,
      attemptNumber: result.attemptNumber,
    };
  }
  const cmd = (result as { cmd: NonNullable<ReturnType<() => any>> }).cmd;

  // Guard: payment-initiation flag MUST be ON for the actual Stripe
  // call to fire.  When OFF, defer the command (state=DEFERRED) so
  // operator can see what's pending without any Stripe side-effects.
  const paymentInitEnabled = process.env.SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION === "1";
  if (!paymentInitEnabled) {
    await prisma.billingCommand.update({
      where: { id: commandId },
      data: {
        state: "DEFERRED",
        lastErrorCode: "PAYMENT_INITIATION_DISABLED",
        lastErrorMessage: "SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION != 1; subscription create deferred",
        lastErrorAt: new Date(),
      },
    });
    logger.info("signup.m4.triggering.worker.deferred_m3_flag_off", {
      commandIdTail: commandId.slice(-6),
      cycleIdTail: cmd.billingCycleId.slice(-6),
    });
    return {
      commandId,
      previousState: result.prevState,
      outcome: "NOOP_PAYMENT_INITIATION_DISABLED",
      attemptNumber: result.attemptNumber,
    };
  }

  // Both flags ON: delegate to M3's advanceToPaymentInitiated.
  // That function performs the §5 Stripe-state re-validation + the
  // actual subscriptions.create.  The idempotency key here is the
  // command's stripeIdempotencyKey -- Stripe de-dupes if retried.
  //
  // Correction #10: on timeout/network error we transition to UNCERTAIN
  // + record error; next attempt re-invokes with same key.  On explicit
  // Stripe error we transition to FAILED.
  const params = JSON.parse(cmd.paramsJson ?? "{}");
  try {
    const { advanceToPaymentInitiated } = await import("./signup-2m3-bank-verification-service");
    const advance = await advanceToPaymentInitiated({
      billingCycleId: cmd.billingCycleId,
      signupRegistrationId: params.signupRegistrationId,
      invokerSource: "SCHEDULED_JOB",
      invokerUserId: null,
    });
    await prisma.billingCommand.update({
      where: { id: commandId },
      data: {
        state: "SUCCEEDED",
        stripeResourceId: advance.stripeSubscriptionId ?? null,
        stripeResourceType: "subscription",
        succeededAt: new Date(),
      },
    });
    await audit(null, {
      action: "signup.m4.triggering.worker.succeeded",
      entityType: "BillingCommand",
      entityId: commandId,
      clubId: null,
      meta: {
        commandIdTail: commandId.slice(-6),
        attemptNumber: result.attemptNumber,
        stripeSubscriptionIdTail: advance.stripeSubscriptionId?.slice(-8) ?? null,
      },
    });
    return {
      commandId,
      previousState: result.prevState,
      outcome: "SUCCEEDED",
      attemptNumber: result.attemptNumber,
      stripeResourceId: advance.stripeSubscriptionId ?? null,
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errCode =
      (err as { code?: string } | undefined)?.code ??
      (err instanceof AppError ? err.code : null) ??
      null;
    // Classify: timeout/network/5xx -> UNCERTAIN (retry OK).
    // Explicit 4xx or AppError -> FAILED.
    const isUncertain =
      /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|StripeConnectionError|StripeAPIError|5\d\d/i.test(errMsg);
    const newState = isUncertain ? "UNCERTAIN" : "FAILED";
    await prisma.billingCommand.update({
      where: { id: commandId },
      data: {
        state: newState,
        lastErrorCode: errCode?.slice(0, 128) ?? null,
        lastErrorMessage: errMsg.slice(0, 500),
        lastErrorAt: new Date(),
      },
    });
    await audit(null, {
      action: `signup.m4.triggering.worker.${newState.toLowerCase()}`,
      entityType: "BillingCommand",
      entityId: commandId,
      clubId: null,
      meta: {
        commandIdTail: commandId.slice(-6),
        attemptNumber: result.attemptNumber,
        errorCode: errCode,
        errorMessageTail: errMsg.slice(0, 200),
      },
    });
    return {
      commandId,
      previousState: result.prevState,
      outcome: newState,
      attemptNumber: result.attemptNumber,
      errorCode: errCode,
      errorMessage: errMsg,
    };
  }
}

/* ============================================================
 * M4-INT-B §1 (2026-10-29): Operator A -- commercial authorization
 * ============================================================
 * The release step (operator B) requires an existing
 * ClubPaymentAuthorisation row.  Operator A records that record
 * from the UI by naming the pricing + contract execution.  SoD
 * check against the release path is enforced by
 * authoriseAndReleaseFirstBilling (release operator MUST differ
 * from commercial operator). */

export interface RecordCommercialAuthorisationInput {
  signupRegistrationId: string;
  commercialApprovedByUserId: string;
  commercialApprovalNotes?: string;
}

export interface RecordCommercialAuthorisationResult {
  authorisationId: string;
  noop: boolean;
}

export async function recordCommercialAuthorisation(
  args: RecordCommercialAuthorisationInput,
): Promise<RecordCommercialAuthorisationResult> {
  assertM4TriggerLiveFlag();

  // Idempotent replay: if an authorization already exists for this
  // registration, return it (same shape as release-path replay).
  const existing = await prisma.clubPaymentAuthorisation.findUnique({
    where: { signupRegistrationId: args.signupRegistrationId },
    select: { id: true, commercialApprovedByUserId: true },
  });
  if (existing) {
    // §2 SoD does NOT apply within commercial authorization itself
    // (only one commercial operator).  The SoD guard that matters
    // sits on the RELEASE side.
    return { authorisationId: existing.id, noop: true };
  }

  // Pricing + contract must exist first (recorded earlier in signup).
  const pricing = await prisma.clubBillingPricing.findUnique({
    where: { signupRegistrationId: args.signupRegistrationId },
    select: {
      id: true, contractExecutionId: true, currency: true, amountMinorUnits: true,
    },
  });
  if (!pricing) {
    throw new AppError(
      "SIGNUP_2M4_TRIGGER_PRICING_MISSING",
      "pricing has not been recorded for this registration",
      409,
    );
  }

  const created = await prisma.clubPaymentAuthorisation.create({
    data: {
      signupRegistrationId: args.signupRegistrationId,
      pricingId: pricing.id,
      contractExecutionId: pricing.contractExecutionId,
      commercialApprovedByUserId: args.commercialApprovedByUserId,
      commercialApprovedAt: new Date(),
      commercialApprovalNotes: args.commercialApprovalNotes ?? null,
      authorisedAmountMinorUnits: pricing.amountMinorUnits,
      authorisedCurrency: pricing.currency,
    },
    select: { id: true },
  });

  await audit(null, {
    action: "signup.m4.trigger.commercial_authorisation_recorded",
    entityType: "ClubPaymentAuthorisation",
    entityId: created.id,
    clubId: null,
    meta: {
      authorisationIdTail: created.id.slice(-6),
      signupRegistrationIdTail: args.signupRegistrationId.slice(-6),
      commercialApprovedByUserIdTail: args.commercialApprovedByUserId.slice(-6),
      amountMinorUnits: pricing.amountMinorUnits.toString(),
      currency: pricing.currency,
    },
  });

  return { authorisationId: created.id, noop: false };
}
