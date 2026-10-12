"use client";

// MBR-VIS-4A (2026-10-11) — Publication status chip.
//
// Portals a compact "DRAFT · Not yet published" (or "UNPUBLISHED
// CHANGES" / "PUBLISHED") status indicator + a "Review Draft Preview"
// gold link into the ReportingShell masthead, next to the Publish /
// Download Draft PDF controls.
//
// Replaces the pale-yellow full-width banner that previously sat
// below the shell chrome.  Keeps every control inside the single
// dark-green masthead, matching the approved Spectre executive-
// reporting chrome.
//
// Only visible in Editing mode on an admin surface.  Preview-mode
// surfaces (?preview=draft / ?preview=published) continue to use
// the existing full-width PublicationStateBanner so navigation back
// to Editing stays obvious — but on Editing itself, this chip is
// deliberately compact.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";

export type PublicationStatusChipTone = "draft" | "pending" | "published";

export type PublicationStatusChipProps = {
  /** Short upper-case label — the state identifier. */
  label: string;
  /** Longer secondary line of context — rendered as a muted suffix. */
  detail: string;
  /** Drives the subtle colour variation.  All three tones use the
   *  gold accent — the distinction is in the label text. */
  tone: PublicationStatusChipTone;
  /** The Draft Preview URL for the current period. */
  reviewDraftHref: string;
  /** The Published State URL — only rendered when a published
   *  snapshot exists for the period. */
  publishedStateHref?: string;
};

const SLOT_ID = "reporting-shell-header-status-slot";

// Shared with PublishHeaderButton — exact same pill dimensions +
// letter-spacing.  The optical-centering fix (`justify-center` +
// `[text-indent:0.18em]`) applies to every pill in the masthead.
const CHIP_BASE =
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap " +
  "rounded-full border px-3.5 py-0.5 font-mono text-[10px] uppercase " +
  "tracking-[0.18em] [text-indent:0.18em] transition";

const CHIP_STYLE_BY_TONE: Record<PublicationStatusChipTone, string> = {
  // All three tones share the quiet gold informational treatment
  // from PublishHeaderButton's `STYLE_INFORMATIONAL_LIVE`.  The
  // chip is informational — the Publish button next to it is the
  // one that CTAs.
  draft:
    "border-club-gold/45 bg-club-green-900/40 text-club-cream",
  pending:
    "border-club-gold/45 bg-club-green-900/40 text-club-cream",
  published:
    "border-club-gold/45 bg-club-green-900/40 text-club-cream",
};

export function PublicationStatusChip({
  label,
  detail,
  tone,
  reviewDraftHref,
  publishedStateHref,
}: PublicationStatusChipProps) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setSlot(document.getElementById(SLOT_ID));
  }, []);

  if (!slot) return null;

  return createPortal(
    <>
      <span
        data-testid="publication-status-chip"
        data-tone={tone}
        role="status"
        aria-label={`${label} — ${detail}`}
        title={detail}
        className={`${CHIP_BASE} ${CHIP_STYLE_BY_TONE[tone]} cursor-default`}
      >
        <span className="font-semibold">{label}</span>
        <span
          aria-hidden="true"
          className="text-club-gold/60"
        >
          ·
        </span>
        <span className="text-club-cream/70 normal-case tracking-normal [text-indent:0]">
          {detail}
        </span>
      </span>
      <Link
        href={reviewDraftHref}
        data-testid="publication-status-review-draft-link"
        className={
          "inline-flex items-center whitespace-nowrap font-mono text-[10px] uppercase " +
          "tracking-[0.18em] text-club-gold transition hover:text-club-cream " +
          "focus:outline-none focus:ring-2 focus:ring-club-gold/50 rounded-sm px-1"
        }
      >
        Review Draft Preview
      </Link>
      {publishedStateHref && (
        <Link
          href={publishedStateHref}
          data-testid="publication-status-published-state-link"
          className={
            "inline-flex items-center whitespace-nowrap font-mono text-[10px] uppercase " +
            "tracking-[0.18em] text-club-cream/70 transition hover:text-club-gold " +
            "focus:outline-none focus:ring-2 focus:ring-club-gold/50 rounded-sm px-1"
          }
        >
          View Published
        </Link>
      )}
    </>,
    slot,
  );
}
