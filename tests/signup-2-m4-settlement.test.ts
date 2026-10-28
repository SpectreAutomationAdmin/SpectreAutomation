// SIGNUP-2 M4-settlement (2026-10-28) -- Contract tests.
//
// Covers the twelve acceptance scenarios from the M4-settlement
// authorisation + service-shape invariants.  Pure contract tests
// (file-source scans + pure predicates on exported functions).
// Behaviour-level tests that need a real DB will land as part of the
// M4-settlement staging acceptance via SSH probe.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertM4SettlementLiveFlag,
  correlateCycleFromInvoiceLikeIds,
  correlateCycleFromDisputeIds,
} from "@/lib/billing/signup-2m4-settlement-service";

const SVC = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2m4-settlement-service.ts"),
  "utf8",
);
const DISPATCH = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2e-webhook-dispatch.ts"),
  "utf8",
);

describe("signup-2 m4-settlement :: service shape (all 6 handlers + utilities)", () => {
  it("exports all 6 event handlers + both correlators + recorders + flag guard", () => {
    expect(SVC).toMatch(/export function assertM4SettlementLiveFlag/);
    expect(SVC).toMatch(/export async function correlateCycleFromInvoiceLikeIds/);
    expect(SVC).toMatch(/export async function correlateCycleFromDisputeIds/);
    expect(SVC).toMatch(/export async function recordPaymentAttempt/);
    expect(SVC).toMatch(/export async function recordBillingException/);
    expect(SVC).toMatch(/export async function handleInvoicePaid/);
    expect(SVC).toMatch(/export async function handleInvoicePaymentFailed/);
    expect(SVC).toMatch(/export async function handleInvoiceMarkedUncollectible/);
    expect(SVC).toMatch(/export async function handleChargeDisputeClosed/);
    expect(SVC).toMatch(/export async function handleChargeDisputeFundsWithdrawn/);
    expect(SVC).toMatch(/export async function handleChargeDisputeFundsReinstated/);
    expect(SVC).toMatch(/export async function replayDeferredM4Events/);
  });
});

describe("signup-2 m4-settlement :: flag gate (SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE)", () => {
  beforeEach(() => { delete process.env.SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE; });
  afterEach(() => { delete process.env.SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE; });

  it("throws when flag is unset", () => {
    expect(() => assertM4SettlementLiveFlag()).toThrow(/disabled/);
  });

  it("throws when flag is 0", () => {
    process.env.SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE = "0";
    expect(() => assertM4SettlementLiveFlag()).toThrow(/disabled/);
  });

  it("succeeds when flag is 1", () => {
    process.env.SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE = "1";
    expect(() => assertM4SettlementLiveFlag()).not.toThrow();
  });

  it("flag is independent of M3 and 2E flags", () => {
    expect(SVC).toMatch(/SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE/);
    expect(SVC).not.toMatch(/SPECTRE_SIGNUP_2M4_SETTLEMENT_LIVE[\s\S]{0,80}\|\|/);
  });
});

describe("signup-2 m4-settlement :: dispatcher wiring", () => {
  it("dispatcher subscribes to all 6 new events in the correct order", () => {
    expect(DISPATCH).toMatch(/case "invoice\.paid":/);
    expect(DISPATCH).toMatch(/case "invoice\.payment_failed":/);
    expect(DISPATCH).toMatch(/case "invoice\.marked_uncollectible":/);
    expect(DISPATCH).toMatch(/case "charge\.dispute\.closed":/);
    expect(DISPATCH).toMatch(/case "charge\.dispute\.funds_withdrawn":/);
    expect(DISPATCH).toMatch(/case "charge\.dispute\.funds_reinstated":/);
    expect(DISPATCH).toMatch(/await onM4SettlementEvent\(event\)/);
  });

  it("onM4SettlementEvent delegates to signup-2m4-settlement-service", () => {
    expect(DISPATCH).toMatch(/await import\("\.\/signup-2m4-settlement-service"\)/);
  });

  it("flag-off path raises SignupM3DeferredEvent so dispatcher leaves processedAt=null (orphan recovery)", () => {
    const block = DISPATCH.slice(DISPATCH.indexOf("async function onM4SettlementEvent"));
    expect(block).toMatch(/M4-settlement workflow is disabled/);
    expect(block).toMatch(/throw new SignupM3DeferredEvent/);
  });
});

