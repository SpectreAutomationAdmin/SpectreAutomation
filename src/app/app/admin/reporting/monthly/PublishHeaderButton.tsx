"use client";

// Publish state indicator — rendered INSIDE the existing dark green
// ReportingShell header via React Portal. Renders nothing at the
// natural DOM position; uses a stable slot in the shell header.
//
// MODES (controller-facing only — Board users never reach this
// component because the report page itself is admin-shelled):
//
//   DRAFT
//     → "Publish" button. Click captures the snapshot for the first
//       time, populates recipients, and either becomes the new Live
//       Package (if it's the newest period) or stays as a historical
//       Archived row (if a newer Live already exists for this club).
//       No overwrite dialog — there's no prior snapshot to replace.
//
//   PUBLISHED + live hash MATCHES the stored publishedPayloadHash
//     → "Published" pill (informational, non-interactive). Signals
//       "this is the version currently live to the Board." Stays
//       visible after publishing.
//
//   PUBLISHED + live hash DIFFERS from the stored hash
//     → "Overwrite Package" button. Click opens the founder-spec
//       overwrite-confirmation dialog. Overwriting the current Live
//       row keeps it Live and refreshes the snapshot in place.
//
//   ARCHIVED
//     → "Overwrite Package" button. The controller is on a
//       historical period (e.g. correcting an error in last month's
//       May package while June is Live). Click opens the overwrite
//       dialog. Overwriting an archived row keeps it Archived; the
//       Board dashboard does NOT regress.
//
//   SENT (legacy)
//     → Same as PUBLISHED. SENT is a pre-migration alias.

import { useEffect, useState, useTransition } from "react";
import { createPortal } from "react-dom";

import { publishMonthlyPackageAction } from "./_lifecycle-actions";

type Props = {
  packageId: string;
  /** "YYYY-MM" — the server action redirects back to this period. */
  period: string;
  /** Current status of the package row passed by the page. */
  status: string;
  /** Display label used in the confirm dialog (the package title,
   *  e.g. "May 2026 Monthly Reporting Package"). */
  title: string;
  /** Human-readable period label ("May 2026") used in the founder-
   *  spec overwrite-confirmation dialog body. */
  periodLabel: string;
  /** True when the live at-a-glance KPIs differ from the snapshot
   *  stored at publish — drives the PUBLISHED → "Overwrite Package"
   *  switch. Ignored for non-PUBLISHED statuses. */
  hasUnpublishedEdits?: boolean;
  /** True when this row IS the club's current Live Package.
   *  Drives the overwrite dialog's "this will change what the
   *  Board reads" vs "this will NOT change what the Board reads"
   *  guidance. */
  isCurrentLive?: boolean;
};

const SLOT_ID = "reporting-shell-header-action-slot";

// Shared header-chip baseline (matches the period chip / Print Mode
// toggle visually). Mode-specific colour tweaks are layered on top.
const BASE_CHIP =
  "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-3.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] transition focus:outline-none focus:ring-2 focus:ring-club-gold/50";

const STYLE_ACTION_PRIMARY =
  // Solid call-to-action — used by DRAFT "Publish" and
  // "Overwrite Package". Same dark band, more saturated gold to
  // draw the eye.
  "border-club-gold/70 bg-club-gold/15 text-club-gold hover:bg-club-gold/25";

const STYLE_INFORMATIONAL_LIVE =
  // Quiet informational tone for "Published" — present but not
  // calling for action. Mirrors the period chip's restraint.
  "border-club-gold/45 bg-club-green-900/40 text-club-cream";

