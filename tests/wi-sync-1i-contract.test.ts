// WI-SYNC-1i (2026-10-19) — contract locks for automatic
// convergence.  Pins:
//
//   §1 A new JobKind MAILBOX_ACTIVE_REVERIFY exists + is marked
//      IMPLEMENTED.
//   §2 A new scheduler active-reverify-scheduler.ts ticks at a
//      bounded, feature-gated, idempotency-keyed cadence.
//   §3 The scheduler is wired into bin/worker.ts.
//   §4 The MAILBOX_ACTIVE_REVERIFY handler delegates to
//      reverifyWorkIntakeEmails with the per-mailbox scope.
//   §5 reverifyWorkIntakeEmails accepts an optional
//      mailboxConnectionId filter.
//   §6 No new deletion handler is introduced — the automatic path
//      reuses WI-SYNC-1h's completeOutlookDetectedDelete.
//   §7 Financial preservation + tenant isolation (scheduler scans
//      by status + mailbox, never cross-tenant).

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SCHED = readFileSync(
  join(process.cwd(), "src/lib/mailbox/active-reverify-scheduler.ts"),
  "utf8",
);
const HANDLERS = readFileSync(
  join(process.cwd(), "src/lib/queue/handlers.ts"),
  "utf8",
);
const QUEUE_INDEX = readFileSync(
  join(process.cwd(), "src/lib/queue/index.ts"),
  "utf8",
);
const WORKER = readFileSync(
  join(process.cwd(), "bin/worker.ts"),
  "utf8",
);
const REVERIFY = readFileSync(
  join(process.cwd(), "src/lib/mailbox/reverify-active.ts"),
  "utf8",
);

describe("WI-SYNC-1i §1 · JobKind + handler status registry", () => {
  it("JobKind union includes MAILBOX_ACTIVE_REVERIFY", () => {
    expect(QUEUE_INDEX).toMatch(/"MAILBOX_ACTIVE_REVERIFY"/);
  });
  it("MAILBOX_JOB_IMPLEMENTATION marks it IMPLEMENTED", () => {
    expect(HANDLERS).toMatch(/MAILBOX_ACTIVE_REVERIFY:\s*"IMPLEMENTED"/);
  });
});

