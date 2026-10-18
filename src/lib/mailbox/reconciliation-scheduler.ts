// WI-SYNC-1b (2026-10-18) — Scheduled reconciliation sweep tick.
//
// Mirrors the delta-sync scheduler (`auto-sync-scheduler.ts`) but
// at a slower cadence — the delta polling path handles the common
// case of a new email arriving (every 60 s), while reconciliation
// is a safety net that re-probes each known EmailMessage against
// Microsoft Graph to detect:
//
//   • messages the delta loop missed because Graph silently
//     dropped an `@removed` event on a PARTIAL continuation page;
//   • messages a founder deleted while Spectre was offline;
//   • folder moves the delta loop can't see (because delta is
//     Inbox-scoped and a user moved a message between non-inbox
//     folders).
//
// Reused infrastructure:
//   • Enqueues `MAILBOX_RECONCILIATION_HEARTBEAT` (previously
//     RESERVED_PHASE_C — now wired to the real reconciliation
//     service — see src/lib/queue/handlers.ts).
//   • Time-bucketed idempotency key — multiple worker instances
//     collapse to one job per (mailbox, bucket).
//   • Local min-gap per mailbox so a slow apply pass doesn't get
//     re-triggered before it finishes.
//
// Bounded by design:
//   • Default interval: 15 min (MAILBOX_RECONCILIATION_INTERVAL_MS).
//   • Default min-gap:  10 min (MAILBOX_RECONCILIATION_MIN_GAP_MS).
//   • Scan cap: 200 mailboxes per tick (same as delta scheduler).
//   • Feature-gated: short-circuits when MAILBOX_INTEGRATION_ENABLED
//     is false — matches the delta scheduler.

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

export interface ReconciliationTickResult {
  ran: boolean;
  reason?: "feature_disabled" | "not_due" | "no_mailboxes" | "ok";
  scanned: number;
  enqueued: number;
  skipped: number;
  errors: number;
}

export async function tickReconciliationSweep(
  args: TickArgs = {},
): Promise<ReconciliationTickResult> {
  const now = args.now ?? new Date();
  const intervalMs =
    args.intervalMs ??
    Number(process.env.MAILBOX_RECONCILIATION_INTERVAL_MS ?? String(15 * 60_000));
  const minGapMs =
    args.minGapMs ??
    Number(process.env.MAILBOX_RECONCILIATION_MIN_GAP_MS ?? String(10 * 60_000));

  if (now.getTime() - lastTickAt < intervalMs) {
    return {
      ran: false,
      reason: "not_due",
      scanned: 0,
      enqueued: 0,
      skipped: 0,
      errors: 0,
    };
  }
  lastTickAt = now.getTime();

  if (!isMailboxIntegrationEnabled()) {
    return {
      ran: false,
      reason: "feature_disabled",
      scanned: 0,
      enqueued: 0,
      skipped: 0,
      errors: 0,
    };
  }

  // Only CONNECTED mailboxes that have at least one delta cursor
  // + a refresh token.  Fresh connections are picked up by the
  // delta scheduler first.
  const mailboxes = await prisma.mailboxConnection.findMany({
    where: {
      status: { in: [MAILBOX_STATUS.CONNECTED] },
      deltaLink: { not: null },
      refreshTokenSecretRef: { not: null },
    },
    select: {
      id: true,
      clubId: true,
      userId: true,
      status: true,
      // We stash the last reconciliation-sweep enqueue time on
      // MailboxSyncRun; the local check below uses the latest
      // sweep run's queuedAt to enforce the min-gap.
    },
    take: 200,
  });

  if (mailboxes.length === 0) {
    return {
      ran: true,
      reason: "no_mailboxes",
      scanned: 0,
      enqueued: 0,
      skipped: 0,
      errors: 0,
    };
  }

  const bucket = Math.floor(now.getTime() / intervalMs);
  let enqueued = 0;
  let skipped = 0;
  let errors = 0;

  for (const mbx of mailboxes) {
    try {
      // Local backoff: look up the most-recent reconciliation
      // sweep run for this mailbox and skip if it was queued less
      // than minGapMs ago.
      const latestSweep = await prisma.mailboxSyncRun.findFirst({
        where: {
          mailboxConnectionId: mbx.id,
          triggerKind: "RECONCILIATION_SWEEP",
        },
        orderBy: { queuedAt: "desc" },
        select: { queuedAt: true },
      });
      if (
        latestSweep?.queuedAt &&
        now.getTime() - latestSweep.queuedAt.getTime() < minGapMs
      ) {
        skipped += 1;
        continue;
      }
      const { enqueue } = await import("@/lib/queue");
      await enqueue({
        kind: "MAILBOX_RECONCILIATION_HEARTBEAT",
        queue: "mailbox",
        clubId: mbx.clubId,
        payload: {
          mailboxConnectionId: mbx.id,
          callerUserId: mbx.userId,
        },
        idempotencyKey: `mailbox:reconcile-sweep:${mbx.id}:${bucket}`,
        maxAttempts: 3,
      });
      enqueued += 1;
    } catch (err) {
      errors += 1;
      logger.warn("mailbox.reconcile-sweep.enqueue_failed", {
        mailboxConnectionIdTail: mbx.id.slice(-6),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("mailbox.reconcile-sweep.tick", {
    intervalMs,
    minGapMs,
    scanned: mailboxes.length,
    enqueued,
    skipped,
    errors,
    bucket,
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

/** Test-only reset. */
export function _resetReconciliationTicker_TEST_ONLY(): void {
  lastTickAt = 0;
}
