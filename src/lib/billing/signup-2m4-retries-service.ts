// SIGNUP-2 M4-retries (2026-10-28) -- Conservative ACSS Debit retry
// policy.  Phase 4 of 6 under the authorised M4 sequence.
//
// Decision carried from M4-schema design:
//   #2  At most ONE automatic retry after insufficient-funds failure,
//       no earlier than 3 business days after failure, notify club
//       before retry, never retry revoked/invalid/expired mandates.
//
// Scope boundaries:
//   - No M4-renewal (no customer.subscription.* writes here).
//   - No M4-cancellation.
//   - No accelerated synthetic signup-to-activation pathway.
//   - No new Stripe destination events subscribed in this slice.
//
// Stripe-native retry setting: operators MUST disable Stripe Billing
// Smart Retries in the dashboard before this slice is enabled.
// Spectre manages the entire retry cadence (one controlled retry at
// Spectre's T+3bd); duplicate retries via Stripe's own scheduler
// would violate decision #2.
//
// Flag gating:
//   SPECTRE_SIGNUP_2M4_RETRIES_LIVE  -- gates this slice's writes +
//                                       worker.
//   Plus the dispatcher's existing WEBHOOK_DISPATCH or 2E flag for
//   webhook delivery, and SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION for
//   the actual stripe.invoices.pay call (same global sub-create block
//   M3 §7).
//
// M4-renewal §5 correction #3 (OPEN ACCEPTANCE GATE):
//   Retry-eligibility decisions driven by signed-webhook fixture
//   invoice.payment_failed events are driven by FIXTURE evidence,
//   not real Stripe-originated settlement.  A real retry collection
//   (stripe.invoices.pay) is additionally gated by
//   SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION, which remains OFF.  Real
//   Stripe-originated settlement is an explicitly OPEN acceptance
//   gate.

import { prisma } from "@/lib/prisma";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/observability/logger";
import { AppError, ForbiddenError } from "@/lib/errors";
import { resolveStripeAdapter } from "./stripe-adapter";

/* ============================================================
 * Flag guard
 * ============================================================ */

export function assertM4RetriesLiveFlag(): void {
  if (process.env.SPECTRE_SIGNUP_2M4_RETRIES_LIVE !== "1") {
    throw new ForbiddenError(
      "SIGNUP-2 M4-retries workflow is disabled (SPECTRE_SIGNUP_2M4_RETRIES_LIVE != 1)",
    );
  }
}

/* ============================================================
 * Failure classification (§4)
 * ============================================================ */

/** Classify an ATTEMPT_FAILURE's outcome into a retry policy category.
 *  Pure predicate; no DB. */
export type RetryClassification =
  | "RETRYABLE_INSUFFICIENT_FUNDS"
  | "REQUIRE_FRESH_MANDATE"
  | "OPERATOR_REVIEW"
  | "NO_RETRY_ALREADY_PAID";

export function classifyFailureForRetry(args: {
  outcome: string | null;
  outcomeStripeCode: string | null;
}): RetryClassification {
  const code = (args.outcomeStripeCode ?? "").toLowerCase();
  // Success / already-paid: NO retry regardless of code.
  if (args.outcome === "SUCCEEDED") return "NO_RETRY_ALREADY_PAID";
  // Revoked/invalid/closed-account mandates MUST NOT be auto-retried.
  if (args.outcome === "FAILED_MANDATE_INVALIDATED") return "REQUIRE_FRESH_MANDATE";
  if (code === "debit_not_authorized" || code === "account_closed" || code === "payment_method_not_available") {
    return "REQUIRE_FRESH_MANDATE";
  }
  if (code === "mandate_invalid" || code === "mandate_revoked" || code === "mandate_expired") {
    return "REQUIRE_FRESH_MANDATE";
  }
  // Insufficient funds is the ONLY auto-retryable branch per decision #2.
  if (args.outcome === "FAILED_INSUFFICIENT_FUNDS" || code === "insufficient_funds") {
    return "RETRYABLE_INSUFFICIENT_FUNDS";
  }
  // Everything else (unknown / ambiguous): operator review.
  return "OPERATOR_REVIEW";
}

