// Sprint 3 Checkpoint 15H-1 (2026-07-25) — Periodic delta-sync
// scheduler for the mailbox pipeline.
//
// Runs INSIDE the existing background worker loop (bin/worker.ts).
// No new process, no cron. Every tick, it:
//   1. Checks the interval budget: only runs at most once per
//      MAILBOX_AUTO_SYNC_INTERVAL_MS (default 60_000).
//   2. Refuses to run if MAILBOX_INTEGRATION_ENABLED is false.
//   3. Enumerates CONNECTED (and DELAYED, PENDING_SYNC) mailboxes.
//   4. Skips any mailbox whose lastAttemptedSyncAt is more recent than
//      the backoff window (MAILBOX_AUTO_SYNC_MIN_GAP_MS, default 30_000).
//   5. Enqueues MAILBOX_DELTA_SYNC with a time-bucketed idempotency key
//      so simultaneous worker instances only produce ONE job per bucket.
//
// Everything is deterministic, bounded, gated. No new Graph calls
// happen inside the scheduler — only queue writes.

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

export interface TickResult {
  ran: boolean;
  reason?: "feature_disabled" | "not_due" | "no_mailboxes" | "ok";
  scanned: number;
  enqueued: number;
  skipped: number;
  errors: number;
}

export async function tickAutoSync(args: TickArgs = {}): Promise<TickResult> {
  const now = args.now ?? new Date();
  const intervalMs = args.intervalMs ?? Number(process.env.MAILBOX_AUTO_SYNC_INTERVAL_MS ?? "60000");
  const minGapMs = args.minGapMs ?? Number(process.env.MAILBOX_AUTO_SYNC_MIN_GAP_MS ?? "30000");

  // Interval budget — one tick per intervalMs. Multiple worker instances
  // will each hit this branch, so the DB idempotency key below is the
  // real de-duplicator.
  if (now.getTime() - lastTickAt < intervalMs) {
    return { ran: false, reason: "not_due", scanned: 0, enqueued: 0, skipped: 0, errors: 0 };
  }
  lastTickAt = now.getTime();

  if (!isMailboxIntegrationEnabled()) {
    return { ran: false, reason: "feature_disabled", scanned: 0, enqueued: 0, skipped: 0, errors: 0 };
  }

  const mailboxes = await prisma.mailboxConnection.findMany({
    where: {
      // Sprint 3 · Checkpoint 15R (2026-07-29) — status list now uses
      // the canonical MAILBOX_STATUS constants. The pre-fix filter had
      // the string "PENDING_SYNC" which does NOT match the actual
      // enum value "CONNECTED_PENDING_SYNC" (see src/lib/mailbox/
      // status.ts:38). Real production symptom: on staging, the
      // Coulee Ridge mailbox was stuck in CONNECTED_PENDING_SYNC
      // with deltaLink populated + refresh token present + all
      // scopes granted — but the scheduler never enqueued a delta
      // job because the string didn't match. The mailbox went
      // 19+ hours without a sync attempt.
      status: {
        in: [
          MAILBOX_STATUS.CONNECTED,
          MAILBOX_STATUS.DELAYED,
          MAILBOX_STATUS.CONNECTED_PENDING_SYNC,
        ],
      },
      // Only mailboxes that have completed at least one initial sync
      // (i.e. have a deltaLink) are eligible for delta polling. Fresh
      // connections that only just OAuth'd will be picked up as soon as
      // their MAILBOX_INITIAL_SYNC job populates the deltaLink.
      deltaLink: { not: null },
      refreshTokenSecretRef: { not: null },
    },
    select: {
      id: true, clubId: true, status: true, lastAttemptedSyncAt: true, lastSuccessfulSyncAt: true,
    },
    take: 200,
  });

  if (mailboxes.length === 0) {
    return { ran: true, reason: "no_mailboxes", scanned: 0, enqueued: 0, skipped: 0, errors: 0 };
  }

  // Time-bucket the idempotency key so parallel workers agree on the
  // key for the same minute. Bucket size == intervalMs, so the same
  // mailbox is only enqueued once per interval globally.
  const bucket = Math.floor(now.getTime() / intervalMs);
  let enqueued = 0;
  let skipped = 0;
  let errors = 0;

  for (const mbx of mailboxes) {
    try {
      // Local backoff: if we tried a sync less than minGapMs ago, wait.
      if (mbx.lastAttemptedSyncAt && now.getTime() - mbx.lastAttemptedSyncAt.getTime() < minGapMs) {
        skipped += 1;
        continue;
      }
      const { enqueue } = await import("@/lib/queue");
      await enqueue({
        kind: "MAILBOX_DELTA_SYNC",
        queue: "mailbox",
        clubId: mbx.clubId,
        payload: { mailboxConnectionId: mbx.id },
        idempotencyKey: `mailbox:auto-delta:${mbx.id}:${bucket}`,
        maxAttempts: 3,
      });
      enqueued += 1;
    } catch (err) {
      errors += 1;
      logger.warn("mailbox.auto-sync.enqueue_failed", {
        mailboxConnectionIdTail: mbx.id.slice(-6),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("mailbox.auto-sync.tick", {
    intervalMs,
    minGapMs,
    scanned: mailboxes.length,
    enqueued,
    skipped,
    errors,
    bucket,
  });

  return { ran: true, reason: "ok", scanned: mailboxes.length, enqueued, skipped, errors };
}

// Test-only reset for the internal tick timer.
export function _resetAutoSyncTicker_TEST_ONLY(): void {
  lastTickAt = 0;
}