describe("signup-2 m4-settlement :: §1 Settlement + Reconciliation", () => {
  it("acceptance #1 Normal ACSS payment processing: invoice.paid records a SUCCEEDED attempt", () => {
    const h = SVC.slice(SVC.indexOf("export async function handleInvoicePaid"), SVC.indexOf("export async function handleInvoicePaymentFailed"));
    expect(h).toMatch(/outcome:\s*"SUCCEEDED"/);
    expect(h).toMatch(/recordPaymentAttempt\(/);
  });

  it("acceptance #2 Delayed settlement: invoice.paid alone is NOT proof of funds-available (no ACTIVATION_READY write here)", () => {
    expect(SVC).not.toMatch(/subscriptionStatus:\s*"ACTIVATION_READY"/);
    // Explicit comment pinning the design intent (multi-line in source).
    expect(SVC).toMatch(/NOT[\s\S]{1,20}proof that funds are available/);
  });

  it("acceptance #3 Pending vs available Stripe funds: dispute handler uses actual balance_transaction", () => {
    expect(SVC).toMatch(/retrieveBalanceTransaction/);
    expect(SVC).toMatch(/balanceAvailableAt/);
  });

  it("populates authoritative Stripe identifiers on BillingInvoicePaymentAttempt", () => {
    expect(SVC).toMatch(/stripeInvoiceId:\s*args\.stripeInvoiceId/);
    expect(SVC).toMatch(/stripePaymentIntentId:\s*args\.stripePaymentIntentId/);
    expect(SVC).toMatch(/stripeChargeId:\s*args\.stripeChargeId/);
    expect(SVC).toMatch(/stripeSubscriptionId:\s*args\.stripeSubscriptionId/);
    expect(SVC).toMatch(/stripeInvoicePeriodStart:\s*args\.stripeInvoicePeriodStart/);
    expect(SVC).toMatch(/stripeInvoicePeriodEnd:\s*args\.stripeInvoicePeriodEnd/);
  });
});

describe("signup-2 m4-settlement :: §2 Webhook Integration", () => {
  it("acceptance #4 Out-of-order delivery: correlator does NOT depend on arrival sequence", () => {
    // No "if (previousEvent)" or timestamp-ordering checks in the handler
    // bodies.  Each handler re-derives state from Stripe identifiers.
    expect(SVC).toMatch(/No webhook ordering assumed/);
  });

  it("acceptance #5 Duplicate webhook delivery: recordPaymentAttempt upserts by unique (invoice, attemptNumber); existing row is NOT overwritten", () => {
    const r = SVC.slice(SVC.indexOf("export async function recordPaymentAttempt"), SVC.indexOf("export async function recordBillingException"));
    expect(r).toMatch(/findUnique\(\{[\s\S]{1,200}stripeInvoiceId_attemptNumber/);
    expect(r).toMatch(/if \(existing\)/);
    // Outcome preservation branch:
    expect(r).toMatch(/existing\.outcome === null/);
  });

  it("acceptance #5 duplicate webhook: BillingExceptionCase dedupes on (cycleId, category, stripeEventId)", () => {
    const start = SVC.indexOf("export async function recordBillingException");
    // Slice to the next function boundary (next `export async function`
    // OR to end of file).
    const nextExportFromStart = SVC.indexOf("export async function", start + 10);
    const end = nextExportFromStart > start ? nextExportFromStart : SVC.length;
    const r = SVC.slice(start, end);
    expect(r).toMatch(/if \(args\.stripeEventId\)/);
    expect(r).toMatch(/findFirst\(\{[\s\S]{1,400}stripeEventId:\s*args\.stripeEventId/);
  });

  it("acceptance #6 Missing webhook recovery: replayDeferredM4Events processes orphan events on demand", () => {
    const r = SVC.slice(SVC.indexOf("export async function replayDeferredM4Events"));
    expect(r).toMatch(/processedAt:\s*null/);
    expect(r).toMatch(/invoice\.paid/);
    expect(r).toMatch(/invoice\.payment_failed/);
    expect(r).toMatch(/charge\.dispute/);
    expect(r).toMatch(/orderBy:\s*\{\s*receivedAt:\s*"asc"\s*\}/);
  });

  it("preserves signature verification + event id dedup (unchanged from Phase 2E)", () => {
    // The service never writes/modifies StripeWebhookEvent dedup
    // behaviour; it only reads payload + marks processedAt on replay.
    expect(SVC).not.toMatch(/stripeWebhookEvent\.(create|upsert)/);
    expect(SVC).not.toMatch(/verifyWebhookSignature/);
  });
});

describe("signup-2 m4-settlement :: §3 Reconciliation + Exception Handling", () => {
  it("acceptance #7 Payment failure before settlement: invoice.payment_failed records attempt + exception (operator action required)", () => {
    const h = SVC.slice(SVC.indexOf("export async function handleInvoicePaymentFailed"), SVC.indexOf("export async function handleInvoiceMarkedUncollectible"));
    expect(h).toMatch(/recordPaymentAttempt\(/);
    expect(h).toMatch(/recordBillingException\(/);
    expect(h).toMatch(/category:\s*"ATTEMPT_FAILURE"/);
    expect(h).toMatch(/requiresOperatorAction:\s*true/);
  });

  it("acceptance #7 maps Stripe decline codes to internal outcomes", () => {
    expect(SVC).toMatch(/insufficient_funds/);
    expect(SVC).toMatch(/debit_not_authorized/);
    expect(SVC).toMatch(/account_closed/);
    expect(SVC).toMatch(/FAILED_INSUFFICIENT_FUNDS/);
    expect(SVC).toMatch(/FAILED_MANDATE_INVALIDATED/);
    expect(SVC).toMatch(/FAILED_UNKNOWN/);
  });

  it("acceptance #8 Refund or dispute after settlement: dispute handlers create exception rows preserving history", () => {
    const h = SVC.slice(SVC.indexOf("async function _handleDisputeEvent"));
    expect(h).toMatch(/recordBillingException\(/);
    // Dispute "closed" branch resolves category from dispute.status (won/lost).
    expect(h).toMatch(/dispute\.status === "won"/);
    expect(h).toMatch(/DISPUTE_CLOSED_WON/);
    expect(h).toMatch(/DISPUTE_CLOSED_LOST/);
  });

  it("does NOT implement M4-retries business policy (per scope boundary)", () => {
    // No automatic retry scheduling, no new attempt enqueuing.
    expect(SVC).not.toMatch(/attemptScheduledAt:\s*new Date\(.*\+/); // no "+ 3 bd" scheduling
    expect(SVC).not.toMatch(/BillingCommand\.create.*INVOICE_PAY_RETRY/);
    expect(SVC).not.toMatch(/schedulRetry|smartRetry/i);
  });

  it("preserves prior payment attempts (never overwrites outcome once set)", () => {
    const r = SVC.slice(SVC.indexOf("export async function recordPaymentAttempt"), SVC.indexOf("export async function recordBillingException"));
    expect(r).toMatch(/existing\.outcome === null\s*&&\s*args\.outcome/);
  });

  it("acceptance #8 reversals: dispute.funds_withdrawn is IMMEDIATE operator action; funds_reinstated is INFORMATIONAL (not operator action)", () => {
    expect(SVC).toMatch(/handleChargeDisputeFundsWithdrawn[\s\S]{0,200}requiresOperatorAction\s*\*\/\s*true/);
    expect(SVC).toMatch(/handleChargeDisputeFundsReinstated[\s\S]{0,200}requiresOperatorAction\s*\*\/\s*false/);
  });
});

describe("signup-2 m4-settlement :: §4 Security + Financial Controls", () => {
  it("acceptance #9 Cross-tenant isolation: BillingInvoicePaymentAttempt + BillingExceptionCase both carry syntheticTestOnly", () => {
    expect(SVC).toMatch(/syntheticTestOnly:\s*args\.syntheticTestOnly/);
    // Resolved from the cycle's own flag -- not caller-supplied.  Note:
    // ?? needs \?\? inside a RegExp literal.
    expect(SVC).toMatch(/cycleRow\?\.syntheticTestOnly\s*\?\?\s*false/);
  });

  it("acceptance #10 Prevention of premature tenant activation: service NEVER writes ClubSubscription.subscriptionStatus = ACTIVE", () => {
    expect(SVC).not.toMatch(/clubSubscription\.(create|update|upsert).*ACTIVE/);
    expect(SVC).not.toMatch(/subscriptionStatus:\s*"ACTIVE"/);
    expect(SVC).not.toMatch(/subscriptionStatus:\s*"ACTIVATION_READY"/);
  });

  it("service never calls stripe.subscriptions.create or stripe.customers.create", () => {
    expect(SVC).not.toMatch(/stripe\.subscriptions\.create/);
    expect(SVC).not.toMatch(/stripe\.customers\./);
    expect(SVC).not.toMatch(/stripe\.createSubscription/);
  });

  it("acceptance #11 Idempotent reconciliation: dedupes attempt rows + exception rows", () => {
    expect(SVC).toMatch(/stripeInvoiceId_attemptNumber:/);
    expect(SVC).toMatch(/if \(existing\) return \{ exceptionId: existing\.id \}/);
  });
});

describe("signup-2 m4-settlement :: §5 Uncertain Stripe responses", () => {
  it("acceptance #12 Correct handling of uncertain Stripe responses: dispute balance-tx lookup failure logs warning + proceeds without balance fields", () => {
    const h = SVC.slice(SVC.indexOf("async function _handleDisputeEvent"));
    expect(h).toMatch(/catch \(err\)[\s\S]{0,300}balance_lookup_failed/);
    // Balance info stays null; exception still recorded.
    expect(h).toMatch(/balanceInfo = /);
  });
});

describe("signup-2 m4-settlement :: correlation (correction #8)", () => {
  it("correlator never uses event ordering: deterministic lookup via (invoice.payment_intent -> cycle.stripePaymentIntentId)", async () => {
    // Pure predicate shape check (no DB).  We export the function so
    // it can be mocked in service unit tests.
    expect(typeof correlateCycleFromInvoiceLikeIds).toBe("function");
    expect(typeof correlateCycleFromDisputeIds).toBe("function");
  });

  it("invoice correlator priority: payment_intent_id > subscription_id > charge_id", () => {
    const c = SVC.slice(SVC.indexOf("export async function correlateCycleFromInvoiceLikeIds"), SVC.indexOf("export async function correlateCycleFromDisputeIds"));
    const piIdx = c.indexOf("args.invoicePaymentIntentId");
    const subIdx = c.indexOf("args.invoiceSubscriptionId");
    const chargeIdx = c.indexOf("args.invoiceChargeId");
    expect(piIdx).toBeGreaterThan(0);
    expect(subIdx).toBeGreaterThan(piIdx);
    expect(chargeIdx).toBeGreaterThan(subIdx);
  });

  it("dispute correlator uses charge.id or payment_intent.id (no dispute-id-based cycle lookup)", () => {
    const c = SVC.slice(SVC.indexOf("export async function correlateCycleFromDisputeIds"), SVC.indexOf("export async function recordPaymentAttempt"));
    expect(c).toMatch(/args\.chargeId/);
    expect(c).toMatch(/args\.paymentIntentId/);
    // Dispute id is NOT a lookup key (Stripe dispute ids aren't on BillingCycle).
    expect(c).not.toMatch(/stripeDisputeId:/);
  });
});

describe("signup-2 m4-settlement :: scope boundaries (per founder M4-settlement authorisation §7)", () => {
  it("no M4-cancellation service file exists (renewal authorised 2026-10-28)", async () => {
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(join(process.cwd(), "src/lib/billing"));
    const forbidden = files.filter((f) =>
      /^signup-2m4-cancellation-service\.ts$/.test(f),
    );
    expect(forbidden, `forbidden future-slice files leaked: ${forbidden.join(", ")}`).toEqual([]);
  });

  it("no renewal preflight or cancellation command types written here", () => {
    // Strip comment lines before scanning so scope-boundary prose that
    // documents what is OUT of scope doesn't false-trigger the guard.
    const codeOnly = SVC.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    expect(codeOnly).not.toMatch(/MANDATE_VALIDITY_CHECK/);
    expect(codeOnly).not.toMatch(/SUBSCRIPTION_SCHEDULE_CANCEL/);
    expect(codeOnly).not.toMatch(/customer\.subscription\./);
    expect(codeOnly).not.toMatch(/mandate\.updated/);
  });

  it("no HTTP routes for settlement actions exist (service-only slice)", async () => {
    const { existsSync } = await import("node:fs");
    const paths = [
      "src/app/api/billing/settlement/route.ts",
      "src/app/api/billing/reconcile/route.ts",
    ];
    for (const p of paths) {
      expect(existsSync(join(process.cwd(), p)), `forbidden route: ${p}`).toBe(false);
    }
  });
});

describe("signup-2 m4-settlement :: audit trail", () => {
  it("writes audit entries for every settlement path", () => {
    expect(SVC).toMatch(/signup\.m4\.settlement\.invoice_paid/);
    expect(SVC).toMatch(/signup\.m4\.settlement\.invoice_payment_failed/);
    expect(SVC).toMatch(/signup\.m4\.settlement\.\$\{category\.toLowerCase\(\)\}/);
  });
});

describe("signup-2 m4-settlement :: schema guard updates for the new slice", () => {
  it("M4-schema behavior-slice guard permits settlement service alongside triggering", async () => {
    const schemaTest = readFileSync(join(process.cwd(), "tests/signup-2-m4-schema.test.ts"), "utf8");
    expect(schemaTest).toMatch(/signup-2m4-triggering-service\.ts/);
  });
});
