"use client";

// MBR-FIX-2L (2026-10-11) — AR Aging importer client form.
//
// Lifecycle:
//   1. User selects XLSX + enters period-end YYYY-MM-DD.
//   2. "Preview" POSTs multipart to /api/admin/ar-aging-import with
//      action=preview. The endpoint parses the workbook, computes
//      aging bucket totals, reconciles to the Jonas GL control
//      account, and returns a `commitEligible` flag.
//   3. If preview succeeds AND commitEligible is true, the "Commit"
//      button activates.  Commit opens a confirmation modal — only
//      the founder's explicit confirmation triggers the POST with
//      action=commit (same file blob, re-parsed server-side so the
//      idempotency hash is deterministic).
//   4. On commit, API returns 200 with `committed: true`.  Section
//      VIII AR Aging and Stewardship Dashboard AR Current % both
//      consume the committed snapshot on the next package build for
//      the matching period end.
//
// Duplicate-import protection: the commit service rejects any
// (clubId, sourceFileHash) that is already COMMITTED. The API
// surfaces that as 409 and this form displays the server's error
// message verbatim.
//
// The form intentionally does NOT ship a "commit without preview"
// path — commit requires a successful preview in the same session
// so the founder sees the aging totals + reconciliation before
// authorising.

import { useState } from "react";
import { useRouter } from "next/navigation";

type PreviewResponse = {
  sourceFileHash: string;
  sourceEffectiveDate: string;
  rowCount: number;
  invalidCount: number;
  warningCount: number;
  warnings: string[];
  aggregateReconcilesPerRow: boolean;
  rowsFailingReconciliation: number;
  totals: {
    totalAR: string;
    current: string;
    oneMonth: string;
    twoMonths: string;
    threeMonths: string;
    overFourMonths: string;
    currentPct: number | null;
    nonCurrentPct: number | null;
    accountCount: number;
    nonCurrentAccountCount: number;
  };
  resolutionSummary: {
    matched: number;
    unmatched: number;
    ambiguous: number;
  };
  nameConsistency: {
    accountsWithDivergence: number;
    totalAccounts: number;
  };
  gl: {
    accountNumber: string | null;
    accountName: string | null;
    fsGroupsUsed: string[];
    naturalBalance: string | null;
    subledgerTotal: string;
    difference: string | null;
    status: string;
    accountsIncluded: number;
  };
  commitEligible: boolean;
};

type CommitResponse = {
  committed: boolean;
  batchId?: string;
  error?: string;
};

