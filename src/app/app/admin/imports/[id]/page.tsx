import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { cookies } from "next/headers";

import { Badge } from "@/components/Badge";
import { isAppError } from "@/lib/errors";
import {
  batchDetail,
  validateBatch,
  commitBatch,
  rollbackBatch,
  planCoaReplacement,
  readTrialBalanceAsOfDate,
} from "@/lib/imports";
import { setTrialBalanceAsOfDateAction } from "../_actions";
import {
  getCoaMappingOptions,
  normaliseCoaRow,
} from "@/lib/imports/coa-mapping";
import { getCurrentPrincipal } from "@/lib/services/principal";

import { CoaMappingTable, type InitialCoaRow } from "./CoaMappingTable";
import { CoaReplaceCommitButton } from "./CoaReplaceCommitButton";
import { CoaErrorsCard } from "./CoaErrorsCard";
// Founder rule 2026-07-01 v14.20 — flash-cookie sweep must run
// OUTSIDE the Server Component render. The imports index page has
// used <FlashClear/> since v14.4; the batch-detail page now
// mirrors that pattern so approving mappings doesn't crash the
// page render with "Cookies can only be modified in a Server
// Action or Route Handler."
import { FlashClear } from "../FlashClear";

async function validateAction(batchId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await validateBatch(p, batchId); }
  catch (err) {
    if (isAppError(err)) cookies().set("spectre_import_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath(`/app/admin/imports/${batchId}`);
}

async function commitAction(batchId: string, formData: FormData) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try {
    const result = await commitBatch(p, {
      batchId,
      allowPartial: formData.get("allowPartial") === "on",
      // The founder's replace-confirmation modal posts this flag
      // back through the form on click. Without it, a COA commit
      // against a club that already has an active COA throws
      // RequiresCoaReplacementConfirmationError and the page
      // renders the modal on next load.
      confirmReplaceCoa: formData.get("confirmReplaceCoa") === "on",
    });
    // COA replacements use a dedicated success message so the
    // operator gets explicit "the prior COA was replaced"
    // feedback, not just the generic batch-commit toast.
    if (
      result.domain === "COA" &&
      formData.get("confirmReplaceCoa") === "on"
    ) {
      cookies().set("spectre_import_success", "Chart of Accounts replaced successfully.", {
        httpOnly: true,
        sameSite: "strict",
        maxAge: 30,
      });
    }
  } catch (err) {
    if (isAppError(err)) cookies().set("spectre_import_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath(`/app/admin/imports/${batchId}`);
}

async function rollbackAction(batchId: string) {
  "use server";
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  try { await rollbackBatch(p, batchId); }
  catch (err) {
    if (isAppError(err)) cookies().set("spectre_import_error", err.safeMessage, { httpOnly: true, sameSite: "strict", maxAge: 30 });
    else throw err;
  }
  revalidatePath(`/app/admin/imports/${batchId}`);
}

export default async function ImportBatchPage({ params }: { params: { id: string } }) {
  const p = await getCurrentPrincipal(); if (!p) redirect("/login");
  let batch;
  try { batch = await batchDetail(p, params.id); }
  catch { notFound(); }
  if (!batch) notFound();
  // Founder rule 2026-07-01 v14.20 — read-only cookie access.
  // Deletion happens in `/app/admin/imports/clear-flash` (a Route
  // Handler that CAN mutate cookies) via the <FlashClear/>
  // client component rendered below. The 30 s maxAge on every
  // flash cookie provides a natural expiry backup if the client
  // never reaches the route (offline, blocked).
  const error = cookies().get("spectre_import_error")?.value;
  const success = cookies().get("spectre_import_success")?.value;
  const notice = cookies().get("spectre_import_notice")?.value;

  // COA-specific: load mapping options + the editable row data the
  // CoaMappingTable consumes. This runs only for COA batches so the
  // other domains pay nothing.
  let coaPanel: { options: Awaited<ReturnType<typeof getCoaMappingOptions>>; rows: InitialCoaRow[] } | null = null;
  if (batch.domain === "COA") {
    const options = await getCoaMappingOptions(batch.clubId);
    // Group per-row error rows so each ImportRow gets its full
    // error list — used by the mapping table to render the inline
    // error message + the Next-error jump cycle.
    const errorsByRowNumber = new Map<number, typeof batch.errors>();
    for (const e of batch.errors) {
      const list = errorsByRowNumber.get(e.rowNumber) ?? [];
      list.push(e);
      errorsByRowNumber.set(e.rowNumber, list);
    }
    const rows: InitialCoaRow[] = batch.rows.map((r) => {
      const raw = parseRawJson(r.rawJson);
      const normalised = normaliseCoaRow(raw);
      const errs = errorsByRowNumber.get(r.rowNumber) ?? [];
      // Founder rule 2026-06-29: each row carries the auto-
      // mapping engine's confidence + source so the mapping
      // table can render subtle indicators (amber for medium,
      // light tint for low). The data lives under `_prediction`
      // in rawJson, written by `applyCoaAutoMapping` on upload.
      const rawForPrediction = parseRawJson(r.rawJson);
      const predBlob = rawForPrediction._prediction as
        | { confidence?: string; source?: string }
        | undefined;
      const predictionConfidence =
        predBlob?.confidence === "high"
          ? ("high" as const)
          : predBlob?.confidence === "medium"
            ? ("medium" as const)
            : predBlob?.confidence === "low"
              ? ("low" as const)
              : null;
      return {
        rowId: r.id,
        rowNumber: r.rowNumber,
        number: normalised.number,
        name: normalised.name,
        type: normalised.type ?? null,
        categoryKey: normalised.categoryKey ?? null,
        fsGroupKey: normalised.fsGroupKey ?? null,
        departmentCodes: normalised.departmentCodes ?? [],
        // Server-side validation state — populated when the batch
        // has been validated. "INVALID" surfaces the row's first
        // error message in the mapping table; "VALID" or any other
        // status reads as ready / needs-mapping in the UI.
        serverStatus: r.status as "PENDING" | "VALID" | "INVALID" | string,
        errorMessage: r.errorMessage ?? null,
        errorCodes: errs.map((e) => ({
          code: e.code,
          columnName: e.columnName ?? null,
          message: e.message,
        })),
        predictionConfidence,
        predictionSource: typeof predBlob?.source === "string" ? predBlob.source : null,
      };
    });
    coaPanel = { options, rows };
  }

  // COA replacement plan — drives the founder's confirmation
  // modal. Only computed for COA batches in the VALIDATED state
  // (the only state the Commit button is rendered from). For
  // every other state / domain it stays null.
  const coaReplacementPlan =
    batch.domain === "COA" && batch.status === "VALIDATED"
      ? await planCoaReplacement(p, batch.id)
      : null;

  const isCoa = batch.domain === "COA";
  const coaReadOnly = batch.status === "COMMITTED" || batch.status === "ROLLED_BACK";

  // Founder rule 2026-07-20: derive a single canonical lifecycle
  // state from the persisted facts (status + dryRunAt +
  // errorRows). Every COA-page affordance — the secondary
  // label, the validate/commit button, the disabled state, the
  // founder-spec copy — reads from this one value so the header
  // never contradicts itself ("VALIDATED" + "Not validated" +
  // "Commit anyway" appearing together was the bug). Non-COA
  // domains keep the legacy per-status branches below; only COA
  // gets the lifecycle helper for now.
  type CoaLifecycle =
    | "NOT_VALIDATED"           // DRAFT, or VALIDATED with stale dryRunAt (post Save Mapping)
    | "VALIDATED_CLEAN"         // VALIDATED + dryRunAt set + zero errors
    | "VALIDATED_WITH_ERRORS"   // VALIDATED + dryRunAt set + errors
    | "COMMITTED"
    | "ARCHIVED";
  const coaLifecycle: CoaLifecycle = isCoa
    ? (batch.status === "COMMITTED"
        ? "COMMITTED"
        : batch.status === "ARCHIVED"
          ? "ARCHIVED"
          : !batch.dryRunAt
            ? "NOT_VALIDATED"
            : batch.errorRows > 0
              ? "VALIDATED_WITH_ERRORS"
              : "VALIDATED_CLEAN")
    : "NOT_VALIDATED"; // placeholder; non-COA branches don't read this

  return (
    <div>
      {/* v14.20 — fire the cookie-clear POST after render so the
          notice/error/success displays exactly once. Only mounted
          when there's a flash to clear (avoids a needless fetch
          on every visit). Cookie deletion happens in the Route
          Handler, never in this Server Component. */}
      {(error || success || notice) && <FlashClear />}
      <Link href="/app/admin/imports" className="text-sm text-stone-500 hover:text-club-ink">← Imports</Link>
      <h1 className="mt-3 page-title">{batch.domain} batch</h1>
      <p className="mt-1 text-stone-500" data-testid="batch-detail-summary">
        Status <Badge status={batch.status} /> · {batch.totalRows} rows ·{" "}
        {/* Founder rule 2026-07-20: the secondary label is
            derived from the lifecycle state, never from the raw
            (status, dryRunAt) pair, so the badge and secondary
            text agree.
              • VALIDATED_CLEAN / VALIDATED_WITH_ERRORS: show
                actual counts.
              • NOT_VALIDATED (DRAFT, or VALIDATED with stale
                dryRunAt after a Save Mapping): show "Not
                validated" — never alongside a clean VALIDATED.
              • COMMITTED / ARCHIVED: show counts (the last
                validation's result is preserved). */}
        {isCoa
          ? (coaLifecycle === "NOT_VALIDATED"
              ? <span data-testid="batch-detail-not-validated">Not validated</span>
              : <>{batch.validRows} valid · {batch.errorRows} errors</>)
          : (batch.dryRunAt
              ? <>{batch.validRows} valid · {batch.errorRows} errors</>
              : <span data-testid="batch-detail-not-validated">Not validated</span>)}
      </p>
      {error && (
        <div
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          role="alert"
          data-testid="batch-detail-error"
        >
          {error}
        </div>
      )}
      {success && (
        <div
          className="mt-4 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
          role="status"
          data-testid="batch-detail-success"
        >
          {success}
        </div>
      )}
      {notice && (
        <div
          className="mt-4 rounded-md border border-club-green-200 bg-club-green-50 px-3 py-2 text-sm text-club-green-800"
          role="status"
          data-testid="batch-detail-notice"
        >
          {notice}
        </div>
      )}

      <div className="mt-4 flex gap-3 items-center" data-testid="batch-detail-actions">
        {/* Founder rule 2026-07-20 — COA action button is driven
            ENTIRELY by the lifecycle state. No "Commit anyway",
            no partial-commit checkbox: a COA import replaces the
            active Chart of Accounts and any partial-invalid
            commit creates reporting risk. */}
        {isCoa ? (
          <>
            {coaLifecycle === "NOT_VALIDATED" && (
              <form action={validateAction.bind(null, batch.id)}>
                <button
                  className="btn btn-primary"
                  data-testid="coa-action-validate"
                >
                  Validate import
                </button>
              </form>
            )}
            {coaLifecycle === "VALIDATED_CLEAN" && coaReplacementPlan && (
              <CoaReplaceCommitButton
                commitAction={commitAction.bind(null, batch.id)}
                plan={coaReplacementPlan}
              />
            )}
            {coaLifecycle === "VALIDATED_WITH_ERRORS" && (
              <button
                type="button"
                className="btn btn-secondary opacity-60 cursor-not-allowed"
                disabled
                aria-disabled="true"
                title="Fix every flagged row in the Map each account table below, then re-validate."
                data-testid="coa-action-fix-errors"
              >
                Fix errors before import
              </button>
            )}
            {coaLifecycle === "COMMITTED" && (
              <>
                <button
                  type="button"
                  className="btn btn-secondary opacity-60 cursor-not-allowed"
                  disabled
                  aria-disabled="true"
                  data-testid="coa-action-completed"
                >
                  Import completed
                </button>
                <form action={rollbackAction.bind(null, batch.id)}>
                  <button className="btn btn-ghost text-xs">Roll back</button>
                </form>
              </>
            )}
            {coaLifecycle === "ARCHIVED" && (
              <button
                type="button"
                className="btn btn-secondary opacity-60 cursor-not-allowed"
                disabled
                aria-disabled="true"
                data-testid="coa-action-archived"
              >
                Archived
              </button>
            )}
          </>
        ) : (
          <>
            {/* Non-COA domains keep the legacy two-button flow
                until they migrate to the lifecycle model. They
                still support partial commits because Members /
                Vendors / Inventory imports are additive, not
                destructive. */}
            {batch.status === "DRAFT" && (
              <form action={validateAction.bind(null, batch.id)}>
                <button className="btn btn-primary">Dry-run / validate</button>
              </form>
            )}
            {batch.status === "VALIDATED" && batch.errorRows === 0 && (
              <form action={commitAction.bind(null, batch.id)}>
                <button className="btn btn-primary">Commit</button>
              </form>
            )}
            {batch.status === "VALIDATED" && batch.errorRows > 0 && (
              <form action={commitAction.bind(null, batch.id)} className="flex items-center gap-2">
                <label className="text-xs"><input type="checkbox" name="allowPartial" /> allow partial commit</label>
                <button className="btn btn-secondary">Commit anyway</button>
              </form>
            )}
            {batch.status === "COMMITTED" && (
              <form action={rollbackAction.bind(null, batch.id)}>
                <button className="btn btn-secondary">Roll back</button>
              </form>
            )}
          </>
        )}
      </div>

      {/* Founder rule 2026-07-15: COA detail page is laid out as
          a Controller-focused workspace, not a debug surface.
            • The Errors summary card appears ONLY when there are
              errors, and ONLY above the mapping table.
            • The legacy Rows card is removed from the default
              view — its row-level status is duplicated by the
              mapping table's per-row Error pill.
            • The Rows card lives behind an "Advanced validation
              details" disclosure (collapsed by default) for
              support / debugging.
          Non-COA domains keep the original two-card layout. */}

      {isCoa ? (
        <>
          {/* Founder rule 2026-07-16: a collapsed-by-default
              Errors card that owns the Next-error navigation +
              "See error details" disclosure. Mapping table no
              longer carries any error UI in its sticky header. */}
          <CoaErrorsCard
            errors={batch.errors.map((e) => ({
              id: e.id,
              rowNumber: e.rowNumber,
              code: e.code,
              columnName: e.columnName ?? null,
              message: e.message,
              // Founder rule 2026-06-29 v12 — severity gate.
              // WARNING-severity errors are surfaced separately
              // and do NOT block Complete-import.
              severity: (e as { severity?: string }).severity === "WARNING" ? "WARNING" : "ERROR",
            }))}
          />

          {coaPanel && (
            <CoaMappingTable
              batchId={batch.id}
              readOnly={coaReadOnly}
              initialRows={coaPanel.rows}
              options={coaPanel.options}
            />
          )}

          {/* Advanced validation details — Controller-grade
              surfaces don't normally need this; it's a debug
              preview of the per-row server status for support
              triage. Collapsed by default. */}
          <details
            className="mt-6 rounded-md border border-stone-200 bg-white"
            data-testid="advanced-validation-details"
          >
            <summary className="cursor-pointer select-none px-4 py-2 text-xs uppercase tracking-wide text-stone-500 hover:text-club-ink">
              Advanced validation details
            </summary>
            <div className="border-t border-stone-200">
              <div className="px-6 py-3 text-[11px] text-stone-500">
                {batch.rows.length > 200
                  ? `Debug preview — showing first 200 of ${batch.rows.length} rows.`
                  : `${batch.rows.length} rows.`}
              </div>
              <table className="table-base">
                <thead><tr><th>#</th><th>Status</th><th>Created</th><th>Error</th></tr></thead>
                <tbody>
                  {batch.rows.slice(0, 200).map((r) => (
                    <tr key={r.id}>
                      <td className="text-xs">{r.rowNumber}</td>
                      <td><Badge status={r.status} /></td>
                      <td className="text-xs font-mono">{r.createdEntityType ? `${r.createdEntityType}:${r.createdEntityId?.slice(0, 8)}` : "—"}</td>
                      <td className="text-xs">{r.errorMessage ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      ) : (
        <>
          {/* Founder rule 2026-06-30 v14 — Trial Balance preview.
              Only renders for OPENING_TRIAL_BALANCE batches; every
              other domain gets the generic errors + rows cards. */}
          {batch.domain === "OPENING_TRIAL_BALANCE" && (
            <TrialBalancePreview batch={batch} />
          )}

          <div className="mt-6 card overflow-hidden">
            <div className="px-6 py-4 border-b border-stone-200 font-medium">Errors ({batch.errors.length})</div>
            <table className="table-base">
              <thead><tr><th>Row</th><th>Code</th><th>Column</th><th>Message</th></tr></thead>
              <tbody>
                {batch.errors.length === 0 && <tr><td colSpan={4} className="px-4 py-6 text-center text-stone-500">No errors.</td></tr>}
                {batch.errors.map((e) => (
                  <tr key={e.id}>
                    <td className="text-xs">{e.rowNumber}</td>
                    <td className="text-xs font-mono">{e.code}</td>
                    <td className="text-xs">{e.columnName ?? "—"}</td>
                    <td className="text-xs">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="mt-6 card overflow-hidden">
            <div className="px-6 py-4 border-b border-stone-200 font-medium">
              Rows{batch.rows.length > 200 ? ` (showing first 200 of ${batch.rows.length})` : ` (${batch.rows.length})`}
            </div>
            <table className="table-base">
              <thead><tr><th>#</th><th>Status</th><th>Created</th><th>Error</th></tr></thead>
              <tbody>
                {batch.rows.slice(0, 200).map((r) => (
                  <tr key={r.id}>
                    <td className="text-xs">{r.rowNumber}</td>
                    <td><Badge status={r.status} /></td>
                    <td className="text-xs font-mono">{r.createdEntityType ? `${r.createdEntityType}:${r.createdEntityId?.slice(0, 8)}` : "—"}</td>
                    <td className="text-xs">{r.errorMessage ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function parseRawJson(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Founder rule 2026-06-30 v14 — Trial Balance preview panel.
// Renders on the import detail page for OPENING_TRIAL_BALANCE
// batches. Shows three artefacts an operator needs BEFORE
// committing the import:
//   1. Totals card — Σ debit, Σ credit, variance (green when
//      balanced, red when out).
//   2. Unmatched accounts panel — every ACCOUNT_NOT_FOUND row,
//      with number + description + debit + credit + the exact
//      copy the founder specified.
//   3. Parsed rows table — every row with its status pill,
//      account, description, debit, credit.
type TbBatch = {
  id: string;
  domain: string;
  status: string;
  totalRows: number;
  validRows: number;
  errorRows: number;
  optionsJson: string | null;
  rows: ReadonlyArray<{
    id: string;
    rowNumber: number;
    status: string;
    rawJson: string | null;
    normalizedJson: string | null;
    errorMessage: string | null;
  }>;
  errors: ReadonlyArray<{ id: string; rowNumber: number; code: string; columnName: string | null; message: string }>;
};
function TrialBalancePreview({ batch }: { batch: TbBatch }) {
  // v14.3 — read the detected TB as-of date off the batch's
  // optionsJson. `readTrialBalanceAsOfDate` returns null when
  // the parser couldn't infer it, in which case we surface a
  // manual-entry form the operator MUST use before commit.
  const asOfDate = readTrialBalanceAsOfDate(batch.optionsJson);
  const asOfDisplay = asOfDate
    ? asOfDate.toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })
    : null;
  let totalDebit = 0;
  let totalCredit = 0;
  type PreviewRow = { rowNumber: number; status: string; accountNumber: string; description: string; debit: number; credit: number };
  const rows: PreviewRow[] = batch.rows.map((r) => {
    const src = parseRawJson(r.normalizedJson ?? r.rawJson);
    const n = String(src.accountNumber ?? src.number ?? src.code ?? "").trim().replace(/\.0+$/, "");
    const d = Number(src.debit ?? 0) || 0;
    const c = Number(src.credit ?? 0) || 0;
    const desc = String(src.description ?? src.name ?? "").trim();
    if (r.status === "VALID") { totalDebit += d; totalCredit += c; }
    return { rowNumber: r.rowNumber, status: r.status, accountNumber: n, description: desc, debit: d, credit: c };
  });
  const variance = totalDebit - totalCredit;
  const isBalanced = Math.abs(variance) <= 0.005;

  // Unmatched accounts — driven by the batch error rows so the
  // presentation stays in sync with the server-side check.
  const unmatched = batch.errors.filter((e) => e.code === "ACCOUNT_NOT_FOUND");
  const outOfBalance = batch.errors.some((e) => e.code === "TB_OUT_OF_BALANCE");

  const fmt = (n: number) => n.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  return (
    <>
      {/* v14.3 — As-of period header. Shows the auto-detected
          date OR a manual-entry form if the parser couldn't
          infer it from a title row. Commit is blocked at the
          service layer when this is still null. */}
      {asOfDisplay ? (
        <div
          className="mt-6 rounded-md border border-club-green-200 bg-club-green-50 px-4 py-3 flex items-baseline justify-between"
          data-testid="tb-asof-detected"
        >
          <div>
            <span className="text-xs uppercase tracking-wide text-club-green-700">Trial Balance as of</span>
            <div className="font-serif text-xl text-club-ink mt-0.5" data-testid="tb-asof-display">
              {asOfDisplay}
            </div>
          </div>
          <span className="text-xs text-stone-500">Auto-detected from source file</span>
        </div>
      ) : (
        <div
          className="mt-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-3"
          data-testid="tb-asof-manual"
        >
          <div className="text-sm text-amber-900 mb-2">
            <strong>Trial Balance as-of date is not set.</strong> Enter it below before completing the import.
            Spectre could not detect a title row like &ldquo;Trial Balance for May, 2026&rdquo; in the source file.
          </div>
          <form action={setTrialBalanceAsOfDateAction} className="flex items-end gap-2">
            <input type="hidden" name="batchId" value={batch.id} />
            <div>
              <label className="label" htmlFor="tb-asof-input">As-of date</label>
              <input
                id="tb-asof-input"
                type="date"
                name="asOfDate"
                required
                className="input"
                data-testid="tb-asof-input"
              />
            </div>
            <button type="submit" className="btn btn-primary" data-testid="tb-asof-save">
              Save date
            </button>
          </form>
        </div>
      )}

      <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-4" data-testid="tb-preview-totals">
        <div className="card px-6 py-4">
          <div className="text-xs uppercase tracking-wide text-stone-500">Total debits</div>
          <div className="mt-1 font-mono text-2xl text-club-ink" data-testid="tb-total-debit">
            {fmt(totalDebit)}
          </div>
        </div>
        <div className="card px-6 py-4">
          <div className="text-xs uppercase tracking-wide text-stone-500">Total credits</div>
          <div className="mt-1 font-mono text-2xl text-club-ink" data-testid="tb-total-credit">
            {fmt(totalCredit)}
          </div>
        </div>
        <div className={`card px-6 py-4 ${isBalanced ? "" : "border-red-300 bg-red-50"}`}>
          <div className="text-xs uppercase tracking-wide text-stone-500">Variance</div>
          <div
            className={`mt-1 font-mono text-2xl ${isBalanced ? "text-emerald-700" : "text-red-700"}`}
            data-testid="tb-variance"
            data-balanced={isBalanced ? "true" : "false"}
          >
            {fmt(variance)}
          </div>
          {!isBalanced && (
            <div className="mt-1 text-xs text-red-700">
              Debits and credits must reconcile before import can complete.
            </div>
          )}
          {isBalanced && (
            <div className="mt-1 text-xs text-emerald-700">Balanced.</div>
          )}
        </div>
      </div>

      {outOfBalance && (
        <div
          className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          data-testid="tb-out-of-balance-banner"
        >
          Trial balance is out of balance. Fix the source file or the reconciling entry
          and re-upload before completing the import.
        </div>
      )}

      {unmatched.length > 0 && (
        <div className="mt-4 card overflow-hidden" data-testid="tb-unmatched-panel">
          <div className="px-6 py-3 border-b border-stone-200 flex items-center justify-between">
            <span className="font-medium text-red-700">
              {unmatched.length} account{unmatched.length === 1 ? "" : "s"} not found in Chart of Accounts
            </span>
            <div className="flex items-center gap-3">
              <a
                href={`/app/admin/imports/${batch.id}/map-accounts`}
                className="text-xs font-medium text-club-green-700 hover:underline"
                data-testid="tb-map-accounts-link"
              >
                Map / Add accounts →
              </a>
              <span className="text-xs text-stone-500">
                Review predicted mappings, approve, and create in the live COA.
              </span>
            </div>
          </div>
          <table className="table-base">
            <thead>
              <tr>
                <th className="w-20">Row</th>
                <th className="w-32">Account</th>
                <th>Description</th>
                <th className="w-32 text-right">Debit</th>
                <th className="w-32 text-right">Credit</th>
                <th>Reason</th>
              </tr>
            </thead>
            <tbody>
              {unmatched.map((e) => {
                const row = rows.find((r) => r.rowNumber === e.rowNumber);
                return (
                  <tr key={e.id} data-testid={`tb-unmatched-row-${e.rowNumber}`}>
                    <td className="text-xs font-mono">{e.rowNumber}</td>
                    <td className="text-xs font-mono">{row?.accountNumber ?? "—"}</td>
                    <td className="text-xs">{row?.description ?? "—"}</td>
                    <td className="text-xs font-mono text-right">{row ? fmt(row.debit) : "—"}</td>
                    <td className="text-xs font-mono text-right">{row ? fmt(row.credit) : "—"}</td>
                    <td className="text-xs text-red-700">Account number not found in Chart of Accounts</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 card overflow-hidden" data-testid="tb-preview-rows">
        <div className="px-6 py-3 border-b border-stone-200 font-medium">
          Parsed rows{rows.length > 200 ? ` (showing first 200 of ${rows.length})` : ` (${rows.length})`}
        </div>
        <table className="table-base">
          <thead>
            <tr>
              <th className="w-16">Row</th>
              <th className="w-24">Status</th>
              <th className="w-32">Account</th>
              <th>Description</th>
              <th className="w-32 text-right">Debit</th>
              <th className="w-32 text-right">Credit</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 200).map((r) => (
              <tr
                key={r.rowNumber}
                data-testid={`tb-preview-row-${r.rowNumber}`}
                className={r.status === "INVALID" ? "bg-red-50/60" : ""}
              >
                <td className="text-xs font-mono">{r.rowNumber}</td>
                <td><Badge status={r.status} /></td>
                <td className="text-xs font-mono">{r.accountNumber || "—"}</td>
                <td className="text-xs">{r.description || "—"}</td>
                <td className="text-xs font-mono text-right">{r.debit === 0 ? "—" : fmt(r.debit)}</td>
                <td className="text-xs font-mono text-right">{r.credit === 0 ? "—" : fmt(r.credit)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="border-t-2 border-stone-300">
              <td colSpan={4} className="text-xs text-right font-medium">Totals</td>
              <td className="text-xs font-mono font-medium text-right" data-testid="tb-preview-total-debit-footer">
                {fmt(totalDebit)}
              </td>
              <td className="text-xs font-mono font-medium text-right" data-testid="tb-preview-total-credit-footer">
                {fmt(totalCredit)}
              </td>
            </tr>
          </tfoot>
        </table>
      </div>
    </>
  );
}
