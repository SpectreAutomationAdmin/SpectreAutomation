// Sprint 3 · Checkpoint 15M (2026-07-27) — Mission Control header
// mailbox connection pill.
//
// Replaces the sidebar "Connected accounts" entry. Renders a compact
// health chip near the Mission Control header:
//
//   • FEED SYNCED (green)      — MailboxConnection.status === CONNECTED
//                                 AND a recent lastSuccessfulSyncAt,
//                                 AND accessTokenExpiresAt is in the future.
//   • FEED DELAYED (amber)     — CONNECTED but last sync is stale
//                                 (> 30 minutes) or the last attempt
//                                 errored without recovering yet.
//   • RECONNECT REQUIRED (red) — status is REAUTH_REQUIRED / DISCONNECTED
//                                 / DELETED, or accessTokenExpiresAt is
//                                 in the past.
//   • NOT CONNECTED (neutral)  — no MailboxConnection row for this
//                                 club/user combination.
//
// Clicking the pill routes to /app/user/settings/connected-accounts
// where the operator can reconnect or manage the mailbox.
//
// Server-rendered. Reads live DB signals per request. No polling —
// the sidebar refresh already re-renders Mission Control every
// minute (and via router.refresh on user action).

import Link from "next/link";

export interface FeedSyncedStatus {
  state: "SYNCED" | "DELAYED" | "RECONNECT" | "NONE";
  label: string;
  detail: string | null;
  href: string;
}

interface Props {
  status: FeedSyncedStatus;
}

const TONE_CLASS: Record<FeedSyncedStatus["state"], string> = {
  SYNCED:    "spectre-feed-pill--synced",
  DELAYED:   "spectre-feed-pill--delayed",
  RECONNECT: "spectre-feed-pill--reconnect",
  NONE:      "spectre-feed-pill--none",
};

export default function FeedSyncedStatusPill({ status }: Props) {
  return (
    <Link
      href={status.href}
      className={`spectre-feed-pill ${TONE_CLASS[status.state]}`}
      data-testid="feed-synced-pill"
      data-state={status.state}
      title={status.detail ?? undefined}
    >
      <span className="spectre-feed-pill__dot" aria-hidden="true" />
      <span className="spectre-feed-pill__label">{status.label}</span>
    </Link>
  );
}
