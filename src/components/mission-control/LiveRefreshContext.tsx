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

export type RefreshError = "network" | "unauthenticated" | "server" | "sync_failed" | "sync_timeout" | "no_mailbox" | null;

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

  // Rev-13 (2026-08-16) — the manual refresh path must ACTUALLY
  // synchronise the mailbox before flipping FEED SYNCED back on.
  // Prior to rev-13 it only re-read the Prisma DB (Defect A in the
  // rev-12 diagnostic), so an Outlook-side unread change couldn't
  // reach Spectre even after the founder clicked refresh.
  //
  // Manual sequence:
  //   1. POST /api/mission-control/refresh-mailbox → enqueues
  //      MAILBOX_DELTA_SYNC (or INITIAL_SYNC for fresh mailboxes)
  //      and returns { jobIds, mailboxConnectionIds }.
  //   2. Poll GET /api/mission-control/refresh-mailbox/status?jobIds=…
  //      every 1s until allTerminal OR a 30s wall-clock timeout.
  //   3. If anyFailed → set error "sync_failed"; do NOT flip pill.
  //   4. If terminal-success → fetch snapshot-summary + router.refresh
  //      + flip pill back to FEED SYNCED.
  //   5. If timeout → set error "sync_timeout"; do NOT flip pill.
  //
  // Background auto-refresh (source === "background") is UNCHANGED
  // and remains SILENT — it still hits snapshot-summary only and
  // never enqueues a sync. This preserves the founder's brief §13:
  // the visible REFRESHING… state is a manual-click affordance only.
  const MANUAL_SYNC_TIMEOUT_MS = 30_000;
  const MANUAL_SYNC_POLL_MS = 1_000;

  const doBackgroundRefresh = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = "background";
    setBackgroundRefreshing(true);
    try {
      const res = await fetch("/api/mission-control/snapshot-summary", { method: "GET" });
      if (res.status === 401) return; // silent — no error state on background
      if (!res.ok) return;
      const body = (await res.json()) as SummaryPayload;
      const newlyArrivedIds = body.workItemIds.filter((id) => !knownIdsRef.current.has(id));
      if (anyPaneExpanded() && newlyArrivedIds.length > 0) {
        setNewItemsAvailable(newlyArrivedIds.length);
        return;
      }
      knownIdsRef.current = new Set(body.workItemIds);
      setSyncedAt(new Date(body.syncedAt));
      setNewItemsAvailable(0);
      router.refresh();
    } catch {
      // Silent on background — never surfaces an error to the pill.
    } finally {
      inFlightRef.current = null;
      setBackgroundRefreshing(false);
    }
  }, [anyPaneExpanded, router]);

  const doManualRefresh = useCallback(async () => {
    // A manual click always wins over an in-flight background; wait
    // for background to release inFlightRef, then take it.
    if (inFlightRef.current === "manual") return;
    inFlightRef.current = "manual";
    setManualRefreshing(true);
    setError(null);
    const startedAt = Date.now();
    try {
      // 1. Enqueue the mailbox sync barrier.
      const enqRes = await fetch("/api/mission-control/refresh-mailbox", { method: "POST" });
      if (enqRes.status === 401) { setError("unauthenticated"); return; }
      if (enqRes.status === 409) { setError("no_mailbox"); return; }
      if (!enqRes.ok) { setError("server"); return; }
      const enqBody = (await enqRes.json()) as { jobIds: string[] };
      if (!enqBody.jobIds || enqBody.jobIds.length === 0) {
        setError("no_mailbox");
        return;
      }
      // 2. Poll job status until every job is terminal OR timeout.
      const jobIdsCsv = enqBody.jobIds.join(",");
      let allTerminal = false;
      let anyFailed = false;
      while (Date.now() - startedAt < MANUAL_SYNC_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, MANUAL_SYNC_POLL_MS));
        const statusRes = await fetch(
          `/api/mission-control/refresh-mailbox/status?jobIds=${encodeURIComponent(jobIdsCsv)}`,
        );
        if (statusRes.status === 401) { setError("unauthenticated"); return; }
        if (!statusRes.ok) continue; // transient — keep polling within the timeout
        const statusBody = (await statusRes.json()) as { allTerminal: boolean; anyFailed: boolean };
        if (statusBody.allTerminal) {
          allTerminal = true;
          anyFailed = statusBody.anyFailed;
          break;
        }
      }
      if (!allTerminal) {
        setError("sync_timeout");
        return;
      }
      if (anyFailed) {
        setError("sync_failed");
        return;
      }
      // 3. Mailbox sync succeeded. Now re-read the DB projection
      //    and re-render.
      const summaryRes = await fetch("/api/mission-control/snapshot-summary", { method: "GET" });
      if (summaryRes.status === 401) { setError("unauthenticated"); return; }
      if (!summaryRes.ok) { setError("server"); return; }
      const summaryBody = (await summaryRes.json()) as SummaryPayload;
      knownIdsRef.current = new Set(summaryBody.workItemIds);
      setSyncedAt(new Date(summaryBody.syncedAt));
      setNewItemsAvailable(0);
      setError(null);
      router.refresh();
    } catch {
      setError("network");
    } finally {
      inFlightRef.current = null;
      setManualRefreshing(false);
    }
  }, [router]);

  const doRefresh = useCallback(
    async (source: "manual" | "background") => {
      if (source === "manual") return doManualRefresh();
      return doBackgroundRefresh();
    },
    [doBackgroundRefresh, doManualRefresh],
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
