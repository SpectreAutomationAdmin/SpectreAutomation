// SIGNUP-2 M4-cancellation (2026-10-28) -- Contract tests.
//
// Phase 6 of 6 under the authorised M4 sequence.  Covers §1-§5
// scenarios from the founder authorisation + §6 outstanding
// integration-gate register (asserted OPEN).  Pure contract tests
// (file-source scans + flag + state-machine shape tests).  No live
// DB, no live Stripe.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  assertM4CancellationLiveFlag,
  CANCELLATION_STATES,
} from "@/lib/billing/signup-2m4-cancellation-service";

const SVC = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2m4-cancellation-service.ts"),
  "utf8",
);
const DISPATCH = readFileSync(
  join(process.cwd(), "src/lib/billing/signup-2e-webhook-dispatch.ts"),
  "utf8",
);
const SCHEMA_PG = readFileSync(
  join(process.cwd(), "prisma-postgres/schema.prisma"),
  "utf8",
);
const SCHEMA_SQLITE = readFileSync(
  join(process.cwd(), "prisma/schema.prisma"),
  "utf8",
);
const MIGRATION_PG = readFileSync(
  join(process.cwd(), "prisma-postgres/migrations/20261028_signup_2_m4_cancellation/migration.sql"),
  "utf8",
);
const MIGRATION_SQLITE = readFileSync(
  join(process.cwd(), "prisma/migrations/20261028_signup_2_m4_cancellation/migration.sql"),
  "utf8",
);
const ADAPTER_TYPES = readFileSync(
  join(process.cwd(), "src/lib/billing/stripe-adapter/types.ts"),
  "utf8",
);
const ADAPTER_MOCK = readFileSync(
  join(process.cwd(), "src/lib/billing/stripe-adapter/mock.ts"),
  "utf8",
);
const ADAPTER_LIVE = readFileSync(
  join(process.cwd(), "src/lib/billing/stripe-adapter/live.ts"),
  "utf8",
);

const codeOnly = (s: string): string =>
  s.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");

/* ============================================================
 * Service shape
 * ============================================================ */

describe("signup-2 m4-cancellation :: service shape", () => {
  it("exports the complete lifecycle API", () => {
    expect(SVC).toMatch(/export function assertM4CancellationLiveFlag/);
    expect(SVC).toMatch(/export const CANCELLATION_STATES/);
    expect(SVC).toMatch(/export async function requestCancellation/);
    expect(SVC).toMatch(/export async function authorizeCancellation/);
    expect(SVC).toMatch(/export async function rejectCancellation/);
    expect(SVC).toMatch(/export async function scheduleCancellation/);
    expect(SVC).toMatch(/export async function drainOneCancellationCommand/);
    expect(SVC).toMatch(/export async function reconcileSubscriptionUpdatedForCancellation/);
    expect(SVC).toMatch(/export async function reconcileSubscriptionDeletedForCancellation/);
    expect(SVC).toMatch(/export async function reverseCancellation/);
    expect(SVC).toMatch(/export async function evaluatePostCancellationAccess/);
  });

  it("declares all 7 lifecycle states", () => {
    expect(CANCELLATION_STATES).toContain("REQUESTED");
    expect(CANCELLATION_STATES).toContain("AUTHORIZED");
    expect(CANCELLATION_STATES).toContain("SCHEDULED");
    expect(CANCELLATION_STATES).toContain("EFFECTIVE");
    expect(CANCELLATION_STATES).toContain("CANCELLED");
    expect(CANCELLATION_STATES).toContain("REVERSED");
    expect(CANCELLATION_STATES).toContain("REJECTED");
  });
});

/* ============================================================
 * Flag gate
 * ============================================================ */

describe("signup-2 m4-cancellation :: flag gate (SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE)", () => {
  beforeEach(() => { delete process.env.SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE; });
  afterEach(() => { delete process.env.SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE; });

  it("throws when flag is unset", () => {
    expect(() => assertM4CancellationLiveFlag()).toThrow(/disabled/);
  });
  it("throws when flag is 0", () => {
    process.env.SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE = "0";
    expect(() => assertM4CancellationLiveFlag()).toThrow(/disabled/);
  });
  it("succeeds when flag is 1", () => {
    process.env.SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE = "1";
    expect(() => assertM4CancellationLiveFlag()).not.toThrow();
  });
});

/* ============================================================
 * §1 Cancellation lifecycle
 * ============================================================ */