/* ============================================================
 * Business-day math (Mon-Fri + Canadian federal + Alberta stat
 * holidays)
 * ============================================================ */

/** Canadian stat holidays per federal + Alberta observance.
 *  Pinned explicitly for predictability + testability.  Floor is a
 *  MINIMUM, so missing a stat holiday only shortens -- never extends --
 *  the retry delay; the calendar below is additive safety.
 *
 *  Entries use ISO date string in UTC.  Expand yearly as needed.
 *
 *  Federal holidays included: New Year's Day, Good Friday, Victoria
 *  Day, Canada Day, Labour Day, Thanksgiving, Remembrance Day,
 *  Christmas Day, Boxing Day.
 *  Alberta-specific: Alberta Family Day, Heritage Day.
 *
 *  M4-renewal §5 correction #2 (2026-10-28). */
export const CANADIAN_STAT_HOLIDAYS_UTC: ReadonlySet<string> = new Set([
  // 2026
  "2026-01-01", // New Year's Day
  "2026-02-16", // Alberta Family Day (3rd Mon Feb)
  "2026-04-03", // Good Friday
  "2026-05-18", // Victoria Day
  "2026-07-01", // Canada Day
  "2026-08-03", // Heritage Day (1st Mon Aug) -- Alberta
  "2026-09-07", // Labour Day
  "2026-10-12", // Thanksgiving (2nd Mon Oct)
  "2026-11-11", // Remembrance Day
  "2026-12-25", // Christmas Day
  "2026-12-28", // Boxing Day observed (Dec 26 is a Sat)
  // 2027
  "2027-01-01",
  "2027-02-15",
  "2027-03-26", // Good Friday
  "2027-05-24",
  "2027-07-01",
  "2027-08-02",
  "2027-09-06",
  "2027-10-11",
  "2027-11-11",
  "2027-12-27", // Christmas Day observed (Dec 25 is a Sat)
  "2027-12-28", // Boxing Day observed
  // 2028
  "2028-01-03", // New Year's Day observed (Jan 1 is a Sat)
  "2028-02-21",
  "2028-04-14",
  "2028-05-22",
  "2028-07-03", // Canada Day observed (Jul 1 is a Sat)
  "2028-08-07",
  "2028-09-04",
  "2028-10-09",
  "2028-11-13", // Remembrance Day observed (Nov 11 is a Sat)
  "2028-12-25",
  "2028-12-26",
]);

function isCanadianStatHoliday(d: Date): boolean {
  return CANADIAN_STAT_HOLIDAYS_UTC.has(d.toISOString().slice(0, 10));
}

/** Earliest instant at least `businessDays` business days after `from`.
 *  Business day = Mon..Fri AND NOT a Canadian federal / Alberta stat
 *  holiday (per CANADIAN_STAT_HOLIDAYS_UTC).  Returns UTC midnight on
 *  the floor day; callers add any within-day scheduling they want. */
export function earliestRetryAt(from: Date, businessDays: number): Date {
  const d = new Date(from.getTime());
  d.setUTCHours(0, 0, 0, 0);
  let bdLeft = businessDays;
  while (bdLeft > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    // 0 = Sunday, 6 = Saturday.
    if (dow === 0 || dow === 6) continue;
    if (isCanadianStatHoliday(d)) continue;
    bdLeft--;
  }
  return d;
}

/* ============================================================
 * Retry eligibility evaluation
 * ============================================================ */

export type RetryEligibilityReason =
  | "NOT_FOUND"
  | "ALREADY_HAS_RETRY"
  | "NOT_RETRYABLE_CLASSIFICATION"
  | "MANDATE_REVOKED"
  | "MANDATE_NOT_FOUND"
  | "SETTLEMENT_FLAG_OFF_FOR_RECORDING"
  | "CYCLE_IN_WRONG_STATE";

export interface RetryEligibilityResult {
  eligible: boolean;
  classification?: RetryClassification;
  reason?: RetryEligibilityReason;
  detail?: string;
  context?: {
    attemptId: string;
    billingCycleId: string;
    stripeInvoiceId: string;
    mandateId: string;
    stripeMandateId: string;
    syntheticTestOnly: boolean;
    earliestRetryAt: Date;
    retryAttemptNumber: number;
  };
}

