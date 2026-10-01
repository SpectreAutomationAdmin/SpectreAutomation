"use client";

// Jonas GL import — client-side workflow.
//
// TB-RESET-1d.b.2 (2026-09-29) — final founder-operated import UI.
//
// State machine:
//   idle → preview-pending → preview-ready → commit-pending → commit-done
//
// Every accounting decision lives server-side; this component only
// drives the workflow, disables the Commit button until the server's
// preview says the gates pass, and renders the results.

import { useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  commitJonasImport,
  previewJonasImport,
  type JonasImportCommitResult,
  type JonasImportPreview,
  type JonasImportPreviewRow,
} from "./actions";

type Stage = "idle" | "preview-pending" | "preview-ready" | "commit-pending" | "commit-done";

type FormFields = {
  /** Base64 of the XLSX file, when the user chose one. */
  xlsxBase64: string;
  /** Pasted or file-derived CSV text. */
  csv: string;
  filename: string;
  /** Founder-supplied effective date (always required in b.2's UI —
   *  the pre-fill happens after preview when the server detects one). */
  effectiveDateOverride: string;
  entityMismatchAcknowledged: boolean;
  replaceExistingBatchId: string;
};

const EMPTY: FormFields = {
  xlsxBase64: "",
  csv: "",
  filename: "",
  effectiveDateOverride: "",
  entityMismatchAcknowledged: false,
  replaceExistingBatchId: "",
};