describe("WI-SYNC-1i §2 · scheduler cadence + guards", () => {
  it("ticks at MAILBOX_ACTIVE_REVERIFY_INTERVAL_MS (default 60 s)", () => {
    expect(SCHED).toMatch(/MAILBOX_ACTIVE_REVERIFY_INTERVAL_MS[\s\S]*?"60000"/);
  });
  it("feature-gated via isMailboxIntegrationEnabled", () => {
    expect(SCHED).toMatch(/if \(!isMailboxIntegrationEnabled\(\)\)/);
  });
  it("interval-budget guard prevents multiple ticks per bucket", () => {
    expect(SCHED).toMatch(/if \(now\.getTime\(\) - lastTickAt < intervalMs\)/);
  });
  it("idempotency key is time-bucketed per mailbox", () => {
    expect(SCHED).toMatch(
      /idempotencyKey:\s*`mailbox:active-reverify:\$\{mbx\.id\}:\$\{bucket\}`/,
    );
  });
  it("scanned mailboxes are capped (200 per tick)", () => {
    expect(SCHED).toMatch(/take:\s*200/);
  });
  it("only CONNECTED/DELAYED/PENDING_SYNC mailboxes with a deltaLink are scanned", () => {
    expect(SCHED).toMatch(/MAILBOX_STATUS\.CONNECTED/);
    expect(SCHED).toMatch(/MAILBOX_STATUS\.DELAYED/);
    expect(SCHED).toMatch(/MAILBOX_STATUS\.CONNECTED_PENDING_SYNC/);
    expect(SCHED).toMatch(/deltaLink:\s*\{\s*not:\s*null\s*\}/);
  });
  it("skips mailboxes with zero active email-backed WIs (bounded Graph load)", () => {
    expect(SCHED).toMatch(/workIntakeItem\.count\(/);
    expect(SCHED).toMatch(/if \(openCount === 0\)/);
  });
});

describe("WI-SYNC-1i §3 · wired into worker loop", () => {
  it("bin/worker.ts imports tickActiveReverify", () => {
    expect(WORKER).toMatch(
      /import \{ tickActiveReverify \} from "\.\.\/src\/lib\/mailbox\/active-reverify-scheduler"/,
    );
  });
  it("bin/worker.ts calls tickActiveReverify in the main loop", () => {
    expect(WORKER).toMatch(/await tickActiveReverify\(\)/);
  });
});

describe("WI-SYNC-1i §4 · handler delegates to reverifyWorkIntakeEmails per mailbox", () => {
  it("handler registered with payload { mailboxConnectionId, callerUserId }", () => {
    expect(HANDLERS).toMatch(
      /registerHandler<\{\s*mailboxConnectionId:\s*string;\s*callerUserId:\s*string \| null;\s*\}>\(\s*"MAILBOX_ACTIVE_REVERIFY"/,
    );
  });
  it("handler scopes reverifyWorkIntakeEmails to the mailbox via mailboxConnectionId", () => {
    expect(HANDLERS).toMatch(
      /reverifyWorkIntakeEmails\(\{[\s\S]*?mailboxConnectionId:\s*mbx\.id/,
    );
  });
  it("handler short-circuits for non-CONNECTED mailboxes (never risks mass suppression on terminal states)", () => {
    expect(HANDLERS).toMatch(
      /MAILBOX_ACTIVE_REVERIFY[\s\S]*?mbx\.status !== "CONNECTED"[\s\S]*?SKIPPED/,
    );
  });
});

describe("WI-SYNC-1i §5 · reverify accepts per-mailbox filter", () => {
  it("reverifyWorkIntakeEmails signature now includes mailboxConnectionId?: string", () => {
    expect(REVERIFY).toMatch(
      /mailboxConnectionId\?: string;/,
    );
  });
  it("filter is applied through emailMessage.mailboxConnectionId when set", () => {
    expect(REVERIFY).toMatch(
      /args\.mailboxConnectionId[\s\S]*?emailMessage:\s*\{\s*mailboxConnectionId:\s*args\.mailboxConnectionId\s*\}/,
    );
  });
});

describe("WI-SYNC-1i §6 · no duplicate deletion handler", () => {
  it("scheduler enqueues one JobKind and does not call completeOutlookDetectedDelete or applyTombstone", () => {
    // Function invocations (with the opening paren) — comments
    // may reference the names without calling them.
    expect(SCHED).not.toMatch(/completeOutlookDetectedDelete\(/);
    expect(SCHED).not.toMatch(/applyTombstone\(/);
  });
  it("handler does not introduce a new tombstone path; it calls reverify", () => {
    // The handler block for MAILBOX_ACTIVE_REVERIFY must not
    // import or call any tombstone function directly.
    const idx = HANDLERS.indexOf('"MAILBOX_ACTIVE_REVERIFY"');
    expect(idx).toBeGreaterThan(0);
    // Grab a safe window — the handler body is well under 2 KB.
    const slice = HANDLERS.slice(idx, idx + 2000);
    expect(slice).toMatch(/reverifyWorkIntakeEmails/);
    expect(slice).not.toMatch(/completeOutlookDetectedDelete\(/);
    expect(slice).not.toMatch(/applyTombstone\(/);
  });
});

describe("WI-SYNC-1i §7 · financial preservation + tenant isolation", () => {
  it("scheduler never touches AP / journal / approval / payment tables", () => {
    expect(SCHED).not.toMatch(/prisma\.aPInvoice\./);
    expect(SCHED).not.toMatch(/prisma\.journalEntry\./);
    expect(SCHED).not.toMatch(/prisma\.approvalRequest\./);
    expect(SCHED).not.toMatch(/prisma\.vendorPayment\./);
  });
  it("scheduler filters WI count by clubId (tenant-scoped)", () => {
    expect(SCHED).toMatch(/clubId:\s*mbx\.clubId/);
  });
  it("scheduler enqueues with explicit clubId (job routing stays tenant-scoped)", () => {
    expect(SCHED).toMatch(/clubId:\s*mbx\.clubId,/);
  });
});
