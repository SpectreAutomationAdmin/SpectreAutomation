"use client";

// Phase 4R rev-6 (2026-08-15) — Mission Control refresh state
// context.
//
// Prior state: `FeedSyncedStatusPill` was a bare server-rendered
// <Link>, and `MissionControlLiveRefresh` owned both the auto-poll
// AND its own visible `Refreshing…` chip + `Refresh now` button.
// The founder correctly identified two problems:
//
//   1. Background auto-refresh should NOT expose transient state —
//      no separate `Refreshing…` element, no distracting flash.
//   2. The manual refresh action + the feed-synced status should be
//      one control, not two.
//
// Rev-6 splits refresh-source-of-truth into `manual` vs `background`
// so the pill can distinguish the two and only visualise the manual
// case. The auto-poll continues quietly in the background.

import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

interface SummaryPayload {
  syncedAt: string;
  workItemCount: number;
  workItemIds: string[];
}

export type RefreshError = "network" | "unauthenticated" | "server" | null;

export interface LiveRefreshState {
  /** ISO of the last successful sync. */
  syncedAt: Date;
  /** True while a USER-initiated refresh is in flight — this is
   *  the ONLY refresh state the pill visualises. */
  manualRefreshing: boolean;
  /** True while a BACKGROUND refresh is in flight — kept for
   *  test coverage / diagnostics; NEVER rendered visibly. */
  backgroundRefreshing: boolean;
  /** Last refresh error, if any. Preserved so a broken sync doesn't
   *  silently roll back to `FEED SYNCED`. */
  error: RefreshError;
  /** Count of newly-arrived items suppressed because a reviewer had
   *  an expanded pane at the moment auto-refresh fired. */
  newItemsAvailable: number;
  /** Fire a manual refresh. Coalesces if a manual refresh is already
   *  pending — prevents accidental double-click bursts. */
  refreshManually: () => void;
  /** Consume the pending-new-items badge (called when the reviewer
   *  clicks "load new" in the banner). */
  acceptNewItems: () => void;
}

const Ctx = createContext<LiveRefreshState | null>(null);

const DEFAULT_POLL_MS = 60_000;

export interface ProviderProps {
  initialWorkItemIds: string[];
  initialSyncedAt: string;
  pollIntervalMs?: number;
  children: ReactNode;
}

export function LiveRefreshProvider({
  initialWorkItemIds,
  initialSyncedAt,
  pollIntervalMs,
  children,
}: ProviderProps) {
  const router = useRouter();
  const [syncedAt, setSyncedAt] = useState<Date>(new Date(initialSyncedAt));
  const [manualRefreshing, setManualRefreshing] = useState(false);
  const [backgroundRefreshing, setBackgroundRefreshing] = useState(false);
  const [error, setError] = useState<RefreshError>(null);
  const [newItemsAvailable, setNewItemsAvailable] = useState<number>(0);

  const knownIdsRef = useRef<Set<string>>(new Set(initialWorkItemIds));
  const pollMs = pollIntervalMs ?? DEFAULT_POLL_MS;
  const inFlightRef = useRef<"manual" | "background" | null>(null);

  const anyPaneExpanded = useCallback(() => {
    if (typeof document === "undefined") return false;
    return document.querySelectorAll(".spectre-mc-inline-expansion").length > 0;
  }, []);

  const doRefresh = useCallback(
    async (source: "manual" | "background") => {
      // Never coalesce a manual refresh with a background one —
      // a user click always wins.
      if (inFlightRef.current === "manual") return;
      // A background poll should not run if a manual is pending.
      if (source === "background" && inFlightRef.current) return;
      inFlightRef.current = source;
      if (source === "manual") setManualRefreshing(true);
      else setBackgroundRefreshing(true);
      // Clear a prior error only when starting a new attempt of the
      // same class — a manual retry should visibly reset the error;
      // a quiet background poll should NOT reset a manual failure
      // (the user needs to see it).
      if (source === "manual") setError(null);
      try {
        const res = await fetch("/api/mission-control/snapshot-summary", { method: "GET" });
        if (res.status === 401) { setError("unauthenticated"); return; }
        if (!res.ok) { setError("server"); return; }
        const body = (await res.json()) as SummaryPayload;
        const newlyArrivedIds = body.workItemIds.filter((id) => !knownIdsRef.current.has(id));
        if (source === "background" && anyPaneExpanded() && newlyArrivedIds.length > 0) {
          // Do not yank the page out from under the reviewer — show
          // the "N new items" banner instead.
          setNewItemsAvailable(newlyArrivedIds.length);
          return;
        }
        knownIdsRef.current = new Set(body.workItemIds);
        setSyncedAt(new Date(body.syncedAt));
        setNewItemsAvailable(0);
        if (source === "manual") setError(null);
        router.refresh();
      } catch {
        setError("network");
      } finally {
        inFlightRef.current = null;
        if (source === "manual") setManualRefreshing(false);
        else setBackgroundRefreshing(false);
      }
    },
    [anyPaneExpanded, router],
  );

  // Background poll.
  useEffect(() => {
    const t = setInterval(() => { void doRefresh("background"); }, pollMs);
    return () => clearInterval(t);
  }, [doRefresh, pollMs]);

  // Refresh on tab-focus (still counts as background — the user did
  // not click the icon).
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible") void doRefresh("background");
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [doRefresh]);

  const refreshManually = useCallback(() => { void doRefresh("manual"); }, [doRefresh]);
  const acceptNewItems = useCallback(() => { void doRefresh("manual"); }, [doRefresh]);

  const value = useMemo<LiveRefreshState>(
    () => ({
      syncedAt, manualRefreshing, backgroundRefreshing, error,
      newItemsAvailable, refreshManually, acceptNewItems,
    }),
    [syncedAt, manualRefreshing, backgroundRefreshing, error,
     newItemsAvailable, refreshManually, acceptNewItems],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useLiveRefresh(): LiveRefreshState | null {
  return useContext(Ctx);
}
