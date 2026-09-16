"use client";

// v-slice-1-followup-7 (2026-09-15) — Payroll Implementation section
// (Payroll Settings → Payroll Implementation). Founder-facing declaration
// of the Club's implementation position for a given tax year:
//   * Zero prior YTD (beginning-of-year implementation)
//   * Transitioning from another payroll system (mid-year)
//
// Server actions (declareImplementationAction / revokeImplementationAction)
// live in _implementation-actions.ts. This client component is purely a
// presentation + form-state wrapper.

import { useState } from "react";
import Link from "next/link";
import type { ImplementationMode } from "@/lib/payroll/implementation-declaration";

interface Declaration {
  id: string;
  taxYear: number;
  mode: ImplementationMode;
  firstSpectrePayDate: string | null;
  confirmedAt: string | null;
  confirmedByDisplayName: string | null;
  notes: string | null;
  updatedAt: string;
}

interface Props {
  clubId: string;
  canWrite: boolean;
  currentTaxYear: number;
  declaration: Declaration | null;
  declareAction: (fd: FormData) => Promise<void>;
  revokeAction: (fd: FormData) => Promise<void>;
  banner?: { tone: "error" | "success"; text: string } | null;
}

function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-CA", { year: "numeric", month: "short", day: "numeric" });
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" });
}

