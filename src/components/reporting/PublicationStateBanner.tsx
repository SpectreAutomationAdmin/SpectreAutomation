"use client";

// MBR-VIS-1 (2026-10-11) — Publication state banner.
//
// Pinned top banner shown ABOVE the report body in the two non-
// editing admin surfaces:
//
//   • "DRAFT PREVIEW" (dark amber) — the Controller is previewing
//     the body as the Board WOULD see it if they re-published now.
//     Shows the count of pending visibility edits since the last
//     publish so the Controller knows how many toggles will land
//     on republish.
//
//   • "PUBLISHED STATE" (cream) — the Controller is viewing the
//     frozen snapshot that currently appears on the Board + PDF.
//     Shows the publish timestamp + the user who last published
//     so the Controller can confirm what the Board sees RIGHT NOW
//     (independent of any pending draft edits).
//
// Both banners are read-only overlays — no toggles, no mutations.

import Link from "next/link";

export type PublicationStateBannerProps = {
  mode: "draft" | "published";
  /** Pending visibility edits since the last publish — rendered in
   *  the DRAFT PREVIEW variant. */
  pendingCount?: number;
  /** Previously-published metadata — rendered in the PUBLISHED
   *  STATE variant. */
  publishedAt?: Date | null;
  publishedByName?: string | null;
  /** Query strings to anchor the "back to editing" / "view live"
   *  links to the current period. Caller composes these. */
  editingHref: string;
  oppositeHref: string;
  /** MBR-VIS-4 — direct `/api/reporting/monthly/pdf` URL for the
   *  download affordance built into the banner.  Draft banner
   *  receives the mode=draft URL; Published banner receives the
   *  mode=published URL.  Omitting it hides the download link
   *  (used in Published State when no snapshot exists yet). */
  downloadPdfHref?: string;
};

function formatPublished(date: Date | null | undefined): string {
  if (!date) return "never published";
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return "never published";
  return d.toLocaleString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

export function PublicationStateBanner({
  mode,
  pendingCount,
  publishedAt,
  publishedByName,
  editingHref,
  oppositeHref,
  downloadPdfHref,
}: PublicationStateBannerProps) {
  if (mode === "draft") {
    const n = pendingCount ?? 0;
    return (
      <div
        data-testid="publication-state-banner-draft"
        role="status"
        className="sticky top-0 z-40 border-b border-amber-700/40 bg-amber-800 text-amber-50"
        style={{ padding: "8px 18px" }}
      >
        <div className="flex items-center justify-between gap-3 text-xs uppercase tracking-wider">
          <div>
            <strong className="font-semibold">Draft Preview</strong>
            <span className="mx-2 opacity-70">·</span>
            <span>
              {n === 0
                ? "No pending visibility edits — matches Published State"
                : `${n} pending visibility edit${n === 1 ? "" : "s"} not yet published`}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {downloadPdfHref && (
              <a
                href={downloadPdfHref}
                className="underline hover:no-underline"
                data-testid="publication-state-draft-download-pdf"
              >
                Download Draft PDF
              </a>
            )}
            <Link
              href={editingHref}
              className="underline hover:no-underline"
              data-testid="publication-state-draft-to-editing"
            >
              Back to editing
            </Link>
            <Link
              href={oppositeHref}
              className="underline hover:no-underline"
              data-testid="publication-state-draft-to-published"
            >
              View currently published
            </Link>
          </div>
        </div>
      </div>
    );
  }
  return (
    <div
      data-testid="publication-state-banner-published"
      role="status"
      className="sticky top-0 z-40 border-b border-club-sand bg-club-cream text-club-green-900"
      style={{ padding: "8px 18px" }}
    >
      <div className="flex items-center justify-between gap-3 text-xs uppercase tracking-wider">
        <div>
          <strong className="font-semibold">Published State</strong>
          <span className="mx-2 opacity-70">·</span>
          <span>
            Matches what the Board sees · last published{" "}
            {formatPublished(publishedAt)}
            {publishedByName ? ` by ${publishedByName}` : ""}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {downloadPdfHref && (
            <a
              href={downloadPdfHref}
              className="underline hover:no-underline"
              data-testid="publication-state-published-download-pdf"
            >
              Download Published PDF
            </a>
          )}
          <Link
            href={editingHref}
            className="underline hover:no-underline"
            data-testid="publication-state-published-to-editing"
          >
            Back to editing
          </Link>
          <Link
            href={oppositeHref}
            className="underline hover:no-underline"
            data-testid="publication-state-published-to-draft"
          >
            View draft preview
          </Link>
        </div>
      </div>
    </div>
  );
}
