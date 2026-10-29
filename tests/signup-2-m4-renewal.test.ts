// SIGNUP-2 M4-renewal (2026-10-28) -- Contract tests.
//
// Covers the 12 acceptance requirements from the M4-renewal
// authorisation + §5 carried-forward corrections.  Pure contract
// tests (file-source scans + pure predicate tests).  No live DB
// or Stripe.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  assertM4RenewalLiveFlag,
  RENEWAL_CHECKPOINTS,
} from "@/lib/billing/signup-2m4-renewal-service";
import {
  CANADIAN_STAT_HOLIDAYS_UTC,
  earliestRetryAt,
  getStatHolidayCalendarCoverage,
} from "@/lib/billing/signup-2m4-retries-service";

const SVC = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2m4-renewal-service.ts"),
  "utf8",
);
const DISPATCH = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2e-webhook-dispatch.ts"),
  "utf8",
);
const RETRIES_SVC = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2m4-retries-service.ts"),
  "utf8",
);
const SETTLEMENT_SVC = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2m4-settlement-service.ts"),
  "utf8",
);

/* ============================================================
 * Service shape
 * ============================================================ */

describe("signup-2 m4-renewal :: service shape", () => {
  it("exports flag guard + T-45/T-7 scheduler + preflight executor + recovery sweep + 3 webhook handlers", () => {
    expect(SVC).toMatch(/export function assertM4RenewalLiveFlag/);
    expect(SVC).toMatch(/export const RENEWAL_CHECKPOINTS/);
    expect(SVC).toMatch(/export async function scheduleRenewalPreflights/);
    expect(SVC).toMatch(/export async function executeRenewalPreflight/);
    expect(SVC).toMatch(/export async function recoverMissedPreflightsForCycle/);
    expect(SVC).toMatch(/export async function handleCustomerSubscriptionUpdated/);
    expect(SVC).toMatch(/export async function handleCustomerSubscriptionDeleted/);
    expect(SVC).toMatch(/export async function handleMandateUpdated/);
  });

  it("declares both renewal checkpoints T-45 + T-7", () => {
    expect(RENEWAL_CHECKPOINTS).toContain("T_MINUS_45_DAYS");
    expect(RENEWAL_CHECKPOINTS).toContain("T_MINUS_7_DAYS");
  });
});

/* ============================================================
 * Flag gate
 * ============================================================ */

describe("signup-2 m4-renewal :: flag gate (SPECTRE_SIGNUP_2M4_RENEWAL_LIVE)", () => {
  beforeEach(() => { delete process.env.SPECTRE_SIGNUP_2M4_RENEWAL_LIVE; });
  afterEach(() => { delete process.env.SPECTRE_SIGNUP_2M4_RENEWAL_LIVE; });

  it("throws when flag is unset", () => {
    expect(() => assertM4RenewalLiveFlag()).toThrow(/disabled/);
  });
  it("throws when flag is 0", () => {
    process.env.SPECTRE_SIGNUP_2M4_RENEWAL_LIVE = "0";
    expect(() => assertM4RenewalLiveFlag()).toThrow(/disabled/);
  });
  it("succeeds when flag is 1", () => {
    process.env.SPECTRE_SIGNUP_2M4_RENEWAL_LIVE = "1";
    expect(() => assertM4RenewalLiveFlag()).not.toThrow();
  });
});

/* ============================================================
 * 12 acceptance scenarios
 * ============================================================ */