describe("signup-2 m4-cancellation :: §1 lifecycle preserves access until effective", () => {
  it("state machine distinguishes SCHEDULED (access retained) from CANCELLED (effective)", () => {
    // The SVC implements separate states + separate transition sites.
    expect(SVC).toMatch(/state:\s*"SCHEDULED"/);
    expect(SVC).toMatch(/state:\s*"CANCELLED"/);
    // EFFECTIVE is declared in the state enum (though the implementation
    // transitions directly SCHEDULED -> CANCELLED on subscription.deleted).
    expect(CANCELLATION_STATES).toContain("EFFECTIVE");
    // Access evaluator defines distinct post-cancellation access states.
    expect(SVC).toMatch(/ACTIVE_SCHEDULED_CANCELLATION/);
    expect(SVC).toMatch(/READ_ONLY_POST_CANCELLATION/);
    expect(SVC).toMatch(/RESTRICTED_POST_CANCELLATION/);
  });

  it("does NOT equate SCHEDULED with CANCELLED (webhook reconciler only transitions on subscription.deleted)", () => {
    const cleaned = codeOnly(SVC);
    // The transition to CANCELLED happens ONLY in
    // reconcileSubscriptionDeletedForCancellation.
    expect(cleaned).toMatch(/reconcileSubscriptionDeletedForCancellation[\s\S]{0,2500}state:\s*"CANCELLED"/);
    // scheduleCancellation does NOT set state=CANCELLED.
    const scheduleBody = cleaned.match(/export async function scheduleCancellation[\s\S]*?\n\}/)?.[0] ?? "";
    expect(scheduleBody).not.toMatch(/state:\s*"CANCELLED"/);
    expect(scheduleBody).not.toMatch(/state:\s*"EFFECTIVE"/);
  });
});

/* ============================================================
 * §2 Authorization + governance (two-operator SoD)
 * ============================================================ */

describe("signup-2 m4-cancellation :: §2 authorization + governance", () => {
  it("enforces two-operator SoD on authorization + rejection + reversal", () => {
    expect(SVC).toMatch(/SoD violation: authorizedByUserId must differ from requestedByUserId/);
    expect(SVC).toMatch(/SoD violation: rejectedByUserId must differ from requestedByUserId/);
    expect(SVC).toMatch(/SoD violation: reversedByUserId must differ from requestedByUserId/);
  });

  it("validates notice period + outstanding invoices + exceptions as evidence", () => {
    expect(SVC).toMatch(/validationEvidenceJson/);
    expect(SVC).toMatch(/noticeOk/);
    expect(SVC).toMatch(/outstandingInvoiceIds/);
    expect(SVC).toMatch(/openExceptionIds/);
    expect(SVC).toMatch(/NOTICE_PERIOD_NOT_SATISFIED/);
  });

  it("refuses backdated effective dates", () => {
    expect(SVC).toMatch(/APPROVED_DATE_IN_PAST/);
    expect(SVC).toMatch(/backdated cancellation is refused/);
  });

  it("writes audit trail for every state transition", () => {
    expect(SVC).toMatch(/signup\.m4\.cancellation\.requested/);
    expect(SVC).toMatch(/signup\.m4\.cancellation\.authorized/);
    expect(SVC).toMatch(/signup\.m4\.cancellation\.rejected/);
    expect(SVC).toMatch(/signup\.m4\.cancellation\.scheduled/);
    expect(SVC).toMatch(/signup\.m4\.cancellation\.effective/);
    expect(SVC).toMatch(/signup\.m4\.cancellation\.reversed/);
  });
});

/* ============================================================
 * §3 Stripe integration (SUBSCRIPTION_SCHEDULE_CANCEL + reconcile)
 * ============================================================ */

