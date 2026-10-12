"use client";

// MBR-VIS-5A (2026-10-11) — Inline chapter visibility toggle.
//
// Replaces the pill-bordered "CHAPTER X · TITLE · VISIBLE" chip
// that MBR-VIS-5 placed above each chapter.  Renders INLINE,
// immediately after the panel's h2 title, as:
//
//   Statement of Financial Position [eye] VISIBLE
//
// Design:
//   • No chip background, no border, no pill.  The control inherits
//     the surrounding typography and sits in normal flow.
//   • Eye icon + small-caps VISIBLE/HIDDEN status label, both
//     clickable and labelled for a11y.
//   • Vertically aligned with the title via `align-middle` /
//     `inline-flex`.
//   • Renders nothing when `editing` is false or `period` is
//     missing — the Draft Preview / Published State / Board / PDF
//     surfaces stay chrome-free.
//
// Each of the 13 toggleable chapters renders this component inside
// its own h2 title, so the eye appears beside the actual chapter
// title (not above it as a leading chip).

import { VisibilityToggle } from "./VisibilityToggle";
import { useVisibilityState } from "./VisibilityState";

export type InlineChapterToggleProps = {
  anchorId: string;
  chapterLabel: string;
};

export function InlineChapterToggle({
  anchorId,
  chapterLabel,
}: InlineChapterToggleProps) {
  // Self-detects editing + period from the shared VisibilityState
  // context — zero-prop integration so panel h2s only pass identity.
  // Returns null outside a Provider (non-editing surfaces: Draft
  // Preview, Published State, Board, PDF).
  const ctx = useVisibilityState();
  if (!ctx || !ctx.period) return null;
  const componentKey = `chapter:${anchorId}`;
  const explicitHidden = ctx.explicitHidden(componentKey);
  return (
    <span
      data-testid={`inline-chapter-toggle-${anchorId}`}
      data-component-key={componentKey}
      className="ml-3 inline-flex items-center gap-1.5 align-middle text-[10px] uppercase tracking-[0.14em] text-club-green-800/75"
    >
      <VisibilityToggle
        reportingYear={ctx.period.reportingYear}
        reportingMonth={ctx.period.reportingMonth}
        componentKey={componentKey}
        hidden={explicitHidden}
        size="sm"
        label={`${explicitHidden ? "Show" : "Hide"} chapter ${chapterLabel} in published report`}
      />
      <span className={explicitHidden ? "text-club-green-800/60" : "text-club-gold"}>
        {explicitHidden ? "Hidden" : "Visible"}
      </span>
    </span>
  );
}
