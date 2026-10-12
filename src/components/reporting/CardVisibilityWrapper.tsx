"use client";

// MBR-VIS-5 (2026-10-11) — Reusable card-level visibility wrapper.
//
// MBR-VIS-5C (2026-10-11) — critical regression fix.  The VIS-5B
// release introduced this wrapper around previously unwrapped
// Financial Performance cards, which added an extra `<div>` as the
// direct child of the grid/flex rows that hold the card pairs
// (Equity + Operating Results, Operating + Capital Scorecards,
// Department Net Performance + Dues Subsidy, Payroll Dept + Payroll
// Ratio).  The row expected `<article className="flex-1 w-full">`
// children; the wrapper's `<div className="relative">` had none of
// that, so each card collapsed to its content width and the
// side-by-side layout broke.
//
// VIS-5C fix: the wrapper no longer renders ANY DOM element.  It
// uses `React.cloneElement` to inject `data-component-key`,
// `data-card-hidden`, and an `opacity` style directly onto the
// child element (which is always the card's own article/section
// root).  The child remains the direct grid/flex child, so every
// pre-VIS-5B measurement — card width, card height, chart container
// width, chart plot area, grid proportions, header height, KPI
// tile dimensions — is preserved exactly.
//
// Semantics are unchanged:
//   • Editing + any state → child renders, with opacity 0.55 when
//     effectively hidden so the Controller can see what's suppressed.
//   • Non-editing + effectively hidden → wrapper returns null (card
//     omitted from Draft Preview, Published State, PDF).
//   • Non-editing + visible → child renders unchanged.
//
// The visibility toggle itself is NOT rendered by the wrapper —
// each card mounts its own <InlineCardToggle> inside its h3 title
// (established in VIS-5A).  This wrapper is now purely a
// zero-DOM-impact decorator for hidden-state behaviour.

import {
  Children,
  cloneElement,
  isValidElement,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import type { MonthlyBodyVisibilityConfig } from "@/app/app/admin/reporting/monthly/visibility-types";
import { useVisibilityState } from "./VisibilityState";

export type CardVisibilityWrapperProps = {
  /** Full componentKey — "card:<chapter-anchor>:<card-key>". */
  componentKey: string;
  /** Human-readable card label, used in the a11y toggle label.
   *  Retained for API stability — VIS-5A moved the toggle UI inline
   *  into each card's own title; this wrapper no longer renders it. */
  cardLabel: string;
  /** MBR-VIS-5B — optional.  When omitted, the wrapper treats the
   *  presence of VisibilityState context as the "editing" signal
   *  (the Provider only mounts on editing surfaces).  Pass
   *  explicitly to force a specific mode. */
  editing?: boolean;
  /** Server-passed visibility config used only on non-editing
   *  surfaces (where no Provider is mounted). */
  visibility?: MonthlyBodyVisibilityConfig;
  /** Retained for API stability; the wrapper no longer uses it
   *  (VIS-5A moved the visible toggle UI inline). */
  publishedVisibility?: MonthlyBodyVisibilityConfig;
  /** Retained for API stability; always false in-tree today
   *  (VIS-5A retired the floating overlay chrome). */
  renderInlineToggle?: boolean;
  /** Retained for API stability; the wrapper no longer owns a
   *  layout node to style. */
  className?: string;
  /** Reporting period — retained for API stability. */
  period?: { reportingYear: number; reportingMonth: number };
  children: ReactNode;
};

/** Shared ancestor-hidden check (identical to the server resolver).
 *  Kept inline here so the client wrapper has no server-only import. */
function isAncestorHidden(
  componentKey: string,
  entries: Record<string, boolean>,
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

export function CardVisibilityWrapper({
  componentKey,
  editing,
  visibility,
  children,
}: CardVisibilityWrapperProps) {
  const ctx = useVisibilityState();
  // "editing" defaults to context presence (Provider only mounts on
  // the editing surface).  Callers can still override.
  const resolvedEditing = editing ?? ctx != null;
  const effectiveHidden = ctx
    ? ctx.effectiveHidden(componentKey)
    : visibility
      ? visibility.entries[componentKey] === true ||
        isAncestorHidden(componentKey, visibility.entries)
      : false;

  // Non-editing + effectively hidden → omit the card entirely.
  if (!resolvedEditing && effectiveHidden) return null;

  // VIS-5C — zero-DOM-impact decoration.  The child must be a single
  // valid React element whose root receives the data attributes +
  // the opacity style.  No new wrapper div is rendered, so the
  // child remains the direct child of its grid/flex parent and the
  // pre-VIS-5B layout geometry is preserved exactly.
  const only = Children.only(children);
  if (!isValidElement(only)) return <>{children}</>;
  const child = only as ReactElement<{
    style?: CSSProperties;
    className?: string;
    "data-component-key"?: string;
    "data-card-hidden"?: string;
    "data-testid"?: string;
  }>;

  const mergedStyle: CSSProperties = {
    ...(child.props.style ?? {}),
    opacity:
      resolvedEditing && effectiveHidden ? 0.55 : child.props.style?.opacity ?? 1,
    transition: child.props.style?.transition ?? "opacity 150ms linear",
  };

  // Preserve any pre-existing data-testid; only add our testid when
  // the child doesn't already carry one.
  const extraTestId = child.props["data-testid"]
    ? {}
    : { "data-testid": `card-visibility-wrap-${componentKey}` };

  return cloneElement(child, {
    style: mergedStyle,
    "data-component-key": componentKey,
    "data-card-hidden": effectiveHidden ? "true" : "false",
    ...extraTestId,
  });
}
