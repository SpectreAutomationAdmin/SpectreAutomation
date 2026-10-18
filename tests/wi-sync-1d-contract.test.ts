// WI-SYNC-1d (2026-10-18) — source-contract locks for the Graph
// change-notification subscription lifecycle + webhook + scheduler
// + health extensions + financial-preservation guards.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SUBS = readFileSync(join(process.cwd(), "src/lib/mailbox/subscriptions.ts"), "utf8");
const SCHED = readFileSync(join(process.cwd(), "src/lib/mailbox/subscription-scheduler.ts"), "utf8");
const WEBHOOK = readFileSync(
  join(process.cwd(), "src/app/api/webhooks/microsoft-graph/notifications/route.ts"),
  "utf8",
);
const HANDLERS = readFileSync(join(process.cwd(), "src/lib/queue/handlers.ts"), "utf8");
const WORKER = readFileSync(join(process.cwd(), "bin/worker.ts"), "utf8");
const PROVIDER = readFileSync(
  join(process.cwd(), "src/lib/integrations/microsoft-graph-delegated.ts"),
  "utf8",
);
const HEALTH = readFileSync(join(process.cwd(), "src/lib/mailbox/sync-health.ts"), "utf8");
const SCHEMA_PG = readFileSync(join(process.cwd(), "prisma-postgres/schema.prisma"), "utf8");
const MIG_PG = readFileSync(
  join(process.cwd(), "prisma-postgres/migrations/20261018_wi_sync_1d_graph_subscriptions/migration.sql"),
  "utf8",
);

describe("WI-SYNC-1d · schema + migration", () => {
  it("GraphSubscription carries clubId + renewalFailureCount + lastRenewalError + lastNotificationTriggeredDeltaAt", () => {
    expect(SCHEMA_PG).toMatch(/clubId\s+String/);
    expect(SCHEMA_PG).toMatch(/renewalFailureCount\s+Int\s+@default\(0\)/);
    expect(SCHEMA_PG).toMatch(/lastRenewalError\s+String\?/);
    expect(SCHEMA_PG).toMatch(/lastNotificationTriggeredDeltaAt\s+DateTime\?/);
    expect(MIG_PG).toMatch(/"clubId" TEXT NOT NULL/);
    expect(MIG_PG).toMatch(/"renewalFailureCount" INTEGER NOT NULL DEFAULT 0/);
    expect(MIG_PG).toMatch(/"lastRenewalError" TEXT/);
    expect(MIG_PG).toMatch(/GraphSubscription_clubId_lifecycleState_idx/);
  });
});

describe("WI-SYNC-1d · Microsoft Graph provider methods", () => {
  it("createSubscription hits POST /subscriptions with change types + resource + clientState", () => {
    const impl = PROVIDER.slice(PROVIDER.indexOf("async createSubscription("));
    expect(impl).toMatch(/method:\s*"POST"/);
    expect(impl).toMatch(/graph\.microsoft\.com\/v1\.0\/subscriptions/);
    expect(impl).toMatch(/changeType:\s*args\.changeTypes/);
    expect(impl).toMatch(/notificationUrl:\s*args\.notificationUrl/);
    expect(impl).toMatch(/clientState:\s*args\.clientState/);
    expect(impl).toMatch(/resource:\s*args\.resource/);
    expect(impl).toMatch(/expirationDateTime:\s*args\.expirationDateTime/);
  });
  it("renewSubscription hits PATCH /subscriptions/{id} with only the new expiration", () => {
    const impl = PROVIDER.slice(PROVIDER.indexOf("async renewSubscription("));
    expect(impl).toMatch(/method:\s*"PATCH"/);
    expect(impl).toMatch(/subscriptions\/\$\{encodeURIComponent\(args\.microsoftSubscriptionId\)\}/);
    expect(impl).toMatch(/expirationDateTime:\s*args\.expirationDateTime/);
  });
  it("deleteSubscription hits DELETE + treats 404 as idempotent success", () => {
    const impl = PROVIDER.slice(PROVIDER.indexOf("async deleteSubscription("));
    expect(impl).toMatch(/method:\s*"DELETE"/);
    expect(impl).toMatch(/res\.status === 404/);
    expect(impl).toMatch(/return;/);
  });
});

