"use client";

// FPP-6D (2026-09-21) — Workspace preview selection state + close
// animation lifecycle.
//
// URL is still the source of truth for whether the workspace is
// open or closed — `?workItem=<id>` selects, absent selection means
// closed. On top of that, this provider owns a short-lived
// `closingWorkItemId` client state that keeps the preview element
// visually mounted for the exit animation window, then commits the
// URL change once the animation has visibly progressed. The
// canonical selection semantics are:
//
//   • selectWorkItem(id) with id !== current selection  →
//       cancel any pending close, push URL with new id.
//   • selectWorkItem(id) with id === current selection  →
//       TOGGLE: close the preview.
//   • closeCurrent()  →
//       explicit close (X button, keyboard Escape) — mounts the
//       preview into the "closing" state, plays exit animation,
//       then replaces URL after ~220ms.
//
// Rapid-click safety: if the user clicks the selected card again
// while a close is in progress, that click is a no-op (the animation
// is already going). If the user clicks a DIFFERENT card during a
// close animation, that cancels the pending close and switches to
// the new item.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Close animation window — matches the CSS `spectre-mc-preview-exit`
// keyframe duration below. Keep these in sync.
const CLOSE_ANIMATION_MS = 220;

interface WorkspacePreviewContextValue {
  /** The workItem currently rendered in the preview slot. Includes
   *  the id that is CLOSING (still visually present) so the pane
   *  keeps rendering until the animation completes. */
  displayedWorkItemId: string | null;
  /** The workItem that URL state currently selects — this is null
   *  as soon as `closeCurrent()` fires, so header controls and card
   *  selection state update immediately even while the preview
   *  finishes its exit animation. */
  selectedWorkItemId: string | null;
  /** True while the preview's exit animation is playing. Consumers
   *  add a modifier class to render the exit motion. */
  isClosing: boolean;
  selectWorkItem: (id: string) => void;
  clearSelection: () => void;
  closeCurrent: () => void;
  isSelected: (id: string) => boolean;
}

const WorkspacePreviewContext = createContext<WorkspacePreviewContextValue | null>(null);

export function WorkspacePreviewProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname() ?? "/app/admin";
  const searchParams = useSearchParams();
  const urlWorkItemId = searchParams?.get("workItem") ?? null;

  // The visual "closing" phase mounts the preview even after URL
  // state has cleared selection.
  const [closingWorkItemId, setClosingWorkItemId] = useState<string | null>(null);
  const closeTimerRef = useRef<number | null>(null);

  // If the URL changes (e.g. from a direct navigation or a card
  // switch), any in-flight close is stale — abandon it.
  useEffect(() => {
    if (closingWorkItemId != null && urlWorkItemId != null && urlWorkItemId !== closingWorkItemId) {
      if (closeTimerRef.current != null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
      setClosingWorkItemId(null);
    }
  }, [urlWorkItemId, closingWorkItemId]);

  // Clean up any pending close on unmount.
  useEffect(() => {
    return () => {
      if (closeTimerRef.current != null) window.clearTimeout(closeTimerRef.current);
    };
  }, []);

  const buildHref = useCallback(
    (id: string | null) => {
      const p = new URLSearchParams(searchParams?.toString() ?? "");
      if (id) p.set("workItem", id);
      else p.delete("workItem");
      const qs = p.toString();
      return qs ? `${pathname}?${qs}` : pathname;
    },
    [pathname, searchParams],
  );

  const cancelPendingClose = useCallback(() => {
    if (closeTimerRef.current != null) {
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    setClosingWorkItemId(null);
  }, []);

  const closeCurrent = useCallback(() => {
    if (!urlWorkItemId) return;
    if (closingWorkItemId != null) return; // Already closing — ignore.
    const id = urlWorkItemId;
    // The URL still carries the id during the exit animation window,
    // so the preview element remains server-rendered and can play
    // its --closing keyframe. Only after the animation window
    // elapses do we call router.replace to commit the URL change;
    // the server re-render then unmounts the preview and the grid's
    // grid-template-columns transitions back to the 2-column closed
    // state.
    setClosingWorkItemId(id);
    closeTimerRef.current = window.setTimeout(() => {
      closeTimerRef.current = null;
      setClosingWorkItemId(null);
      router.replace(buildHref(null));
    }, CLOSE_ANIMATION_MS);
  }, [urlWorkItemId, closingWorkItemId, buildHref, router]);

  const selectWorkItem = useCallback(
    (id: string) => {
      // Toggle-on-second-click.
      if (id === urlWorkItemId) {
        closeCurrent();
        return;
      }
      // Switching to a different item cancels any in-flight close
      // and immediately selects the new item.
      cancelPendingClose();
      router.push(buildHref(id));
    },
    [urlWorkItemId, buildHref, router, closeCurrent, cancelPendingClose],
  );

  const clearSelection = useCallback(() => {
    // Legacy contract — X button and other consumers call this to
    // close. Routed through the animated closeCurrent for symmetry.
    closeCurrent();
  }, [closeCurrent]);

  const isSelected = useCallback(
    (id: string) => urlWorkItemId === id,
    [urlWorkItemId],
  );

  const isClosing = closingWorkItemId != null;
  const displayedWorkItemId = urlWorkItemId ?? closingWorkItemId;

  const value = useMemo<WorkspacePreviewContextValue>(
    () => ({
      displayedWorkItemId,
      selectedWorkItemId: urlWorkItemId,
      isClosing,
      selectWorkItem,
      clearSelection,
      closeCurrent,
      isSelected,
    }),
    [displayedWorkItemId, urlWorkItemId, isClosing, selectWorkItem, clearSelection, closeCurrent, isSelected],
  );

  return (
    <WorkspacePreviewContext.Provider value={value}>
      {children}
    </WorkspacePreviewContext.Provider>
  );
}

export function useWorkspacePreview(): WorkspacePreviewContextValue {
  const ctx = useContext(WorkspacePreviewContext);
  if (!ctx) {
    return {
      displayedWorkItemId: null,
      selectedWorkItemId: null,
      isClosing: false,
      selectWorkItem: () => {},
      clearSelection: () => {},
      closeCurrent: () => {},
      isSelected: () => false,
    };
  }
  return ctx;
}
