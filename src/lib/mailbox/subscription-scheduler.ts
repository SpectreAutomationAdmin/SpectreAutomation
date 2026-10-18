// WI-SYNC-1d (2026-10-18) — subscription maintenance tick.
//
// Runs inside bin/worker.ts loop alongside tickAutoSync +
// tickReconciliationSweep.  Interval- and gap-budgeted so adding
// this tick costs effectively zero CPU; the real work (create /
// renew / recreate) is in the enqueued MAILBOX_RENEW_SUBSCRIPTION
// jobs.
//
// Scope per tick:
//   * CONNECTED mailboxes with no active subscription → enqueue
//     a create.
//   * ACTIVE subscriptions expiring within RENEWAL_WINDOW_MIN →
//     enqueue a renew.
//   * EXPIRED / FAILED / REVOKED subscriptions → enqueue a
//     recreate.
//
// Feature-gated via MAILBOX_INTEGRATION_ENABLED (same as the delta
// scheduler).  Idempotency key is time-bucketed per (mailbox,
// bucket) so parallel workers collapse to one job per bucket.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";
import { isMailboxIntegrationEnabled } from "@/lib/env";
import { MAILBOX_STATUS } from "./status";

let lastTickAt = 0;

export interface SubscriptionTickResult {
  ran: boolean;
  reason?: "feature_disabled" | "not_due" | "no_mailboxes" | "ok";
  scanned: number;
  enqueuedCreate: number;
  enqueuedRenew: number;
  enqueuedRecreate: number;
  errors: number;
}

interface TickArgs {
  now?: Date;
  intervalMs?: number;
}

export async function tickSubscriptionMaintenance(
  args: TickArgs = {},
): Promise<SubscriptionTickResult> {
  const now = args.now ?? new Date();
  const intervalMs =
    args.intervalMs ??
    Number(process.env.MAILBOX_SUBSCRIPTION_INTERVAL_MS ?? String(5 * 60_000));

  if (now.getTime() - lastTickAt < intervalMs) {
    return {
      ran: false,
      reason: "not_due",
      scanned: 0,
      enqueuedCreate: 0,
      enqueuedRenew: 0,
      enqueuedRecreate: 0,
      errors: 0,
    };
  }
  lastTickAt = now.getTime();

  if (!isMailboxIntegrationEnabled()) {
    return {
      ran: false,
      reason: "feature_disabled",
      scanned: 0,
      enqueuedCreate: 0,
      enqueuedRenew: 0,
      enqueuedRecreate: 0,
      errors: 0,
    };
  }

  const mailboxes = await prisma.mailboxConnection.findMany({
    where: {
      status: { in: [MAILBOX_STATUS.CONNECTED] },
      refreshTokenSecretRef: { not: null },
    },
    select: {
      id: true,
      clubId: true,
      userId: true,
      subscriptions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: {
          id: true,
          lifecycleState: true,
          expirationDateTime: true,
          renewalFailureCount: true,
        },
      },
    },
    take: 200,
  });

  if (mailboxes.length === 0) {
    return {
      ran: true,
      reason: "no_mailboxes",
      scanned: 0,
      enqueuedCreate: 0,
      enqueuedRenew: 0,
      enqueuedRecreate: 0,
      errors: 0,
    };
  }

  const bucket = Math.floor(now.getTime() / intervalMs);
  const renewalWindowMs =
    Number(process.env.MAILBOX_SUBSCRIPTION_RENEWAL_WINDOW_MIN ?? "1440") * 60_000;
  let enqueuedCreate = 0;
  let enqueuedRenew = 0;
  let enqueuedRecreate = 0;
  let errors = 0;

  for (const mbx of mailboxes) {
    const sub = mbx.subscriptions[0];
    let action: "CREATE" | "RENEW" | "RECREATE" | null = null;
    if (!sub) action = "CREATE";
    else if (
      sub.lifecycleState === "FAILED" ||
      sub.lifecycleState === "EXPIRED" ||
      sub.lifecycleState === "REVOKED"
    ) {
      action = "RECREATE";
    } else if (
      sub.lifecycleState === "ACTIVE" &&
      sub.expirationDateTime.getTime() - now.getTime() < renewalWindowMs
    ) {
      action = "RENEW";
    }
    if (!action) continue;

    try {
      const { enqueue } = await import("@/lib/queue");
      await enqueue({
        kind: "MAILBOX_RENEW_SUBSCRIPTION",
        queue: "mailbox",
        clubId: mbx.clubId,
        payload: {
          mailboxConnectionId: mbx.id,
          callerUserId: mbx.userId,
          hint: action,
        },
        idempotencyKey: `mailbox:subscription:${mbx.id}:${bucket}:${action}`,
        maxAttempts: 3,
      });
      if (action === "CREATE") enqueuedCreate += 1;
      else if (action === "RENEW") enqueuedRenew += 1;
      else enqueuedRecreate += 1;
    } catch (err) {
      errors += 1;
      logger.warn("mailbox.subscription-scheduler.enqueue_failed", {
        mailboxConnectionIdTail: mbx.id.slice(-6),
        action,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("mailbox.subscription-scheduler.tick", {
    intervalMs,
    scanned: mailboxes.length,
    enqueuedCreate,
    enqueuedRenew,
    enqueuedRecreate,
    errors,
    bucket,
  });

  return {
    ran: true,
    reason: "ok",
    scanned: mailboxes.length,
    enqueuedCreate,
    enqueuedRenew,
    enqueuedRecreate,
    errors,
  };
}

export function _resetSubscriptionTicker_TEST_ONLY(): void {
  lastTickAt = 0;
}
