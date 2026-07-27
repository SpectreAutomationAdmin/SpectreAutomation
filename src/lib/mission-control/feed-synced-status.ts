// Sprint 3 · Checkpoint 15M (2026-07-27) — mailbox connection health
// loader that backs the Mission Control "Feed synced" header pill.
//
// Reads live signals from MailboxConnection: status, last successful
// sync timestamp, last attempted sync timestamp, last sync error, and
// access-token expiry. Returns a compact, presentation-friendly shape
// the pill component consumes directly.
//
// Never returns SYNCED just because a MailboxConnection row exists —
// the state must reflect actual health.

import { prisma } from "@/lib/prisma";
import type { FeedSyncedStatus } from "@/components/mission-control/FeedSyncedStatusPill";

const RECONNECT_HREF = "/app/user/settings/connected-accounts";
const DELAYED_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export async function loadFeedSyncedStatus(clubId: string, userId: string): Promise<FeedSyncedStatus> {
  const conn = await prisma.mailboxConnection.findFirst({
    where: { clubId, userId, status: { not: "DELETED" } },
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      lastSuccessfulSyncAt: true,
      lastAttemptedSyncAt: true,
      lastSyncError: true,
      accessTokenExpiresAt: true,
      connectedEmail: true,
    },
  });

  if (!conn) {
    return {
      state: "NONE",
      label: "Not connected",
      detail: "No mailbox integration is connected for your account.",
      href: RECONNECT_HREF,
    };
  }

  const now = Date.now();
  const tokenExpired = conn.accessTokenExpiresAt.getTime() < now;
  const disconnected = conn.status !== "CONNECTED";

  if (disconnected || tokenExpired) {
    return {
      state: "RECONNECT",
      label: "Reconnect required",
      detail: disconnected
        ? `Mailbox status is ${conn.status.toLowerCase().replace(/_/g, " ")} — reconnect ${conn.connectedEmail}.`
        : `Access token expired for ${conn.connectedEmail}.`,
      href: RECONNECT_HREF,
    };
  }

  const lastSync = conn.lastSuccessfulSyncAt?.getTime() ?? 0;
  const staleSync = lastSync > 0 && now - lastSync > DELAYED_THRESHOLD_MS;
  const attemptedAfterSuccess =
    conn.lastAttemptedSyncAt &&
    conn.lastAttemptedSyncAt.getTime() > lastSync &&
    conn.lastSyncError != null;

  if (staleSync || attemptedAfterSuccess) {
    return {
      state: "DELAYED",
      label: "Feed delayed",
      detail: conn.lastSyncError
        ? `Last sync attempt failed: ${conn.lastSyncError.slice(0, 120)}`
        : lastSync > 0
        ? `Last successful sync ${new Date(lastSync).toISOString().slice(0, 16).replace("T", " ")}`
        : "No successful sync yet.",
      href: RECONNECT_HREF,
    };
  }

  return {
    state: "SYNCED",
    label: "Feed synced",
    detail: lastSync > 0
      ? `Mailbox ${conn.connectedEmail} · last synced ${new Date(lastSync).toISOString().slice(0, 16).replace("T", " ")}`
      : `Mailbox ${conn.connectedEmail} connected.`,
    href: RECONNECT_HREF,
  };
}