describe("signup-2 m4-renewal :: §4 twelve acceptance scenarios -- service wiring", () => {
  // #1 normal annual renewal: T-45 + T-7 preflights, mandate still
  //    valid, no pricing drift -> READY outcome.
  it("#1 normal annual renewal: scheduler writes both T-45 and T-7 rows and READY outcome exists", () => {
    expect(SVC).toMatch(/T_MINUS_45_DAYS/);
    expect(SVC).toMatch(/T_MINUS_7_DAYS/);
    expect(SVC).toMatch(/"READY"/);
  });

  // #2 missed T-45 or T-7 scheduler execution: recovery sweep finds
  //    due-and-unexecuted rows and executes them.
  it("#2 missed scheduler execution is recovered via sweep over scheduledFor<=now AND executedAt is null", () => {
    expect(SVC).toMatch(/recoverMissedPreflightsForCycle/);
    expect(SVC).toMatch(/executedAt:\s*null/);
    expect(SVC).toMatch(/scheduledFor:\s*\{\s*lte:\s*new Date\(\)\s*\}/);
  });

  // #3 duplicate scheduler invocation: idempotency via unique
  //    constraint + conditional updateMany on executedAt.
  it("#3 duplicate scheduler invocation does not produce duplicate rows (unique checkpoint upsert + idempotent execute)", () => {
    expect(SVC).toMatch(/billingCycleId_checkpointLabel/);
    expect(SVC).toMatch(/updateMany/);
    expect(SVC).toMatch(/executedAt:\s*null/);
  });

  // #4 expired/revoked mandate: MANDATE_EXPIRED outcome + operator
  //    inbox entry; retry worker in M4-retries also refuses revoked
  //    mandates.
  it("#4 expired/revoked mandate flags MANDATE_EXPIRED + records operator inbox entry", () => {
    expect(SVC).toMatch(/"MANDATE_EXPIRED"/);
    expect(SVC).toMatch(/mandateStillValid/);
    expect(SVC).toMatch(/revokedAt/);
    expect(SVC).toMatch(/operatorInboxEntry\.create/);
  });

  // #5 pricing drift: PRICING_CHANGED outcome; service does NOT
  //    silently apply changed pricing.  renewalPricingDriftDetected
  //    is persisted + routed to operator.
  it("#5 pricing drift: PRICING_CHANGED outcome exists + renewalPricingDriftDetected flag persisted + no silent price change", () => {
    expect(SVC).toMatch(/"PRICING_CHANGED"/);
    expect(SVC).toMatch(/renewalPricingDriftDetected/);
    // Confirm the resolver surfaces drift to the operator inbox (not a
    // silent application).
    expect(SVC).toMatch(/requiresOperatorAction/);
  });

  // #6 tax-treatment / commercial-terms changes: captured on
  //    preflight row (renewalTaxTreatment, renewalGstPercentBps).
  it("#6 tax-treatment captured on preflight (renewalTaxTreatment + renewalGstPercentBps)", () => {
    expect(SVC).toMatch(/renewalTaxTreatment/);
    expect(SVC).toMatch(/renewalGstPercentBps/);
  });

  // #7 duplicate invoice / duplicate subscription prevention:
  //    renewal service does NOT create subscriptions; it only
  //    reconciles.  M3 §7 global sub-create block (reference).
  it("#7 renewal service does not create subscriptions or invoices (M3 §7 block preserved)", () => {
    const codeOnly = SVC.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    expect(codeOnly).not.toMatch(/stripe\.subscriptions\.create/);
    expect(codeOnly).not.toMatch(/stripe\.invoices\.create/);
  });

  // #8 delayed / out-of-order webhook events: every handler
  //    correlates by Stripe identifier (not by ordering).
  it("#8 webhook handlers correlate by Stripe identifier -- do NOT assume delivery order", () => {
    expect(SVC).toMatch(/correlateCycleFromSubscription/);
    // Each handler looks up BillingCommand or SubscriptionPaymentMandate
    // by Stripe id, not by position/order.
    expect(SVC).toMatch(/stripeResourceId:\s*stripeSubscriptionId/);
    expect(SVC).toMatch(/stripeMandateId:\s*stripeMandate\.id/);
  });

  // #9 renewal payment failure: dispatched to M4-settlement
  //    invoice.payment_failed handler (unchanged); renewal service
  //    marks an exception when the subscription itself is deleted.
  it("#9 renewal subscription deletion records BillingExceptionCase RENEWAL_SUBSCRIPTION_DELETED", () => {
    expect(SVC).toMatch(/"RENEWAL_SUBSCRIPTION_DELETED"/);
    expect(SVC).toMatch(/requiresOperatorAction:\s*true/);
  });

  // #10 tenant isolation: all state is tied to BillingCycle.clubId
  //     + BillingCycle lookups are keyed by Stripe-authoritative ids.
  it("#10 tenant isolation: every state write is keyed by billingCycleId / clubId / signupRegistrationId", () => {
    expect(SVC).toMatch(/billingCycleId:\s*cycle\.id/);
    expect(SVC).toMatch(/clubId:\s*cycle\.clubId/);
  });

  // #11 correct customer notification: §4 requires club admin be
  //     notified through a USABLE channel; internal inbox alone
  //     is NOT sufficient.  Operator entry is written for
  //     visibility.  (End-customer notification channel is wired
  //     via the retries service's selectPlatformEmailAdapter path
  //     -- see §5 correction #1 below.)
  it("#11 operator-visibility entry written for every outcome that requires action", () => {
    expect(SVC).toMatch(/operatorInboxEntry\.create/);
    expect(SVC).toMatch(/category:\s*`RENEWAL_PREFLIGHT_\$\{outcome\}`/);
  });

  // #12 prevent duplicate tenant provisioning: renewal processing
  //     cannot create a second club or re-provision.  The service
  //     writes no Club rows + no CLUB_PROVISION commands.
  it("#12 renewal service writes no Club rows and no CLUB_PROVISION commands", () => {
    const codeOnly = SVC.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    expect(codeOnly).not.toMatch(/prisma\.club\.create/);
    expect(codeOnly).not.toMatch(/CLUB_PROVISION/);
    expect(codeOnly).not.toMatch(/provisionTenant/);
  });
});