function fmtMoney(raw: string | null | undefined): string {
  if (raw == null) return "—";
  const n = Number(raw);
  if (!Number.isFinite(n)) return raw;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtPct(n: number | null | undefined): string {
  return n == null ? "—" : `${n.toFixed(2)}%`;
}

export default function ArAgingImportForm({ clubId }: { clubId: string }) {
  const router = useRouter();
  const [file, setFile] = useState<File | null>(null);
  const [effectiveDate, setEffectiveDate] = useState<string>("");
  const [state, setState] = useState<"idle" | "previewing" | "committing" | "ok" | "committed" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [commitResult, setCommitResult] = useState<CommitResponse | null>(null);
  const [showConfirm, setShowConfirm] = useState(false);

  async function onPreview(e: React.FormEvent) {
    e.preventDefault();
    if (!file) {
      setError("Choose an AR aging workbook first.");
      setState("error");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) {
      setError("Period end must be YYYY-MM-DD (e.g. 2026-02-28).");
      setState("error");
      return;
    }
    setState("previewing");
    setError(null);
    setPreview(null);
    setCommitResult(null);
    try {
      const form = new FormData();
      form.append("clubId", clubId);
      form.append("action", "preview");
      form.append("sourceEffectiveDate", effectiveDate);
      form.append("file", file);
      const res = await fetch("/api/admin/ar-aging-import", { method: "POST", body: form });
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(body.error ?? "Preview failed.");
      }
      const data = (await res.json()) as PreviewResponse;
      setPreview(data);
      setState("ok");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Preview failed.");
      setState("error");
    }
  }

  async function onCommit() {
    if (!file || !preview) return;
    setState("committing");
    setError(null);
    try {
      const form = new FormData();
      form.append("clubId", clubId);
      form.append("action", "commit");
      form.append("sourceEffectiveDate", effectiveDate);
      form.append("file", file);
      const res = await fetch("/api/admin/ar-aging-import", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({ committed: false, error: res.statusText }))) as CommitResponse;
      if (!res.ok || body.committed !== true) {
        throw new Error(body.error ?? `Commit failed (${res.status}).`);
      }
      setCommitResult(body);
      setState("committed");
      setShowConfirm(false);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Commit failed.");
      setState("error");
      setShowConfirm(false);
    }
  }

  return (
    <section className="card" data-testid="ar-aging-import-form">
      <div className="card-body space-y-3">
        <h2 className="section-title text-lg">Upload month-end AR aging workbook</h2>
        <p className="text-xs text-stone-500">
          Supported source: Jonas AR aging XLSX workbook (one calendar
          month per file). Spectre never commits uploaded data
          automatically; preview the parsed totals + GL reconciliation
          below, then explicitly commit.
        </p>
        <form onSubmit={onPreview} className="flex flex-col gap-3" data-testid="ar-aging-import-upload">
          <div className="flex flex-col gap-1">
            <label className="label" htmlFor="ar-aging-file">AR aging workbook (.xlsx)</label>
            <input
              id="ar-aging-file"
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              data-testid="ar-aging-import-file"
              className="text-sm"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="label" htmlFor="ar-aging-effective-date">Period end (month-end YYYY-MM-DD)</label>
            <input
              id="ar-aging-effective-date"
              type="date"
              value={effectiveDate}
              onChange={(e) => setEffectiveDate(e.target.value)}
              data-testid="ar-aging-import-effective-date"
              className="text-sm w-64"
            />
            <p className="text-[11px] text-stone-500">
              Must match the workbook&rsquo;s as-of date exactly. The AR
              resolver uses an exact-day match (no carry-forward) — a
              Feb package reads the Feb&nbsp;28 snapshot only.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="submit"
              className="btn-primary"
              disabled={!file || !effectiveDate || state === "previewing" || state === "committing"}
              data-testid="ar-aging-import-submit"
            >
              {state === "previewing" ? "Parsing…" : "Preview"}
            </button>
            {preview && preview.commitEligible && state !== "committed" && (
              <button
                type="button"
                className="btn-primary"
                onClick={() => setShowConfirm(true)}
                disabled={state === "committing"}
                data-testid="ar-aging-import-commit"
              >
                {state === "committing" ? "Committing…" : "Commit"}
              </button>
            )}
          </div>
        </form>

        {error && (
          <div
            className="rounded border border-rose-400 bg-rose-50 p-3 text-sm text-rose-800"
            data-testid="ar-aging-import-error"
          >
            {error}
          </div>
        )}

        {state === "committed" && commitResult && (
          <div
            className="rounded border border-emerald-400 bg-emerald-50 p-3 text-sm text-emerald-900"
            data-testid="ar-aging-import-committed-notice"
          >
            <div className="font-semibold">Committed.</div>
            <div className="mt-1 text-xs">
              Batch {commitResult.batchId ?? "(id unknown)"} is now the
              authoritative AR aging snapshot for{" "}
              <span className="tabular-nums">{effectiveDate}</span>.
              Section VIII and the Stewardship Dashboard AR Current %
              populate on the next package build for that period.
            </div>
          </div>
        )}

        {preview && (
          <div className="mt-4 border-t pt-4 space-y-4" data-testid="ar-aging-import-preview">
            <div className="text-sm">
              Preview parsed{" "}
              <strong className="tabular-nums">{preview.rowCount}</strong>{" "}
              rows (period end{" "}
              <span className="tabular-nums">{preview.sourceEffectiveDate}</span>).
              {preview.warningCount > 0 && (
                <span className="ml-2 text-amber-700">
                  {preview.warningCount} warning{preview.warningCount === 1 ? "" : "s"}
                </span>
              )}
              {preview.rowsFailingReconciliation > 0 && (
                <span className="ml-2 text-rose-600">
                  {preview.rowsFailingReconciliation} row(s) failing bucket reconciliation
                </span>
              )}
            </div>

            {/* Aging bucket totals */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-500 mb-1">
                Aging buckets
              </h3>
              <table className="table-base w-full text-xs" data-testid="ar-aging-import-totals">
                <thead>
                  <tr>
                    <th className="text-left">Bucket</th>
                    <th className="text-right">Amount</th>
                    <th className="text-right">% of Total</th>
                  </tr>
                </thead>
                <tbody>
                  <tr data-testid="ar-aging-bucket-current">
                    <td className="text-left">Current</td>
                    <td className="text-right tabular-nums">{fmtMoney(preview.totals.current)}</td>
                    <td className="text-right tabular-nums">{fmtPct(preview.totals.currentPct)}</td>
                  </tr>
                  <tr data-testid="ar-aging-bucket-one-month">
                    <td className="text-left">1 month</td>
                    <td className="text-right tabular-nums">{fmtMoney(preview.totals.oneMonth)}</td>
                    <td className="text-right">—</td>
                  </tr>
                  <tr data-testid="ar-aging-bucket-two-months">
                    <td className="text-left">2 months</td>
                    <td className="text-right tabular-nums">{fmtMoney(preview.totals.twoMonths)}</td>
                    <td className="text-right">—</td>
                  </tr>
                  <tr data-testid="ar-aging-bucket-three-months">
                    <td className="text-left">3 months</td>
                    <td className="text-right tabular-nums">{fmtMoney(preview.totals.threeMonths)}</td>
                    <td className="text-right">—</td>
                  </tr>
                  <tr data-testid="ar-aging-bucket-over-four">
                    <td className="text-left">4+ months</td>
                    <td className="text-right tabular-nums">{fmtMoney(preview.totals.overFourMonths)}</td>
                    <td className="text-right">—</td>
                  </tr>
                  <tr className="font-semibold border-t" data-testid="ar-aging-bucket-total">
                    <td className="text-left">Total AR</td>
                    <td className="text-right tabular-nums">{fmtMoney(preview.totals.totalAR)}</td>
                    <td className="text-right tabular-nums">100.00%</td>
                  </tr>
                </tbody>
              </table>
              <div className="mt-1 text-[11px] text-stone-500">
                {preview.totals.accountCount} accounts ·{" "}
                {preview.totals.nonCurrentAccountCount} with non-current balance ·{" "}
                non-current {fmtPct(preview.totals.nonCurrentPct)}
              </div>
            </div>

            {/* GL reconciliation */}
            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-500 mb-1">
                GL reconciliation
              </h3>
              <table className="table-base w-full text-xs" data-testid="ar-aging-import-gl">
                <tbody>
                  <tr>
                    <td className="text-left">Control account</td>
                    <td className="text-right tabular-nums">
                      {preview.gl.accountNumber ?? "—"}
                      {preview.gl.accountName && (
                        <span className="ml-2 text-stone-500">{preview.gl.accountName}</span>
                      )}
                    </td>
                  </tr>
                  <tr>
                    <td className="text-left">GL natural balance</td>
                    <td className="text-right tabular-nums">{fmtMoney(preview.gl.naturalBalance)}</td>
                  </tr>
                  <tr>
                    <td className="text-left">Subledger total</td>
                    <td className="text-right tabular-nums">{fmtMoney(preview.gl.subledgerTotal)}</td>
                  </tr>
                  <tr>
                    <td className="text-left">Difference</td>
                    <td
                      className={`text-right tabular-nums ${
                        preview.gl.difference != null && Number(preview.gl.difference) !== 0
                          ? "text-rose-600"
                          : ""
                      }`}
                    >
                      {fmtMoney(preview.gl.difference)}
                    </td>
                  </tr>
                  <tr>
                    <td className="text-left">Status</td>
                    <td className="text-right">
                      <span
                        className={
                          preview.gl.status === "RECONCILED"
                            ? "badge badge-green"
                            : preview.gl.status === "OUT_OF_BALANCE"
                            ? "badge badge-rose"
                            : "badge badge-amber"
                        }
                        data-testid="ar-aging-import-gl-status"
                      >
                        {preview.gl.status}
                      </span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* Member resolution */}
            <div className="text-xs text-stone-500" data-testid="ar-aging-import-resolution">
              Member resolution:{" "}
              <strong>{preview.resolutionSummary.matched}</strong> matched ·{" "}
              <strong>{preview.resolutionSummary.unmatched}</strong> unmatched
              {preview.resolutionSummary.ambiguous > 0 && (
                <>
                  {" "}·{" "}
                  <strong className="text-amber-700">
                    {preview.resolutionSummary.ambiguous}
                  </strong>{" "}
                  ambiguous
                </>
              )}
            </div>

            {preview.warnings.length > 0 && (
              <details className="text-xs" data-testid="ar-aging-import-warnings">
                <summary className="cursor-pointer text-amber-700">
                  {preview.warnings.length} warning{preview.warnings.length === 1 ? "" : "s"}
                </summary>
                <ul className="mt-2 list-disc pl-5 text-stone-600 space-y-1">
                  {preview.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </details>
            )}

            <div
              className={`rounded border p-3 text-xs ${
                preview.commitEligible
                  ? "border-emerald-300 bg-emerald-50 text-emerald-900"
                  : "border-rose-300 bg-rose-50 text-rose-800"
              }`}
              data-testid="ar-aging-import-commit-eligibility"
            >
              {preview.commitEligible
                ? "This batch is eligible to commit. Review the totals and GL reconciliation above, then click Commit."
                : "This batch is NOT eligible to commit — the preview surfaced a blocking condition (bucket reconciliation failure, GL mismatch outside tolerance, or duplicate hash). Fix the source workbook and preview again."}
            </div>
          </div>
        )}
      </div>

      {/* Commit confirmation modal — explicit Controller
          authorization per the directive. */}
      {showConfirm && preview && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-stone-900/40 px-4"
          data-testid="ar-aging-commit-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Confirm AR aging commit"
        >
          <div className="card w-full max-w-md">
            <div className="flex items-center justify-between border-b border-stone-200 px-6 py-3">
              <h2 className="font-serif text-xl text-club-ink">
                Commit AR aging batch?
              </h2>
              <button
                type="button"
                className="text-stone-500 hover:text-club-ink text-xl leading-none"
                aria-label="Close"
                onClick={() => setShowConfirm(false)}
              >
                ×
              </button>
            </div>
            <div className="px-6 py-4 space-y-3 text-sm">
              <p>
                This will commit{" "}
                <strong className="tabular-nums">{preview.rowCount}</strong>{" "}
                rows totalling{" "}
                <strong className="tabular-nums">{fmtMoney(preview.totals.totalAR)}</strong>{" "}
                as the authoritative AR aging snapshot for period end{" "}
                <strong className="tabular-nums">{preview.sourceEffectiveDate}</strong>.
              </p>
              <p className="text-xs text-stone-600">
                Section VIII AR Aging and the Stewardship Dashboard AR
                Current % will update on the next Monthly Package
                build for the matching period. Previously committed
                batches for other periods are not affected.
              </p>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  className="btn-secondary"
                  onClick={() => setShowConfirm(false)}
                  disabled={state === "committing"}
                  data-testid="ar-aging-commit-cancel"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="btn-primary"
                  onClick={onCommit}
                  disabled={state === "committing"}
                  data-testid="ar-aging-commit-confirm"
                >
                  {state === "committing" ? "Committing…" : "Confirm commit"}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
