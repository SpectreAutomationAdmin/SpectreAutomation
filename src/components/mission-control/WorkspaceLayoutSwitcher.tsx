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
  const { selectedWorkItemId } = useWorkspacePreview();
  const isOpen = !!selectedWorkItemId;
  return (
    <div
      className={`spectre-mc-grid${isOpen ? " spectre-mc-grid--with-preview" : ""}${
        className ? " " + className : ""
      }`}
      data-preview-open={isOpen ? "true" : "false"}
      data-testid="mission-control-workspace"
    >
      {children}
    </div>
  );
}
