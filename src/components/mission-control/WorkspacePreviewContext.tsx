"use client";

// FPP-6 (2026-09-21) — Workspace preview selection state.
//
// The Mission Control workspace can render a two-column layout
// (feed + rail, closed state) or a three-column layout (compressed
// feed + preview pane + rail, open state). This provider owns the
// selection state and drives the URL param (`?workItem=<id>`).
//
// URL state semantics:
//   • `router.push` on select (adds history entry — Back returns to
//     closed state).
//   • `router.replace` on close (does NOT add another entry — Back
//     goes to whatever preceded the initial selection).
//   • Preserves every other search param (e.g. `?view=history`).
//
// Server-side: the page reads `searchParams.workItem` and pre-loads
// the preview DTO. If the param is present but the loader rejects
// (not found, cross-tenant), the server falls back to closed state
// and does NOT leak the param — the provider then clears the URL on
// mount to keep the state consistent.

import { createContext, useCallback, useContext, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

interface WorkspacePreviewContextValue {
  selectedWorkItemId: string | null;
  selectWorkItem: (id: string) => void;
  clearSelection: () => void;
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
  const selectedWorkItemId = searchParams?.get("workItem") ?? null;

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

  const selectWorkItem = useCallback(
    (id: string) => {
      if (selectedWorkItemId === id) return;
      // push — adds a history entry so browser Back returns to the
      // prior state (closed OR previously-selected).
      router.push(buildHref(id));
    },
    [buildHref, router, selectedWorkItemId],
  );

  const clearSelection = useCallback(() => {
    if (!selectedWorkItemId) return;
    // replace — closing does NOT add another history entry; Back
    // goes to whatever preceded the initial selection.
    router.replace(buildHref(null));
  }, [buildHref, router, selectedWorkItemId]);

  const isSelected = useCallback(
    (id: string) => selectedWorkItemId === id,
    [selectedWorkItemId],
  );

  const value = useMemo<WorkspacePreviewContextValue>(
    () => ({ selectedWorkItemId, selectWorkItem, clearSelection, isSelected }),
    [selectedWorkItemId, selectWorkItem, clearSelection, isSelected],
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
    // Called outside the provider — fall back to a no-op so cards
    // outside the workspace don't error, they simply do nothing.
    return {
      selectedWorkItemId: null,
      selectWorkItem: () => {},
      clearSelection: () => {},
      isSelected: () => false,
    };
  }
  return ctx;
}