/* ============================================================
 * Dispatcher wiring
 * ============================================================ */

describe("signup-2 m4-renewal :: dispatcher wiring (3 new events)", () => {
  it("dispatcher routes customer.subscription.updated + customer.subscription.deleted + mandate.updated", () => {
    expect(DISPATCH).toMatch(/case "customer\.subscription\.updated":/);
    expect(DISPATCH).toMatch(/case "customer\.subscription\.deleted":/);
    expect(DISPATCH).toMatch(/case "mandate\.updated":/);
  });

  it("dispatcher defers (processedAt=null) when renewal flag is OFF", () => {
    expect(DISPATCH).toMatch(/SIGNUP-2 M4-renewal workflow is disabled/);
    expect(DISPATCH).toMatch(/stripe\.webhook\.m4_renewal\.deferred_flag_off/);
    // Message text widened in M4-cancellation to also cover the
    // cancellation-side flag-off defer.  Both the renewal-only path
    // ("M4-renewal flag off") and the dual-flag-off path ("M4 flags
    // off for") are now acceptable.
    expect(DISPATCH).toMatch(/throw new SignupM3DeferredEvent\(`M4(-renewal flag off|\s*flags off for)/);
  });

  it("dispatcher imports renewal service dynamically (lazy, flag-aware)", () => {
    expect(DISPATCH).toMatch(/await import\("\.\/signup-2m4-renewal-service"\)/);
  });
});

/* ============================================================
 * §5 carried-forward corrections (retries + settlement)
 * ============================================================ */

describe("signup-2 m4-renewal :: §5 correction #1 -- club admin notification channel", () => {
  it("retries service wires selectPlatformEmailAdapter for pre-retry notification", () => {
    expect(RETRIES_SVC).toMatch(/selectPlatformEmailAdapter/);
    expect(RETRIES_SVC).toMatch(/notifyClubBeforeRetry/);
    expect(RETRIES_SVC).toMatch(/emailDelivered/);
  });
  it("retries service clearly states operator inbox is NOT a substitute for customer communication", () => {
    expect(RETRIES_SVC).toMatch(/NOT a substitute for the customer communication/);
  });
});

describe("signup-2 m4-renewal :: §5 correction #2 -- Canadian stat holiday calendar", () => {
  it("exposes CANADIAN_STAT_HOLIDAYS_UTC with 2026/2027/2028 federal + Alberta observances", () => {
    expect(CANADIAN_STAT_HOLIDAYS_UTC.size).toBeGreaterThanOrEqual(30);
    // Spot-check federal and Alberta observances.
    expect(CANADIAN_STAT_HOLIDAYS_UTC.has("2026-07-01")).toBe(true);  // Canada Day
    expect(CANADIAN_STAT_HOLIDAYS_UTC.has("2026-12-25")).toBe(true);  // Christmas
    expect(CANADIAN_STAT_HOLIDAYS_UTC.has("2026-02-16")).toBe(true);  // Alberta Family Day
    expect(CANADIAN_STAT_HOLIDAYS_UTC.has("2026-08-03")).toBe(true);  // Alberta Heritage Day
  });

  it("earliestRetryAt skips weekends", () => {
    // Fri 2026-06-05 00:00:00Z + 3bd -> Wed 2026-06-10 (skips Sat/Sun).
    const r = earliestRetryAt(new Date("2026-06-05T00:00:00Z"), 3);
    expect(r.toISOString().slice(0, 10)).toBe("2026-06-10");
  });

  it("earliestRetryAt skips a stat holiday", () => {
    // Fri 2026-06-26 + 3bd normally -> Wed 2026-07-01 (Canada Day).
    // Correct behaviour -> skip 07-01 -> Thu 2026-07-02.
    const r = earliestRetryAt(new Date("2026-06-26T00:00:00Z"), 3);
    expect(r.toISOString().slice(0, 10)).toBe("2026-07-02");
  });

  it("earliestRetryAt skips Alberta Family Day", () => {
    // Thu 2026-02-12 + 3bd normally -> Tue 2026-02-17 (Fri Mon Tue).
    // Correct: Mon 2026-02-16 is Alberta Family Day -> skip -> Wed 02-18.
    const r = earliestRetryAt(new Date("2026-02-12T00:00:00Z"), 3);
    expect(r.toISOString().slice(0, 10)).toBe("2026-02-18");
  });

  it("exposes calendar coverage for ops observability (durability contract)", () => {
    const coverage = getStatHolidayCalendarCoverage();
    expect(coverage.latestCoveredYear).toBeGreaterThanOrEqual(2028);
    expect(coverage.totalEntries).toBe(CANADIAN_STAT_HOLIDAYS_UTC.size);
  });
});

describe("signup-2 m4-renewal :: §5 correction #3 -- real-Stripe-settlement open-gate documentation", () => {
  it("settlement service documents the open acceptance gate", () => {
    expect(SETTLEMENT_SVC).toMatch(/OPEN ACCEPTANCE GATE/);
    expect(SETTLEMENT_SVC).toMatch(/HMAC-signed Stripe-SHAPED fixtures/);
    // Comment prose may line-wrap; collapse whitespace before matching.
    const collapsed = SETTLEMENT_SVC.replace(/\s+/g, " ");
    expect(collapsed).toMatch(/NOT proof of actual.{0,20}funds settlement/);
  });
  it("retries service documents the open acceptance gate", () => {
    expect(RETRIES_SVC).toMatch(/OPEN ACCEPTANCE GATE/);
    expect(RETRIES_SVC).toMatch(/SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION/);
  });
});

/* ============================================================
 * Scope boundaries (per founder M4-renewal authorisation §6)
 * ============================================================ */

describe("signup-2 m4-renewal :: scope boundaries", () => {
  it("M4-renewal service file remains present (all six phases now authorised 2026-10-28)", () => {
    const files = readdirSync(join(process.cwd(), "src/lib/billing"));
    expect(files).toContain("signup-2m4-renewal-service.ts");
  });

  it("no HTTP routes for renewal / cancellation / accelerated signup-to-activation exist", () => {
    const paths = [
      "src/app/api/billing/renewal/route.ts",
      "src/app/api/billing/renewal-preflight/route.ts",
      "src/app/api/billing/cancel/route.ts",
      "src/app/api/billing/activation-fast-path/route.ts",
    ];
    for (const p of paths) {
      expect(existsSync(join(process.cwd(), p)), `forbidden route: ${p}`).toBe(false);
    }
  });

  it("renewal service does not touch M3 experience, Stripe secrets, or $38k Price", () => {
    const codeOnly = SVC.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    // M3 experience: no rewrite of registration state.
    expect(codeOnly).not.toMatch(/signupRegistration\.update/);
    // Stripe secrets: service never reads STRIPE_SECRET_KEY or
    // STRIPE_WEBHOOK_SIGNING_SECRET directly (dispatcher handles verification).
    expect(codeOnly).not.toMatch(/STRIPE_SECRET_KEY/);
    expect(codeOnly).not.toMatch(/STRIPE_WEBHOOK_SIGNING_SECRET/);
    // $38k Price: service never WRITES a new Price (no ClubBillingPricing
    // mutations here).  Any amountMinorUnits touch is a read-only Prisma
    // select, not a mutation.
    expect(codeOnly).not.toMatch(/prisma\.clubBillingPricing\.(create|update|upsert|delete)/);
    expect(codeOnly).not.toMatch(/stripe\.prices\.(create|update|delete)/);
  });

  it("renewal service does not initiate production billing or subscription creation", () => {
    const codeOnly = SVC.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
    expect(codeOnly).not.toMatch(/stripe\.subscriptions\.create/);
    expect(codeOnly).not.toMatch(/stripe\.paymentIntents\.create/);
    expect(codeOnly).not.toMatch(/paymentInitiationEnabled/);
  });
});
