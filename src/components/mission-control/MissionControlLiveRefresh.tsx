"use client";

// Phase 4R rev-6 (2026-08-15) — the visible `Refreshing…` chip and
// the `Refresh now` text button previously rendered by this
// component are RETIRED. All refresh state now lives in
// `LiveRefreshContext`; the manual refresh control lives inside
// the Feed Synced pill; and background auto-refresh is silent.
//
// What remains here: the non-blocking "N new items available"
// banner. Background auto-refresh suppresses a router.refresh()
// when the reviewer has an expanded pane, so new items would
// otherwise never surface until the reviewer manually refreshes
// or closes their pane. The banner keeps them informed without
// yanking the page out from under them.

import { useLiveRefresh } from "./LiveRefreshContext";

export default function MissionControlLiveRefresh() {
  const live = useLiveRefresh();
  if (!live) return null;
  if (live.newItemsAvailable <= 0) return null;
  return (
    <button
      type="button"
      className="spectre-btn spectre-btn--sm spectre-btn--primary spectre-mc-live-refresh-new-items"
      onClick={() => live.acceptNewItems()}
      data-testid="mc-new-items-banner"
    >
      {live.newItemsAvailable} new work {live.newItemsAvailable === 1 ? "item" : "items"} — click to load
    </button>
  );
}
