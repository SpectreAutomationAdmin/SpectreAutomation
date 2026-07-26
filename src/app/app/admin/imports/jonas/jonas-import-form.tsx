"use client";

// Jonas GL import — client-side state machine.
//
// Drives the multi-step workflow:
//
//   idle  →  preview-pending  →  preview-ready  →  commit-pending  →  commit-done
//
// Server-side parse + reconciliation is the source of truth. The
// client never trusts its own parse — every state transition goes
// through a server action so audit, tenancy, and validation live
// server-side.
//
// Reliability over polish: progress indicators are textual; errors
// are surfaced verbatim; the commit button is disabled when the
// preview reports problems the operator hasn't acknowledged.

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  commitJonasImport,
  previewJonasImport,
  type JonasImportCommitResult,
  type JonasImportPreview,
} from "./actions";

type Stage = "idle" | "preview-pending" | "preview-ready" | "commit-pending" | "commit-done";

type FormFields = {
  csv: string;
  filename: string;
  periodStart: string;
  periodEnd: string;
  fiscalYearLabel: string;
  fiscalPeriodSequence: string;
};

const EMPTY_FIELDS: FormFields = {
  csv: "",
  filename: "",
  periodStart: "",
  periodEnd: "",
  fiscalYearLabel: "",
  fiscalPeriodSequence: "",
};

function buildFormData(fields: FormFields): FormData {
  const fd = new FormData();
  fd.set("csv", fields.csv);
  fd.set("filename", fields.filename || "pasted.csv");
  fd.set("periodStart", fields.periodStart);
  fd.set("periodEnd", fields.periodEnd);
  fd.set("fiscalYearLabel", fields.fiscalYearLabel);
  fd.set("fiscalPeriodSequence", fields.fiscalPeriodSequence);
  return fd;
}

function formatMoney(amount: number): string {
  return amount.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
  });
}

