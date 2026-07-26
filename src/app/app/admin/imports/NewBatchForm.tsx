"use client";

// New Batch form on /app/admin/imports.
//
// Three input affordances:
//   1. Domain selector — drives which template metadata the helper
//      card renders + which validator the server uses.
//   2. File upload — accepts .xlsx (Chart of Accounts) AND .csv
//      (every domain, plus legacy COA workflows). The server
//      auto-detects the format by extension + magic bytes.
//   3. CSV textarea — paste alternative for ERP exports that arrive
//      as text on the clipboard. Paste path is CSV-only by design;
//      XLSX users use the file picker.
//
// Mutual exclusion: only one of (file, paste) is allowed per
// submission. The client surfaces a visible warning and disables
// the Create Batch button when both are populated; the server
// action enforces the same rule as the authoritative gate.
//
// The form submits via the server action — file uploads round-trip
// as a multipart/form-data `csvFile` field that the action reads
// off `formData.get("csvFile") instanceof File`.

import { useRef, useState, useTransition } from "react";

import {
  IMPORT_TEMPLATE_METADATA,
  supportsXlsx,
  type ImportDomain,
} from "@/lib/imports/templates";

import { createBatchAction } from "./_actions";
import { ImportTemplateHelper } from "./ImportTemplateHelper";

const DOMAINS = Object.keys(IMPORT_TEMPLATE_METADATA) as ImportDomain[];

export function NewBatchForm() {
  const [domain, setDomain] = useState<ImportDomain>("MEMBERS");
  const [pasted, setPasted] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const formRef = useRef<HTMLFormElement | null>(null);

  const metadata = IMPORT_TEMPLATE_METADATA[domain];
  const hasFile = fileName !== null;
  const hasPaste = pasted.trim().length > 0;
  const bothProvided = hasFile && hasPaste;
  const nothingProvided = !hasFile && !hasPaste;
  const canSubmit = !bothProvided && !nothingProvided && !isPending;

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setFileName(file ? file.name : null);
  }

  function clearFile() {
    if (fileInputRef.current) fileInputRef.current.value = "";
    setFileName(null);
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!canSubmit) return;
    const fd = new FormData(e.currentTarget);
    startTransition(async () => {
      await createBatchAction(fd);
      // The server action calls revalidatePath. Clear the local
      // state so the form is ready for the next batch.
      setPasted("");
      clearFile();
    });
  }

  return (
    <form
      ref={formRef}
      onSubmit={handleSubmit}
      className="mt-3 space-y-4"
      encType="multipart/form-data"
      data-testid="new-batch-form"
    >
      {/* Domain selector --------------------------------------------------*/}
      <div>
        <label
          htmlFor="new-batch-domain"
          className="block text-xs uppercase tracking-wide text-stone-500"
        >
          Domain
        </label>
        <select
          id="new-batch-domain"
          name="domain"
          className="input mt-1 w-full text-sm"
          value={domain}
          onChange={(e) => setDomain(e.target.value as ImportDomain)}
          data-testid="new-batch-domain-select"
        >
          {DOMAINS.map((d) => (
            <option key={d} value={d}>
              {IMPORT_TEMPLATE_METADATA[d].displayName}
            </option>
          ))}
        </select>
      </div>

      {/* Per-domain helper card ------------------------------------------*/}
      <ImportTemplateHelper metadata={metadata} />

      {/* File upload ------------------------------------------------------*/}
      {/* Founder rule 2026-06-30 v14.1 — the picker's accept
          attribute AND user-facing copy come from the shared
          `supportsXlsx(domain)` helper so COA, Opening Trial
          Balance, and any future XLSX-capable domain all opt in
          from one central switch. The server-side parser auto-
          detects XLSX vs CSV by file extension + OPC magic bytes. */}
      {(() => {
        const xlsxOk = supportsXlsx(metadata.domain);
        const acceptAttr = xlsxOk
          ? ".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
          : ".csv,text/csv";
        const labelText = xlsxOk
          ? `Upload ${metadata.displayName} (.xlsx or .csv)`
          : "Upload CSV file";
        const clearHint = xlsxOk
          ? "Clear the pasted CSV below to upload a workbook or file instead."
          : "Clear the pasted CSV below to upload a file instead.";
        return (
          <div>
            <label
              htmlFor="new-batch-file"
              className="block text-xs uppercase tracking-wide text-stone-500"
              data-testid="new-batch-file-label"
            >
              {labelText}
            </label>
            <div className="mt-1 flex items-center gap-3">
              <input
                ref={fileInputRef}
                id="new-batch-file"
                name="csvFile"
                type="file"
                accept={acceptAttr}
                onChange={handleFileChange}
                disabled={hasPaste}
                aria-disabled={hasPaste}
                className="block w-full text-xs text-stone-700 file:mr-3 file:rounded file:border-0 file:bg-stone-200 file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-stone-800 hover:file:bg-stone-300 disabled:opacity-40"
                data-testid="new-batch-file-input"
              />
              {fileName && (
                <button
                  type="button"
                  className="btn btn-sm btn-secondary shrink-0"
                  onClick={clearFile}
                  data-testid="new-batch-file-clear"
                >
                  Clear
                </button>
              )}
            </div>
            {fileName && (
              <p className="mt-1 text-xs text-stone-600" data-testid="new-batch-file-name">
                Selected: <span className="font-mono">{fileName}</span>
              </p>
            )}
            {hasPaste && !hasFile && (
              <p className="mt-1 text-xs text-stone-500">{clearHint}</p>
            )}
          </div>
        );
      })()}

      {/* Separator -------------------------------------------------------*/}
      <div className="flex items-center gap-3 text-xs uppercase tracking-wide text-stone-400">
        <span className="h-px flex-1 bg-stone-200" />
        <span>or</span>
        <span className="h-px flex-1 bg-stone-200" />
      </div>

      {/* CSV textarea ----------------------------------------------------*/}
      <div>
        <label
          htmlFor="new-batch-paste"
          className="block text-xs uppercase tracking-wide text-stone-500"
        >
          Paste CSV content (header row required)
        </label>
        <textarea
          id="new-batch-paste"
          name="csv"
          rows={8}
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
          disabled={hasFile}
          aria-disabled={hasFile}
          className="input mt-1 w-full font-mono text-xs disabled:bg-stone-100 disabled:opacity-60"
          placeholder={metadata.headers.join(",")}
          data-testid="new-batch-paste"
        />
        {hasFile && !hasPaste && (
          <p className="mt-1 text-xs text-stone-500">
            Clear the uploaded file above to paste CSV instead.
          </p>
        )}
      </div>

      {/* Mutual-exclusion warning ----------------------------------------*/}
      {bothProvided && (
        <div
          className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800"
          role="alert"
          data-testid="new-batch-both-provided-warning"
        >
          {metadata.domain === "COA"
            ? "Use only one input source — either upload a workbook / CSV file OR paste CSV content, not both. Clear one to continue."
            : "Use only one input source — either upload a CSV file OR paste CSV content, not both. Clear one to continue."}
        </div>
      )}

      {/* Submit ----------------------------------------------------------*/}
      <div className="flex items-center gap-3">
        <button
          type="submit"
          className="btn btn-primary"
          disabled={!canSubmit}
          aria-disabled={!canSubmit}
          data-testid="new-batch-submit"
        >
          {isPending ? "Creating batch…" : "Create batch"}
        </button>
        {nothingProvided && (
          <span className="text-xs text-stone-500">
            Upload a file or paste CSV content to enable Create batch.
          </span>
        )}
      </div>
    </form>
  );
}