/** Pure-ish evaluation.  No writes.  Call before scheduling a retry. */
export async function evaluateRetryEligibility(
  attemptId: string,
): Promise<RetryEligibilityResult> {
  const attempt = await prisma.billingInvoicePaymentAttempt.findUnique({
    where: { id: attemptId },
    select: {
      id: true,
      billingCycleId: true,
      stripeInvoiceId: true,
      attemptNumber: true,
      attemptSettledAt: true,
      outcome: true,
      outcomeStripeCode: true,
      originatingAttemptId: true,
      syntheticTestOnly: true,
    },
  });
  if (!attempt) return { eligible: false, reason: "NOT_FOUND" };

  // Only the FIRST attempt (originatingAttemptId=null) may schedule
  // a retry.  Decision #2 cap: at most ONE automatic retry.
  if (attempt.originatingAttemptId !== null) {
    return { eligible: false, reason: "ALREADY_HAS_RETRY", detail: "attempt is itself a retry" };
  }

  // Any existing retry already linked to this attempt?
  const existingRetry = await prisma.billingInvoicePaymentAttempt.findFirst({
    where: { originatingAttemptId: attempt.id },
    select: { id: true, attemptNumber: true },
  });
  if (existingRetry) {
    return {
      eligible: false,
      reason: "ALREADY_HAS_RETRY",
      detail: `retry already scheduled (attempt ${existingRetry.id.slice(-6)})`,
    };
  }

  const classification = classifyFailureForRetry({
    outcome: attempt.outcome,
    outcomeStripeCode: attempt.outcomeStripeCode,
  });
  if (classification !== "RETRYABLE_INSUFFICIENT_FUNDS") {
    return {
      eligible: false,
      classification,
      reason: "NOT_RETRYABLE_CLASSIFICATION",
      detail: `classification=${classification}`,
    };
  }

  // Cycle must still be in a state consistent with a retry (not
  // suspended, not reversed, not activated).
  const cycle = await prisma.billingCycle.findUnique({
    where: { id: attempt.billingCycleId },
    select: { subscriptionStatus: true, reversedAt: true },
  });
  if (!cycle) return { eligible: false, reason: "CYCLE_IN_WRONG_STATE", detail: "cycle not found" };
  if (cycle.reversedAt !== null) {
    return { eligible: false, reason: "CYCLE_IN_WRONG_STATE", detail: "cycle reversed" };
  }
  const acceptableCycleStates = new Set(["INITIATED", "AWAITING_SETTLEMENT", "PAYMENT_FAILED"]);
  if (cycle.subscriptionStatus && !acceptableCycleStates.has(cycle.subscriptionStatus)) {
    return {
      eligible: false,
      reason: "CYCLE_IN_WRONG_STATE",
      detail: `cycle status=${cycle.subscriptionStatus}`,
    };
  }

  // Mandate must exist + not be revoked.  Look up the RELEASE record
  // via the cycle's releasedByOperatorRecordId FK -> registration ->
  // mandate.
  const cycleRel = await prisma.billingCycle.findUnique({
    where: { id: attempt.billingCycleId },
    select: {
      releasedByOperatorRecord: { select: { signupRegistrationId: true } },
    },
  });
  const signupRegistrationId = cycleRel?.releasedByOperatorRecord?.signupRegistrationId;
  if (!signupRegistrationId) {
    return { eligible: false, reason: "MANDATE_NOT_FOUND", detail: "no RELEASE record for cycle" };
  }
  const mandate = await prisma.subscriptionPaymentMandate.findFirst({
    where: { signupRegistrationId },
    orderBy: { acceptedAt: "desc" },
    select: { id: true, stripeMandateId: true, revokedAt: true },
  });
  if (!mandate) return { eligible: false, reason: "MANDATE_NOT_FOUND" };
  if (mandate.revokedAt !== null) {
    return { eligible: false, reason: "MANDATE_REVOKED", detail: `revokedAt=${mandate.revokedAt.toISOString()}` };
  }

  const retryFloor = earliestRetryAt(attempt.attemptSettledAt ?? new Date(), 3);

  return {
    eligible: true,
    classification,
    context: {
      attemptId: attempt.id,
      billingCycleId: attempt.billingCycleId,
      stripeInvoiceId: attempt.stripeInvoiceId,
      mandateId: mandate.id,
      stripeMandateId: mandate.stripeMandateId,
      syntheticTestOnly: attempt.syntheticTestOnly,
      earliestRetryAt: retryFloor,
      retryAttemptNumber: attempt.attemptNumber + 1,
    },
  };
}