export function JonasImportForm() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("idle");
  const [fields, setFields] = useState<FormFields>(EMPTY_FIELDS);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [preview, setPreview] = useState<JonasImportPreview | null>(null);
  const [commit, setCommit] = useState<JonasImportCommitResult | null>(null);
  const [pending, startTransition] = useTransition();

  // ---- File reader ----
  function onFileChosen(file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      setFields((f) => ({ ...f, csv: text, filename: file.name }));
      // Reset downstream state.
      setStage("idle");
      setPreview(null);
      setCommit(null);
    };
    reader.readAsText(file);
  }

  // ---- Field setter ----
  function updateField<K extends keyof FormFields>(key: K, value: string) {
    setFields((f) => ({ ...f, [key]: value }));
    // Any field change invalidates a prior preview.
    if (stage === "preview-ready") {
      setStage("idle");
      setPreview(null);
    }
  }

  // ---- Preview action ----
  function onPreview() {
    setSubmitError(null);
    setCommit(null);
    setStage("preview-pending");
    startTransition(async () => {
      const result = await previewJonasImport(buildFormData(fields));
      if ("error" in result) {
        setSubmitError(result.error);
        setStage("idle");
        return;
      }
      setPreview(result);
      setStage("preview-ready");
    });
  }

  // ---- Commit action ----
  function onCommit() {
    setSubmitError(null);
    setStage("commit-pending");
    startTransition(async () => {
      const result = await commitJonasImport(buildFormData(fields));
      if ("error" in result) {
        setSubmitError(result.error);
        setStage("preview-ready");
        return;
      }
      setCommit(result);
      setStage("commit-done");
      // Refresh server-side history rail.
      router.refresh();
    });
  }

  // ---- Reset ----
  function onReset() {
    setFields(EMPTY_FIELDS);
    setStage("idle");
    setSubmitError(null);
    setPreview(null);
    setCommit(null);
  }

  // Commit gate.
  const canCommit =
    stage === "preview-ready" &&
    preview?.status === "ok" &&
    preview.reconciliation.isBalanced &&
    preview.mappingCoverage.unmapped === 0;

  return (
    <div className="space-y-4">
      <div className="card card-body" data-testid="jonas-import-inputs">
        <h2 className="section-title text-lg">New Jonas GL import</h2>
        <p className="mt-1 text-xs text-stone-500">
          Paste or upload the Jonas trial balance CSV, then preview.
          Period dates and fiscal-year metadata are read from the Jonas
          heading and your Club Settings — no manual entry required.
        </p>

        {/* Jonas-native detected — read-only "Detected period" summary.
         *  Replaces the four manual date/fiscal inputs entirely. */}
        {preview?.status === "ok" && preview.inferredDates ? (
          <div
            data-testid="jonas-detected-period"
            className="mt-4 rounded-md border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-900"
          >
            <p className="text-[10px] uppercase tracking-[0.18em] text-emerald-800/70">
              Detected period
            </p>
            <p
              className="mt-1 font-medium"
              data-testid="jonas-detected-period-summary"
            >
              {preview.inferredDates.fiscalYearLabel} · Period{" "}
              {preview.inferredDates.fiscalPeriodSequence} ·{" "}
              <span data-testid="jonas-detected-period-start">
                {preview.inferredDates.periodStartIso}
              </span>
              {" "}–{" "}
              <span data-testid="jonas-detected-period-end">
                {preview.inferredDates.periodEndIso}
              </span>
            </p>
            <p className="mt-1 text-xs opacity-80">
              Inferred from the Jonas CSV heading + your club's fiscal-year-end
              policy in Club Settings.
            </p>
          </div>
        ) : null}

        {/* Non-Jonas (spectre-normalised) preview returned but no
         *  inferred dates — surface a hint that manual fields are
         *  needed and auto-open the Advanced panel via its `open`
         *  attribute below. */}
        {preview?.status === "ok" && !preview.inferredDates ? (
          <div
            data-testid="jonas-manual-required-hint"
            className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            <p className="font-medium">
              This CSV is not a Jonas-native trial balance — period dates can't be inferred.
            </p>
            <p className="mt-1 text-xs">
              Fill in the period and fiscal-year fields in <em>Advanced /
              manual import options</em> below, then preview again.
            </p>
          </div>
        ) : null}

        {/* Advanced / manual import options — collapsed by default.
         *  Used for spectre-normalised CSVs that lack a Jonas heading.
         *  Opens automatically when preview returns no inferred dates.
         *  The four inputs always render in the DOM (so the
         *  testids resolve for e2e + so React state stays consistent),
         *  but they're inside a <details> so the founder's primary
         *  Jonas-native workflow never sees them. */}
        <details
          data-testid="jonas-manual-options"
          className="mt-4 rounded-md border border-stone-200 bg-stone-50 px-3 py-2 text-sm"
          open={
            preview?.status === "ok" && !preview.inferredDates
          }
        >
          <summary
            data-testid="jonas-manual-options-summary"
            className="cursor-pointer text-xs uppercase tracking-[0.18em] text-stone-600"
          >
            Advanced / manual import options
          </summary>
          <p className="mt-2 text-xs text-stone-500">
            Only needed for non-Jonas (spectre-normalised) CSVs that don't
            carry a "Trial Balance for <em>Month, Year</em>" heading.
            For raw Jonas exports, leave these blank.
          </p>
          <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
            <div>
              <label className="block text-xs uppercase text-stone-500">Period start</label>
              <input
                type="date"
                data-testid="field-period-start"
                value={fields.periodStart}
                onChange={(e) => updateField("periodStart", e.target.value)}
                className="input mt-1 text-sm w-full"
              />
            </div>
            <div>
              <label className="block text-xs uppercase text-stone-500">Period end</label>
              <input
                type="date"
                data-testid="field-period-end"
                value={fields.periodEnd}
                onChange={(e) => updateField("periodEnd", e.target.value)}
                className="input mt-1 text-sm w-full"
              />
            </div>
            <div>
              <label className="block text-xs uppercase text-stone-500">Fiscal year label</label>
              <input
                type="text"
                placeholder="FY2026"
                data-testid="field-fiscal-year"
                value={fields.fiscalYearLabel}
                onChange={(e) => updateField("fiscalYearLabel", e.target.value)}
                className="input mt-1 text-sm w-full"
              />
            </div>
            <div>
              <label className="block text-xs uppercase text-stone-500">Fiscal period (1–12)</label>
              <input
                type="number"
                min={1}
                max={12}
                placeholder="5"
                data-testid="field-fiscal-period"
                value={fields.fiscalPeriodSequence}
                onChange={(e) => updateField("fiscalPeriodSequence", e.target.value)}
                className="input mt-1 text-sm w-full"
              />
            </div>
          </div>
        </details>

        <div className="mt-4">
          <label className="block text-xs uppercase text-stone-500">CSV file</label>
          <input
            type="file"
            accept=".csv,text/csv"
            data-testid="field-csv-file"
            onChange={(e) => onFileChosen(e.target.files?.[0] ?? null)}
            className="mt-1 text-sm"
          />
          {fields.filename && (
            <p className="mt-1 text-xs text-stone-500" data-testid="field-csv-filename">
              Loaded: {fields.filename}
            </p>
          )}
        </div>

        <div className="mt-4">
          <label className="block text-xs uppercase text-stone-500">
            …or paste CSV directly (header row required)
          </label>
          <textarea
            rows={8}
            data-testid="field-csv-textarea"
            value={fields.csv}
            onChange={(e) => updateField("csv", e.target.value)}
            placeholder="AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod
1010,Cash,180000,2000000,FY2026,5"
            className="input mt-1 text-xs font-mono w-full"
          />
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            className="btn btn-primary"
            data-testid="btn-preview"
            disabled={pending || !fields.csv.trim()}
            onClick={onPreview}
          >
            {stage === "preview-pending" ? "Validating…" : "Preview"}
          </button>
          {stage !== "idle" && (
            <button
              className="btn btn-secondary"
              data-testid="btn-reset"
              disabled={pending}
              onClick={onReset}
            >
              Reset
            </button>
          )}
        </div>
      </div>

      {submitError && (
        <div
          className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          data-testid="submit-error"
        >
          {submitError}
        </div>
      )}

      {preview && <PreviewPanel preview={preview} onCommit={onCommit} canCommit={canCommit} stage={stage} />}

      {commit && <CommitSummary commit={commit} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview panel
// ---------------------------------------------------------------------------

function PreviewPanel({
  preview,
  canCommit,
  stage,
  onCommit,
}: {
  preview: JonasImportPreview;
  canCommit: boolean;
  stage: Stage;
  onCommit: () => void;
}) {
  if (preview.status === "validation-failed") {
    return (
      <div className="card card-body" data-testid="preview-validation-failed">
        <h2 className="section-title text-lg text-red-700">Validation failed</h2>
        <p className="mt-1 text-xs text-stone-500">
          The CSV could not be parsed. Fix the errors below and re-preview.
        </p>
        <ul className="mt-3 list-disc pl-5 text-sm text-red-700">
          {preview.fileErrors.map((e, i) => (
            <li key={`file-${i}`}>[file:{e.kind}] {e.message}</li>
          ))}
          {preview.rowErrors.map((e, i) => (
            <li key={`row-${i}`}>
              [line {e.lineNumber}{e.column ? ` · ${e.column}` : ""}] {e.message}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const reconciliationOk = preview.reconciliation.isBalanced;
  const mappingOk = preview.mappingCoverage.unmapped === 0;

  return (
    <div className="card card-body" data-testid="preview-ok">
      <div className="flex items-baseline justify-between">
        <h2 className="section-title text-lg">Preview</h2>
        <span className="text-xs text-stone-500">No data has been written yet.</span>
      </div>

      <dl className="mt-3 grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
        <div>
          <dt className="text-xs uppercase text-stone-500">Rows parsed</dt>
          <dd data-testid="preview-row-count">{preview.rowCount}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-stone-500">Accounts mapped</dt>
          <dd data-testid="preview-mapped-count">
            {preview.mappingCoverage.mapped} / {preview.mappingCoverage.mapped + preview.mappingCoverage.unmapped}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-stone-500">Reconciliation</dt>
          <dd data-testid="preview-reconciliation">
            {reconciliationOk ? "PASS" : "FAIL"} · Δ {formatMoney(preview.reconciliation.delta)}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-stone-500">Total debits</dt>
          <dd data-testid="preview-total-debits">{formatMoney(preview.reconciliation.totalDebits)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-stone-500">Total credits</dt>
          <dd data-testid="preview-total-credits">{formatMoney(preview.reconciliation.totalCredits)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase text-stone-500">Warnings</dt>
          <dd>{preview.warnings.length}</dd>
        </div>
      </dl>

      {preview.unmappedAccounts.length > 0 && (
        <div
          className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          data-testid="preview-unmapped"
        >
          <p className="font-medium">
            {preview.unmappedAccounts.length} account(s) have no mapping rule. Commit is blocked.
          </p>
          <ul className="mt-1 list-disc pl-5 text-xs">
            {preview.unmappedAccounts.slice(0, 10).map((u, i) => (
              <li key={i}>
                Line {u.lineNumber} · account {u.accountNumber} · {u.accountDescription}
              </li>
            ))}
            {preview.unmappedAccounts.length > 10 && (
              <li>…and {preview.unmappedAccounts.length - 10} more.</li>
            )}
          </ul>
        </div>
      )}

      {!reconciliationOk && (
        <div
          className="mt-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700"
          data-testid="preview-unbalanced"
        >
          Trial balance does NOT reconcile. Commit is blocked.
        </div>
      )}

      {preview.existingSnapshotForPeriod && (
        <div
          className="mt-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          data-testid="preview-duplicate-warning"
        >
          <p className="font-medium">Duplicate-period warning</p>
          <p className="mt-1 text-xs">
            A trial-balance snapshot already exists for this club at this period
            ({preview.existingSnapshotForPeriod.reportingPeriod ?? "—"}, imported{" "}
            {new Date(preview.existingSnapshotForPeriod.capturedAt).toLocaleString()}
            {preview.existingSnapshotForPeriod.sourceFile
              ? ` from ${preview.existingSnapshotForPeriod.sourceFile}`
              : ""}).
            A bit-identical re-import will be a no-op. A revised CSV will write
            a replacement snapshot; the prior snapshot stays for audit.
          </p>
        </div>
      )}

      {preview.warnings.length > 0 && (
        <details className="mt-4 text-xs text-stone-600">
          <summary className="cursor-pointer">{preview.warnings.length} parser warning(s)</summary>
          <ul className="mt-1 list-disc pl-5">
            {preview.warnings.map((w, i) => (
              <li key={i}>
                [line {w.lineNumber}{w.column ? ` · ${w.column}` : ""}] {w.message}
              </li>
            ))}
          </ul>
        </details>
      )}

      <div className="mt-4 flex flex-wrap gap-2">
        <button
          className="btn btn-primary"
          data-testid="btn-commit"
          disabled={!canCommit || stage === "commit-pending"}
          onClick={onCommit}
        >
          {stage === "commit-pending" ? "Importing…" : "Commit import"}
        </button>
        <span className="self-center text-xs text-stone-500">
          {canCommit
            ? "Click commit to persist this trial balance to the Reporting Ledger."
            : "Resolve the blockers above to enable commit."}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Commit summary
// ---------------------------------------------------------------------------

function CommitSummary({ commit }: { commit: JonasImportCommitResult }) {
  const isSuccess = commit.status === "succeeded";
  const isDuplicateNoop = commit.status === "duplicate-no-op";
  const tone = isSuccess
    ? "border-emerald-300 bg-emerald-50 text-emerald-900"
    : isDuplicateNoop
      ? "border-stone-300 bg-stone-50 text-stone-700"
      : "border-red-300 bg-red-50 text-red-800";

  return (
    <div className={`card card-body ${tone}`} data-testid="commit-summary">
      <h2 className="section-title text-lg">
        Import result: <span data-testid="commit-status">{commit.status.toUpperCase()}</span>
      </h2>
      <dl className="mt-3 grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
        <div>
          <dt className="text-xs uppercase opacity-60">Snapshot ID</dt>
          <dd className="font-mono text-xs break-all" data-testid="commit-snapshot-id">
            {commit.snapshotId ?? "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase opacity-60">Batch ID</dt>
          <dd className="font-mono text-xs break-all" data-testid="commit-batch-id">
            {commit.batchId || "—"}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase opacity-60">Rows persisted</dt>
          <dd data-testid="commit-row-count">{commit.rowCount}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase opacity-60">Replaced prior snapshot?</dt>
          <dd>{commit.replacedCount > 0 ? "Yes" : "No"}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase opacity-60">Reconciliation</dt>
          <dd>
            {commit.reconciliation.isBalanced ? "PASS" : "FAIL"} · Δ{" "}
            {formatMoney(commit.reconciliation.delta)}
          </dd>
        </div>
        <div>
          <dt className="text-xs uppercase opacity-60">Mapping coverage</dt>
          <dd>
            {commit.mappingCoverage.mapped} mapped, {commit.mappingCoverage.unmapped} unmapped
          </dd>
        </div>
      </dl>
      {commit.notes && (
        <p className="mt-3 text-xs opacity-80" data-testid="commit-notes">
          {commit.notes}
        </p>
      )}
    </div>
  );
}
