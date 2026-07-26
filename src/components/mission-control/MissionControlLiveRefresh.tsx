"use client";
// Sprint 3 Checkpoint 15H-1 (2026-07-25) — Mission Control live
// refresh component.
//
// Renders:
//   * "Last refreshed X ago" label (updates every second)
//   * "Refresh now" button (force immediate refresh)
//   * A non-blocking banner "N new items available" when the
//     background poll detects new work items AND at least one review
//     pane is expanded (so we don't disturb an active review).
//
// Uses router.refresh() to re-fetch the RSC page. Router.refresh()
// preserves ALL client component state (including <EmailIntakeCard>
// and <IntelligenceReviewCard> expansion state) because React
// re-hydrates existing tree with new props. Individual cards decide
// what to re-render.

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Props {
  initialWorkItemIds: string[];
  initialSyncedAt: string; // ISO
  pollIntervalMs?: number;
}

interface SummaryPayload {
  syncedAt: string;
  workItemCount: number;
  workItemIds: string[];
}

const DEFAULT_POLL_MS = 60_000;

export default function MissionControlLiveRefresh({
  initialWorkItemIds,
  initialSyncedAt,
  pollIntervalMs,
}: Props) {
  const router = useRouter();
  const [syncedAt, setSyncedAt] = useState<Date>(new Date(initialSyncedAt));
  const [nowTick, setNowTick] = useState<number>(Date.now());
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newItemsAvailable, setNewItemsAvailable] = useState<number>(0);
  const knownIdsRef = useRef<Set<string>>(new Set(initialWorkItemIds));
  const pollMs = pollIntervalMs ?? DEFAULT_POLL_MS;

  // ------------------------------------------------------------------
  // Detect any expanded review pane by peeking at the DOM. We do NOT
  // wire prop-drilling into every card — instead, we rely on the fact
  // that expanded cards mount <div class="spectre-mc-inline-expansion">.
  // If any exists, background refreshes are held to a banner instead of
  // firing router.refresh() (which would re-render the whole page).
  // ------------------------------------------------------------------
  const anyPaneExpanded = useCallback(() => {
    if (typeof document === "undefined") return false;
    return document.querySelectorAll(".spectre-mc-inline-expansion").length > 0;
  }, []);

  const doRefresh = useCallback(
    async (forced: boolean) => {
      if (refreshing) return;
      setRefreshing(true);
      setError(null);
      try {
        // First: hit the summary endpoint to compare against last-known ids.
        const res = await fetch("/api/mission-control/snapshot-summary", { method: "GET" });
        if (res.status === 401) { setError("unauthenticated"); return; }
        if (!res.ok) { setError(`http_${res.status}`); return; }
        const body = (await res.json()) as SummaryPayload;

        const newlyArrivedIds = body.workItemIds.filter((id) => !knownIdsRef.current.has(id));

        if (!forced && anyPaneExpanded() && newlyArrivedIds.length > 0) {
          // Reviewer is in the middle of something — don't yank the
          // page out from under them. Show a banner instead.
          setNewItemsAvailable(newlyArrivedIds.length);
          return;
        }

        // Safe to refresh: either forced, or no pane is expanded, or
        // no new items arrived (still refresh to update "last refreshed").
        knownIdsRef.current = new Set(body.workItemIds);
        setSyncedAt(new Date(body.syncedAt));
        setNewItemsAvailable(0);
        // router.refresh() re-runs server components; existing client
        // components (cards) retain their local state (expansion, form
        // fields, etc.) because their keys don't change.
        router.refresh();
      } catch {
        setError("network");
      } finally {
        setRefreshing(false);
      }
    },
    [anyPaneExpanded, refreshing, router],
  );

  // Interval poll.
  useEffect(() => {
    const t = setInterval(() => { void doRefresh(false); }, pollMs);
    return () => clearInterval(t);
  }, [doRefresh, pollMs]);

  // "X ago" label ticks every second.
  useEffect(() => {
    const t = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  // Pause auto-poll while the tab is hidden; resume + refresh on focus.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") void doRefresh(false);
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [doRefresh]);

  const ageLabel = relTimeLabel(syncedAt.getTime(), nowTick);

  return (
    <div className="spectre-mc-live-refresh" data-testid="mc-live-refresh">
      <span className="spectre-mc-live-refresh-status" aria-live="polite" data-testid="mc-live-refresh-status">
        {refreshing ? "Refreshing…" : `Last refreshed ${ageLabel}`}
      </span>
      <button
        type="button"
        className="spectre-btn spectre-btn--sm spectre-btn--ghost"
        onClick={() => { void doRefresh(true); }}
        disabled={refreshing}
        aria-busy={refreshing}
        data-testid="mc-refresh-now"
      >
        Refresh now
      </button>
      {error ? (
        <span className="spectre-mc-live-refresh-error" role="alert" data-testid="mc-refresh-error">
          {error === "unauthenticated" ? "Session expired" : "Refresh failed"}
        </span>
      ) : null}
      {newItemsAvailable > 0 ? (
        <button
          type="button"
          className="spectre-btn spectre-btn--sm spectre-btn--primary spectre-mc-live-refresh-new-items"
          onClick={() => { void doRefresh(true); }}
          data-testid="mc-new-items-banner"
        >
          {newItemsAvailable} new work {newItemsAvailable === 1 ? "item" : "items"} — click to load
        </button>
      ) : null}
    </div>
  );
}

function relTimeLabel(then: number, now: number): string {
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ago`;
}