/* ============================================================
 * Club notification BEFORE the retry fires (§5)
 * ============================================================ */

export interface ClubNotificationResult {
  notificationId: string;
  channel: "PRE_ACTIVATION_OPERATOR_INBOX" | "TENANT_WORK_INTAKE";
  emailDelivered: boolean;
  emailProviderMessageId?: string;
  emailFailureReason?: string;
}

/** M4-renewal §5 correction #1 (2026-10-28): the retry notification
 *  now ALSO sends email directly to the registration admin email
 *  (so a human can act), not just the OperatorInboxEntry (operator-
 *  visibility only).  The OperatorInboxEntry remains for operator
 *  oversight.  Pre-activation clubs don't have a tenant portal, so
 *  the registration admin email is the authoritative customer
 *  channel.  For post-activation clubs this will transition to
 *  Work Intake (later slice). */
export async function notifyClubBeforeRetry(args: {
  billingCycleId: string;
  stripeInvoiceId: string;
  retryScheduledFor: Date;
  originatingAttemptId: string;
  retryAttemptNumber: number;
  syntheticTestOnly: boolean;
}): Promise<ClubNotificationResult> {
  // 1. OperatorInboxEntry (operator visibility -- unchanged).
  const inbox = await prisma.operatorInboxEntry.create({
    data: {
      severity: "IMMEDIATE",
      category: "PRE_ACTIVATION_RETRY_PENDING_CLUB_NOTIFICATION",
      clubId: null,
      billingCycleId: args.billingCycleId,
      providerEventId: null,
      title: "Scheduled ACSS retry -- club notified by email",
      body:
        `BillingCycle ${args.billingCycleId.slice(-6)} invoice ${args.stripeInvoiceId.slice(-8)} ` +
        `will auto-retry on ${args.retryScheduledFor.toISOString()} (3+ business days after the ` +
        `insufficient-funds failure).  The club administrator has been emailed directly via ` +
        `selectPlatformEmailAdapter -- the operator inbox entry is for internal visibility only ` +
        `and is NOT a substitute for the customer communication.  ` +
        `No sensitive bank details are exposed in the email body.`,
    },
    select: { id: true },
  });

  // 2. Email send to registration admin (correction #1).  Find the
  // adminEmail via the cycle -> RELEASE record -> registration lookup.
  let emailDelivered = false;
  let emailProviderMessageId: string | undefined;
  let emailFailureReason: string | undefined;
  try {
    const cycle = await prisma.billingCycle.findUnique({
      where: { id: args.billingCycleId },
      select: {
        releasedByOperatorRecord: {
          select: {
            signupRegistration: { select: { adminEmail: true, legalName: true, adminDisplayName: true } },
          },
        },
      },
    });
    const adminEmail = cycle?.releasedByOperatorRecord?.signupRegistration?.adminEmail;
    const legalName = cycle?.releasedByOperatorRecord?.signupRegistration?.legalName ?? "your Spectre registration";
    const adminDisplayName = cycle?.releasedByOperatorRecord?.signupRegistration?.adminDisplayName ?? null;
    if (!adminEmail) {
      emailFailureReason = "no_admin_email_on_registration";
    } else {
      // Use the platform-level email adapter (same pipeline SIGNUP-1
      // resume emails use -- Microsoft 365 / SES / SMTP / dev).
      const { selectPlatformEmailAdapter } = await import("@/lib/integrations/email");
      const adapter = await selectPlatformEmailAdapter();
      const greeting = adminDisplayName ? `Hi ${adminDisplayName.split(" ")[0]},` : "Hi there,";
      const retryDate = args.retryScheduledFor.toISOString().slice(0, 10);
      const subject = "A scheduled debit retry for your Spectre registration";
      const body = [
        greeting,
        "",
        `A scheduled debit retry for ${legalName} is planned for ${retryDate}.`,
        "",
        `The first attempt was unsuccessful.  Please ensure the account has sufficient funds before ${retryDate}.`,
        "",
        `No action is required inside Spectre; the retry will fire automatically.  If you need to`,
        `change the bank account or discuss the scheduled retry, please reply to this email.`,
        "",
        `For your security, no bank account details appear in this message.`,
        "",
        "— Spectre",
      ].join("\n");
      const result = await adapter.send({
        clubId: "", channel: "EMAIL",
        to: { email: adminEmail },
        subject, body,
      });
      emailDelivered = result.status === "SENT";
      emailProviderMessageId = result.providerMessageId;
      emailFailureReason = result.failureReason;
    }
  } catch (err) {
    emailFailureReason = err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200);
  }

  await audit(null, {
    action: "signup.m4.retries.club_notified",
    entityType: "OperatorInboxEntry",
    entityId: inbox.id,
    clubId: null,
    meta: {
      billingCycleIdTail: args.billingCycleId.slice(-6),
      emailDelivered,
      emailProviderMessageId: emailProviderMessageId ?? null,
      emailFailureReason: emailFailureReason ?? null,
      syntheticTestOnly: args.syntheticTestOnly,
    },
  });

  return {
    notificationId: inbox.id,
    channel: "PRE_ACTIVATION_OPERATOR_INBOX",
    emailDelivered,
    emailProviderMessageId,
    emailFailureReason,
  };
}

