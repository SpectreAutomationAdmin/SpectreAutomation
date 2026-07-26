"use client";

// Collapsed-by-default Errors summary for the COA import detail
// page (founder rule 2026-07-16). Owns the "Next error →"
// affordance — which was previously inside the Map each account
// table's sticky header. The mapping table header now stays
// focused purely on mapping actions; this card is the single
// place where validation-error navigation lives.
//
// Communication with the mapping table is via two window
// CustomEvents so this card can stay a sibling of the table on
// a server-rendered page (no shared React context required):
//
//   • 'spectre:coa-next-error'          — cycle to the next error row.
//   • 'spectre:coa-jump-to-row'         — { rowNumber } → scroll to
//     that specific row (used when the operator clicks a row in
//     the expanded error list).
//
// The mapping table listens for both events and runs its existing
// scrollToErrorRow / flash logic.

import { useState } from "react";

type CoaError = {
  id: string;
  rowNumber: number;
  code: string;
  columnName: string | null;
  message: string;
  // Founder rule 2026-06-29 v12 — severity gate. WARNING surfaces
  // separately and does NOT block Complete-import.
  severity?: "ERROR" | "WARNING";
};

type Props = {
  errors: ReadonlyArray<CoaError>;
};

export function CoaErrorsCard({ errors }: Props) {
  const [expanded, setExpanded] = useState(false);
  const hardErrors = errors.filter((e) => e.severity !== "WARNING");
  const warnings = errors.filter((e) => e.severity === "WARNING");
  if (hardErrors.length === 0 && warnings.length === 0) return null;

  function nextError() {
    if (typeof window === "undefined") return;
    window.dispatchEvent(new CustomEvent("spectre:coa-next-error"));
  }

  function jumpTo(rowNumber: number) {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent("spectre:coa-jump-to-row", { detail: { rowNumber } }),
    );
  }

  return (
    <div
      className="mt-6 card overflow-hidden"
      data-testid="coa-errors-summary-card"
      role="region"
      aria-label="Validation errors"
    >
      {/* Compact summary bar — always visible. Founder copy:
          "1 error found" · "See error details" · "Next error →".
          The "See error details" toggle controls the disclosure
          below it via aria-expanded. */}
      <div
        className="flex flex-wrap items-center justify-between gap-3 px-6 py-3 border-b border-stone-200"
        data-testid="coa-errors-summary-bar"
      >
        <div className="flex items-center gap-2 text-sm text-red-700">
          <svg
            width="13"
            height="13"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="13" />
            <line x1="12" y1="16" x2="12" y2="16.01" />
          </svg>
          <span className="font-medium" data-testid="coa-errors-summary-count">
            {hardErrors.length} error{hardErrors.length === 1 ? "" : "s"} found
            {warnings.length > 0 && (
              <span
                className="ml-3 text-amber-700"
                data-testid="coa-warnings-summary-count"
              >
                · {warnings.length} warning{warnings.length === 1 ? "" : "s"}
              </span>
            )}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            aria-expanded={expanded}
            aria-controls="coa-errors-detail-list"
            className="text-xs text-red-700 hover:underline"
            data-testid="coa-errors-toggle"
          >
            {expanded ? "Hide error details" : "See error details"}
          </button>
          <button
            type="button"
            onClick={nextError}
            className="inline-flex items-center gap-1 rounded border border-red-300 bg-white px-2.5 py-1 text-xs font-medium text-red-700 hover:bg-red-50"
            data-testid="coa-errors-next-error"
          >
            Next error →
          </button>
        </div>
      </div>

      {/* Expanded error list. Each row is a button that jumps
          the mapping table to the matching account row. */}
      {expanded && (
        <div
          id="coa-errors-detail-list"
          data-testid="coa-errors-detail-list"
        >
          <table className="table-base">
            <thead>
              <tr>
                <th className="w-20">Row</th>
                <th className="w-44">Code</th>
                <th className="w-36">Column</th>
                <th>Message</th>
              </tr>
            </thead>
            <tbody>
              {errors.map((e) => {
                const isWarn = e.severity === "WARNING";
                return (
                  <tr
                    key={e.id}
                    className={
                      isWarn
                        ? "cursor-pointer hover:bg-amber-50"
                        : "cursor-pointer hover:bg-red-50"
                    }
                    onClick={() => jumpTo(e.rowNumber)}
                    data-testid={`coa-errors-detail-row-${e.rowNumber}`}
                    data-severity={isWarn ? "WARNING" : "ERROR"}
                  >
                    <td className="text-xs font-mono">{e.rowNumber}</td>
                    <td className="text-xs font-mono">
                      {isWarn && (
                        <span className="mr-1 text-amber-700">⚠</span>
                      )}
                      {e.code}
                    </td>
                    <td className="text-xs">{e.columnName ?? "—"}</td>
                    <td className="text-xs">{e.message}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
