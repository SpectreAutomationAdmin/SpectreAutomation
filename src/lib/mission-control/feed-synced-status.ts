// Sprint 3 · Checkpoint 15M (2026-07-27), revised 15R (2026-07-29) —
// mailbox connection health loader that backs the Mission Control
// "Feed synced" header pill.
//
// Sprint 3 · Checkpoint 15R (2026-07-29) — REWIRED to derive from
// the canonical `deriveMailboxHealth` mapper. The pre-15R
// implementation checked `conn.status !== "CONNECTED"` and
// `accessTokenExpiresAt < now` — both wrong (see health.ts). The
// bug produced founder-observed "RECONNECT REQUIRED" pills on
// mailboxes that were actually healthy in the CONNECTED_PENDING_
// SYNC or DELAYED states, prompting the founder to repeatedly
// reconnect and never recover.

import { prisma } from "@/lib/prisma";
import type { FeedSyncedStatus } from "@/components/mission-control/FeedSyncedStatusPill";
import { deriveMailboxHealth } from "@/lib/mailbox/health";

const RECONNECT_HREF = "/app/user/settings/connected-accounts";

export async function loadFeedSyncedStatus(clubId: string, userId: string): Promise<FeedSyncedStatus> {
  const conn = await prisma.mailboxConnection.findFirst({
    where: { clubId, userId, status: { not: "DELETED" } },
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      lastSuccessfulSyncAt: true,
      lastAttemptedSyncAt: true,
      lastSyncError: true,
      connectedEmail: true,
      refreshTokenSecretRef: true,
    },
  });

  const health = deriveMailboxHealth(
    conn
      ? {
          status: conn.status,
          lastSuccessfulSyncAt: conn.lastSuccessfulSyncAt,
          lastAttemptedSyncAt: conn.lastAttemptedSyncAt,
          lastSyncError: conn.lastSyncError,
          connectedEmail: conn.connectedEmail,
          hasRefreshToken: conn.refreshTokenSecretRef != null,
        }
      : null,
  );

  if (health.credentials === "NONE") {
    return {
      state: "NONE",
      label: "Not connected",
      detail: "No mailbox integration is connected for your account.",
      href: RECONNECT_HREF,
    };
  }
  if (health.credentials === "REAUTH_REQUIRED" || health.credentials === "DISCONNECTED") {
    return {
      state: "RECONNECT",
      label: "Reconnect required",
      detail: `Mailbox status is ${(health.rawStatus ?? "unknown").toLowerCase().replace(/_/g, " ")} — reconnect ${health.connectedEmail ?? "your mailbox"}.`,
      href: RECONNECT_HREF,
    };
  }
  // credentials === "CONNECTED" — sync axis decides the visible pill.
  if (health.sync === "NEVER") {
    return {
      state: "DELAYED",
      label: "Awaiting first sync",
      detail: `Mailbox ${health.connectedEmail ?? "connected"} — first sync scheduled.`,
      href: RECONNECT_HREF,
    };
  }
  if (health.sync === "FAILING") {
    return {
      state: "DELAYED",
      label: "Feed delayed",
      detail: health.lastSyncError
        ? `Last sync attempt failed: ${health.lastSyncError.slice(0, 120)}`
        : "Last sync attempt failed — will retry.",
      href: RECONNECT_HREF,
    };
  }
  if (health.sync === "STALE") {
    return {
      state: "DELAYED",
      label: "Feed delayed",
      detail: health.lastSuccessfulSyncAt
        ? `Last successful sync ${health.lastSuccessfulSyncAt.toISOString().slice(0, 16).replace("T", " ")}`
        : "No successful sync yet.",
      href: RECONNECT_HREF,
    };
  }
  // sync === "FRESH".
  return {
    state: "SYNCED",
    label: "Feed synced",
    detail: health.lastSuccessfulSyncAt
      ? `Mailbox ${health.connectedEmail ?? ""} · last synced ${health.lastSuccessfulSyncAt.toISOString().slice(0, 16).replace("T", " ")}`
      : `Mailbox ${health.connectedEmail ?? ""} connected.`,
    href: RECONNECT_HREF,
  };
}
