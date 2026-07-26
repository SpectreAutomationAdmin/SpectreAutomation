"use client";

// Row-level interactive actions on the Monthly Package archive table.
//
// Two confirm-gated actions:
//   • Re-send / notify Board — shown for PUBLISHED or SENT only.
//   • Delete — shown for DRAFT only.
//
// Both wrap `window.confirm()` around the corresponding server action
// — same pattern the imports surface uses (DeleteDraftBatchButton).
// "View package" and "View recipient list" are plain Next.js <Link>s
// rendered by the page (no JS needed) so they're not in this file.

import { useTransition } from "react";

import {
  deleteDraftMonthlyPackageAction,
  resendMonthlyPackageAction,
} from "./_actions";

type Props = {
  packageId: string;
  status: string;
  title: string;
};

export function ArchiveRowActions({ packageId, status, title }: Props) {
  const [isPending, startTransition] = useTransition();

  function handleResend() {
    if (
      !window.confirm(
        `Re-send the ${title} package to the entire recipient list? Each recipient will receive a fresh delivery.`,
      )
    ) {
      return;
    }
    startTransition(() => {
      void resendMonthlyPackageAction(packageId);
    });
  }

  function handleDelete() {
    if (
      !window.confirm(
        `Delete the DRAFT ${title} package? Drafts can be deleted; published or sent packages cannot. This cannot be undone.`,
      )
    ) {
      return;
    }
    startTransition(() => {
      void deleteDraftMonthlyPackageAction(packageId);
    });
  }

  return (
    <span className="inline-flex items-center gap-3" data-testid={`archive-row-actions-${packageId}`}>
      {(status === "PUBLISHED" || status === "SENT") && (
        <button
          type="button"
          onClick={handleResend}
          disabled={isPending}
          className="text-xs text-club-ink hover:underline disabled:opacity-60"
          data-testid={`archive-resend-${packageId}`}
        >
          {isPending ? "Working…" : "Re-send"}
        </button>
      )}
      {status === "DRAFT" && (
        <button
          type="button"
          onClick={handleDelete}
          disabled={isPending}
          className="text-xs text-red-700 hover:underline disabled:opacity-60"
          data-testid={`archive-delete-${packageId}`}
        >
          {isPending ? "Deleting…" : "Delete"}
        </button>
      )}
    </span>
  );
}
