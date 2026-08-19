"use client";

// Phase 4R rev-14 (2026-08-16) — Work Intake Feed active-card context.
//
// The founder's rule (rev-14 brief §3-§7):
//
//   Only the currently active/interacted-with Work Intake card may
//   retain a non-default tab. All other cards return to AI Summary
//   as their VISUAL state. The reset is presentation-only — it must
//   NOT trigger mark-read, enqueue a Graph mutation, or count as a
//   user interaction with the reset card.
//
// This context owns exactly one piece of feed-level state:
//   activeWorkItemId: the ID of the Work Intake item the founder is
//                     currently working with (i.e. the last one they
//                     meaningfully interacted with — see §5).
//
// Each card keeps its own local `ownTab` state, but its RENDERED
// tab is derived:
//
//   effectiveTab = (activeWorkItemId === thisCard.id) ? ownTab
//                                                     : "spectre-summary"
//
// So switching to another card visually collapses this one back to
// AI Summary without touching state, hooks, or side-effects. If the
// user later returns via a tab click on this card, that click sets
// ownTab AND fires setActiveCard(thisCard.id) atomically.
//
// The internal identifier stays "spectre-summary" (founder brief
// §1: "Do not rename internal intelligence services/types simply
// because the visible tab label changes"). Only the user-facing
// LABEL is "AI Summary" — see CARD_TAB_LABEL.

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface WorkFeedActiveState {
  activeWorkItemId: string | null;
  setActiveCard: (workItemId: string) => void;
}

const Ctx = createContext<WorkFeedActiveState | null>(null);

export function WorkFeedActiveProvider({ children }: { children: ReactNode }) {
  const [activeWorkItemId, setActiveWorkItemId] = useState<string | null>(null);
  const setActiveCard = useCallback((workItemId: string) => {
    setActiveWorkItemId((prev) => (prev === workItemId ? prev : workItemId));
  }, []);
  const value = useMemo<WorkFeedActiveState>(
    () => ({ activeWorkItemId, setActiveCard }),
    [activeWorkItemId, setActiveCard],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWorkFeedActive(): WorkFeedActiveState | null {
  return useContext(Ctx);
}