describe("signup-2 m4-cancellation :: §3 Stripe integration", () => {
  it("uses the SUBSCRIPTION_SCHEDULE_CANCEL BillingCommand type", () => {
    expect(SVC).toMatch(/commandType:\s*"SUBSCRIPTION_SCHEDULE_CANCEL"/);
  });

  it("deterministic idempotency key prevents duplicate commands", () => {
    expect(SVC).toMatch(/stripeIdempotencyKey\s*=\s*`signup-2m4-sub-cancel:\$\{req\.id\}:v1`/);
  });

  it("reconciles customer.subscription.updated + customer.subscription.deleted (no delivery order assumed)", () => {
    expect(SVC).toMatch(/reconcileSubscriptionUpdatedForCancellation/);
    expect(SVC).toMatch(/reconcileSubscriptionDeletedForCancellation/);
    expect(SVC).toMatch(/stripeSubscriptionId:\s*sub\.id/);
  });

  it("StripeAdapter interface declares scheduleSubscriptionCancellation + resumeSubscription", () => {
    expect(ADAPTER_TYPES).toMatch(/scheduleSubscriptionCancellation\(args:.*ScheduleSubscriptionCancellationArgs\)/);
    expect(ADAPTER_TYPES).toMatch(/resumeSubscription\(args:.*ResumeSubscriptionArgs\)/);
    expect(ADAPTER_TYPES).toMatch(/stripeSubscriptionId:\s*string/);
    expect(ADAPTER_TYPES).toMatch(/cancelAt:\s*Date;/);
  });

  it("mock adapter provides deterministic cancellation + resume", () => {
    expect(ADAPTER_MOCK).toMatch(/async scheduleSubscriptionCancellation\(args:/);
    expect(ADAPTER_MOCK).toMatch(/async resumeSubscription\(args:/);
    expect(ADAPTER_MOCK).toMatch(/evidenceSource:\s*"mock-stripe"/);
  });

  it("live adapter uses stripe.subscriptions.update(cancel_at=future) and REFUSES immediate cancel", () => {
    expect(ADAPTER_LIVE).toMatch(/stripe\.subscriptions\.update\(/);
    expect(ADAPTER_LIVE).toMatch(/cancel_at:\s*cancelAtUnix/);
    expect(ADAPTER_LIVE).toMatch(/immediate cancellation refused/);
  });

  it("dispatcher routes BOTH renewal + cancellation reconciliation on subscription events", () => {
    expect(DISPATCH).toMatch(/signup-2m4-cancellation-service/);
    expect(DISPATCH).toMatch(/reconcileSubscriptionUpdatedForCancellation/);
    expect(DISPATCH).toMatch(/reconcileSubscriptionDeletedForCancellation/);
  });

  it("dispatcher defers (processedAt=null) when BOTH renewal + cancellation flags are OFF", () => {
    expect(DISPATCH).toMatch(/SIGNUP-2 M4-cancellation workflow is disabled/);
    expect(DISPATCH).toMatch(/stripe\.webhook\.m4_cancellation\.deferred_flag_off/);
    expect(DISPATCH).toMatch(/renewalDeferred/);
    expect(DISPATCH).toMatch(/cancellationDeferred/);
  });

  it("worker is DUAL-flag gated (M4-cancellation + M3 payment-initiation)", () => {
    expect(SVC).toMatch(/SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION/);
    expect(SVC).toMatch(/m3_payment_initiation_blocked/);
  });
});

/* ============================================================
 * §4 Tenant access + financial history preservation
 * ============================================================ */

describe("signup-2 m4-cancellation :: §4 financial history preserved; no tenant-data deletion", () => {
  it("evaluatePostCancellationAccess returns an access state without destroying data", () => {
    expect(SVC).toMatch(/evaluatePostCancellationAccess/);
    expect(SVC).toMatch(/is preserved indefinitely/);
    expect(SVC).toMatch(/retentionNote/);
  });

  it("service writes NO Club rows, NO delete calls on accounting / historical records", () => {
    const cleaned = codeOnly(SVC);
    expect(cleaned).not.toMatch(/prisma\.club\.create/);
    expect(cleaned).not.toMatch(/prisma\.club\.delete/);
    expect(cleaned).not.toMatch(/prisma\.journalEntry\.delete/);
    expect(cleaned).not.toMatch(/prisma\.invoice\.delete/);
    expect(cleaned).not.toMatch(/prisma\.member\.delete/);
    expect(cleaned).not.toMatch(/prisma\.payrollBatch\.delete/);
    expect(cleaned).not.toMatch(/prisma\.subscriptionPaymentMandate\.delete/);
  });

  it("§4 contract text asserts data preservation", () => {
    // Collapse whitespace + strip JSDoc leading "*" so multi-line
    // comment prose matches robustly.
    const collapsed = SVC.replace(/\n\s*\*\s?/g, " ").replace(/\s+/g, " ");
    expect(collapsed).toMatch(/subscription cancellation != tenant-data deletion/);
    expect(collapsed).toMatch(/historical records are preserved indefinitely/);
  });
});

/* ============================================================
 * §5 Exceptions + recovery
 * ============================================================ */

describe("signup-2 m4-cancellation :: §5 exceptions + recovery", () => {
  it("deduplicates duplicate cancellation requests on the same open cycle", () => {
    expect(SVC).toMatch(/signup\.m4\.cancellation\.request\.deduped/);
    expect(SVC).toMatch(/state: \{ in: \["REQUESTED", "AUTHORIZED", "SCHEDULED"\] \}/);
  });

  it("refuses cancellation when subscription is already in canceled state", () => {
    expect(SVC).toMatch(/SUBSCRIPTION_ALREADY_CANCELLED/);
  });

  it("Stripe timeout path records UNCERTAIN (not FAILED-blind) for operator review", () => {
    expect(SVC).toMatch(/outcome:\s*"UNCERTAIN"/);
    expect(SVC).toMatch(/markCommandTerminal\(commandId, "UNCERTAIN"/);
  });

  it("concurrent state transitions are detected via conditional updateMany", () => {
    expect(SVC).toMatch(/CONCURRENT_AUTHORIZATION_RACE/);
    expect(SVC).toMatch(/CONCURRENT_REJECTION_RACE/);
    expect(SVC).toMatch(/CONCURRENT_SCHEDULE_RACE/);
    expect(SVC).toMatch(/CONCURRENT_REVERSAL_RACE/);
  });

  it("already-cancelled subscription short-circuits scheduling to no-op", () => {
    expect(SVC).toMatch(/request already resolved/);
    expect(SVC).toMatch(/no-op/);
  });

  it("reversal is refused once actualEffectiveAt is set", () => {
    expect(SVC).toMatch(/CANCELLATION_ALREADY_EFFECTIVE/);
    expect(SVC).toMatch(/cannot reverse a cancellation that has already taken effect/);
  });

  it("reversal enqueues SUBSCRIPTION_RESUME command with its own idempotency key", () => {
    expect(SVC).toMatch(/commandType:\s*"SUBSCRIPTION_RESUME"/);
    expect(SVC).toMatch(/signup-2m4-sub-resume:\$\{req\.id\}:v1/);
  });

  it("cross-tenant cancellation attempt is refused with ForbiddenError", () => {
    expect(SVC).toMatch(/cross-tenant cancellation refused/);
  });

  it("missing stripeSubscriptionId records UNCERTAIN for operator triage", () => {
    expect(SVC).toMatch(/SUBSCRIPTION_NOT_FOUND/);
    expect(SVC).toMatch(/no stripeSubscriptionId on billingCycle/);
  });
});

/* ============================================================
 * §6 Outstanding integration gates (register asserted OPEN)
 * ============================================================ */

describe("signup-2 m4-cancellation :: §6 outstanding integration gates remain OPEN", () => {
  // Per the founder authorisation: do not mark these complete based
  // solely on contract tests or mocked events.  The register below
  // documents what REMAINS OPEN after Phase 6 is accepted.
  const OPEN_GATES = [
    "Actual Stripe-originated subscription and settlement verification",
    "End-to-end renewal execution on staging",
    "End-to-end retry execution on staging",
    "Verified club-facing email delivery",
    "Statutory-holiday scheduling that cannot silently violate the three-business-day minimum",
    "Full billing lifecycle integration and activation safeguards",
  ] as const;

  it("register of OPEN gates has 6 items", () => {
    expect(OPEN_GATES).toHaveLength(6);
  });

  it("the service does not claim real-Stripe origin + flag remains OFF path exists", () => {
    expect(SVC).toMatch(/OPEN ACCEPTANCE GATE/);
    // Collapsed-whitespace match -- the sentence wraps across multiple
    // comment lines.
    const collapsed = SVC.replace(/\s+/g, " ");
    expect(collapsed).toMatch(/Signed-webhook fixture evidence is NOT proof of actual/i);
  });

  it("worker refuses to call Stripe without BOTH flags on (M4-cancellation + M3-payment-initiation)", () => {
    expect(SVC).toMatch(/SPECTRE_SIGNUP_2M4_CANCELLATION_LIVE/);
    expect(SVC).toMatch(/SPECTRE_SIGNUP_2M3_PAYMENT_INITIATION/);
    expect(SVC).toMatch(/outcome:\s*"SKIPPED_FLAG_OFF"/);
  });
});

/* ============================================================
 * Schema + migration shape
 * ============================================================ */

describe("signup-2 m4-cancellation :: schema + migration", () => {
  it("BillingCancellationRequest model exists in both schemas", () => {
    expect(SCHEMA_PG).toMatch(/model BillingCancellationRequest \{/);
    expect(SCHEMA_SQLITE).toMatch(/model BillingCancellationRequest \{/);
  });

  it("schema carries requester + authorizer + reverser SoD fields", () => {
    for (const schema of [SCHEMA_PG, SCHEMA_SQLITE]) {
      expect(schema).toMatch(/requestedByUserId\s+String\b/);
      expect(schema).toMatch(/authorizedByUserId\s+String\?/);
      expect(schema).toMatch(/reversedByUserId\s+String\?/);
      expect(schema).toMatch(/rejectedByUserId\s+String\?/);
    }
  });

  it("schema distinguishes approvedEffectiveDate from actualEffectiveAt", () => {
    for (const schema of [SCHEMA_PG, SCHEMA_SQLITE]) {
      expect(schema).toMatch(/approvedEffectiveDate\s+DateTime\?/);
      expect(schema).toMatch(/actualEffectiveAt\s+DateTime\?/);
    }
  });

  it("migrations are additive (CREATE TABLE only; no ALTER on preexisting tables)", () => {
    for (const mig of [MIGRATION_PG, MIGRATION_SQLITE]) {
      expect(mig).toMatch(/CREATE TABLE "BillingCancellationRequest"/);
      expect(mig).not.toMatch(/ALTER TABLE "BillingCycle"/);
      expect(mig).not.toMatch(/ALTER TABLE "BillingCommand"/);
      expect(mig).not.toMatch(/DROP TABLE/);
    }
  });

  it("migration has FK + indexes for tenant + state + stripeSubscriptionId", () => {
    for (const mig of [MIGRATION_PG, MIGRATION_SQLITE]) {
      expect(mig).toMatch(/REFERENCES "Club"\("id"\)/);
      expect(mig).toMatch(/REFERENCES "BillingCycle"\("id"\)/);
      expect(mig).toMatch(/BillingCancellationRequest_clubId_idx/);
      expect(mig).toMatch(/BillingCancellationRequest_billingCycleId_idx/);
      expect(mig).toMatch(/BillingCancellationRequest_state_idx/);
      expect(mig).toMatch(/BillingCancellationRequest_stripeSubscriptionId_idx/);
    }
  });
});

/* ============================================================
 * Scope boundaries (per founder M4-cancellation §7)
 * ============================================================ */

describe("signup-2 m4-cancellation :: §7 scope boundaries", () => {
  it("no accelerated synthetic signup-to-activation path exists", () => {
    const paths = [
      "src/app/api/billing/activation-fast-path/route.ts",
      "src/app/api/signup/synthetic-activation/route.ts",
    ];
    for (const p of paths) {
      expect(existsSync(join(process.cwd(), p)), `forbidden route: ${p}`).toBe(false);
    }
  });

  it("no HTTP routes for cancellation initiation / authorization / reversal exist (service-only slice)", () => {
    const paths = [
      "src/app/api/billing/cancel/route.ts",
      "src/app/api/billing/cancellation/route.ts",
      "src/app/api/billing/cancellation-request/route.ts",
    ];
    for (const p of paths) {
      expect(existsSync(join(process.cwd(), p)), `forbidden route: ${p}`).toBe(false);
    }
  });

  it("service does not touch M3 experience / Stripe secrets / $38k Price mutations", () => {
    const cleaned = codeOnly(SVC);
    expect(cleaned).not.toMatch(/STRIPE_SECRET_KEY/);
    expect(cleaned).not.toMatch(/STRIPE_WEBHOOK_SIGNING_SECRET/);
    expect(cleaned).not.toMatch(/prisma\.clubBillingPricing\.(create|update|upsert|delete)/);
    expect(cleaned).not.toMatch(/stripe\.prices\.(create|update|delete)/);
  });

  it("service does not initiate production billing / payment creation", () => {
    const cleaned = codeOnly(SVC);
    expect(cleaned).not.toMatch(/stripe\.subscriptions\.create/);
    expect(cleaned).not.toMatch(/stripe\.paymentIntents\.create/);
    expect(cleaned).not.toMatch(/stripe\.invoices\.pay/);
  });
});

/* ============================================================
 * Dispatcher wiring
 * ============================================================ */

describe("signup-2 m4-cancellation :: dispatcher wiring", () => {
  it("dispatcher lazy-imports cancellation service", () => {
    expect(DISPATCH).toMatch(/await import\("\.\/signup-2m4-cancellation-service"\)/);
  });

  it("cancellation reconciliation does NOT run on mandate.updated (renewal-only)", () => {
    // The dispatcher branches on event.type === "customer.subscription.updated"
    // || event.type === "customer.subscription.deleted" before calling the
    // cancellation reconciler.  mandate.updated goes to renewal only.
    expect(DISPATCH).toMatch(/customer\.subscription\.updated.*customer\.subscription\.deleted/);
  });
});
