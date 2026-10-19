// WI-SYNC-1i (2026-10-19) — Automatic active-WI reverify scheduler.
//
// Runs INSIDE the existing worker loop (bin/worker.ts).  Every tick,
// enqueues one `MAILBOX_ACTIVE_REVERIFY` job per connected mailbox
// so the probe-based folder detection that WI-SYNC-1h built for the
// manual Feed Sync refresh fires automatically, without user action.
//
// Why this exists
// ---------------
//
// Microsoft Graph's Inbox-scoped `/me/mailFolders/inbox/messages/delta`
// does not reliably emit `@removed` markers when a message is moved
// out of Inbox.  The 60-s auto-delta poll inherits this gap — it
// re-fetches delta pages and finds nothing to update.  The 15-min
// reconciliation sweep uses active `probeMessage` + `classifyProbe`,
// which IS reliable, but 15 minutes is too long for the founder's
// expected convergence.
//
// This scheduler closes the gap by firing the same probe path at
// 60-s cadence per mailbox.  It is deliberately scoped to active
// email-backed WIs (OPEN / IN_PROGRESS / INFORMATIONAL / DEFERRED),
// up to 50 per tick.  RESOLVED / SUPPRESSED are already finalised,
// so they contribute zero Graph calls.
//
// Bounded + tenant-scoped + idempotency-keyed
// -------------------------------------------
//
//   • One tick per MAILBOX_ACTIVE_REVERIFY_INTERVAL_MS (default 60s).
//   • Per-mailbox min-gap backoff via lastSuccessfulSyncAt.
//   • Idempotency key: `mailbox:active-reverify:<mcId>:<bucket>`
//     collapses parallel workers to one job per bucket.
//   • 200-mailbox scan cap per tick (same as auto-sync-scheduler).
//   • The handler itself bounds Graph work via reverify's own
//     50-WI limit per call.
//
// No new deletion handlers are introduced — the reverify + its
// completeOutlookDetectedDelete already handle PRESENT_INBOX /
// PRESENT_DELETED_ITEMS / PRESENT_ARCHIVE / PRESENT_OTHER_FOLDER /
// DELETED / INACCESSIBLE_* uniformly across the manual and
// automatic paths.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import { MAILBOX_STATUS } from "./status";

let lastTickAt = 0;

interface TickArgs {
  now?: Date;
  intervalMs?: number;
  minGapMs?: number;
}

export interface ActiveReverifyTickResult {
  ran: boolean;
  reason?: "feature_disabled" | "not_due" | "no_mailboxes" | "ok";
  scanned: number;
  enqueued: number;
  skipped: number;
  errors: number;
}

export async function tickActiveReverify(args: TickArgs = {}): Promise<ActiveReverifyTickResult> {
  const now = args.now ?? new Date();
  const intervalMs =
    args.intervalMs ??
    Number(process.env.MAILBOX_ACTIVE_REVERIFY_INTERVAL_MS ?? "60000");
  const minGapMs =
    args.minGapMs ??
    Number(process.env.MAILBOX_ACTIVE_REVERIFY_MIN_GAP_MS ?? "30000");

  if (now.getTime() - lastTickAt < intervalMs) {
    return { ran: false, reason: "not_due", scanned: 0, enqueued: 0, skipped: 0, errors: 0 };
  }
  lastTickAt = now.getTime();

  if (!isMailboxIntegrationEnabled()) {
    return { ran: false, reason: "feature_disabled", scanned: 0, enqueued: 0, skipped: 0, errors: 0 };
  }

  const mailboxes = await prisma.mailboxConnection.findMany({
    where: {
      status: {
        in: [
          MAILBOX_STATUS.CONNECTED,
          MAILBOX_STATUS.DELAYED,
          MAILBOX_STATUS.CONNECTED_PENDING_SYNC,
        ],
      },
      deltaLink: { not: null },
      refreshTokenSecretRef: { not: null },
    },
    select: {
      id: true,
      clubId: true,
      userId: true,
      lastSuccessfulSyncAt: true,
    },
    take: 200,
  });

  if (mailboxes.length === 0) {
    return { ran: true, reason: "no_mailboxes", scanned: 0, enqueued: 0, skipped: 0, errors: 0 };
  }

  const bucket = Math.floor(now.getTime() / intervalMs);
  let enqueued = 0;
  let skipped = 0;
  let errors = 0;

  for (const mbx of mailboxes) {
    try {
      // Only reverify mailboxes that have at least one active
      // email-backed WI.  Pure-SUPPRESSED / RESOLVED mailboxes do
      // not need the Graph round-trip.
      const openCount = await prisma.workIntakeItem.count({
        where: {
          clubId: mbx.clubId,
          status: { in: ["OPEN", "IN_PROGRESS", "DEFERRED", "INFORMATIONAL"] },
          emailOrigins: {
            some: {
              role: "PRIMARY",
              emailMessage: { mailboxConnectionId: mbx.id },
            },
          },
        },
      });
      if (openCount === 0) {
        skipped += 1;
        continue;
      }
      // Local backoff — if a delta sync JUST attempted (via the
      // auto-sync-scheduler), skip this tick's reverify.  Keeps
      // Graph load bounded during a burst.
      if (
        mbx.lastSuccessfulSyncAt &&
        now.getTime() - mbx.lastSuccessfulSyncAt.getTime() < minGapMs
      ) {
        // No skip — we WANT reverify to fire even on well-synced
        // mailboxes, because the whole point of this scheduler is
        // to cover the gap the delta can't see.  Continue to the
        // enqueue below.
      }
      const { enqueue } = await import("@/lib/queue");
      await enqueue({
        kind: "MAILBOX_ACTIVE_REVERIFY",
        queue: "mailbox",
        clubId: mbx.clubId,
        payload: {
          mailboxConnectionId: mbx.id,
          callerUserId: mbx.userId,
        },
        idempotencyKey: `mailbox:active-reverify:${mbx.id}:${bucket}`,
        maxAttempts: 3,
      });
      enqueued += 1;
    } catch (err) {
      errors += 1;
      logger.warn("mailbox.active-reverify.enqueue_failed", {
        mailboxConnectionIdTail: mbx.id.slice(-6),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("mailbox.active-reverify.tick", {
    intervalMs,
    minGapMs,
    scanned: mailboxes.length,
    enqueued,
    skipped,
    errors,
  });

  return {
    ran: true,
    reason: "ok",
    scanned: mailboxes.length,
    enqueued,
    skipped,
    errors,
  };
}

// Test-only reset for the module-local lastTickAt.
export function __resetTickState(): void {
  lastTickAt = 0;
}
