// WI-2C.1 (2026-09-28) — Work-Intake-styled feed sync control.
//
// Uses the shared Mission Control refresh functionality via
// `useLiveRefresh()` but renders the pre-WI-2C compact hero
// treatment ("FEED SYNCED  ↻") — no large green pill, no borders,
// no capsule chrome. Presentation belongs to Work Intake;
// functionality is shared with Mission Control per the WI-2C.1
// brief §1 ("presentation != functionality").
//
// Interaction:
//   - resting:    FEED SYNCED   ↻
//   - active:     FEED SYNCING  ↻ (glyph rotates)
//   - error:      SYNC FAILED   ↻ (muted; hover reveals title)
// Click the refresh glyph → `refreshManually()`, exact same
// synchronization pathway as Mission Control.

"use client";

import { useLiveRefresh } from "@/components/mission-control/LiveRefreshContext";

function RefreshGlyph({ spinning }: { spinning: boolean }) {
  return (
    <svg
      width="15" height="15" viewBox="0 0 16 16" aria-hidden="true"
      style={spinning ? { animation: "wi-hero-sync-spin 900ms linear infinite" } : undefined}
    >
      <path
        d="M3 8a5 5 0 0 1 8.5-3.5M13 8a5 5 0 0 1-8.5 3.5M12 3v3H9M4 13v-3h3"
        stroke="currentColor" strokeWidth="1.75" fill="none"
        strokeLinecap="round" strokeLinejoin="round"
      />
    </svg>
  );
}

export default function WorkIntakeFeedSyncPill() {
  const live = useLiveRefresh();

  // Provider missing → render an inert label so the hero still
  // draws in dev/preview contexts. Never null the whole hero.
  const manualRefreshing = live?.manualRefreshing ?? false;
  const hasError = live?.error != null;

  const label = manualRefreshing
    ? "FEED SYNCING"
    : hasError
      ? "SYNC FAILED"
      : "FEED SYNCED";

  const onClick = () => {
    if (!live) return;
    if (manualRefreshing) return;
    live.refreshManually();
  };

  return (
    <div className="wi-hero-sync" data-testid="wi-hero-sync">
      <span className="wi-hero-sync-label">{label}</span>
      <button
        type="button"
        className="wi-hero-sync-btn"
        onClick={onClick}
        disabled={!live || manualRefreshing}
        aria-label={manualRefreshing ? "Sync in progress" : "Refresh Work Intake feed"}
        title={hasError ? `Last sync failed: ${live?.error ?? "unknown"}` : undefined}
        data-testid="wi-hero-sync-btn"
      >
        <RefreshGlyph spinning={manualRefreshing} />
      </button>
    </div>
  );
}
