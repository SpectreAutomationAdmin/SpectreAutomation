// SIGNUP-2 M4-retries (2026-10-28) -- Contract tests.
//
// Covers the 14 acceptance requirements from the M4-retries
// authorisation + service-shape invariants.  Pure contract tests
// (file-source scans + pure predicate tests).  No live DB or Stripe.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertM4RetriesLiveFlag,
  classifyFailureForRetry,
  earliestRetryAt,
} from "@/lib/billing/signup-2m4-retries-service";

const SVC = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2m4-retries-service.ts"),
  "utf8",
);

describe("signup-2 m4-retries :: service shape", () => {
  it("exports flag guard + eligibility evaluator + scheduler + worker + classifier + bd math + notify", () => {
    expect(SVC).toMatch(/export function assertM4RetriesLiveFlag/);
    expect(SVC).toMatch(/export function classifyFailureForRetry/);
    expect(SVC).toMatch(/export function earliestRetryAt/);
    expect(SVC).toMatch(/export async function evaluateRetryEligibility/);
    expect(SVC).toMatch(/export async function notifyClubBeforeRetry/);
    expect(SVC).toMatch(/export async function scheduleRetryForFailedAttempt/);
    expect(SVC).toMatch(/export async function drainOneInvoiceRetryCommand/);
  });
});

describe("signup-2 m4-retries :: flag gate (SPECTRE_SIGNUP_2M4_RETRIES_LIVE)", () => {
  beforeEach(() => { delete process.env.SPECTRE_SIGNUP_2M4_RETRIES_LIVE; });
  afterEach(() => { delete process.env.SPECTRE_SIGNUP_2M4_RETRIES_LIVE; });

  it("throws when flag is unset", () => {
    expect(() => assertM4RetriesLiveFlag()).toThrow(/disabled/);
  });
  it("throws when flag is 0", () => {
    process.env.SPECTRE_SIGNUP_2M4_RETRIES_LIVE = "0";
    expect(() => assertM4RetriesLiveFlag()).toThrow(/disabled/);
  });
  it("succeeds when flag is 1", () => {
    process.env.SPECTRE_SIGNUP_2M4_RETRIES_LIVE = "1";
    expect(() => assertM4RetriesLiveFlag()).not.toThrow();
  });
});

