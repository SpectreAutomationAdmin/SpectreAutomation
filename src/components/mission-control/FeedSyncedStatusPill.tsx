"use client";

// Sprint 3 · Checkpoint 15M (2026-07-27) — Mission Control header
// mailbox connection pill.
//
// Renders a compact health chip near the Mission Control header.
// State classes:
//   • FEED SYNCED   (green)  — status = SYNCED
//   • FEED DELAYED  (amber)  — status = DELAYED
//   • RECONNECT     (red)    — status = RECONNECT
//   • NOT CONNECTED (neutral) — status = NONE
//
// Phase 4R rev-6 (2026-08-15) — the pill now integrates the manual
// refresh control:
//   • an <IconRefresh> button lives INSIDE the same pill (no
//     separate `Refresh now` text link);
//   • clicking the icon fires a user-initiated refresh via the
//     shared LiveRefreshContext;
//   • while the manual refresh is in flight the pill's LABEL
//     swaps to "REFRESHING…" and the icon spins;
//   • background / auto-refresh is silent — the pill NEVER
//     visualises the background refresh state;
//   • a real refresh failure surfaces a "REFRESH FAILED" tone
//     so a broken sync is not silently rolled back to synced.

import Link from "next/link";
import { IconRefresh } from "@/components/spectre/icons";
import { useLiveRefresh } from "./LiveRefreshContext";

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
  const live = useLiveRefresh();

  // The pill's LABEL follows the user-perceptible refresh state:
  //   • idle / auto-refreshing         → status.label ("FEED SYNCED")
  //   • user-initiated refresh pending → "REFRESHING…"
  //   • honest failure                 → "REFRESH FAILED"
  // Background refresh state is intentionally invisible.
  const manualRefreshing = !!live?.manualRefreshing;
  const refreshFailed = !!live?.error;

  const displayLabel = manualRefreshing
    ? "Refreshing…"
    : refreshFailed
      ? "Refresh failed"
      : status.label;

  const toneClass = refreshFailed && !manualRefreshing
    ? "spectre-feed-pill--reconnect" // reuse the amber/red tone for a live failure
    : TONE_CLASS[status.state];

  const onLabelClick = (e: React.MouseEvent) => {
    // Preserve the original "click the label to open the connected-
    // accounts settings" behaviour, but only when the pill is in
    // the base SYNCED / DELAYED / RECONNECT / NONE state — during
    // a manual refresh a click on the label is meaningless.
    if (manualRefreshing) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const onRefreshClick = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!live || manualRefreshing) return;
    live.refreshManually();
  };

  return (
    <span
      className={`spectre-feed-pill ${toneClass}`}
      data-testid="feed-synced-pill"
      data-state={status.state}
      data-manual-refreshing={manualRefreshing ? "true" : "false"}
      data-refresh-failed={refreshFailed ? "true" : "false"}
      title={status.detail ?? undefined}
    >
      <Link
        href={status.href}
        className="spectre-feed-pill__label-link"
        onClick={onLabelClick}
        data-testid="feed-synced-pill-label"
        aria-live="polite"
      >
        <span className="spectre-feed-pill__dot" aria-hidden="true" />
        <span className="spectre-feed-pill__label">{displayLabel}</span>
      </Link>
      {live ? (
        <button
          type="button"
          className={`spectre-feed-pill__refresh${manualRefreshing ? " is-spinning" : ""}`}
          aria-label="Refresh feed"
          aria-busy={manualRefreshing}
          disabled={manualRefreshing}
          data-testid="feed-synced-pill-refresh"
          onClick={onRefreshClick}
          onKeyDown={(e) => {
            // Explicit Enter/Space handling for keyboard parity —
            // <button> handles this natively but the aria-busy state
            // above suppresses the default click when disabled; the
            // browser handles it correctly, this block is defensive.
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onRefreshClick(e as unknown as React.MouseEvent);
            }
          }}
        >
          <IconRefresh size={14} />
        </button>
      ) : null}
      {/* When there is no LiveRefreshProvider (rare — legacy render
          paths / fallback), fall through to the classic navigation
          behaviour by leaving the icon button off. The founder
          approves this graceful degradation: no shell means no
          refresh mechanism to hook into. */}
    </span>
  );
}