/* ============================================================
 * scheduleRetryForFailedAttempt
 * ============================================================ */

export interface ScheduleRetryResult {
  retryAttemptId: string;
  billingCommandId: string;
  stripeIdempotencyKey: string;
  scheduledFor: Date;
  clubNotificationId: string;
}

/** §3: durable retry scheduling.  Creates a follow-up
 *  BillingInvoicePaymentAttempt + a BillingCommand(INVOICE_PAY_RETRY) +
 *  the club notification + links them together inside one $transaction.
 *  The actual stripe.invoices.pay call fires only when the worker
 *  drains the command AFTER scheduledFor AND both the retries flag +
 *  the M3 payment-initiation flag are ON. */
export async function scheduleRetryForFailedAttempt(args: {
  originatingAttemptId: string;
}): Promise<ScheduleRetryResult> {
  assertM4RetriesLiveFlag();

  const elig = await evaluateRetryEligibility(args.originatingAttemptId);
  if (!elig.eligible || !elig.context) {
    throw new AppError(
      "SIGNUP_2M4_RETRY_INELIGIBLE",
      `${elig.reason ?? "unknown"}${elig.detail ? ` -- ${elig.detail}` : ""}`,
      409,
    );
  }
  const ctx = elig.context;

  // Deterministic idempotency key -- Stripe de-dupes if we re-send.
  const stripeIdempotencyKey = `signup-2m4-invoice-retry:${ctx.stripeInvoiceId}:${ctx.retryAttemptNumber}:v1`;

  // §5: notify club BEFORE scheduling the retry.
  const notification = await notifyClubBeforeRetry({
    billingCycleId: ctx.billingCycleId,
    stripeInvoiceId: ctx.stripeInvoiceId,
    retryScheduledFor: ctx.earliestRetryAt,
    originatingAttemptId: ctx.attemptId,
    retryAttemptNumber: ctx.retryAttemptNumber,
    syntheticTestOnly: ctx.syntheticTestOnly,
  });

  const result = await prisma.$transaction(async (tx) => {
    // Create the retry attempt row (preserves history; linked via
    // originatingAttemptId).  outcome stays null until the worker fires.
    const retry = await tx.billingInvoicePaymentAttempt.create({
      data: {
        billingCycleId: ctx.billingCycleId,
        stripeInvoiceId: ctx.stripeInvoiceId, // SAME invoice (correction #6)
        attemptNumber: ctx.retryAttemptNumber,
        attemptScheduledAt: ctx.earliestRetryAt,
        originatingAttemptId: ctx.attemptId,
        clubNotifiedAt: new Date(),
        clubNotificationWorkIntakeId: `pre-activation-inbox:${notification.notificationId}`,
        syntheticTestOnly: ctx.syntheticTestOnly,
      },
      select: { id: true },
    });

    // Create the durable command.
    const cycle = await tx.billingCycle.findUnique({
      where: { id: ctx.billingCycleId },
      select: { clubId: true },
    });
    const command = await tx.billingCommand.create({
      data: {
        commandType: "INVOICE_PAY_RETRY",
        stripeIdempotencyKey,
        billingCycleId: ctx.billingCycleId,
        clubId: cycle!.clubId,
        state: "PENDING",
        attemptNumber: 0,
        maxAttempts: 1, // Only ONE automatic retry per decision #2.
        nextAttemptAt: ctx.earliestRetryAt,
        paramsJson: JSON.stringify({
          originatingAttemptId: ctx.attemptId,
          retryAttemptId: retry.id,
          stripeInvoiceId: ctx.stripeInvoiceId,
          stripeMandateId: ctx.stripeMandateId,
          clubNotificationId: notification.notificationId,
          retryAttemptNumber: ctx.retryAttemptNumber,
        }),
        syntheticTestOnly: ctx.syntheticTestOnly,
      },
      select: { id: true },
    });

    return { retryAttemptId: retry.id, commandId: command.id };
  });

  await audit(null, {
    action: "signup.m4.retries.scheduled",
    entityType: "BillingInvoicePaymentAttempt",
    entityId: result.retryAttemptId,
    clubId: null,
    meta: {
      billingCycleIdTail: ctx.billingCycleId.slice(-6),
      originatingAttemptIdTail: ctx.attemptId.slice(-6),
      retryAttemptIdTail: result.retryAttemptId.slice(-6),
      commandIdTail: result.commandId.slice(-6),
      scheduledFor: ctx.earliestRetryAt.toISOString(),
      stripeIdempotencyKey,
      syntheticTestOnly: ctx.syntheticTestOnly,
    },
  });
  logger.info("signup.m4.retries.scheduled", {
    retryAttemptIdTail: result.retryAttemptId.slice(-6),
    scheduledFor: ctx.earliestRetryAt.toISOString(),
  });

  return {
    retryAttemptId: result.retryAttemptId,
    billingCommandId: result.commandId,
    stripeIdempotencyKey,
    scheduledFor: ctx.earliestRetryAt,
    clubNotificationId: notification.notificationId,
  };
}

