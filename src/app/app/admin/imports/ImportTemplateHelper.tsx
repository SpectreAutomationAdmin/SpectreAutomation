"use client";

// Reusable helper card for the New Batch form. Renders the per-domain
// guidance an admin needs to populate a CSV without opening the docs:
//
//   • short blurb describing what the domain imports
//   • per-column field documentation (name, description, example,
//     required vs optional)
//   • "Download Template" → emits a .csv with the header row + the
//     domain's sample rows
//   • "Copy Header Row" → puts just the comma-separated header row
//     on the clipboard (for admins exporting from another ERP)
//   • "View Sample" → expands the in-page preview of the same sample
//     rows in a scrollable table
//
// This component is intentionally domain-agnostic: it consumes a
// single `ImportTemplateMetadata` and renders the same shape for
// MEMBERS, VENDORS, COA, etc. The COA-specific column docs come
// from the metadata, not from a special-case branch here.

import { useState } from "react";

import {
  buildHeaderRowCsv,
  buildTemplateCsv,
  templateFilename,
  type ImportTemplateMetadata,
} from "@/lib/imports/templates";

type Props = {
  metadata: ImportTemplateMetadata;
};

export function ImportTemplateHelper({ metadata }: Props) {
  const [showSample, setShowSample] = useState(false);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");

  // Founder spec 2026-07-04: the COA download is a multi-sheet XLSX
  // workbook (Instructions + import sheet + reference tabs for
  // Types / Categories / FS Groups / Departments). Every other
  // domain keeps the original CSV path until each is upgraded the
  // same way.
  async function handleDownload() {
    if (metadata.domain === "COA") {
      const res = await fetch("/api/imports/coa/template", {
        credentials: "same-origin",
      });
      if (!res.ok) {
        // eslint-disable-next-line no-console
        console.error("COA template download failed", res.status);
        return;
      }
      // Server sets a descriptive Content-Disposition; pull it
      // through to the browser via the standard blob → anchor
      // pattern.
      const disposition = res.headers.get("content-disposition") ?? "";
      const m = /filename="([^"]+)"/.exec(disposition);
      const fileName = m?.[1] ?? "Spectre-Chart-of-Accounts-Template.xlsx";
      const blob = await res.blob();
      triggerDownload(blob, fileName);
      return;
    }
    const csv = buildTemplateCsv(metadata);
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    triggerDownload(blob, templateFilename(metadata));
  }

  function triggerDownload(blob: Blob, fileName: string) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  async function handleCopyHeaders() {
    const headerRow = buildHeaderRowCsv(metadata);
    try {
      await navigator.clipboard.writeText(headerRow);
      setCopyStatus("copied");
      setTimeout(() => setCopyStatus("idle"), 1800);
    } catch {
      setCopyStatus("failed");
      setTimeout(() => setCopyStatus("idle"), 2400);
    }
  }

  return (
    <section
      className="mt-4 rounded-md border border-stone-200 bg-stone-50 p-4"
      data-testid={`import-template-helper-${metadata.domain}`}
      aria-label={`${metadata.displayName} template helper`}
    >
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-stone-800">
            {metadata.displayName} template
          </h3>
          <p className="mt-0.5 text-xs text-stone-600">{metadata.blurb}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={handleDownload}
            data-testid="template-download"
          >
            {metadata.domain === "COA"
              ? "Download Excel Template"
              : "Download Template (.csv)"}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={handleCopyHeaders}
            data-testid="template-copy-headers"
            aria-live="polite"
          >
            {copyStatus === "copied"
              ? "Copied!"
              : copyStatus === "failed"
                ? "Copy failed"
                : "Copy Header Row"}
          </button>
          <button
            type="button"
            className="btn btn-sm btn-secondary"
            onClick={() => setShowSample((s) => !s)}
            data-testid="template-toggle-sample"
            aria-expanded={showSample}
          >
            {showSample ? "Hide Sample" : "View Sample"}
          </button>
        </div>
      </header>

      <dl
        className="mt-4 grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2"
        data-testid="template-field-docs"
      >
        {metadata.fields.map((f) => (
          <div key={f.name}>
            <dt className="font-mono text-xs font-semibold text-stone-800">
              {f.name}
              {f.required ? (
                <span className="ml-1 text-rose-700" aria-label="required">*</span>
              ) : (
                <span className="ml-1 text-xs font-normal text-stone-500">(optional)</span>
              )}
            </dt>
            <dd className="mt-0.5 text-xs text-stone-600">
              {f.description}
              {f.example && (
                <>
                  {" "}
                  <span className="text-stone-500">Example: </span>
                  <span className="font-mono text-stone-700">{f.example}</span>
                </>
              )}
            </dd>
          </div>
        ))}
      </dl>

      {showSample && (
        <div className="mt-4 overflow-x-auto" data-testid="template-sample-preview">
          <table className="table-base text-xs">
            <thead>
              <tr>
                {metadata.headers.map((h) => (
                  <th key={h} className="font-mono">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {metadata.sampleRows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td key={j} className="font-mono">
                      {cell === "" ? <span className="text-stone-400">—</span> : cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
