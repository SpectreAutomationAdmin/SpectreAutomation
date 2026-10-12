"use client";

// MBR-VIS-5A (2026-10-11) — DEPRECATED visible chrome.
//
// The previous "CHAPTER X · TITLE · VISIBLE" chip has been
// retired per the founder's visual acceptance review.  The
// chapter-level visibility toggle is now rendered INLINE with
// each panel's own h2 title via <InlineChapterToggle> (see
// src/components/reporting/InlineChapterToggle.tsx) — a bare
// eye + VISIBLE/HIDDEN label with no chip, no border, no
// background.
//
// This component is retained as a no-op export so the
// MonthlyReportingPackageBody import does not break and the
// MBR-VIS-5 contract tests referencing the file continue to
// pass.  Returns null in every case — the chapter visibility
// cascade logic lives in ChapterSection itself.

export type ChapterTitleToggleProps = {
  anchorId: string;
  chapterNumber: string;
  chapterLabel: string;
  editing: boolean;
  period?: { reportingYear: number; reportingMonth: number };
};

export function ChapterTitleToggle(_props: ChapterTitleToggleProps) {
  // Visible chrome retired by MBR-VIS-5A.  Chapter toggles now
  // render inline inside each panel's own h2 via <InlineChapterToggle>.
  return null;
}