function money(n: number): string {
  return n.toLocaleString("en-US", {
    style: "currency", currency: "USD",
    minimumFractionDigits: 2, maximumFractionDigits: 2,
  });
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function buildFormData(fields: FormFields): FormData {
  const fd = new FormData();
  if (fields.xlsxBase64) fd.set("xlsxBase64", fields.xlsxBase64);
  if (fields.csv) fd.set("csv", fields.csv);
  fd.set("filename", fields.filename || "import.csv");
  fd.set("effectiveDateOverride", fields.effectiveDateOverride);
  fd.set("entityMismatchAcknowledged", fields.entityMismatchAcknowledged ? "true" : "false");
  fd.set("replaceExistingBatchId", fields.replaceExistingBatchId);
  return fd;
}

export function JonasImportForm() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("idle");
  const [fields, setFields] = useState<FormFields>(EMPTY);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [preview, setPreview] = useState<JonasImportPreview | null>(null);
  const [commit, setCommit] = useState<JonasImportCommitResult | null>(null);
  const [replaceOptIn, setReplaceOptIn] = useState(false);
  const [pending, startTransition] = useTransition();

  function resetPreview() {
    setStage("idle");
    setPreview(null);
    setCommit(null);
  }

  function updateField<K extends keyof FormFields>(k: K, v: FormFields[K]) {
    setFields((f) => ({ ...f, [k]: v }));
    if (stage === "preview-ready") resetPreview();
  }

  async function onFileChosen(file: File | null) {
    if (!file) return;
    const name = file.name.toLowerCase();
    if (name.endsWith(".xlsx")) {
      const buf = await file.arrayBuffer();
      setFields((f) => ({
        ...f,
        xlsxBase64: toBase64(buf),
        csv: "",
        filename: file.name,
      }));
    } else {
      const text = await file.text();
      setFields((f) => ({
        ...f,
        xlsxBase64: "",
        csv: text,
        filename: file.name,
      }));
    }
    resetPreview();
  }

  function onPreview() {
    // TB-HIST-3 (2026-10-01) — defensive double-submit guard.
    // startTransition already queues to React's transition manager, but
    // under the previous shape the button could re-fire in the window
    // between click and `pending=true` propagating. Short-circuit here.
    if (pending || stage === "preview-pending") return;
    setSubmitError(null);
    setCommit(null);
    setStage("preview-pending");
    startTransition(async () => {
      try {
        const result = await previewJonasImport(buildFormData(fields));
        if ("error" in result) {
          setSubmitError(result.error);
          setStage("idle");
          return;
        }
        if (result.status === "ok" && !fields.effectiveDateOverride && result.resolvedDates) {
          setFields((f) => ({ ...f, effectiveDateOverride: result.resolvedDates!.periodEndIso }));
        }
        setPreview(result);
        setStage("preview-ready");
      } catch (err) {
        // TB-HIST-3 — never leave the operator on a silent screen.
        // A thrown server-action error (payload too large, network
        // failure, Prisma error inside the action, parser throw not
        // wrapped by `decodeInput`) now surfaces as an actionable
        // message so the founder can see WHAT failed instead of
        // waiting indefinitely at the import form.
        const message = err instanceof Error ? err.message : String(err);
        setSubmitError("Preview failed: " + message);
        setStage("idle");
      }
    });
  }

  function onCommit() {
    setSubmitError(null);
    setStage("commit-pending");
    // If preview showed a duplicate period AND founder opted in to
    // replacement, thread the replace target through.
    const previewOk = preview?.status === "ok" ? preview : null;
    const replaceTarget = replaceOptIn && previewOk?.existingSnapshotForPeriod?.batchId
      ? previewOk.existingSnapshotForPeriod.batchId
      : "";
    const fd = buildFormData({ ...fields, replaceExistingBatchId: replaceTarget });
    startTransition(async () => {
      const result = await commitJonasImport(fd);
      if ("error" in result) {
        setSubmitError(result.error);
        setStage("preview-ready");
        return;
      }
      if (result.status === "blocked") {
        setSubmitError(`Commit blocked (${result.code}): ${result.reason}`);
        setStage("preview-ready");
        return;
      }
      setCommit(result);
      setStage("commit-done");
      router.refresh();
    });
  }

  function onReset() {
    setFields(EMPTY);
    setStage("idle");
    setSubmitError(null);
    setPreview(null);
    setCommit(null);
    setReplaceOptIn(false);
  }

  const previewOk = preview?.status === "ok" ? preview : null;
  const commitOk = commit && !("error" in commit) && commit.status === "committed" ? commit : null;

  const canCommit = useMemo(() => {
    if (stage !== "preview-ready") return false;
    if (!previewOk) return false;
    if (!previewOk.reconciliation.isBalanced) return false;
    if (previewOk.mappingCoverage.unmapped > 0) return false;
    if (previewOk.mappingCoverage.duplicates > 0) return false;
    if (previewOk.requiresEffectiveDateSelection && !fields.effectiveDateOverride) return false;
    if (previewOk.requiresEntityMismatchAcknowledgement && !fields.entityMismatchAcknowledged) return false;
    if (previewOk.duplicateSourceFileBatch) return false;
    if (previewOk.existingSnapshotForPeriod && !replaceOptIn) return false;
    return true;
  }, [stage, previewOk, fields.effectiveDateOverride, fields.entityMismatchAcknowledged, replaceOptIn]);

  // ---------------------------------------------------------------- render
  return (
    <div className="space-y-4">
      <div className="card card-body" data-testid="jonas-import-inputs">
        <h2 className="section-title text-lg">Import Jonas Trial Balance</h2>
        <p className="mt-1 text-xs text-stone-500">
          Upload the month-end Jonas Trial Balance (XLSX or CSV). Preview
          runs every accounting control server-side; nothing becomes
          authoritative until you press <em>Commit</em>.
        </p>

        {/* File upload */}
        <div className="mt-4">
          <label className="block text-xs uppercase text-stone-500">Source file (XLSX or CSV)</label>
          <input
            type="file"
            accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            data-testid="field-source-file"
            onChange={(e) => onFileChosen(e.target.files?.[0] ?? null)}
            className="mt-1 text-sm"
          />
          {fields.filename && (
            <p className="mt-1 text-xs text-stone-500" data-testid="field-source-filename">
              Loaded: {fields.filename}
            </p>
          )}
        </div>

        {/* Effective date — always visible + confirmable */}
        <div className="mt-4">
          <label className="block text-xs uppercase text-stone-500">Effective date (period end)</label>
          <input
            type="date"
            data-testid="field-effective-date"
            value={fields.effectiveDateOverride}
            onChange={(e) => updateField("effectiveDateOverride", e.target.value)}
            className="input mt-1 text-sm"
          />
          <p className="mt-1 text-xs text-stone-500">
            Coulee fiscal year end is December 31. The importer resolves
            fiscal year + period from the date you confirm here.
          </p>
        </div>

        {/* Optional: pasted CSV */}
        <details className="mt-4 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm">
          <summary className="cursor-pointer text-xs uppercase tracking-[0.18em] text-stone-600">
            Alternative — paste CSV
          </summary>
          <p className="mt-2 text-xs text-stone-500">
            For quick tests of a Jonas-native CSV export.
          </p>
          <textarea
            rows={6}
            data-testid="field-csv-textarea"
            value={fields.csv}
            onChange={(e) => updateField("csv", e.target.value)}
            className="input mt-2 text-xs font-mono w-full"
          />
        </details>

        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            className="btn btn-primary disabled:opacity-60"
            data-testid="btn-preview"
            disabled={pending || stage === "preview-pending" || (!fields.xlsxBase64 && !fields.csv.trim())}
            aria-busy={stage === "preview-pending" || pending}
            onClick={onPreview}
          >
            {stage === "preview-pending" ? "Preparing preview…" : "Preview"}
          </button>
          <button className="btn btn-secondary" data-testid="btn-reset" onClick={onReset} disabled={pending}>
            Reset
          </button>
          {stage === "preview-pending" && (
            <div
              role="progressbar"
              aria-label="Preparing preview"
              aria-busy="true"
              aria-valuetext="in progress"
              data-testid="jonas-preview-progress"
              className="relative ml-2 h-1 w-40 overflow-hidden rounded bg-stone-200"
            >
              <div className="absolute inset-y-0 left-0 w-full animate-pulse bg-club-forest" />
            </div>
          )}
        </div>
      </div>

      {submitError && (
        <div className="card card-body border-red-200 bg-red-50" data-testid="jonas-submit-error">
          <p className="text-sm text-red-800">{submitError}</p>
        </div>
      )}

      {/* ---- Preview panel ---- */}
      {previewOk && (
        <div className="card card-body space-y-4" data-testid="jonas-preview">
          <h2 className="section-title text-lg">Preview — no authority written yet</h2>

          {/* Summary grid */}
          <dl className="grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
            <SummaryRow k="Source file" v={previewOk.sourceFilename} testId="sum-file" />
            <SummaryRow k="Source system" v="Jonas" />
            <SummaryRow
              k="Source entity"
              v={previewOk.detectedEntity ?? "Not detected in source file"}
              testId="sum-entity"
            />
            <SummaryRow k="Target tenant" v={previewOk.targetTenantName} testId="sum-tenant" />
            <SummaryRow
              k="Effective date"
              v={
                previewOk.resolvedDates
                  ? `${previewOk.resolvedDates.periodEndIso} · period ${previewOk.resolvedDates.fiscalPeriodSequence} of ${previewOk.resolvedDates.fiscalYearLabel}`
                  : "Not detected — select above"
              }
              testId="sum-effective-date"
            />
            <SummaryRow k="Source-file hash" v={previewOk.sourceFileHash.slice(0, 16) + "…"} testId="sum-hash" />
            <SummaryRow k="Account count" v={String(previewOk.rowCount)} testId="sum-account-count" />
            <SummaryRow k="Mapped" v={String(previewOk.mappingCoverage.mapped)} />
            <SummaryRow k="Unmapped" v={String(previewOk.mappingCoverage.unmapped)} />
            <SummaryRow k="Description conflicts" v={String(previewOk.mappingCoverage.descriptionConflicts)} />
            <SummaryRow k="Duplicate account codes" v={String(previewOk.mappingCoverage.duplicates)} />
            <SummaryRow k="Total Debit" v={money(previewOk.reconciliation.totalDebits)} testId="sum-total-debit" />
            <SummaryRow k="Total Credit" v={money(previewOk.reconciliation.totalCredits)} testId="sum-total-credit" />
            <SummaryRow k="Difference" v={money(Math.abs(previewOk.reconciliation.delta))} testId="sum-delta" />
            <SummaryRow
              k="Balanced"
              v={previewOk.reconciliation.isBalanced ? `Yes (≤ $${previewOk.reconciliation.tolerance.toFixed(2)})` : "NO"}
              testId="sum-balanced"
            />
          </dl>

          {/* Warnings/gates */}
          {previewOk.requiresEffectiveDateSelection && !fields.effectiveDateOverride && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              This file has no reliable effective date. Select one above before committing.
            </div>
          )}

          {previewOk.requiresEntityMismatchAcknowledgement && (
            <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900" data-testid="entity-mismatch">
              <p>
                <strong>Entity mismatch.</strong> Source workbook identifies{" "}
                <em>{previewOk.detectedEntity}</em>. Target tenant is{" "}
                <em>{previewOk.targetTenantName}</em>.
              </p>
              <label className="mt-2 flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  data-testid="chk-entity-ack"
                  checked={fields.entityMismatchAcknowledged}
                  onChange={(e) => updateField("entityMismatchAcknowledged", e.target.checked)}
                />
                I have verified the mismatch and authorise importing this file into {previewOk.targetTenantName}.
              </label>
            </div>
          )}

          {previewOk.duplicateSourceFileBatch && (
            <div className="rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-900" data-testid="duplicate-file">
              <strong>Duplicate source file.</strong> An identical file was already committed on{" "}
              {previewOk.duplicateSourceFileBatch.openedAt.slice(0, 10)} (batch{" "}
              <code>{previewOk.duplicateSourceFileBatch.batchId.slice(0, 8)}…</code>). Ordinary
              commit is blocked.
            </div>
          )}

          {previewOk.existingSnapshotForPeriod && (
            <div className="rounded-md border border-orange-400 bg-orange-50 px-3 py-3 text-sm text-orange-900" data-testid="duplicate-period">
              <p className="font-semibold">AUTHORITATIVE TRIAL BALANCE ALREADY EXISTS FOR {previewOk.resolvedDates?.periodEndIso ?? "this period"}.</p>
              <p className="mt-1 text-xs">
                Existing batch <code>{previewOk.existingSnapshotForPeriod.batchId.slice(0, 8)}…</code> ·
                snapshot <code>{previewOk.existingSnapshotForPeriod.snapshotId.slice(0, 8)}…</code> ·
                committed {previewOk.existingSnapshotForPeriod.capturedAt.slice(0, 10)} ·
                source <em>{previewOk.existingSnapshotForPeriod.sourceFile ?? "unknown"}</em>.
              </p>
              <p className="mt-2 text-xs">
                Ordinary Commit is <strong>blocked</strong>. Replacement is a
                supervised accounting action: the existing snapshot is
                marked <em>rolled-back</em>, this new one becomes the
                authoritative snapshot for {previewOk.resolvedDates?.periodEndIso ?? "this period"},
                and the audit chain is preserved via <code>supersededByBatchId</code>.
              </p>
              <label className="mt-2 flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  data-testid="chk-replace"
                  checked={replaceOptIn}
                  onChange={(e) => setReplaceOptIn(e.target.checked)}
                />
                Replace Existing Trial Balance — I understand the existing authoritative snapshot will be superseded.
              </label>
            </div>
          )}

          {/* TB-HIST-2b (2026-10-01) §4 — continuity review card. */}
          {previewOk.continuity && (
            <div className="mt-4 rounded-md border border-stone-200 bg-stone-50 p-3" data-testid="preview-continuity">
              <h3 className="text-sm font-semibold">Continuity vs prior committed snapshot</h3>
              <div className="mt-1 text-xs text-stone-600">
                <div>
                  Prior snapshot: <span className="font-mono">{previewOk.continuity.priorSnapshot?.asOf.slice(0, 10) ?? "—"}</span>
                  {previewOk.continuity.priorSnapshot?.fiscalYearLabel && (
                    <> · {previewOk.continuity.priorSnapshot.fiscalYearLabel}</>
                  )}
                </div>
                {previewOk.continuity.isFiscalYearBoundary && (
                  <div className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-amber-800">
                    Fiscal year boundary — current month equals current fiscal-YTD (no subtraction from prior fiscal year).
                  </div>
                )}
                {previewOk.continuity.notes.map((n, i) => (
                  <div key={i} className="mt-1 text-stone-700">{n}</div>
                ))}
                {previewOk.continuity.divergences.length > 0 && (
                  <div className="mt-2">
                    <div className="font-semibold text-stone-700">Top P&amp;L YTD divergences (review aid, non-blocking):</div>
                    <table className="mt-1 w-full text-[11px]">
                      <thead><tr className="text-left"><th>Code</th><th>Name</th><th className="text-right">Prior YTD</th><th className="text-right">Current YTD</th><th className="text-right">Delta</th></tr></thead>
                      <tbody>
                        {previewOk.continuity.divergences.slice(0, 10).map((d) => (
                          <tr key={d.accountCode}>
                            <td className="font-mono">{d.accountCode}</td>
                            <td>{d.accountName ?? ""}</td>
                            <td className="text-right tabular-nums">{money(d.priorYtd)}</td>
                            <td className="text-right tabular-nums">{money(d.currentYtd)}</td>
                            <td className={"text-right tabular-nums " + (d.delta >= 0 ? "text-emerald-700" : "text-red-700")}>{money(d.delta)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Full account-level preview table */}
          <div>
            <h3 className="text-sm font-semibold mt-4">Account preview ({previewOk.rows.length} rows)</h3>
            <div className="mt-2 max-h-96 overflow-auto border border-stone-200 rounded-md" data-testid="preview-account-table">
              <table className="table-base text-xs w-full">
                <thead className="sticky top-0 bg-stone-50 z-10">
                  <tr>
                    <th className="w-24 text-left">Account</th>
                    <th className="text-left">Jonas description</th>
                    <th className="text-left">Spectre account</th>
                    <th className="w-28 text-left">Department</th>
                    <th className="w-20 text-left">Fund</th>
                    <th className="text-right w-28">Debit</th>
                    <th className="text-right w-28">Credit</th>
                    <th className="text-left w-24">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {previewOk.rows.map((r) => (
                    <PreviewRow key={r.lineNumber} row={r} />
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <button
              className={"btn " + (previewOk.existingSnapshotForPeriod && replaceOptIn ? "btn-danger" : "btn-primary")}
              data-testid="btn-commit"
              disabled={!canCommit || pending}
              onClick={onCommit}
            >
              {previewOk.existingSnapshotForPeriod && replaceOptIn ? "Commit REPLACEMENT" : "Commit"}
            </button>
            <button className="btn btn-secondary" data-testid="btn-reset" onClick={onReset} disabled={pending}>
              Reset
            </button>
          </div>
        </div>
      )}

      {/* ---- Post-commit receipt ---- */}
      {commitOk && (
        <div className="card card-body border-emerald-300 bg-emerald-50" data-testid="jonas-commit-receipt">
          <h2 className="section-title text-lg text-emerald-900">Trial Balance committed</h2>
          <dl className="mt-3 grid grid-cols-1 gap-2 text-xs md:grid-cols-2">
            <SummaryRow k="Effective date" v={commitOk.periodEndIso} testId="receipt-effective-date" />
            <SummaryRow k="Batch id" v={commitOk.batchId} testId="receipt-batch-id" />
            <SummaryRow k="Snapshot id" v={commitOk.snapshotId} testId="receipt-snapshot-id" />
            <SummaryRow k="Source file" v={commitOk.sourceFile} testId="receipt-source-file" />
            <SummaryRow k="Source hash" v={commitOk.sourceFileHash} testId="receipt-source-hash" />
            <SummaryRow k="Account count" v={String(commitOk.rowCount)} testId="receipt-account-count" />
            <SummaryRow k="Total Debit" v={money(commitOk.totalDebits)} testId="receipt-total-debit" />
            <SummaryRow k="Total Credit" v={money(commitOk.totalCredits)} testId="receipt-total-credit" />
            <SummaryRow k="Difference" v={money(Math.abs(commitOk.delta))} testId="receipt-delta" />
            <SummaryRow k="Committed at" v={commitOk.committedAt.slice(0, 19).replace("T", " ")} testId="receipt-committed-at" />
            <SummaryRow k="Committed by" v={commitOk.committedByUserId} testId="receipt-committed-by" />
            {commitOk.supersededBatchId && (
              <SummaryRow k="Superseded batch" v={commitOk.supersededBatchId} testId="receipt-superseded" />
            )}
          </dl>
          <div className="mt-4 flex flex-wrap gap-2">
            <a className="btn btn-secondary" href={commitOk.links.trialBalance} data-testid="receipt-link-tb">
              View Trial Balance
            </a>
            <a className="btn btn-secondary" href={commitOk.links.balanceSheet} data-testid="receipt-link-bs">
              View Balance Sheet
            </a>
            <a className="btn btn-secondary" href={commitOk.links.monthlyBoardPackage} data-testid="receipt-link-mbp">
              View Monthly Board Reporting Package
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryRow({ k, v, testId }: { k: string; v: string; testId?: string }) {
  return (
    <div className="flex justify-between border-b border-stone-100 py-1">
      <dt className="text-stone-500">{k}</dt>
      <dd className="text-stone-800 font-mono text-right" data-testid={testId}>{v}</dd>
    </div>
  );
}

function PreviewRow({ row }: { row: JonasImportPreviewRow }) {
  const status = row.mappingStatus;
  const statusColor =
    status === "mapped" ? "text-emerald-700"
    : status === "description-conflict" ? "text-amber-700"
    : status === "unmapped" ? "text-red-700"
    : "text-red-700";
  // TB-HIST-2b (2026-10-01) §6 — surface Department / Fund per row.
  const deptColor =
    row.departmentStatus === "ok" ? "text-emerald-700"
    : row.departmentStatus === "n/a" ? "text-stone-400"
    : "text-red-700";
  const deptLabel =
    row.departmentStatus === "missing-required" ? "missing (REQUIRED)"
    : row.departmentStatus === "unknown-dept" ? `unknown: ${row.department ?? ""}`
    : (row.department ?? "—");
  return (
    <tr data-testid={`row-${row.accountCode}`}>
      <td className="font-mono">{row.accountCode}</td>
      <td>{row.jonasDescription}</td>
      <td>{row.spectreAccountName ?? <em className="text-red-700">no match</em>}</td>
      <td className={deptColor} title={`Department status: ${row.departmentStatus}`}>{deptLabel}</td>
      <td className="text-stone-700">{row.fund ?? "—"}</td>
      <td className="text-right tabular-nums">{row.debit ? money(row.debit) : ""}</td>
      <td className="text-right tabular-nums">{row.credit ? money(row.credit) : ""}</td>
      <td className={statusColor}>{status}</td>
    </tr>
  );
}
