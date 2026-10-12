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
  /** When true (default), the wrapper renders a floating toggle
   *  overlay in the top-right of the card.  When false, the
   *  wrapper only applies the hidden/opacity/render-decision logic
   *  and the caller is responsible for mounting its own toggle in
   *  the card header (e.g. the Stewardship Scorecard renders its
   *  toggle inline in the dark-green header band). */
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
  renderInlineToggle = true,
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
      {editing && period && renderInlineToggle && (
        <div
          data-testid={`card-visibility-overlay-${componentKey}`}
          className="mb-2 inline-flex max-w-full flex-wrap items-center gap-1.5 rounded border border-club-sand bg-club-cream/90 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-club-green-900"
        >
          <span className="font-mono text-club-gold">Card</span>
          <span className="opacity-60" aria-hidden="true">·</span>
          <span className="truncate">{cardLabel}</span>
          <span className="opacity-60" aria-hidden="true">·</span>
          <span className="font-semibold">
            {explicitHidden ? "Hidden" : "Visible"}
          </span>
          <VisibilityToggle
            reportingYear={period.reportingYear}
            reportingMonth={period.reportingMonth}
            componentKey={componentKey}
            hidden={explicitHidden}
            publishedHidden={publishedHidden}
            size="sm"
            label={`${explicitHidden ? "Show" : "Hide"} ${cardLabel} in published report`}
          />
        </div>
      )}
      {children}
    </div>
  );
}