describe("WI-SYNC-1d · subscription service", () => {
  it("notificationUrlFor returns the deterministic webhook path", () => {
    expect(SUBS).toMatch(/notificationUrlFor/);
    expect(SUBS).toMatch(/\/api\/webhooks\/microsoft-graph\/notifications/);
  });
  it("tenant-guards mailbox → clubId match + skips non-CONNECTED mailboxes", () => {
    expect(SUBS).toMatch(/mailbox\.clubId !== args\.clubId/);
    expect(SUBS).toMatch(/mailbox\.status !== "CONNECTED"/);
  });
  it("CREATE path: delete-before-create for obsolete rows + stores sha256 hash of clientState", () => {
    expect(SUBS).toMatch(/provider\.deleteSubscription\(/);
    expect(SUBS).toMatch(/clientStateSecretRef:\s*sha256\(clientState\)/);
    expect(SUBS).toMatch(/newClientState\(\)/);
  });
  it("RENEW path: increments renewalFailureCount on failure + flips to FAILED after 3 strikes", () => {
    expect(SUBS).toMatch(/RENEWAL_FAILURE_RECREATE_THRESHOLD = 3/);
    expect(SUBS).toMatch(/nextCount\s*>=\s*RENEWAL_FAILURE_RECREATE_THRESHOLD/);
  });
  it("expiration always ≤ Graph's 3-day cap (hard-coded 2d 23h)", () => {
    expect(SUBS).toMatch(/MAX_LIFETIME_MINUTES\s*=\s*2 \* 24 \* 60 \+ 23 \* 60/);
  });
  it("exports hashClientState for webhook verification", () => {
    expect(SUBS).toMatch(/export function hashClientState/);
  });
  it("subscription service never touches APInvoice / JournalEntry / Approval / Payment / ApIntakeSource", () => {
    for (const forbidden of [
      /prisma\.aPInvoice\./,
      /prisma\.journalEntry\./,
      /prisma\.approval\./,
      /prisma\.payment\./,
      /prisma\.apIntakeSource\./,
    ]) {
      expect(SUBS).not.toMatch(forbidden);
    }
  });
});

describe("WI-SYNC-1d · webhook route", () => {
  it("validation-token handshake echoes the token as text/plain, 200", () => {
    expect(WEBHOOK).toMatch(/validationToken/);
    expect(WEBHOOK).toMatch(/"Content-Type":\s*"text\/plain"/);
    expect(WEBHOOK).toMatch(/return new NextResponse\(validationToken/);
  });
  it("rejects notifications when integration disabled with 410", () => {
    expect(WEBHOOK).toMatch(/isMailboxIntegrationEnabled/);
    expect(WEBHOOK).toMatch(/status:\s*410/);
  });
  it("rejects invalid JSON or empty bodies with 400", () => {
    expect(WEBHOOK).toMatch(/"invalid_json"/);
    expect(WEBHOOK).toMatch(/"empty_notifications"/);
  });
  it("required security checks — subscription id lookup + clientState hash compare", () => {
    expect(WEBHOOK).toMatch(/prisma\.graphSubscription\.findUnique/);
    expect(WEBHOOK).toMatch(/hashClientState\(n\.clientState\) !== sub\.clientStateSecretRef/);
    expect(WEBHOOK).toMatch(/CLIENT_STATE_MISMATCH/);
    expect(WEBHOOK).toMatch(/UNKNOWN_SUBSCRIPTION/);
    expect(WEBHOOK).toMatch(/INVALID_SHAPE/);
  });
  it("tenant-safe: enqueue uses sub.clubId NOT the request's", () => {
    expect(WEBHOOK).toMatch(/clubId:\s*sub\.clubId/);
  });
  it("duplicate suppression — enqueue errors fall through to DUPLICATE_SUPPRESSED, not a 500", () => {
    expect(WEBHOOK).toMatch(/DUPLICATE_SUPPRESSED/);
    expect(WEBHOOK).toMatch(/try \{\s*await enqueue/);
  });
  it("expedited delta uses time-bucketed idempotency key so poller + webhook collapse to one job", () => {
    expect(WEBHOOK).toMatch(/idempotencyKey:\s*`mailbox:webhook-delta:/);
    expect(WEBHOOK).toMatch(/bucket/);
  });
  it("rejects invalid or unrecognised notifications WITHOUT triggering mailbox operations", () => {
    // The invalid branches continue the loop; they never call enqueue.
    const section = WEBHOOK.slice(WEBHOOK.indexOf("for (const n of body.value)"));
    expect(section).toMatch(/outcome:\s*"UNKNOWN_SUBSCRIPTION"/);
    expect(section).toMatch(/outcome:\s*"CLIENT_STATE_MISMATCH"/);
    // enqueue is INSIDE the matched/valid branch only.
    const invalidPos = section.indexOf("UNKNOWN_SUBSCRIPTION");
    const enqueuePos = section.indexOf("enqueue({");
    expect(invalidPos).toBeGreaterThan(0);
    expect(enqueuePos).toBeGreaterThan(invalidPos);
  });
  it("webhook route never touches APInvoice / JournalEntry / Approval / Payment", () => {
    for (const forbidden of [
      /prisma\.aPInvoice\./,
      /prisma\.journalEntry\./,
      /prisma\.approval\./,
      /prisma\.payment\./,
    ]) {
      expect(WEBHOOK).not.toMatch(forbidden);
    }
  });
});

describe("WI-SYNC-1d · MAILBOX_RENEW_SUBSCRIPTION handler", () => {
  it("promoted from RESERVED_PHASE_C to IMPLEMENTED", () => {
    expect(HANDLERS).toMatch(/MAILBOX_RENEW_SUBSCRIPTION:\s*"IMPLEMENTED"/);
    expect(HANDLERS).not.toMatch(/NOT_IMPLEMENTED: MAILBOX_RENEW_SUBSCRIPTION/);
  });
  it("delegates to maintainSubscriptionForMailbox with hint-based forceRecreate", () => {
    expect(HANDLERS).toMatch(/maintainSubscriptionForMailbox\(/);
    expect(HANDLERS).toMatch(/forceRecreate:\s*payload\?\.hint === "RECREATE"/);
  });
  it("skips non-CONNECTED mailboxes without throwing", () => {
    expect(HANDLERS).toMatch(/mailbox\.subscription\.skipped_not_connected/);
  });
});

describe("WI-SYNC-1d · subscription-maintenance scheduler", () => {
  it("feature-gated + interval-budgeted", () => {
    expect(SCHED).toMatch(/isMailboxIntegrationEnabled/);
    expect(SCHED).toMatch(/MAILBOX_SUBSCRIPTION_INTERVAL_MS/);
    expect(SCHED).toMatch(/5\s*\*\s*60_000/);
  });
  it("classifies to CREATE / RENEW / RECREATE based on current state", () => {
    for (const label of [
      /action = "CREATE"/,
      /action = "RENEW"/,
      /action = "RECREATE"/,
    ]) {
      expect(SCHED).toMatch(label);
    }
  });
  it("time-bucketed idempotency key per (mailbox, action, bucket)", () => {
    expect(SCHED).toMatch(/idempotencyKey:\s*`mailbox:subscription:\$\{mbx\.id\}:\$\{bucket\}:\$\{action\}`/);
  });
  it("scan cap 200", () => {
    expect(SCHED).toMatch(/take:\s*200/);
  });
  it("renewal window configurable via MAILBOX_SUBSCRIPTION_RENEWAL_WINDOW_MIN (default 1440 = 24h)", () => {
    expect(SCHED).toMatch(/MAILBOX_SUBSCRIPTION_RENEWAL_WINDOW_MIN/);
    expect(SCHED).toMatch(/"1440"/);
  });
});

describe("WI-SYNC-1d · worker loop wiring", () => {
  it("imports + invokes tickSubscriptionMaintenance alongside the other ticks", () => {
    expect(WORKER).toMatch(/import \{ tickSubscriptionMaintenance \} from ".*subscription-scheduler"/);
    expect(WORKER).toMatch(/await tickSubscriptionMaintenance\(\)/);
    expect(WORKER).toMatch(/tickAutoSync\(\)/);
    expect(WORKER).toMatch(/tickReconciliationSweep\(\)/);
    expect(WORKER).toMatch(/processPending\(/);
  });
});

describe("WI-SYNC-1d · sync-health service extensions", () => {
  it("per-mailbox report carries subscription metrics", () => {
    expect(HEALTH).toMatch(/subscription:\s*subRow/);
    expect(HEALTH).toMatch(/microsoftSubscriptionIdTail/);
    expect(HEALTH).toMatch(/lastNotificationAgeSeconds/);
    expect(HEALTH).toMatch(/pollingFallbackActive/);
    expect(HEALTH).toMatch(/renewalFailureCount/);
    expect(HEALTH).toMatch(/lastRenewalError/);
  });
  it("intervention reasons include subscription_renewal_failures_N + subscription_<lifecycle>", () => {
    expect(HEALTH).toMatch(/subscription_renewal_failures_/);
    // The lifecycle-based reason is a template literal that emits
    // "subscription_failed" or "subscription_expired" at runtime —
    // match the shape of the construction expression.
    expect(HEALTH).toMatch(/`subscription_\$\{subRow\.lifecycleState\.toLowerCase\(\)\}`/);
    expect(HEALTH).toMatch(/subRow\.lifecycleState === "FAILED"/);
    expect(HEALTH).toMatch(/subRow\.lifecycleState === "EXPIRED"/);
  });
  it("totals carry subscription-coverage counts", () => {
    for (const field of [
      /mailboxesWithActiveSubscription/,
      /mailboxesWithoutSubscription/,
      /mailboxesOnPollingFallback/,
    ]) {
      expect(HEALTH).toMatch(field);
    }
  });
  it("still never writes to APInvoice / JournalEntry / Approval / Payment / ApIntakeSource", () => {
    for (const forbidden of [
      /prisma\.aPInvoice\./,
      /prisma\.journalEntry\./,
      /prisma\.approval\./,
      /prisma\.payment\./,
      /prisma\.apIntakeSource\./,
    ]) {
      expect(HEALTH).not.toMatch(forbidden);
    }
  });
});

describe("WI-SYNC-1d · financial-preservation (whole slice)", () => {
  it("no new module writes to AP / journal / approval / payment surfaces", () => {
    for (const src of [SUBS, SCHED, WEBHOOK, HEALTH]) {
      for (const forbidden of [
        /prisma\.aPInvoice\.(update|delete|create|upsert)/,
        /prisma\.journalEntry\.(update|delete|create|upsert)/,
        /prisma\.approval\.(update|delete|create|upsert)/,
        /prisma\.payment\.(update|delete|create|upsert)/,
        /prisma\.apIntakeSource\.(update|delete|create|upsert)/,
      ]) {
        expect(src).not.toMatch(forbidden);
      }
    }
  });
});
