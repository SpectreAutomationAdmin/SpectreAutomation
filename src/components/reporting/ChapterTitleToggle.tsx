"use client";

// MBR-VIS-5 (2026-10-11) — Chapter visibility toggle rendered inline
// at the TOP of the chapter section, immediately above the chapter
// heading.  Replaces the previous absolute-positioned chip at
// `top: 4, right: 4` that collided with chapter header elements
// (e.g. Statement of Activities' right-side "Statement No. IV" +
// "Two-Fund Format" document chip).
//
// Design:
//   • No absolute positioning — the toggle lives in normal flow
//     at the top of the chapter and wraps gracefully on narrow
//     viewports.
//   • Chip reads "CHAPTER <N> · Visible/Hidden" with a visibility
//     eye icon button inline.
//   • Aligned LEFT so it sits above the chapter title's natural
//     start column — the eye icon is "immediately beside" the
//     heading in the reading order.
//   • Rendered only when `editing === true` and a period is
//     supplied; otherwise returns null.
//
// Reused across every ChapterSection — one shared pattern, 14
// chapters, zero per-chapter CSS.

import type { MonthlyBodyVisibilityConfig } from "@/app/app/admin/reporting/monthly/visibility-types";
import { VisibilityToggle } from "./VisibilityToggle";
import { useVisibilityState } from "./VisibilityState";

export type ChapterTitleToggleProps = {
  anchorId: string;
  chapterNumber: string;
  chapterLabel: string;
  editing: boolean;
  period?: { reportingYear: number; reportingMonth: number };
  visibility?: MonthlyBodyVisibilityConfig;
  publishedVisibility?: MonthlyBodyVisibilityConfig;
};

function pendingPublishState(
  componentKey: string,
  draft?: MonthlyBodyVisibilityConfig,
  published?: MonthlyBodyVisibilityConfig,
): boolean | undefined {
  if (!draft || !published) return undefined;
  return published.entries[componentKey] ?? false;
}

export function ChapterTitleToggle({
  anchorId,
  chapterNumber,
  chapterLabel,
  editing,
  period,
  visibility,
  publishedVisibility,
}: ChapterTitleToggleProps) {
  const ctx = useVisibilityState();
  if (!editing || !period) return null;
  const componentKey = `chapter:${anchorId}`;
  const explicitHidden = ctx
    ? ctx.explicitHidden(componentKey)
    : visibility?.entries[componentKey] === true;
  const published = pendingPublishState(
    componentKey,
    visibility,
    publishedVisibility,
  );
  return (
    <div
      data-testid={`chapter-title-toggle-${anchorId}`}
      data-component-key={componentKey}
      className="mb-3 inline-flex max-w-full flex-wrap items-center gap-2 rounded border border-club-sand bg-club-cream/80 px-2 py-1 text-[10px] uppercase tracking-[0.1em] text-club-green-900"
    >
      <span className="font-mono text-club-gold">Chapter {chapterNumber}</span>
      <span className="opacity-60" aria-hidden="true">·</span>
      <span className="truncate" aria-label={`Chapter title: ${chapterLabel}`}>
        {chapterLabel}
      </span>
      <span className="opacity-60" aria-hidden="true">·</span>
      <span className="font-semibold">
        {explicitHidden ? "Hidden" : "Visible"}
      </span>
      <VisibilityToggle
        reportingYear={period.reportingYear}
        reportingMonth={period.reportingMonth}
        componentKey={componentKey}
        hidden={explicitHidden}
        publishedHidden={published}
        size="sm"
        label={`${explicitHidden ? "Show" : "Hide"} chapter ${chapterLabel} in published report`}
      />
    </div>
  );
}
