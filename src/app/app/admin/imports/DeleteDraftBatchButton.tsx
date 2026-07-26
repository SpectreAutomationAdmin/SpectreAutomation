"use client";

// Delete-batch button for the Batches table on /app/admin/imports.
//
// Founder rule 2026-07-12: only COMMITTED batches are protected
// from deletion. Every other status (DRAFT, VALIDATED, FAILED,
// ARCHIVED, …) is deletable. The legacy "DRAFT-only" name on
// this file is preserved to avoid churn at the call sites; the
// behaviour is now full-lifecycle.
//
// Renders a real confirmation modal with the founder's exact
// copy. When the batch is ARCHIVED, the modal also surfaces the
// "already overridden by a newer Chart of Accounts import" line
// so the operator understands why it's still listed.

import { useState, useTransition } from "react";

import { deleteDraftBatchAction } from "./_actions";

type Props = {
  batchId: string;
  domain: string;
  /** Used to render the archive-specific helper line in the modal
   *  body. Falls back to "" if the caller doesn't pass it (older
   *  call sites). */
  status?: string;
};

export function DeleteDraftBatchButton({ batchId, domain, status }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const isArchived = status === "ARCHIVED" || status === "SUPERSEDED";

  function handleConfirm() {
    startTransition(() => {
      void deleteDraftBatchAction(batchId);
      setOpen(false);
    });
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        disabled={isPending}
        className="text-xs text-red-700 hover:underline disabled:opacity-60"
        data-testid={`delete-draft-batch-${batchId}`}
      >
        {isPending ? "Deleting…" : "Delete"}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4 py-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby={`delete-batch-title-${batchId}`}
          data-testid={`delete-batch-modal-${batchId}`}
        >
          <div className="card max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
            <h2
              id={`delete-batch-title-${batchId}`}
              className="text-lg font-semibold text-club-ink"
              data-testid={`delete-batch-modal-title-${batchId}`}
            >
              Delete import batch?
            </h2>
            <p className="mt-3 text-sm text-stone-700">
              This will permanently delete this import batch and its staged
              rows. This cannot be undone.
            </p>
            {isArchived && (
              <p
                className="mt-2 text-sm text-stone-700"
                data-testid={`delete-batch-archived-hint-${batchId}`}
              >
                This batch has already been overridden by a newer Chart of
                Accounts import.
              </p>
            )}
            <p className="mt-3 text-xs text-stone-500">
              Domain: <span className="font-mono">{domain}</span>
              {status ? (
                <>
                  {" "}· Status: <span className="font-mono">{status}</span>
                </>
              ) : null}
            </p>

            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setOpen(false)}
                disabled={isPending}
                data-testid={`delete-batch-modal-cancel-${batchId}`}
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={handleConfirm}
                disabled={isPending}
                data-testid={`delete-batch-modal-confirm-${batchId}`}
              >
                {isPending ? "Deleting…" : "Delete batch"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