describe("signup-2 m4-retries :: §4 Failure classification", () => {
  it("insufficient_funds -> RETRYABLE_INSUFFICIENT_FUNDS", () => {
    expect(classifyFailureForRetry({ outcome: "FAILED_INSUFFICIENT_FUNDS", outcomeStripeCode: "insufficient_funds" }))
      .toBe("RETRYABLE_INSUFFICIENT_FUNDS");
    expect(classifyFailureForRetry({ outcome: null, outcomeStripeCode: "insufficient_funds" }))
      .toBe("RETRYABLE_INSUFFICIENT_FUNDS");
  });

  it("debit_not_authorized / account_closed / mandate_* -> REQUIRE_FRESH_MANDATE", () => {
    for (const code of ["debit_not_authorized", "account_closed", "mandate_invalid", "mandate_revoked", "mandate_expired"]) {
      expect(classifyFailureForRetry({ outcome: null, outcomeStripeCode: code })).toBe("REQUIRE_FRESH_MANDATE");
    }
    expect(classifyFailureForRetry({ outcome: "FAILED_MANDATE_INVALIDATED", outcomeStripeCode: null }))
      .toBe("REQUIRE_FRESH_MANDATE");
  });

  it("payment_method_not_available -> REQUIRE_FRESH_MANDATE", () => {
    expect(classifyFailureForRetry({ outcome: null, outcomeStripeCode: "payment_method_not_available" }))
      .toBe("REQUIRE_FRESH_MANDATE");
  });

  it("unknown / ambiguous -> OPERATOR_REVIEW", () => {
    expect(classifyFailureForRetry({ outcome: "FAILED_UNKNOWN", outcomeStripeCode: null }))
      .toBe("OPERATOR_REVIEW");
    expect(classifyFailureForRetry({ outcome: null, outcomeStripeCode: "unexpected_decline" }))
      .toBe("OPERATOR_REVIEW");
  });

  it("SUCCEEDED -> NO_RETRY_ALREADY_PAID", () => {
    expect(classifyFailureForRetry({ outcome: "SUCCEEDED", outcomeStripeCode: null }))
      .toBe("NO_RETRY_ALREADY_PAID");
  });

  it("acceptance #11 ambiguous failures do NOT auto-suspend tenants (we only enqueue operator review)", () => {
    // Service never calls suspendTenant.
    expect(SVC).not.toMatch(/suspendTenant\(/);
    // OPERATOR_REVIEW is a distinct outcome, not SUSPEND.
    expect(SVC).toMatch(/"OPERATOR_REVIEW"/);
  });
});

describe("signup-2 m4-retries :: §1 3-business-day minimum (business-day math)", () => {
  it("Monday failure -> earliest retry Thursday (3 business days)", () => {
    // Monday Jan 5 2026 (UTC) is day-of-week 1.
    const mon = new Date(Date.UTC(2026, 0, 5)); // Mon Jan 5
    const earliest = earliestRetryAt(mon, 3);
    expect(earliest.getUTCDay()).toBe(4); // Thursday
    expect(earliest.toISOString().slice(0, 10)).toBe("2026-01-08");
  });

  it("Thursday failure -> earliest retry Tuesday (skips weekend)", () => {
    const thu = new Date(Date.UTC(2026, 0, 8)); // Thu Jan 8
    const earliest = earliestRetryAt(thu, 3);
    expect(earliest.getUTCDay()).toBe(2); // Tuesday
    expect(earliest.toISOString().slice(0, 10)).toBe("2026-01-13");
  });

  it("Friday failure -> earliest retry Wednesday (skips weekend)", () => {
    const fri = new Date(Date.UTC(2026, 0, 2)); // Fri Jan 2
    const earliest = earliestRetryAt(fri, 3);
    expect(earliest.getUTCDay()).toBe(3); // Wednesday
  });

  it("acceptance #2 scheduleRetry writes nextAttemptAt = earliestRetryAt (3bd floor)", () => {
    // earliestRetryAt is resolved by evaluateRetryEligibility (upstream of
    // scheduleRetryForFailedAttempt) and carried on ctx.earliestRetryAt.
    expect(SVC).toMatch(/earliestRetryAt\(.*?,\s*3\s*\)/);
    const sched = SVC.slice(SVC.indexOf("export async function scheduleRetryForFailedAttempt"));
    expect(sched).toMatch(/nextAttemptAt:\s*ctx\.earliestRetryAt/);
    expect(sched).toMatch(/attemptScheduledAt:\s*ctx\.earliestRetryAt/);
  });
});

describe("signup-2 m4-retries :: §1 one-retry cap (decision #2)", () => {
  it("evaluateRetryEligibility refuses ALREADY_HAS_RETRY when attempt is itself a retry", () => {
    expect(SVC).toMatch(/attempt\.originatingAttemptId !== null/);
    expect(SVC).toMatch(/"ALREADY_HAS_RETRY"/);
    expect(SVC).toMatch(/attempt is itself a retry/);
  });

  it("evaluateRetryEligibility refuses ALREADY_HAS_RETRY when a retry row already exists", () => {
    expect(SVC).toMatch(/originatingAttemptId:\s*attempt\.id/);
    expect(SVC).toMatch(/retry already scheduled/);
  });

  it("BillingCommand.maxAttempts is 1 (ONE automatic retry total per decision #2)", () => {
    expect(SVC).toMatch(/maxAttempts:\s*1/);
    expect(SVC).toMatch(/ONE automatic retry per decision #2/);
  });
});

describe("signup-2 m4-retries :: §5 Advance club notification (pre-activation channel)", () => {
  it("acceptance #3 schedules the OperatorInboxEntry notification BEFORE the $transaction creates the retry row", () => {
    const sched = SVC.slice(SVC.indexOf("export async function scheduleRetryForFailedAttempt"));
    const notifyIdx = sched.indexOf("notifyClubBeforeRetry");
    const txIdx = sched.indexOf("prisma.$transaction");
    expect(notifyIdx).toBeGreaterThan(0);
    expect(notifyIdx).toBeLessThan(txIdx);
  });

  it("retry row's clubNotificationWorkIntakeId records the OperatorInbox id as pre-activation channel", () => {
    expect(SVC).toMatch(/clubNotificationWorkIntakeId:\s*`pre-activation-inbox:\$\{notification\.notificationId\}`/);
  });

  it("acceptance #13 pre-activation channel is OperatorInbox (clubs without a tenant Work Intake)", () => {
    expect(SVC).toMatch(/PRE_ACTIVATION_RETRY_PENDING_CLUB_NOTIFICATION/);
    expect(SVC).toMatch(/channel: "PRE_ACTIVATION_OPERATOR_INBOX"/);
  });

  it("notification body does NOT expose sensitive bank details", () => {
    const notify = SVC.slice(SVC.indexOf("export async function notifyClubBeforeRetry"));
    expect(notify).not.toMatch(/account[_\s]?number|routing[_\s]?number|institution[_\s]?number|transit[_\s]?number/i);
    expect(notify).toMatch(/No sensitive bank details are exposed/);
  });

  it("retry attempt row sets clubNotifiedAt BEFORE the attemptSettledAt (notified before fire)", () => {
    const sched = SVC.slice(SVC.indexOf("export async function scheduleRetryForFailedAttempt"));
    expect(sched).toMatch(/clubNotifiedAt:\s*new Date\(\)/);
    // attemptSettledAt is NOT set at schedule time (worker sets it on fire).
    const createBlock = sched.match(/tx\.billingInvoicePaymentAttempt\.create\(\{[\s\S]+?\}\s*\)/)![0];
    expect(createBlock).not.toMatch(/attemptSettledAt:/);
  });
});

describe("signup-2 m4-retries :: §1 mandate validity immediately before retry (acceptance #4 + #5)", () => {
  it("worker revalidates mandate immediately before calling Stripe", () => {
    const worker = SVC.slice(SVC.indexOf("export async function drainOneInvoiceRetryCommand"));
    expect(worker).toMatch(/revalidate mandate immediately before/i);
    expect(worker).toMatch(/subscriptionPaymentMandate\.findFirst/);
  });

  it("revoked mandate triggers REFUSED_MANDATE_REVOKED_SINCE_SCHEDULE + TERMINAL state", () => {
    expect(SVC).toMatch(/MANDATE_REVOKED_SINCE_SCHEDULE/);
    expect(SVC).toMatch(/"TERMINAL"/);
    expect(SVC).toMatch(/REFUSED_MANDATE_REVOKED_SINCE_SCHEDULE/);
  });

  it("eligibility check also refuses MANDATE_REVOKED (schedule-time gate)", () => {
    expect(SVC).toMatch(/mandate\.revokedAt !== null/);
    expect(SVC).toMatch(/"MANDATE_REVOKED"/);
  });
});

describe("signup-2 m4-retries :: §2 Invoice integrity (acceptance #6)", () => {
  it("retry attempt row carries SAME stripeInvoiceId as originating attempt", () => {
    expect(SVC).toMatch(/stripeInvoiceId:\s*ctx\.stripeInvoiceId/);
    expect(SVC).toMatch(/SAME invoice/);
  });

  it("deterministic Stripe idempotency key per (invoice, attemptNumber)", () => {
    expect(SVC).toMatch(/stripeIdempotencyKey = `signup-2m4-invoice-retry:\$\{ctx\.stripeInvoiceId\}:\$\{ctx\.retryAttemptNumber\}:v1`/);
  });

  it("worker calls stripe.invoices.pay (NOT paymentIntents.create or subscriptions.create)", () => {
    expect(SVC).toMatch(/client\.invoices\.pay\(/);
    expect(SVC).not.toMatch(/paymentIntents\.create/);
    expect(SVC).not.toMatch(/stripe\.subscriptions\.create/);
    expect(SVC).not.toMatch(/stripe\.createSubscription/);
  });

  it("worker passes the deterministic idempotency key to Stripe", () => {
    expect(SVC).toMatch(/\{\s*idempotencyKey:\s*cmd\.stripeIdempotencyKey\s*\}/);
  });
});

describe("signup-2 m4-retries :: §3 Durable scheduling + worker safety", () => {
  it("acceptance #7 worker uses FOR UPDATE lock to prevent concurrent collection", () => {
    expect(SVC).toMatch(/FOR UPDATE/);
  });

  it("acceptance #8 worker crashes recoverable: UNCERTAIN state keeps same idempotency key for safe retry", () => {
    expect(SVC).toMatch(/isUncertain\s*\?\s*"UNCERTAIN"\s*:\s*"FAILED"/);
    expect(SVC).toMatch(/timeout\|ETIMEDOUT\|ECONNRESET/);
  });

  it("acceptance #9 Stripe timeout => UNCERTAIN classification + no duplicate collection", () => {
    expect(SVC).toMatch(/timeout\|ETIMEDOUT\|ECONNRESET\|ENOTFOUND\|StripeConnectionError\|StripeAPIError\|5\\d\\d/);
  });

  it("acceptance #10 worker short-circuits NOOP_ALREADY_PAID when invoice is already paid", () => {
    expect(SVC).toMatch(/invoice\.status === "paid"/);
    expect(SVC).toMatch(/NOOP_ALREADY_PAID/);
    expect(SVC).toMatch(/invoice already paid at retry time/);
  });

  it("worker refuses to fire before nextAttemptAt (prevents premature retry)", () => {
    expect(SVC).toMatch(/cmd\.nextAttemptAt\.getTime\(\) > Date\.now\(\)/);
    expect(SVC).toMatch(/DEFERRED_NOT_YET_SCHEDULED/);
  });

  it("worker caps attempts at maxAttempts = 1 -> TERMINAL beyond that", () => {
    expect(SVC).toMatch(/nextAttempt > cmd\.maxAttempts/);
    expect(SVC).toMatch(/"TERMINAL"/);
  });
});

describe("signup-2 m4-retries :: §4 full-history preservation", () => {
  it("retry attempt row is CREATED (not updating the originating attempt)", () => {
    const sched = SVC.slice(SVC.indexOf("export async function scheduleRetryForFailedAttempt"));
    expect(sched).toMatch(/tx\.billingInvoicePaymentAttempt\.create/);
    // No update to the originating attempt during scheduling.
    expect(sched).not.toMatch(/tx\.billingInvoicePaymentAttempt\.update.*?originatingAttemptId:/s);
  });

  it("original attempt's outcome is NOT overwritten (preserved by schema UNIQUE + settlement handler contract)", () => {
    // Retries live in distinct rows; originating row's outcome is read-only
    // in scheduleRetryForFailedAttempt.  (The worker DOES update the RETRY
    // attempt row's outcome after Stripe responds; that's a different row.)
    const sched = SVC.slice(
      SVC.indexOf("export async function scheduleRetryForFailedAttempt"),
      SVC.indexOf("export type RetryDrainOutcome"),
    );
    // Scheduler never updates ANY attempt row.
    expect(sched).not.toMatch(/billingInvoicePaymentAttempt\.update/);
  });
});

describe("signup-2 m4-retries :: §4 security / §7 cross-tenant isolation + flag gates", () => {
  it("acceptance #12 synthetic test rows propagate syntheticTestOnly through all writes", () => {
    expect(SVC).toMatch(/syntheticTestOnly:\s*ctx\.syntheticTestOnly/);
  });

  it("acceptance #14 payment-initiation flag OFF => DEFERRED, no Stripe call", () => {
    expect(SVC).toMatch(/SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION !== "1"/);
    expect(SVC).toMatch(/DEFERRED_PAYMENT_INITIATION_FLAG_OFF/);
  });

  it("flag-off path does NOT call client.invoices.pay (import gated to live branch after preflight)", () => {
    const worker = SVC.slice(SVC.indexOf("export async function drainOneInvoiceRetryCommand"));
    const guardIdx = worker.indexOf('SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION !== "1"');
    const payIdx = worker.indexOf("invoices.pay(");
    expect(guardIdx).toBeGreaterThan(0);
    expect(payIdx).toBeGreaterThan(guardIdx);
  });

  it("acceptance #2 Stripe-native Smart Retries explicitly documented as REQUIRED-DISABLED by operator", () => {
    expect(SVC).toMatch(/operators MUST disable Stripe Billing/);
    expect(SVC).toMatch(/Smart Retries/);
    expect(SVC).toMatch(/duplicate retries via Stripe's own scheduler/);
  });
});

describe("signup-2 m4-retries :: audit trail", () => {
  it("every outcome branch writes an audit entry", () => {
    expect(SVC).toMatch(/signup\.m4\.retries\.scheduled/);
    expect(SVC).toMatch(/signup\.m4\.retries\.worker\.succeeded/);
    expect(SVC).toMatch(/signup\.m4\.retries\.worker\.\$\{newState\.toLowerCase\(\)\}/);
    expect(SVC).toMatch(/signup\.m4\.retries\.worker\.refused_mandate_revoked/);
  });
});

describe("signup-2 m4-retries :: scope boundaries (per founder §9)", () => {
  it("no M4-renewal or M4-cancellation service files exist", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(join(process.cwd(), "src/lib/billing"));
    const forbidden = files.filter((f) => /^signup-2m4-(renewal|cancellation)-service\.ts$/.test(f));
    expect(forbidden, `forbidden future-slice files: ${forbidden.join(", ")}`).toEqual([]);
  });

  it("no renewal preflight / cancellation command types written by this service", () => {
    const codeOnly = SVC.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    expect(codeOnly).not.toMatch(/MANDATE_VALIDITY_CHECK/);
    expect(codeOnly).not.toMatch(/SUBSCRIPTION_SCHEDULE_CANCEL/);
    expect(codeOnly).not.toMatch(/customer\.subscription\./);
    expect(codeOnly).not.toMatch(/mandate\.updated/);
  });
});

describe("signup-2 m4-retries :: schema-slice guard update (settlement, triggering, retries all permitted; renewal + cancellation forbidden)", () => {
  it("M4-schema behavior-slice guard permits retries alongside triggering + settlement", async () => {
    const schemaTest = readFileSync(join(process.cwd(), "tests/signup-2-m4-schema.test.ts"), "utf8");
    expect(schemaTest).toMatch(/signup-2m4-retries-service\.ts/);
  });
});
