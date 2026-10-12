"use client";

// MBR-VIS-2 (2026-10-11) — Client-side visibility state.
//
// The MBR-VIS-1 implementation threaded `visibility` through the body
// as a server-passed prop; the VisibilityToggle updated its OWN local
// optimistic state and called `router.refresh()` to re-fetch.  Consumers
// (ChapterSection, StewardshipScorecardCard rows) read the SERVER prop,
// not the toggle's local state, so visual feedback waited on the
// server round-trip — the symptom the founder observed.
//
// This Provider owns the authoritative CLIENT-side visibility map
// (explicit + effective), hydrated from the server config at mount.
// Every toggle writes through the Provider's `setHidden` callback,
// which:
//
//   1. Updates the client map OPTIMISTICALLY so consumers re-render
//      immediately.
//   2. POSTs to /api/admin/reporting/monthly/visibility for durable
//      persistence.
//   3. Rolls back + surfaces an error on API failure.
//
// Explicit vs effective — the directive §3 fix:
//
//   • Explicit visibility is what the Controller saved for a specific
//     componentKey (the Prisma row).  Toggle buttons display THIS so
//     a child's eye icon never collapses to EyeOff just because its
//     parent is hidden.
//   • Effective visibility accounts for the parent-child cascade
//     (hidden parent → child suppressed in the published report).
//     Section + card + row rendering reads EFFECTIVE so the
//     published surface renders correctly.

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

type VisibilityEntries = Record<string, boolean>;

type VisibilityStateContextValue = {
  /** Current DRAFT entries (client-authoritative; may be ahead of
   *  server during an in-flight POST). */
  entries: VisibilityEntries;
  /** Frozen PUBLISHED entries (server-passed; immutable here). */
  publishedEntries: VisibilityEntries;
  /** Explicitly saved state for `componentKey` (ignores parent
   *  cascade).  Drives the toggle button's icon. */
  explicitHidden: (componentKey: string) => boolean;
  /** Rendered state for `componentKey` honoring parent-child
   *  cascade (chapter → card → row/commentary).  Drives whether
   *  the section/card/row appears or is muted/collapsed. */
  effectiveHidden: (componentKey: string) => boolean;
  /** `true` when the DRAFT state for `componentKey` differs from
   *  PUBLISHED.  Drives the amber "pending publish" dot. */
  isPendingPublish: (componentKey: string) => boolean;
  /** Optimistic write: set the client state immediately + POST +
   *  rollback on failure. */
  setHidden: (
    componentKey: string,
    hidden: boolean,
    period: { reportingYear: number; reportingMonth: number },
  ) => Promise<void>;
  /** Last toggle error, cleared on next successful write.  Rendered
   *  by the toggle button's title / aria-label on hover. */
  lastError: string | null;
  /** MBR-VIS-5A — reporting period exposed via context so leaf
   *  toggles can self-identify the (year, month) without threading
   *  props through 11 panel components.  Null when the Provider
   *  wasn't given a period. */
  period: { reportingYear: number; reportingMonth: number } | null;
};

const VisibilityStateContext = createContext<VisibilityStateContextValue | null>(null);

function isAncestorHiddenIn(
  componentKey: string,
  entries: VisibilityEntries,
): boolean {
  const parts = componentKey.split(":");
  if (parts.length < 2) return false;
  const [tier, anchor, cardKey] = parts;
  if (tier === "chapter") return false;
  if (tier === "card") return entries[`chapter:${anchor}`] === true;
  if (tier === "row" || tier === "commentary") {
    if (entries[`chapter:${anchor}`] === true) return true;
    if (cardKey && entries[`card:${anchor}:${cardKey}`] === true) return true;
    return false;
  }
  return false;
}

export function VisibilityStateProvider({
  initialDraft,
  initialPublished,
  period,
  children,
}: {
  initialDraft: VisibilityEntries | undefined;
  initialPublished: VisibilityEntries | undefined;
  /** MBR-VIS-5A — reporting period exposed via context so inline
   *  toggles embedded in panel h2s self-identify without threading. */
  period?: { reportingYear: number; reportingMonth: number };
  children: ReactNode;
}) {
  const [entries, setEntries] = useState<VisibilityEntries>(() => ({
    ...(initialDraft ?? {}),
  }));
  const [publishedEntries] = useState<VisibilityEntries>(() => ({
    ...(initialPublished ?? {}),
  }));
  const [lastError, setLastError] = useState<string | null>(null);

  const explicitHidden = useCallback(
    (componentKey: string): boolean => entries[componentKey] === true,
    [entries],
  );
  const effectiveHidden = useCallback(
    (componentKey: string): boolean =>
      entries[componentKey] === true || isAncestorHiddenIn(componentKey, entries),
    [entries],
  );
  const isPendingPublish = useCallback(
    (componentKey: string): boolean =>
      (entries[componentKey] ?? false) !== (publishedEntries[componentKey] ?? false),
    [entries, publishedEntries],
  );

  const setHidden = useCallback(
    async (
      componentKey: string,
      hidden: boolean,
      period: { reportingYear: number; reportingMonth: number },
    ) => {
      // 1. Snapshot the current value for rollback.
      const before = entries[componentKey] ?? false;
      // 2. Optimistic write.
      setEntries((prev) => ({ ...prev, [componentKey]: hidden }));
      setLastError(null);
      // 3. Persist.
      try {
        const res = await fetch("/api/admin/reporting/monthly/visibility", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reportingYear: period.reportingYear,
            reportingMonth: period.reportingMonth,
            componentKey,
            hidden,
          }),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => ({ error: res.statusText }));
          throw new Error(body.error ?? "Toggle failed.");
        }
      } catch (e) {
        // Rollback.
        setEntries((prev) => ({ ...prev, [componentKey]: before }));
        setLastError(e instanceof Error ? e.message : "Toggle failed.");
      }
    },
    [entries],
  );

  const value = useMemo<VisibilityStateContextValue>(
    () => ({
      entries,
      publishedEntries,
      explicitHidden,
      effectiveHidden,
      isPendingPublish,
      setHidden,
      lastError,
      period: period ?? null,
    }),
    [entries, publishedEntries, explicitHidden, effectiveHidden, isPendingPublish, setHidden, lastError, period],
  );

  return (
    <VisibilityStateContext.Provider value={value}>
      {children}
    </VisibilityStateContext.Provider>
  );
}

/** Hook — returns the Provider's value when inside a Provider,
 *  otherwise null so SSR / non-editing paths render without a
 *  Provider wrapping them. */
export function useVisibilityState(): VisibilityStateContextValue | null {
  return useContext(VisibilityStateContext);
}
