// WI-SYNC-1b (2026-10-18) — mailbox synchronization health
// service (NEW).  Companion to the pre-existing
// `src/lib/mailbox/health.ts` which models the credentials + sync
// UI tuple; THIS module reports the operator-side observability
// metrics introduced in WI-SYNC-1b.
//
// Computes the metrics the admin dashboard (and the operator)
// needs to answer:
//
//   * Is delta sync alive?           → lastSuccessfulDeltaAt
//   * Is reconciliation alive?        → lastSuccessfulReconciliationAt
//   * How fresh is the mailbox?       → deltaLagSeconds / reconcileLagSeconds
//   * Is anything broken?             → consecutiveDeltaFailures,
//                                        requiresIntervention,
//                                        lastErrorCode
//   * What did the last pass do?      → mostRecentReconciliation counts
//   * Which mailboxes need action?    → requiresIntervention list
//
// This service reads MailboxConnection + MailboxSyncRun; it never
// writes anything and never contacts Microsoft Graph.
//
// Tenant-scoped: every query is bounded by the caller's clubId.

import { prisma } from "@/lib/prisma";

export interface MailboxSyncHealth {
  mailboxConnectionId: string;
  mailboxConnectionIdTail: string;
  clubId: string;
  userId: string;
  status: string;
  deltaLink: boolean; // present / absent — never dump the URL itself
  lastSuccessfulDeltaAt: Date | null;
  lastSuccessfulReconciliationAt: Date | null;
  lastAttemptedSyncAt: Date | null;
  lastSyncError: string | null;
  deltaLagSeconds: number | null;
  reconcileLagSeconds: number | null;
  consecutiveDeltaFailures: number;
  mostRecentReconciliation: {
    runId: string;
    status: string;
    queuedAt: Date;
    completedAt: Date | null;
    messagesExamined: number;
    messagesUpdated: number;
    messagesSuppressed: number;
    failureCategory: string | null;
  } | null;
  requiresIntervention: boolean;
  interventionReasons: string[];
}

export interface MailboxSyncHealthReport {
  clubId: string;
  observedAt: Date;
  thresholds: {
    deltaLagRedSeconds: number;
    reconcileLagRedSeconds: number;
    consecutiveFailureRedCount: number;
  };
  mailboxes: MailboxSyncHealth[];
  totals: {
    mailboxesConnected: number;
    mailboxesRequiringIntervention: number;
    mailboxesWithoutDelta: number;
  };
}

/** Default thresholds — tunable via env but shipped with sane
 *  defaults for the 60s delta + 15-min reconcile cadence. */
const DELTA_LAG_RED_SECONDS = Number(
  process.env.MAILBOX_HEALTH_DELTA_LAG_RED_SECONDS ?? "600", // 10 min
);
const RECONCILE_LAG_RED_SECONDS = Number(
  process.env.MAILBOX_HEALTH_RECONCILE_LAG_RED_SECONDS ?? "3600", // 60 min
);
const CONSECUTIVE_FAILURE_RED_COUNT = Number(
  process.env.MAILBOX_HEALTH_CONSECUTIVE_FAILURE_RED_COUNT ?? "3",
);

