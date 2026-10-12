"use client";

// MBR-VIS-5 (2026-10-11) — Reusable card-level visibility wrapper.
//
// Wraps any independently rendered report component (card, panel,
// chart container, scorecard, commentary block) with a card-level
// visibility toggle and the explicit-vs-effective render rules
// shared across chapter, card, and row tiers:
//
//   • Editing + any state → always rendered.  Children shown at
//     reduced opacity (0.55) when effectively hidden so the
//     Controller can see what's being suppressed and click the
//     toggle to restore it.
//   • Non-editing + effectively hidden → returns null.  Draft
//     Preview, Published State, and PDF omit the whole card
//     (no blank frame, no reserved column, no orphan heading).
//   • Non-editing + visible → renders children unchanged.
//
// The visibility toggle is rendered via a floating overlay
// positioned at the TOP-RIGHT of the card (absolute relative to
// the wrapper's `position: relative`), small enough to sit over a
// dark-green card header without displacing its content.  For
// cards that want the toggle inline in their own header (e.g. the
// Stewardship Scorecard which already renders a dark-green header
// band and prefers to flex-align the toggle inside), use
// `renderInlineToggle={false}` and mount the toggle in the card's
// own header via <VisibilityToggle> directly.

import type { ReactNode } from "react";
import type { MonthlyBodyVisibilityConfig } from "@/app/app/admin/reporting/monthly/visibility-types";
import { VisibilityToggle } from "./VisibilityToggle";
import { useVisibilityState } from "./VisibilityState";

export type CardVisibilityWrapperProps = {
  /** Full componentKey — "card:<chapter-anchor>:<card-key>". */
  componentKey: string;
  /** Human-readable card label, used in the a11y toggle label. */
  cardLabel: string;
  editing: boolean;
  period?: { reportingYear: number; reportingMonth: number };
  visibility?: MonthlyBodyVisibilityConfig;
  publishedVisibility?: MonthlyBodyVisibilityConfig;
  /** MBR-VIS-5A — defaults to FALSE.  The chip overlay was retired;
   *  component toggles now live inside each sub-card's own title
   *  via <InlineCardToggle>.  Set to true only if a caller needs
   *  the legacy icon overlay (used nowhere in-tree today). */
  renderInlineToggle?: boolean;
  /** Optional class name applied to the wrapper div. */
  className?: string;
  children: ReactNode;
};

function pendingPublishState(
  componentKey: string,
  draft?: MonthlyBodyVisibilityConfig,
  published?: MonthlyBodyVisibilityConfig,
): boolean | undefined {
  if (!draft || !published) return undefined;
  return published.entries[componentKey] ?? false;
}

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
  cardLabel,
  editing,
  period,
  visibility,
  publishedVisibility,
  renderInlineToggle = false,
  className,
  children,
}: CardVisibilityWrapperProps) {
  const ctx = useVisibilityState();
  const explicitHidden = ctx
    ? ctx.explicitHidden(componentKey)
    : visibility?.entries[componentKey] === true;
  const effectiveHidden = ctx
    ? ctx.effectiveHidden(componentKey)
    : visibility
      ? visibility.entries[componentKey] === true ||
        isAncestorHidden(componentKey, visibility.entries)
      : false;
  const publishedHidden = pendingPublishState(
    componentKey,
    visibility,
    publishedVisibility,
  );

  // Non-editing + effectively hidden → omit entirely.
  if (!editing && effectiveHidden) return null;

  const wrapperClass =
    "relative" + (className ? ` ${className}` : "");

  return (
    <div
      data-testid={`card-visibility-wrap-${componentKey}`}
      data-component-key={componentKey}
      data-card-hidden={effectiveHidden ? "true" : "false"}
      className={wrapperClass}
      style={{
        opacity: editing && effectiveHidden ? 0.55 : 1,
        transition: "opacity 150ms linear",
      }}
    >
      {/* MBR-VIS-5A — visible chrome retired.  Component visibility
          toggles are now rendered INLINE inside each sub-card's own
          title via <InlineCardToggle> (icon only, no chip).  The
          wrapper still owns the cascade/opacity/hidden-state render
          decision, so the frozen snapshot + draft/published parity
          continue to resolve through the single `MonthlyPackageVisibility`
          source.  `renderInlineToggle` is retained for callers that
          need it; defaults to false (no visible overlay).
          Suppresses the redundant control on single-component
          chapters per the directive — the chapter toggle on the
          panel's h2 is the only visible control. */}
      {editing && period && renderInlineToggle && (
        <span
          data-testid={`card-visibility-overlay-${componentKey}`}
          className="ml-2 inline-flex items-center align-middle"
        >
          <VisibilityToggle
            reportingYear={period.reportingYear}
            reportingMonth={period.reportingMonth}
            componentKey={componentKey}
            hidden={explicitHidden}
            publishedHidden={publishedHidden}
            size="sm"
            label={`${explicitHidden ? "Show" : "Hide"} ${cardLabel} in published report`}
          />
        </span>
      )}
      {children}
    </div>
  );
}