export default function PayrollImplementationEditor(props: Props) {
  const { clubId, canWrite, currentTaxYear, declaration, declareAction, revokeAction, banner } = props;
  const [mode, setMode] = useState<ImplementationMode>(declaration?.mode ?? "ZERO_OPENING_YTD");
  const [firstPayDate, setFirstPayDate] = useState<string>(
    declaration?.firstSpectrePayDate ? declaration.firstSpectrePayDate.slice(0, 10) : "",
  );

  const isConfirmed = declaration?.confirmedAt != null;
  const isMidYear = declaration?.mode === "MID_YEAR_MIGRATION" && isConfirmed;
  const isZero = declaration?.mode === "ZERO_OPENING_YTD" && isConfirmed;

  return (
    <div data-testid="payroll-implementation-editor" className="space-y-4">
      {banner && (
        <div
          role={banner.tone === "error" ? "alert" : "status"}
          data-testid={
            banner.tone === "error"
              ? "payroll-implementation-error-banner"
              : "payroll-implementation-success-banner"
          }
          style={{
            padding: "8px 12px",
            borderRadius: 4,
            fontSize: 13,
            border: banner.tone === "error" ? "1px solid #b91c1c" : "1px solid #166534",
            background: banner.tone === "error" ? "#fef2f2" : "#f0fdf4",
            color: banner.tone === "error" ? "#7f1d1d" : "#14532d",
          }}
        >
          {banner.text}
        </div>
      )}

      <div
        data-testid="payroll-implementation-status"
        style={{
          borderRadius: 6,
          padding: "12px 14px",
          border: "1px solid #d0c9bd",
          background: isConfirmed ? "#f8fafc" : "#fffbeb",
        }}
      >
        <div style={{ display: "flex", alignItems: "baseline", gap: 12 }}>
          <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, color: "#78716c" }}>
            Tax year {currentTaxYear}
          </span>
          <span
            data-testid="payroll-implementation-status-badge"
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: isMidYear ? "#7c2d12" : isZero ? "#166534" : "#92400e",
            }}
          >
            {isMidYear
              ? "Mid-year migration"
              : isZero
                ? "Zero prior YTD"
                : "Not declared"}
          </span>
        </div>
        <p style={{ margin: "6px 0 0 0", fontSize: 13, color: "#44403c", lineHeight: 1.55 }}>
          {isMidYear && (
            <>
              This Club processed payroll before Spectre in {currentTaxYear}. Employees included in Spectre Payroll
              must have opening year-to-date balances activated before payroll can be calculated.
            </>
          )}
          {isZero && (
            <>
              Employees included in Spectre Payroll have no payroll amounts from this employer earlier in the
              {" "}{currentTaxYear} tax year that need to be carried forward.
            </>
          )}
          {!isConfirmed && (
            <>
              Spectre needs to know whether this Club processed payroll from another system earlier in this tax year.
              Declare your implementation position below. Payroll cannot be prepared for this tax year until this is
              confirmed.
            </>
          )}
        </p>
        {declaration && (
          <p style={{ margin: "6px 0 0 0", fontSize: 11.5, color: "#78716c" }}>
            {isConfirmed ? "Confirmed" : "Last updated"} {fmtDateTime(isConfirmed ? declaration.confirmedAt : declaration.updatedAt)}
            {declaration.confirmedByDisplayName ? ` by ${declaration.confirmedByDisplayName}` : ""}
            {declaration.firstSpectrePayDate ? ` · first Spectre pay date ${fmtDate(declaration.firstSpectrePayDate)}` : ""}
          </p>
        )}
        {isMidYear && (
          <div style={{ marginTop: 10 }}>
            <Link
              href="/app/admin/payroll/setup/opening-balances"
              data-testid="payroll-implementation-manage-opening-balances"
              className="inline-flex items-center gap-1 rounded border border-stone-300 bg-white hover:bg-stone-50 px-3 py-1.5 text-[12.5px] text-stone-700"
              style={{ textDecoration: "none" }}
            >
              Manage Opening Balances →
            </Link>
          </div>
        )}
      </div>

      {canWrite && (
        <form
          action={declareAction}
          data-testid="payroll-implementation-form"
          style={{ padding: "12px 14px", borderRadius: 6, border: "1px solid #e7e5e4", background: "#fbfaf7" }}
        >
          <input type="hidden" name="taxYear" value={currentTaxYear} />
          <p style={{ margin: "0 0 8px 0", fontSize: 12, fontWeight: 600, color: "#292524", textTransform: "uppercase", letterSpacing: 0.5 }}>
            {isConfirmed ? "Update declaration" : "Declare implementation"}
          </p>
          <fieldset style={{ border: "none", padding: 0, margin: "0 0 10px 0" }}>
            <legend style={{ fontSize: 13, color: "#57534e", marginBottom: 6 }}>How did this Club run payroll earlier in {currentTaxYear}?</legend>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 6, fontSize: 13, color: "#44403c" }}>
              <input
                type="radio"
                name="mode"
                value="ZERO_OPENING_YTD"
                checked={mode === "ZERO_OPENING_YTD"}
                onChange={() => setMode("ZERO_OPENING_YTD")}
                data-testid="payroll-implementation-mode-zero"
              />
              <span>
                <span style={{ fontWeight: 500 }}>Zero prior YTD</span>{" "}
                <span style={{ color: "#78716c" }}>
                  — no payroll amounts exist for this employer earlier in the {currentTaxYear} tax year.
                </span>
              </span>
            </label>
            <label style={{ display: "flex", alignItems: "flex-start", gap: 8, fontSize: 13, color: "#44403c" }}>
              <input
                type="radio"
                name="mode"
                value="MID_YEAR_MIGRATION"
                checked={mode === "MID_YEAR_MIGRATION"}
                onChange={() => setMode("MID_YEAR_MIGRATION")}
                data-testid="payroll-implementation-mode-midyear"
              />
              <span>
                <span style={{ fontWeight: 500 }}>Transitioning from another payroll system</span>{" "}
                <span style={{ color: "#78716c" }}>
                  — this Club processed payroll before Spectre in {currentTaxYear}. Opening YTD balances required.
                </span>
              </span>
            </label>
          </fieldset>
          <label
            htmlFor="firstSpectrePayDate"
            style={{ display: "block", fontSize: 13, color: "#57534e", marginBottom: 4 }}
          >
            First Spectre pay date {mode === "MID_YEAR_MIGRATION" ? <span style={{ color: "#b91c1c" }}>*</span> : <span style={{ color: "#78716c" }}>(optional)</span>}
          </label>
          <input
            id="firstSpectrePayDate"
            name="firstSpectrePayDate"
            type="date"
            value={firstPayDate}
            onChange={(e) => setFirstPayDate(e.target.value)}
            required={mode === "MID_YEAR_MIGRATION"}
            data-testid="payroll-implementation-first-pay-date"
            style={{
              width: 220, height: 34, padding: "0 10px", fontSize: 14,
              border: "1px solid #d0c9bd", borderRadius: 4, background: "white",
            }}
          />
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
            {isConfirmed && (
              <form action={revokeAction} style={{ display: "inline" }}>
                <input type="hidden" name="taxYear" value={currentTaxYear} />
                <button
                  type="submit"
                  data-testid="payroll-implementation-revoke"
                  style={{
                    padding: "8px 14px", fontSize: 13, border: "1px solid #d0c9bd",
                    background: "transparent", color: "#57534e", borderRadius: 4, cursor: "pointer",
                  }}
                >
                  Unconfirm
                </button>
              </form>
            )}
            <button
              type="submit"
              data-testid="payroll-implementation-confirm"
              style={{
                padding: "8px 14px", fontSize: 13, border: "none",
                background: "#1e3a2a", color: "white", borderRadius: 4, cursor: "pointer", fontWeight: 500,
              }}
            >
              {isConfirmed ? "Update declaration" : "Confirm implementation"}
            </button>
          </div>
        </form>
      )}

      <input type="hidden" data-testid="payroll-implementation-clubId" value={clubId} readOnly />
    </div>
  );
}
