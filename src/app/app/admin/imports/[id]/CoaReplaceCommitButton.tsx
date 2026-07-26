"use client";

// COA replace-on-commit confirmation modal.
//
// Founder rule 2026-07-07: a COA commit REPLACES the club's
// existing active Chart of Accounts. We never run the
// destructive write without an explicit, in-modal "Replace Chart
// of Accounts" click.
//
// The page passes a `plan` describing the impact (how many
// existing accounts, how many will be replaced, how many will be
// soft-deactivated). If `plan.requiresConfirmation` is false
// (club has no existing active COA), this component renders a
// plain Commit button that posts the form straight through.
//
// The server action receives the existing `commitAction` bound
// to the batch id; we POST it with `confirmReplaceCoa=on` only
// after the modal is confirmed.

import { useRef, useState, useTransition } from "react";

type CoaReplacementPlanProps = {
  existingActiveCount: number;
  matchingImportCount: number;
  deactivateCount: number;
  importedRowCount: number;
  requiresConfirmation: boolean;
};

type Props = {
  /** Server action bound to the batch id by the page. Receives
   *  FormData and must perform the actual commit. */
  commitAction: (formData: FormData) => Promise<void> | void;
  /** Impact summary from `planCoaReplacement` on the server. */
  plan: CoaReplacementPlanProps;
};

// Founder rule 2026-07-20: this button only renders for COA
// batches whose lifecycle state is VALIDATED_CLEAN (zero
// errors + dryRunAt set). The page won't mount us when errors
// exist, so the "Commit anyway" / "allow partial commit"
// affordances that used to live here are GONE — a COA import
// replaces the active Chart of Accounts and partial-invalid
// commits would create reporting risk.
export function CoaReplaceCommitButton({ commitAction, plan }: Props) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const dialogRef = useRef<HTMLDivElement | null>(null);

  function submitWithConfirmation() {
    const fd = new FormData();
    fd.set("confirmReplaceCoa", "on");
    startTransition(async () => {
      await commitAction(fd);
      setOpen(false);
    });
  }

  // No existing COA → render a plain commit form, no modal needed.
  if (!plan.requiresConfirmation) {
    return (
      <form action={commitAction} className="flex items-center gap-2">
        <button
          type="submit"
          className="btn btn-primary"
          data-testid="coa-commit-direct"
        >
          Complete import
        </button>
      </form>
    );
  }

  return (
    <>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() => setOpen(true)}
        data-testid="coa-commit-open-modal"
      >
        Complete import
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4 py-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="coa-replace-title"
          data-testid="coa-replace-modal"
        >
          <div
            ref={dialogRef}
            className="card max-w-lg w-full p-6"
            onClick={(e) => e.stopPropagation()}
          >
            <h2
              id="coa-replace-title"
              className="text-lg font-semibold text-club-ink"
              data-testid="coa-replace-modal-title"
            >
              Replace existing Chart of Accounts?
            </h2>
            <p className="mt-3 text-sm text-stone-700">
              This import will replace the current Chart of Accounts for this
              club. Existing account mappings that are not included in this
              import will be removed or deactivated. This may affect financial
              reporting, imports, and historical account mappings. Do you want
              to continue?
            </p>

            <dl
              className="mt-4 grid grid-cols-2 gap-x-6 gap-y-2 rounded-md border border-stone-200 bg-stone-50 p-3 text-xs"
              data-testid="coa-replace-modal-impact"
            >
              <div>
                <dt className="text-stone-500">Current active accounts</dt>
                <dd className="font-mono text-stone-800" data-testid="coa-replace-existing">
                  {plan.existingActiveCount}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Accounts in this import</dt>
                <dd className="font-mono text-stone-800" data-testid="coa-replace-imported">
                  {plan.importedRowCount}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Updated (matched by number)</dt>
                <dd className="font-mono text-stone-800" data-testid="coa-replace-matching">
                  {plan.matchingImportCount}
                </dd>
              </div>
              <div>
                <dt className="text-stone-500">Soft-deactivated</dt>
                <dd className="font-mono text-stone-800" data-testid="coa-replace-deactivate">
                  {plan.deactivateCount}
                </dd>
              </div>
            </dl>

            <div className="mt-6 flex items-center justify-end gap-2">
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => setOpen(false)}
                disabled={isPending}
                data-testid="coa-replace-modal-cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={submitWithConfirmation}
                disabled={isPending}
                data-testid="coa-replace-modal-confirm"
              >
                {isPending ? "Replacing…" : "Replace Chart of Accounts"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