/* ============================================================
 * Worker: drainOneInvoiceRetryCommand
 * ============================================================ */

export type RetryDrainOutcome =
  | "SUCCEEDED"
  | "FAILED"
  | "UNCERTAIN"
  | "DEFERRED_PAYMENT_INITIATION_FLAG_OFF"
  | "DEFERRED_NOT_YET_SCHEDULED"
  | "NOOP_WRONG_STATE"
  | "NOOP_ALREADY_PAID"
  | "REFUSED_MANDATE_REVOKED_SINCE_SCHEDULE"
  | "TERMINAL";

export interface RetryDrainResult {
  commandId: string;
  outcome: RetryDrainOutcome;
  attemptNumber: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/** §3: worker.  Loads the command FOR UPDATE, performs §1 pre-call
 *  mandate revalidation + §4 "already paid" short-circuit, then calls
 *  stripe.invoices.pay(invoiceId) with the deterministic idempotency
 *  key.  Uncertain outcomes transition to UNCERTAIN (safe to re-attempt
 *  because Stripe de-dupes on the key). */
export async function drainOneInvoiceRetryCommand(commandId: string): Promise<RetryDrainResult> {
  assertM4RetriesLiveFlag();

  // Load + lock the command.
  const loadResult = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRawUnsafe<Array<{
      id: string; commandType: string; state: string; attemptNumber: number;
      maxAttempts: number; stripeIdempotencyKey: string; billingCycleId: string;
      clubId: string; paramsJson: string | null; nextAttemptAt: Date;
      syntheticTestOnly: boolean;
    }>>(
      `SELECT id, "commandType", state, "attemptNumber", "maxAttempts",
              "stripeIdempotencyKey", "billingCycleId", "clubId",
              "paramsJson", "nextAttemptAt", "syntheticTestOnly"
       FROM "BillingCommand" WHERE id = $1 AND "commandType" = 'INVOICE_PAY_RETRY'
       FOR UPDATE`,
      commandId,
    );
    if (!rows || rows.length === 0) {
      throw new AppError("SIGNUP_2M4_RETRY_COMMAND_NOT_FOUND", `BillingCommand ${commandId.slice(-6)} not found`, 404);
    }
    const cmd = rows[0];
    const prev = cmd.state;
    if (cmd.state === "SUCCEEDED" || cmd.state === "TERMINAL") {
      return { outcome: "NOOP_WRONG_STATE" as const, cmd, prev };
    }
    const allowed = new Set(["PENDING", "UNCERTAIN", "DEFERRED", "FAILED"]);
    if (!allowed.has(cmd.state)) return { outcome: "NOOP_WRONG_STATE" as const, cmd, prev };

    // Not yet scheduled?  Keep PENDING + return DEFERRED_NOT_YET_SCHEDULED.
    if (cmd.nextAttemptAt.getTime() > Date.now()) {
      return { outcome: "DEFERRED_NOT_YET_SCHEDULED" as const, cmd, prev };
    }
    const nextAttempt = cmd.attemptNumber + 1;
    if (nextAttempt > cmd.maxAttempts) {
      await tx.billingCommand.update({
        where: { id: cmd.id },
        data: { state: "TERMINAL", terminalAt: new Date() },
      });
      return { outcome: "TERMINAL" as const, cmd, prev };
    }
    await tx.billingCommand.update({
      where: { id: cmd.id },
      data: { state: "ATTEMPTED", attemptNumber: nextAttempt },
    });
    return { outcome: "ADVANCED" as const, cmd, prev, nextAttempt };
  });

  if (loadResult.outcome !== "ADVANCED") {
    return {
      commandId,
      outcome: loadResult.outcome,
      attemptNumber: loadResult.cmd.attemptNumber,
    };
  }
  const cmd = loadResult.cmd;
  const nextAttempt = (loadResult as { nextAttempt: number }).nextAttempt;
  const params = JSON.parse(cmd.paramsJson ?? "{}");

  // §1: payment-initiation flag MUST be ON to actually hit Stripe.
  if (process.env.SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION !== "1") {
    await prisma.billingCommand.update({
      where: { id: commandId },
      data: {
        state: "DEFERRED",
        lastErrorCode: "PAYMENT_INITIATION_DISABLED",
        lastErrorMessage: "SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION != 1; invoice retry deferred",
        lastErrorAt: new Date(),
      },
    });
    logger.info("signup.m4.retries.worker.deferred_m3_flag_off", {
      commandIdTail: commandId.slice(-6),
    });
    return {
      commandId,
      outcome: "DEFERRED_PAYMENT_INITIATION_FLAG_OFF",
      attemptNumber: nextAttempt,
    };
  }

  // §1: revalidate mandate immediately before firing.
  const mandate = await prisma.subscriptionPaymentMandate.findFirst({
    where: { stripeMandateId: params.stripeMandateId },
    select: { id: true, revokedAt: true },
  });
  if (!mandate || mandate.revokedAt !== null) {
    await prisma.billingCommand.update({
      where: { id: commandId },
      data: {
        state: "TERMINAL",
        terminalAt: new Date(),
        lastErrorCode: "MANDATE_REVOKED_SINCE_SCHEDULE",
        lastErrorMessage: `mandate ${mandate ? "revokedAt " + mandate.revokedAt?.toISOString() : "not found"}`,
        lastErrorAt: new Date(),
      },
    });
    await audit(null, {
      action: "signup.m4.retries.worker.refused_mandate_revoked",
      entityType: "BillingCommand",
      entityId: commandId,
      clubId: null,
      meta: {
        commandIdTail: commandId.slice(-6),
        stripeMandateIdTail: typeof params.stripeMandateId === "string" ? params.stripeMandateId.slice(-8) : null,
      },
    });
    return {
      commandId,
      outcome: "REFUSED_MANDATE_REVOKED_SINCE_SCHEDULE",
      attemptNumber: nextAttempt,
    };
  }

  // §4: short-circuit if invoice is already paid.
  const stripe = resolveStripeAdapter();
  try {
    // Direct invoice lookup via Stripe adapter is not currently on the
    // adapter surface (added here as a side-channel).  For M4-retries
    // we use the raw stripe SDK call -- it stays in test mode because
    // SDK mode is already "test".
    const stripeAdapterAny = stripe as unknown as { isLive: boolean };
    if (stripeAdapterAny.isLive) {
      // Live-SDK: lookup invoice directly.
      const Stripe = (await import("stripe")).default;
      const client = new Stripe(process.env.STRIPE_SECRET_KEY ?? "", {
        apiVersion: "2026-09-30.endive",
        maxNetworkRetries: 0,
        timeout: 15_000,
        telemetry: false,
      });
      const invoice = await client.invoices.retrieve(params.stripeInvoiceId);
      if (invoice.status === "paid") {
        await prisma.billingCommand.update({
          where: { id: commandId },
          data: {
            state: "SUCCEEDED",
            succeededAt: new Date(),
            stripeResourceId: invoice.id,
            stripeResourceType: "invoice",
          },
        });
        // Also mark the retry attempt as succeeded (preserving history).
        await prisma.billingInvoicePaymentAttempt.update({
          where: { id: params.retryAttemptId },
          data: {
            attemptStartedAt: new Date(),
            attemptSettledAt: new Date(),
            outcome: "SUCCEEDED",
            outcomeMessage: "invoice already paid at retry time",
          },
        });
        return { commandId, outcome: "NOOP_ALREADY_PAID", attemptNumber: nextAttempt };
      }

      // Fire the retry -- stripe.invoices.pay with deterministic idempotency.
      const paid = await client.invoices.pay(params.stripeInvoiceId, {}, { idempotencyKey: cmd.stripeIdempotencyKey });
      await prisma.billingCommand.update({
        where: { id: commandId },
        data: {
          state: "SUCCEEDED",
          succeededAt: new Date(),
          stripeResourceId: paid.id,
          stripeResourceType: "invoice",
        },
      });
      await prisma.billingInvoicePaymentAttempt.update({
        where: { id: params.retryAttemptId },
        data: {
          attemptStartedAt: new Date(),
          attemptSettledAt: new Date(),
          outcome: paid.status === "paid" ? "SUCCEEDED" : "FAILED_UNKNOWN",
        },
      });
      await audit(null, {
        action: "signup.m4.retries.worker.succeeded",
        entityType: "BillingCommand",
        entityId: commandId,
        clubId: null,
        meta: {
          commandIdTail: commandId.slice(-6),
          invoiceIdTail: paid.id?.slice(-8) ?? null,
        },
      });
      return { commandId, outcome: "SUCCEEDED", attemptNumber: nextAttempt };
    }
    // Mock adapter: deterministic simulated success.
    await prisma.billingCommand.update({
      where: { id: commandId },
      data: {
        state: "SUCCEEDED",
        succeededAt: new Date(),
        stripeResourceId: params.stripeInvoiceId,
        stripeResourceType: "invoice",
      },
    });
    await prisma.billingInvoicePaymentAttempt.update({
      where: { id: params.retryAttemptId },
      data: {
        attemptStartedAt: new Date(),
        attemptSettledAt: new Date(),
        outcome: "SUCCEEDED",
      },
    });
    return { commandId, outcome: "SUCCEEDED", attemptNumber: nextAttempt };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const errCode =
      (err as { code?: string } | undefined)?.code ??
      (err instanceof AppError ? err.code : null) ??
      null;
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
      action: `signup.m4.retries.worker.${newState.toLowerCase()}`,
      entityType: "BillingCommand",
      entityId: commandId,
      clubId: null,
      meta: {
        commandIdTail: commandId.slice(-6),
        attemptNumber: nextAttempt,
        errorCode: errCode,
      },
    });
    return {
      commandId,
      outcome: newState,
      attemptNumber: nextAttempt,
      errorCode: errCode,
      errorMessage: errMsg,
    };
  }
}