/** Compute the health report for every mailbox owned by `clubId`. */
export async function getMailboxSyncHealthForClub(
  clubId: string,
  now: Date = new Date(),
): Promise<MailboxSyncHealthReport> {
  const mailboxes = await prisma.mailboxConnection.findMany({
    where: { clubId },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      clubId: true,
      userId: true,
      status: true,
      deltaLink: true,
      lastSuccessfulSyncAt: true,
      lastAttemptedSyncAt: true,
      lastSyncError: true,
    },
  });

  const per: MailboxSyncHealth[] = [];
  for (const m of mailboxes) {
    const latestReconcile = await prisma.mailboxSyncRun.findFirst({
      where: {
        mailboxConnectionId: m.id,
        triggerKind: { in: ["RECONCILIATION_SWEEP", "RECONCILIATION"] },
      },
      orderBy: { queuedAt: "desc" },
      select: {
        id: true,
        status: true,
        queuedAt: true,
        completedAt: true,
        messagesExamined: true,
        messagesUpdated: true,
        messagesSuppressed: true,
        failureCategory: true,
      },
    });
    const lastSuccessfulReconciliation = await prisma.mailboxSyncRun.findFirst({
      where: {
        mailboxConnectionId: m.id,
        triggerKind: { in: ["RECONCILIATION_SWEEP", "RECONCILIATION"] },
        status: { in: ["COMPLETED", "PARTIAL"] },
      },
      orderBy: { completedAt: "desc" },
      select: { completedAt: true },
    });
    const consecutiveFailures = await prisma.mailboxSyncRun.count({
      where: {
        mailboxConnectionId: m.id,
        triggerKind: { in: ["DELTA", "SYNC_NOW"] },
        status: { in: ["TERMINAL", "DELAYED"] },
        queuedAt: m.lastSuccessfulSyncAt
          ? { gt: m.lastSuccessfulSyncAt }
          : undefined,
      },
    });

    const deltaLagSeconds = m.lastSuccessfulSyncAt
      ? Math.max(0, Math.floor((now.getTime() - m.lastSuccessfulSyncAt.getTime()) / 1000))
      : null;
    const reconcileLagSeconds = lastSuccessfulReconciliation?.completedAt
      ? Math.max(
          0,
          Math.floor(
            (now.getTime() - lastSuccessfulReconciliation.completedAt.getTime()) / 1000,
          ),
        )
      : null;

    const reasons: string[] = [];
    if (m.status !== "CONNECTED") reasons.push(`status=${m.status}`);
    if (!m.deltaLink) reasons.push("no_delta_cursor");
    if (
      deltaLagSeconds !== null &&
      deltaLagSeconds > DELTA_LAG_RED_SECONDS
    ) {
      reasons.push(`delta_lag_${deltaLagSeconds}s`);
    }
    if (
      reconcileLagSeconds !== null &&
      reconcileLagSeconds > RECONCILE_LAG_RED_SECONDS
    ) {
      reasons.push(`reconcile_lag_${reconcileLagSeconds}s`);
    }
    if (consecutiveFailures >= CONSECUTIVE_FAILURE_RED_COUNT) {
      reasons.push(`consecutive_delta_failures_${consecutiveFailures}`);
    }
    if (m.lastSyncError) reasons.push(`last_error=${m.lastSyncError}`);

    per.push({
      mailboxConnectionId: m.id,
      mailboxConnectionIdTail: m.id.slice(-6),
      clubId: m.clubId,
      userId: m.userId,
      status: m.status,
      deltaLink: !!m.deltaLink,
      lastSuccessfulDeltaAt: m.lastSuccessfulSyncAt,
      lastSuccessfulReconciliationAt:
        lastSuccessfulReconciliation?.completedAt ?? null,
      lastAttemptedSyncAt: m.lastAttemptedSyncAt,
      lastSyncError: m.lastSyncError,
      deltaLagSeconds,
      reconcileLagSeconds,
      consecutiveDeltaFailures: consecutiveFailures,
      mostRecentReconciliation: latestReconcile
        ? {
            runId: latestReconcile.id,
            status: latestReconcile.status,
            queuedAt: latestReconcile.queuedAt,
            completedAt: latestReconcile.completedAt,
            messagesExamined: latestReconcile.messagesExamined,
            messagesUpdated: latestReconcile.messagesUpdated,
            messagesSuppressed: latestReconcile.messagesSuppressed,
            failureCategory: latestReconcile.failureCategory,
          }
        : null,
      requiresIntervention: reasons.length > 0,
      interventionReasons: reasons,
    });
  }

  return {
    clubId,
    observedAt: now,
    thresholds: {
      deltaLagRedSeconds: DELTA_LAG_RED_SECONDS,
      reconcileLagRedSeconds: RECONCILE_LAG_RED_SECONDS,
      consecutiveFailureRedCount: CONSECUTIVE_FAILURE_RED_COUNT,
    },
    mailboxes: per,
    totals: {
      mailboxesConnected: per.filter((p) => p.status === "CONNECTED").length,
      mailboxesRequiringIntervention: per.filter((p) => p.requiresIntervention)
        .length,
      mailboxesWithoutDelta: per.filter((p) => !p.deltaLink).length,
    },
  };
}
