"use client";

// COA-MAP-2B (2026-10-06) — the canonical Mapping Reporting Impact
// panel.  Extracted from the Mapping Studio client so BOTH entry
// points — /app/admin/coa (Account List) and /app/admin/coa-mapping
// (Mapping Studio) — mount EXACTLY the same panel.  There is one
// preview UI; one effective-date UX; one apply button.
//
// The panel is pure UI — it receives the preview payload the caller
// already fetched from /api/admin/coa-mapping/preview, plus the
// Apply callback.  The caller owns the fetching + the final apply
// request so neither surface duplicates mutation logic.

import { useState } from "react";

export type MappingPreviewResult = {
  accountNumber: string;
  accountName: string;
  currentFsGroup: { id: string; name: string; statement: string } | null;
  targetFsGroup: { id: string; name: string; statement: string };
  rows: Array<{
    key: string;
    label: string;
    beforeLabel: string;
    afterLabel: string;
    deltaLabel: string;
  }>;
  note: string;
};

type EffectiveMode = "current-period" | "fiscal-year" | "custom";

export function MappingPreviewPanel(props: {
  preview: MappingPreviewResult;
  errorText: string | null;
  confirmWarnings: boolean;
  applying: boolean;
  currentPeriodIso: string;
  fiscalYearIso: string;
  todayIso: string;
  onApply: (effectiveFromISO: string) => Promise<void>;
  onCancel: () => void;
  /** Optional testid override — defaults to coa-mapping-preview. */
  testid?: string;
}) {
  const collapsePeriodAndFiscalYear = props.currentPeriodIso === props.fiscalYearIso;
  const [mode, setMode] = useState<EffectiveMode>("current-period");
  const [customIso, setCustomIso] = useState<string>(props.todayIso);
  const effectiveFromIso =
    mode === "current-period" ? props.currentPeriodIso
    : mode === "fiscal-year" ? props.fiscalYearIso
    : customIso;

  const prettyDate = (iso: string) => {
    const [y, m, d] = iso.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, {
      year: "numeric", month: "long", day: "numeric", timeZone: "UTC",
    });
  };

  const effectiveFromDate = new Date(effectiveFromIso);
  const todayDate = new Date(props.todayIso);
  const isHistorical = effectiveFromDate.getTime() < todayDate.getTime();
  const historicalNote = isHistorical
    ? `This change will update unpublished reporting from ${prettyDate(effectiveFromIso)} forward. ` +
      `Published Board packages will not change.`
    : null;

  const currentLabel = props.preview.currentFsGroup?.name ?? "Unmapped";
  const proposedLabel = props.preview.targetFsGroup.name;
  const testid = props.testid ?? "coa-mapping-preview";

  return (
    <section className="card" data-testid={testid}>
      <div className="card-body space-y-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
          Reporting impact
        </h2>
        <div className="space-y-1">
          <div className="text-xs text-stone-500">
            <span className="font-mono tabular-nums">{props.preview.accountNumber}</span>
            {" · "}
            {props.preview.accountName}
          </div>
          <div className="text-sm">
            <span className="text-stone-500">Current</span>
            {" · "}
            <span className="text-stone-900">{currentLabel}</span>
          </div>
          <div className="text-sm">
            <span className="text-stone-500">Proposed</span>
            {" · "}
            <span className="font-semibold text-stone-900">{proposedLabel}</span>
          </div>
        </div>
        <table className="table-base w-full text-xs">
          <thead>
            <tr><th className="text-left">Metric</th><th className="text-left">Before</th><th className="text-left">After</th></tr>
          </thead>
          <tbody>
            {props.preview.rows.map((r) => (
              <tr key={r.key} data-testid={`coa-mapping-preview-row-${r.key}`}>
                <td className="text-left">{r.label}</td>
                <td className="text-left">{humanizeLabel(r.beforeLabel)}</td>
                <td className="text-left">{humanizeLabel(r.afterLabel)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="text-xs text-stone-600">
          {props.preview.rows.map((r) => (
            <li key={`delta-${r.key}`}>{humanizeLabel(r.deltaLabel)}</li>
          ))}
        </ul>

        <fieldset className="rounded border border-stone-200 p-3" data-testid="coa-mapping-preview-effective-fieldset">
          <legend className="px-1 text-[11px] font-semibold uppercase tracking-[0.14em] text-stone-500">
            Apply this mapping from
          </legend>
          <label className="mt-1 flex items-start gap-2 text-xs">
            <input
              type="radio"
              name="effective-mode"
              checked={mode === "current-period"}
              onChange={() => setMode("current-period")}
              data-testid="coa-mapping-effective-current-period"
            />
            <span>
              <strong>
                {collapsePeriodAndFiscalYear
                  ? "Current reporting period / fiscal year"
                  : "Current reporting period"}
              </strong>
              <br />
              <span className="text-stone-500">{prettyDate(props.currentPeriodIso)}</span>
            </span>
          </label>
          {!collapsePeriodAndFiscalYear && (
            <label className="mt-1 flex items-start gap-2 text-xs">
              <input
                type="radio"
                name="effective-mode"
                checked={mode === "fiscal-year"}
                onChange={() => setMode("fiscal-year")}
                data-testid="coa-mapping-effective-fiscal-year"
              />
              <span>
                <strong>Beginning of fiscal year</strong>
                <br />
                <span className="text-stone-500">{prettyDate(props.fiscalYearIso)}</span>
              </span>
            </label>
          )}
          <label className="mt-1 flex items-start gap-2 text-xs">
            <input
              type="radio"
              name="effective-mode"
              checked={mode === "custom"}
              onChange={() => setMode("custom")}
              data-testid="coa-mapping-effective-custom"
            />
            <span className="flex-1">
              <strong>Choose another date</strong>
              <br />
              <input
                type="date"
                data-testid="coa-mapping-preview-effective-from"
                value={customIso}
                onChange={(e) => { setMode("custom"); setCustomIso(e.target.value); }}
                className="mt-1 block w-full rounded border border-stone-200 px-2 py-1"
              />
            </span>
          </label>
        </fieldset>

        {historicalNote && (
          <div
            className="rounded border border-stone-200 bg-stone-50 p-2 text-xs text-stone-700"
            data-testid="coa-mapping-historical-note"
          >
            {historicalNote}
          </div>
        )}

        {props.errorText && (
          <div
            className={
              "rounded border p-2 text-xs " +
              (props.errorText.startsWith("BLOCKED")
                ? "border-rose-300 bg-rose-50 text-rose-900"
                : "border-amber-300 bg-amber-50 text-amber-900")
            }
          >
            {humanizePreviewError(props.errorText)}
            {props.confirmWarnings && (
              <div className="mt-1 text-[11px]">
                Press Review &amp; Apply to confirm this change.
              </div>
            )}
          </div>
        )}
        <div className="flex gap-2">
          <button
            type="button"
            className="btn-primary"
            disabled={props.applying}
            data-testid="coa-mapping-preview-apply"
            onClick={() => void props.onApply(effectiveFromIso)}
          >
            {props.applying ? "Applying…" : props.confirmWarnings ? "Review & Apply" : "Apply"}
          </button>
          <button type="button" className="btn-secondary" onClick={props.onCancel} data-testid="coa-mapping-preview-cancel">
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}

function titleize(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/_/g, " ");
}

function humanizeLabel(s: string): string {
  if (/^[A-Z][A-Z_]+$/.test(s)) return titleize(s);
  return s;
}

function humanizePreviewError(err: string): string {
  if (err.startsWith("BLOCKED:")) return err.replace(/^BLOCKED:\s*/, "").trim() || "This mapping is not allowed.";
  if (err.startsWith("WARNING:")) return err.replace(/^WARNING:\s*/, "").trim() || "This change needs your attention.";
  return err;
}