export function PublishHeaderButton({
  packageId,
  period,
  status,
  title,
  periodLabel,
  hasUnpublishedEdits = false,
  isCurrentLive = false,
}: Props) {
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  const [isPending, startTransition] = useTransition();
  const [overwriteOpen, setOverwriteOpen] = useState(false);

  useEffect(() => {
    setSlot(document.getElementById(SLOT_ID));
  }, []);

  if (!slot) return null;

  const runPublish = () => {
    startTransition(() => {
      void publishMonthlyPackageAction(packageId, period);
    });
  };

  // Founder-spec overwrite confirmation. Single dialog covers
  // every overwrite case — the "unless [period] is already the
  // current live package" clause lets the same copy be honest
  // whether the controller is overwriting the LIVE row or an
  // older archived row.
  const overwriteDialog = overwriteOpen ? (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="overwrite-pkg-title"
      aria-describedby="overwrite-pkg-body"
      data-testid="overwrite-confirm-dialog"
      className="fixed inset-0 z-[120] flex items-center justify-center bg-club-ink/55 px-4"
    >
      <div className="w-full max-w-md rounded-xl border border-club-sand bg-white shadow-xl">
        <div className="border-b border-club-sand/70 px-6 py-4">
          <h2
            id="overwrite-pkg-title"
            className="font-serif text-lg text-club-ink"
          >
            Overwrite existing package?
          </h2>
        </div>
        <div
          id="overwrite-pkg-body"
          className="space-y-3 px-6 py-5 text-sm text-stone-700"
        >
          <p>{`A Monthly Reporting Package already exists for ${periodLabel}.`}</p>
          <p>{`Publishing this version will replace the existing package for ${periodLabel}.`}</p>
          <p>{`This will not change the Monthly Reporting Package currently displayed on Board member dashboards unless ${periodLabel} is already the current live package.`}</p>
          <p className="text-stone-500">This action cannot be undone.</p>
        </div>
        <div className="flex justify-end gap-2 border-t border-club-sand/70 px-6 py-3">
          <button
            type="button"
            onClick={() => setOverwriteOpen(false)}
            disabled={isPending}
            data-testid="overwrite-cancel-btn"
            className="rounded-md border border-stone-300 px-3 py-1.5 text-xs text-stone-700 hover:bg-stone-50 disabled:opacity-60"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              setOverwriteOpen(false);
              runPublish();
            }}
            disabled={isPending}
            data-testid="overwrite-confirm-btn"
            className="rounded-md border border-club-green-700 bg-club-green-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-club-green-800 disabled:opacity-60"
            aria-busy={isPending || undefined}
          >
            {isPending ? "Overwriting…" : "Overwrite Package"}
          </button>
        </div>
      </div>
    </div>
  ) : null;

  // ── Build the rendered indicator based on status + edits flag.
  // ──────────────────────────────────────────────────────────────
  let content: React.ReactNode = null;

  if (status === "DRAFT") {
    content = (
      <button
        type="button"
        onClick={() => {
          if (
            !window.confirm(
              `Publish ${title}? The snapshot will be captured and the package will become available to every Board member at this club. This action does not send email.`,
            )
          ) {
            return;
          }
          runPublish();
        }}
        disabled={isPending}
        data-testid="reporting-header-publish-btn"
        data-mode="publish"
        className={`${BASE_CHIP} ${STYLE_ACTION_PRIMARY} disabled:opacity-60`}
        aria-busy={isPending || undefined}
        title="Publish this Monthly Reporting Package"
      >
        {isPending ? "Publishing…" : "Publish"}
      </button>
    );
  } else if (status === "PUBLISHED" || status === "SENT") {
    if (hasUnpublishedEdits) {
      content = (
        <button
          type="button"
          onClick={() => setOverwriteOpen(true)}
          disabled={isPending}
          data-testid="reporting-header-publish-btn"
          data-mode="overwrite-published"
          data-is-current-live={isCurrentLive ? "true" : "false"}
          className={`${BASE_CHIP} ${STYLE_ACTION_PRIMARY} disabled:opacity-60`}
          aria-busy={isPending || undefined}
          title="Overwrite the snapshot for this reporting period"
        >
          {isPending ? "Overwriting…" : "Overwrite Package"}
        </button>
      );
    } else {
      content = (
        <span
          data-testid="reporting-header-publish-btn"
          data-mode="published"
          className={`${BASE_CHIP} ${STYLE_INFORMATIONAL_LIVE} cursor-default`}
          role="status"
          aria-label="This is the version currently live to the Board"
          title="This is the version currently live to the Board"
        >
          Published
        </span>
      );
    }
  } else if (status === "ARCHIVED") {
    // Archived rows always offer Overwrite — that's the founder's
    // "Controller regenerates May and clicks Publish" path. The
    // dialog explains that the Board dashboard will NOT regress.
    content = (
      <button
        type="button"
        onClick={() => setOverwriteOpen(true)}
        disabled={isPending}
        data-testid="reporting-header-publish-btn"
        data-mode="overwrite-archived"
        data-is-current-live="false"
        className={`${BASE_CHIP} ${STYLE_ACTION_PRIMARY} disabled:opacity-60`}
        aria-busy={isPending || undefined}
        title="Overwrite this historical reporting period (the live Board package will not change)"
      >
        {isPending ? "Overwriting…" : "Overwrite Package"}
      </button>
    );
  }

  if (!content) return null;
  return createPortal(
    <>
      {content}
      {overwriteDialog}
    </>,
    slot,
  );
}
