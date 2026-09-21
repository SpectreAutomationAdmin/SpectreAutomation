"use client";

// FPP-6 (2026-09-21) — Mission Control workspace layout switcher.
//
// Wraps the .spectre-mc-grid element and toggles the
// `spectre-mc-grid--with-preview` modifier class based on
// selection state. The class swap drives a CSS
// `grid-template-columns` transition (~200ms ease-out) that
// smoothly compresses the feed column to the LEFT and reveals the
// preview column between the feed and the right rail.
//
// The right rail and top KPI strip remain stationary because
// their layout is not affected by the grid-template-columns swap.

import type { ReactNode } from "react";
import { useWorkspacePreview } from "./WorkspacePreviewContext";

interface Props {
  children: ReactNode;
  className?: string;
}

export default function WorkspaceLayoutSwitcher({ children, className }: Props) {
  const { selectedWorkItemId, isClosing } = useWorkspacePreview();
  // FPP-6D — grid stays in the open composition while the preview
  // is playing its exit animation. The `--closing` modifier gives
  // the preview element a way to alter its animation state without
  // affecting the grid tracks.
  const isOpen = !!selectedWorkItemId;
  return (
    <div
      className={
        `spectre-mc-grid${isOpen ? " spectre-mc-grid--with-preview" : ""}` +
        `${isClosing ? " spectre-mc-grid--closing" : ""}` +
        (className ? " " + className : "")
      }
      data-preview-open={isOpen ? "true" : "false"}
      data-preview-closing={isClosing ? "true" : "false"}
      data-testid="mission-control-workspace"
    >
      {children}
    </div>
  );
}
