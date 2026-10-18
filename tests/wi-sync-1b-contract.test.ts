// WI-SYNC-1b (2026-10-18) — source-contract locks for the scheduled
// reconciliation sweep + health endpoint + financial-preservation
// guarantees.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCHEDULER = readFileSync(
  join(process.cwd(), "src/lib/mailbox/reconciliation-scheduler.ts"),
  "utf8",
);
const HANDLERS = readFileSync(
  join(process.cwd(), "src/lib/queue/handlers.ts"),
  "utf8",
);
const WORKER = readFileSync(join(process.cwd(), "bin/worker.ts"), "utf8");
const RECONCILIATION = readFileSync(
  join(process.cwd(), "src/lib/mailbox/reconciliation.ts"),
  "utf8",
);
const HEALTH = readFileSync(join(process.cwd(), "src/lib/mailbox/sync-health.ts"), "utf8");
const HEALTH_ROUTE = readFileSync(
  join(process.cwd(), "src/app/api/admin/mailbox/health/route.ts"),
  "utf8",
);

describe("WI-SYNC-1b · scheduled reconciliation sweep tick", () => {
  it("feature-gated — short-circuits when MAILBOX_INTEGRATION_ENABLED is false", () => {
    expect(SCHEDULER).toMatch(/isMailboxIntegrationEnabled\(\)/);
    expect(SCHEDULER).toMatch(/reason:\s*"feature_disabled"/);
  });
  it("default interval 15 min, min-gap 10 min", () => {
    expect(SCHEDULER).toMatch(/15\s*\*\s*60_000/);
    expect(SCHEDULER).toMatch(/10\s*\*\s*60_000/);
  });
  it("time-bucketed idempotency key — one job per (mailbox, bucket) across all workers", () => {
    expect(SCHEDULER).toMatch(/const bucket = Math\.floor\(now\.getTime\(\) \/ intervalMs\)/);
    expect(SCHEDULER).toMatch(/idempotencyKey:\s*`mailbox:reconcile-sweep:\$\{mbx\.id\}:\$\{bucket\}`/);
  });
  it("only enumerates CONNECTED mailboxes with deltaLink + refreshToken", () => {
    expect(SCHEDULER).toMatch(/MAILBOX_STATUS\.CONNECTED/);
    expect(SCHEDULER).toMatch(/deltaLink:\s*\{\s*not:\s*null\s*\}/);
    expect(SCHEDULER).toMatch(/refreshTokenSecretRef:\s*\{\s*not:\s*null\s*\}/);
  });
  it("caps the scan at 200 mailboxes per tick", () => {
    expect(SCHEDULER).toMatch(/take:\s*200/);
  });
  it("respects per-mailbox local backoff via latest RECONCILIATION_SWEEP run", () => {
    expect(SCHEDULER).toMatch(/triggerKind:\s*"RECONCILIATION_SWEEP"/);
    expect(SCHEDULER).toMatch(/orderBy:\s*\{\s*queuedAt:\s*"desc"\s*\}/);
    expect(SCHEDULER).toMatch(/now\.getTime\(\)\s*-\s*latestSweep\.queuedAt\.getTime\(\)\s*<\s*minGapMs/);
  });
  it("never calls Graph directly — only enqueues jobs", () => {
    expect(SCHEDULER).not.toMatch(/getMicrosoftDelegatedProvider/);
    expect(SCHEDULER).not.toMatch(/graph\.microsoft\.com/i);
    expect(SCHEDULER).not.toMatch(/reconcileMailbox\(/);
  });
});

describe("WI-SYNC-1b · MAILBOX_RECONCILIATION_HEARTBEAT handler", () => {
  it("promoted from RESERVED_PHASE_C to IMPLEMENTED", () => {
    expect(HANDLERS).toMatch(/MAILBOX_RECONCILIATION_HEARTBEAT:\s*"IMPLEMENTED"/);
    expect(HANDLERS).not.toMatch(/MAILBOX_RECONCILIATION_HEARTBEAT:\s*"RESERVED_PHASE_C"/);
  });
  it("payload requires mailboxConnectionId", () => {
    expect(HANDLERS).toMatch(/mailboxConnectionId:\s*string;/);
    expect(HANDLERS).toMatch(/MAILBOX_RECONCILIATION_HEARTBEAT payload missing mailboxConnectionId/);
  });
  it("tenant-guards against unknown mailboxConnectionId", () => {
    expect(HANDLERS).toMatch(/mailboxConnectionId.*not found/);
  });
  it("skips non-CONNECTED mailboxes without throwing", () => {
    expect(HANDLERS).toMatch(/mailbox\.reconcile-sweep\.skipped_not_connected/);
    expect(HANDLERS).toMatch(/outcome:\s*"SKIPPED"/);
  });
  it("calls reconcileMailbox in APPLY mode with triggerKind=RECONCILIATION_SWEEP", () => {
    expect(HANDLERS).toMatch(/dryRun:\s*false/);
    expect(HANDLERS).toMatch(/triggerKind:\s*"RECONCILIATION_SWEEP"/);
  });
  it("MAILBOX_RENEW_SUBSCRIPTION is still deferred to WI-SYNC-1d", () => {
    expect(HANDLERS).toMatch(/NOT_IMPLEMENTED: MAILBOX_RENEW_SUBSCRIPTION/);
  });
});

describe("WI-SYNC-1b · worker loop wiring", () => {
  it("imports and invokes tickReconciliationSweep every poll iteration", () => {
    expect(WORKER).toMatch(
      /import \{ tickReconciliationSweep \} from ".*reconciliation-scheduler"/,
    );
    expect(WORKER).toMatch(/await tickReconciliationSweep\(\)/);
  });
  it("preserves the delta tick + queue processing calls", () => {
    expect(WORKER).toMatch(/tickAutoSync\(\)/);
    expect(WORKER).toMatch(/processPending\(/);
  });
});

describe("WI-SYNC-1b · bounded cursor advancement across sweep runs", () => {
  it("MailboxConnection schema carries reconciliationCursorReceivedAt (DateTime?)", () => {
    const SCHEMA = readFileSync(join(process.cwd(), "prisma/schema.prisma"), "utf8");
    expect(SCHEMA).toMatch(/reconciliationCursorReceivedAt\s+DateTime\?/);
  });
  it("sweep runs read the cursor and filter candidates by receivedAt < cursor", () => {
    expect(RECONCILIATION).toMatch(/triggerKind\s*===\s*"RECONCILIATION_SWEEP"/);
    expect(RECONCILIATION).toMatch(/reconciliationCursorReceivedAt/);
    expect(RECONCILIATION).toMatch(/receivedAt:\s*\{\s*lt:\s*cursorBefore/);
  });
  it("end-of-run advances cursor to OLDEST examined receivedAt when more rows exist", () => {
    // WI-SYNC-1c (2026-10-18) — the old `candidates[last].receivedAt`
    // literal was refactored into a `const oldestRow = candidates[last]`
    // binding so the sibling cursor-id write can share it.  Match
    // either the direct index or the bound-row shape.
    expect(RECONCILIATION).toMatch(/candidates\[candidates\.length - 1\][\s\S]{0,80}receivedAt/);
    expect(RECONCILIATION).toMatch(/reconciliationCursorReceivedAt:\s*cursorAfter/);
  });
  it("resets cursor to null when the run reaches the bottom of the mailbox", () => {
    expect(RECONCILIATION).toMatch(/reachedBottom\s*=\s*examinedCount\s*<\s*limit/);
    expect(RECONCILIATION).toMatch(/reachedBottom\s*\?\s*null\s*:/);
  });
  it("operator-initiated runs (triggerKind=RECONCILIATION) never touch the cursor", () => {
    // The cursor-advancing update sits inside `if (isSweep && !partial)`.
    expect(RECONCILIATION).toMatch(/if\s*\(isSweep\s*&&\s*!partial\)/);
  });
  it("PARTIAL runs (any INACCESSIBLE_RETRYABLE row) leave the cursor unchanged", () => {
    // The !partial guard is the explicit lock on this behaviour.
    const section = RECONCILIATION.slice(RECONCILIATION.indexOf("cursor advancement"));
    expect(section).toMatch(/!partial/);
  });
  it("report surfaces cursorBefore / cursorAfter / reachedBottomOfMailbox for operator visibility", () => {
    expect(RECONCILIATION).toMatch(/cursorBefore\?:/);
    expect(RECONCILIATION).toMatch(/cursorAfter\?:/);
    expect(RECONCILIATION).toMatch(/reachedBottomOfMailbox\?:/);
  });
});

describe("WI-SYNC-1b · reconciliation service persists observability runs", () => {
  it("creates a MailboxSyncRun BEFORE any Graph call", () => {
    const idxCreate = RECONCILIATION.indexOf("prisma.mailboxSyncRun.create");
    const idxGraph = RECONCILIATION.indexOf("provider.getWellKnownFolder");
    expect(idxCreate).toBeGreaterThan(0);
    expect(idxGraph).toBeGreaterThan(idxCreate);
  });
  it("final MailboxSyncRun captures COMPLETED or PARTIAL with totals", () => {
    expect(RECONCILIATION).toMatch(/status:\s*partial \? "PARTIAL" : "COMPLETED"/);
    expect(RECONCILIATION).toMatch(/messagesExamined:\s*totals\.messagesExamined/);
    expect(RECONCILIATION).toMatch(/messagesUpdated:\s*args\.dryRun \? 0 :/);
  });
  it("PARTIAL is set when any INACCESSIBLE_RETRYABLE row observed", () => {
    expect(RECONCILIATION).toMatch(/totals\.inaccessibleRetryable\s*>\s*0/);
  });
});

describe("WI-SYNC-1b · health service", () => {
  it("computes deltaLagSeconds + reconcileLagSeconds", () => {
    expect(HEALTH).toMatch(/deltaLagSeconds/);
    expect(HEALTH).toMatch(/reconcileLagSeconds/);
  });
  it("flags requiresIntervention with explicit reasons", () => {
    expect(HEALTH).toMatch(/requiresIntervention/);
    expect(HEALTH).toMatch(/interventionReasons/);
    for (const r of [
      "no_delta_cursor",
      "delta_lag_",
      "reconcile_lag_",
      "consecutive_delta_failures_",
    ]) {
      expect(HEALTH).toContain(r);
    }
  });
  it("counts consecutive delta failures since last successful sync", () => {
    expect(HEALTH).toMatch(/consecutiveFailures/);
    expect(HEALTH).toMatch(/triggerKind:\s*\{\s*in:\s*\["DELTA",\s*"SYNC_NOW"\]\s*\}/);
    expect(HEALTH).toMatch(/status:\s*\{\s*in:\s*\["TERMINAL",\s*"DELAYED"\]\s*\}/);
  });
  it("tenant-scoped — every query filters by clubId", () => {
    expect(HEALTH).toMatch(/where:\s*\{\s*clubId\s*\}/);
    expect(HEALTH).toMatch(/mailboxConnectionId:\s*m\.id/);
  });
  it("never touches APInvoice / JournalEntry / Approval / Payment", () => {
    expect(HEALTH).not.toMatch(/aPInvoice|apInvoice/i);
    expect(HEALTH).not.toMatch(/journalEntry/i);
    expect(HEALTH).not.toMatch(/approval\.update|approval\.delete/i);
    expect(HEALTH).not.toMatch(/payment\.update|payment\.delete/i);
  });
});

describe("WI-SYNC-1b · /api/admin/mailbox/health route", () => {
  it("401 unauthenticated / 400 no active club / 404 feature off", () => {
    expect(HEALTH_ROUTE).toMatch(/"unauthenticated"/);
    expect(HEALTH_ROUTE).toMatch(/"no_active_club"/);
    expect(HEALTH_ROUTE).toMatch(/"mailbox_integration_disabled"/);
  });
  it("tenant-scoped by active club id", () => {
    expect(HEALTH_ROUTE).toMatch(/getActiveClubId/);
    expect(HEALTH_ROUTE).toMatch(/getMailboxSyncHealthForClub\(clubId/);
  });
  it("GET-only — no POST / PATCH / DELETE exported", () => {
    expect(HEALTH_ROUTE).toMatch(/export async function GET\(/);
    expect(HEALTH_ROUTE).not.toMatch(/export async function POST\(/);
    expect(HEALTH_ROUTE).not.toMatch(/export async function PATCH\(/);
    expect(HEALTH_ROUTE).not.toMatch(/export async function DELETE\(/);
  });
});

describe("WI-SYNC-1b · financial-preservation regression (reconciliation never cascades into accounting)", () => {
  it("reconciliation.ts never writes to APInvoice / JournalEntry / Approval / Payment", () => {
    // Allowed read-only reference: `prisma.apIntakeSource.findMany` to
    // FLAG rows in the report.  Writes must not exist on accounting
    // models.
    for (const forbidden of [
      /prisma\.aPInvoice\.(update|delete|create|upsert)/,
      /prisma\.journalEntry\.(update|delete|create|upsert)/,
      /prisma\.approval\.(update|delete|create|upsert)/,
      /prisma\.payment\.(update|delete|create|upsert)/,
      /prisma\.apIntakeSource\.(update|delete|create|upsert)/,
    ]) {
      expect(RECONCILIATION).not.toMatch(forbidden);
    }
  });
  it("reconciliation imports only EmailMessage + WorkIntakeItem (via handleEmailEvidenceDeleted) write surface", () => {
    // handleEmailEvidenceDeleted is the only WI-mutating import.
    expect(RECONCILIATION).toMatch(/handleEmailEvidenceDeleted/);
    expect(RECONCILIATION).not.toMatch(/from.*ap-intelligence/);
    expect(RECONCILIATION).not.toMatch(/from.*ap-posting/);
    expect(RECONCILIATION).not.toMatch(/from.*accounting/);
    expect(RECONCILIATION).not.toMatch(/from.*journal/);
    expect(RECONCILIATION).not.toMatch(/from.*approval/);
    expect(RECONCILIATION).not.toMatch(/from.*payment/);
  });
  it("the admin apply route also never writes to accounting", () => {
    const ROUTE = readFileSync(
      join(process.cwd(), "src/app/api/admin/mailbox/reconcile/route.ts"),
      "utf8",
    );
    for (const forbidden of [
      /aPInvoice\./,
      /journalEntry\./,
      /approval\./,
      /payment\./,
      /apIntakeSource\./,
    ]) {
      expect(ROUTE).not.toMatch(forbidden);
    }
  });
});
