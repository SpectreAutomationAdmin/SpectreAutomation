import Link from "next/link";
import { redirect } from "next/navigation";
import { cookies } from "next/headers";

import { Badge } from "@/components/Badge";
import { getActiveClubId } from "@/lib/active-club";
import { formatDate } from "@/lib/finance";
import { listBatches, readTrialBalanceAsOfDate } from "@/lib/imports";
import { hasPermission } from "@/lib/rbac";
import { getCurrentPrincipal } from "@/lib/services/principal";

import { voidBatchAction } from "./_actions";
import { DeleteDraftBatchButton } from "./DeleteDraftBatchButton";
import { FlashClear } from "./FlashClear";
import { NewBatchForm } from "./NewBatchForm";

export default async function ImportsPage({
  searchParams,
}: {
  searchParams: { void?: string };
}) {
  const p = await getCurrentPrincipal();
  if (!p) redirect("/login");
  const clubId = await getActiveClubId({ clubId: p.activeClubId ?? null, role: "" });
  if (!hasPermission(p, clubId, "settings:write")) redirect("/app/admin");
  const batches = await listBatches(p, clubId);
  // v14.5 — void-confirmation modal is URL-driven (?void=<id>).
  // The batch must belong to this club (defensive check).
  const voidTarget = searchParams.void
    ? batches.find((b) => b.id === searchParams.void)
    : null;
  // Founder rule 2026-06-30 v14.4 — read-only cookie access in a
  // Server Component render. Mutation (set + delete) is prohibited
  // here — the <FlashClear/> client component below fires a POST
  // to /app/admin/imports/clear-flash on mount to remove the
  // flash cookies after the notice has been shown once.
  const error = cookies().get("spectre_import_error")?.value;
  const notice = cookies().get("spectre_import_notice")?.value;

  return (
    <div>
      {/* v14.4 — fire the cookie-clear POST after render so the
          notice/error displays exactly once. Only mounted when
          there's a flash to clear (avoids a needless fetch on
          every visit). */}
      {(error || notice) && <FlashClear />}
      <h1 className="page-title">Data imports</h1>
      <p className="mt-1 text-stone-500">
        Import members, vendors, chart of accounts, opening balances, and more.
        Every batch is validated before commit.
      </p>
      {error && (
        <div
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          role="alert"
          data-testid="new-batch-error"
        >
          {error}
        </div>
      )}
      {notice && (
        <div
          className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700"
          role="status"
          data-testid="new-batch-notice"
        >
          {notice}
        </div>
      )}

      <div className="mt-6 card card-body">
        <h2 className="section-title text-lg">New batch</h2>
        <NewBatchForm />
      </div>

      <div className="mt-6 card overflow-hidden">
        <div className="px-6 py-4 border-b border-stone-200 font-medium">
          Batches ({batches.length})
        </div>
        <table className="table-base">
          <thead>
            <tr>
              <th>Domain</th>
              <th>Status</th>
              {/* v14.5 — As-of column shows the imported Trial
                  Balance period for TB batches so a user can
                  see WHICH period each batch belongs to. Blank
                  for other domains. */}
              <th>As-of</th>
              <th>Rows</th>
              <th>Valid</th>
              <th>Errors</th>
              <th>Created</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {batches.length === 0 && (
              <tr>
                <td colSpan={8} className="px-4 py-6 text-center text-stone-500">
                  No import batches yet.
                </td>
              </tr>
            )}
            {batches.map((b) => {
              // Founder rule 2026-07-13: a DRAFT batch must not
              // imply "0 valid / 0 errors" unless validation has
              // actually run. We use `dryRunAt` as the truth
              // signal — present = a Validate pass has run since
              // the last mapping edit; null = the counts are not
              // yet meaningful, so we render an em-dash + the
              // "Not validated" hint.
              const validated = b.dryRunAt !== null;
              // v14.5 — Trial Balance lifecycle state derived
              // from the new schema fields. "Live" = COMMITTED
              // + not superseded + not voided. Only one live TB
              // batch per club is guaranteed by the commit path.
              const isTb = b.domain === "OPENING_TRIAL_BALANCE";
              const asOfDate = isTb ? readTrialBalanceAsOfDate(b.optionsJson) : null;
              const tbLifecycle: "LIVE" | "SUPERSEDED" | "VOIDED" | null =
                !isTb ? null :
                b.voidedAt ? "VOIDED" :
                b.status === "SUPERSEDED" || b.supersededAt ? "SUPERSEDED" :
                b.status === "COMMITTED" ? "LIVE" : null;
              return (
              <tr key={b.id}>
                <td className="text-xs">{b.domain}</td>
                <td>
                  <Badge status={b.status} />
                  {/* v14.5 — Trial Balance lifecycle badge in
                      addition to the base status. */}
                  {tbLifecycle && (
                    <span
                      className={
                        "ml-2 inline-block px-1.5 py-0.5 rounded text-[10px] font-medium " +
                        (tbLifecycle === "LIVE"
                          ? "bg-emerald-100 text-emerald-800 ring-1 ring-emerald-200"
                          : tbLifecycle === "SUPERSEDED"
                            ? "bg-amber-100 text-amber-800 ring-1 ring-amber-200"
                            : "bg-stone-100 text-stone-700 ring-1 ring-stone-200")
                      }
                      data-testid={`tb-lifecycle-${b.id}`}
                    >
                      {tbLifecycle === "LIVE" ? "Live" : tbLifecycle === "SUPERSEDED" ? "Superseded" : "Voided"}
                    </span>
                  )}
                  {b.status === "ARCHIVED" && b.domain === "COA" && (
                    <div
                      className="mt-1 text-[10px] text-stone-500"
                      data-testid={`batch-archived-hint-${b.id}`}
                    >
                      Overridden by newer COA import
                    </div>
                  )}
                  {!validated && b.status === "DRAFT" && (
                    <div
                      className="mt-1 text-[10px] text-stone-500"
                      data-testid={`batch-not-validated-hint-${b.id}`}
                    >
                      Not validated
                    </div>
                  )}
                </td>
                <td className="text-xs" data-testid={`batch-asof-${b.id}`}>
                  {asOfDate
                    ? asOfDate.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
                    : <span className="text-stone-400">—</span>}
                </td>
                <td className="text-xs">{b.totalRows}</td>
                <td
                  className="text-xs"
                  data-testid={`batch-valid-cell-${b.id}`}
                >
                  {validated ? b.validRows : <span className="text-stone-400">—</span>}
                </td>
                <td
                  className="text-xs"
                  data-testid={`batch-error-cell-${b.id}`}
                >
                  {validated ? b.errorRows : <span className="text-stone-400">—</span>}
                </td>
                <td className="text-xs">{formatDate(b.createdAt)}</td>
                <td className="text-right">
                  <div className="flex items-center justify-end gap-3">
                    <Link
                      href={`/app/admin/imports/${b.id}`}
                      className="text-xs text-club-ink hover:underline"
                    >
                      Open
                    </Link>
                    {/* v14.5 — action column decision tree:
                        • DRAFT / VALIDATED / FAILED       → Delete
                        • TB SUPERSEDED / VOIDED           → Delete (ledger already reversed)
                        • TB COMMITTED + LIVE              → Void (with confirmation)
                        • Other COMMITTED (COA, etc.)      → Audit-locked (unchanged) */}
                    {isTb && tbLifecycle === "LIVE" ? (
                      <Link
                        href={`/app/admin/imports?void=${b.id}`}
                        className="text-xs text-red-700 hover:underline"
                        data-testid={`void-batch-${b.id}`}
                      >
                        Void
                      </Link>
                    ) : isTb && (tbLifecycle === "SUPERSEDED" || tbLifecycle === "VOIDED") ? (
                      <DeleteDraftBatchButton
                        batchId={b.id}
                        domain={b.domain}
                        status={b.status}
                      />
                    ) : b.status === "COMMITTED" ? (
                      <span
                        className="text-xs text-stone-400"
                        title="Committed batches are retained for audit history."
                        data-testid={`delete-batch-committed-hint-${b.id}`}
                      >
                        Audit-locked
                      </span>
                    ) : (
                      <DeleteDraftBatchButton
                        batchId={b.id}
                        domain={b.domain}
                        status={b.status}
                      />
                    )}
                  </div>
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* v14.5 — void-confirmation modal. Renders as a server-
          side overlay when ?void=<batchId> is present. Two copy
          variants: "supersede the live batch" (destructive) vs
          "clean up superseded/committed" (record-keeping). */}
      {voidTarget && voidTarget.domain === "OPENING_TRIAL_BALANCE" && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4"
          data-testid="tb-void-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Void Trial Balance batch"
        >
          <div className="card w-full max-w-lg">
            <div className="flex items-center justify-between border-b border-stone-200 px-6 py-3">
              <h2 className="font-serif text-xl text-club-ink">
                Void Trial Balance batch?
              </h2>
              <Link
                href="/app/admin/imports"
                className="text-stone-500 hover:text-club-ink text-xl leading-none"
                aria-label="Close"
              >
                ×
              </Link>
            </div>
            <form action={voidBatchAction} className="px-6 py-4 space-y-3">
              <input type="hidden" name="batchId" value={voidTarget.id} />
              <p className="text-sm text-stone-700" data-testid="tb-void-copy">
                This will remove the ledger impact of this imported Trial Balance batch. Continue?
              </p>
              <div>
                <label className="label" htmlFor="void-reason">Reason (required)</label>
                <textarea
                  id="void-reason"
                  name="reason"
                  required
                  rows={2}
                  minLength={3}
                  className="textarea"
                  placeholder="e.g. duplicate import, wrong period, test data"
                  data-testid="tb-void-reason"
                />
              </div>
              <div className="flex justify-end gap-2 border-t border-stone-200 pt-3">
                <Link href="/app/admin/imports" className="btn btn-secondary">Cancel</Link>
                <button type="submit" className="btn btn-danger" data-testid="tb-void-confirm">
                  Void batch
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
