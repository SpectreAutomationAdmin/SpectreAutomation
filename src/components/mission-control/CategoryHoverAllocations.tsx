// Sprint 3 · Phase 4 Slice 5.2 (2026-08-08) — Multiple hover
// disclosure for the AP Work Intake card Category cell.
//
// Founder amendment #7 (approved):
//   - Entire Category cell is the hover/focus target.
//   - Popover consumes the SAME canonical allocation entries used by
//     AP Coding modal (no UI-side allocation inference).
//   - Shows GL number + name + allocation amount.
//   - Unresolved allocations shown HONESTLY (never fabricated).
//   - Total reconciliation displayed.
//   - Compact, anchored, no modal, no bright colours, dismissable on
//     mouse-out / Escape, accessible.
//
// The component reads the shared `allocations` projection surfaced
// by `intelligence-review-intakes.ts:486` which is the SAME shape
// the AP Coding modal consumes (per amendment #18 architecture
// invariant). Zero UI-side allocation logic.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

// ---------------------------------------------------------------------------
// Shape (mirrors the projection in intelligence-review-intakes.ts:486)
// ---------------------------------------------------------------------------

export interface CategoryHoverAllocationEntry {
  id: string;
  descriptions: string[];
  economicPurposeConcept: string;
  amount: number;
  taxAmount: number | null;
  recommendedAccount: null | {
    accountId: string;
    accountNumber: string;
    accountName: string;
    confidence: number;
    requiresReview: boolean;
  };
}

export interface CategoryHoverAllocations {
  cardCategory: string | null;
  requiresReview: boolean;
  totals: {
    allocationsSubtotal: number;
    taxTotal: number;
    creditTotal: number;
    grossTotal: number;
    allocationVariance: number;
  };
  entries: CategoryHoverAllocationEntry[];
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface CategoryHoverAllocationsProps {
  category: string | null;
  allocations: CategoryHoverAllocations | null;
  currency: string;
  currencyShowCode: boolean;
  testid?: string;
  /** Sprint 3 · Phase 4 Slice 5.2 completion (2026-08-08, amendment
   *  #8) — canonical purpose label used as fallback when `category`
   *  is null. Renders as the cell text with `purposeReason` tooltip.
   *  Distinct from the "purpose unresolved" state (both null =
   *  render "—"). */
  purposeLabel?: string | null;
  purposeReason?: string | null;
}

/** Renders the Category readout cell with hover/focus disclosure
 *  for the Multiple case. When category !== "Multiple" or the
 *  allocation projection is absent, renders the same plain-string
 *  behaviour the prior ReadoutCell did. */
export function CategoryHoverAllocations(props: CategoryHoverAllocationsProps) {
  const { category, allocations, currency, currencyShowCode, testid, purposeLabel, purposeReason } = props;
  const [open, setOpen] = useState(false);
  const cellRef = useRef<HTMLDivElement | null>(null);
  const popoverId = "cat-hover-" + (testid ?? "default");

  const shouldDisclose =
    category === "Multiple"
    && allocations != null
    && (allocations.entries?.length ?? 0) >= 1;

  // Amendment #8: when GL commits to null but purpose is understood,
  // surface the purpose label in the Category cell with a compact
  // tooltip reason. Distinct from the truly-unresolved state (both
  // category and purposeLabel null → render "—").
  const usePurposeFallback = !category && purposeLabel;

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (!shouldDisclose) return;
    if (e.key === "Escape") { setOpen(false); }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen((v) => !v);
    }
  }, [shouldDisclose]);

  // Close on Escape at window level while open.
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  const cellV = category ?? (usePurposeFallback ? purposeLabel! : "—");
  const tone = category ? undefined : (usePurposeFallback ? "observation" : "observation");

  if (!shouldDisclose) {
    // Amendment #8: purpose-fallback cell — same layout as the plain
    // ReadoutCell but with the purposeReason tooltip surfaced via
    // `title` (native browser tooltip; keyboard users get it via
    // aria-label). Non-modal, no popover — mirrors the existing
    // ReadoutCell footprint exactly.
    return (
      <div
        className="cell"
        data-testid={testid}
        title={usePurposeFallback ? (purposeReason ?? undefined) : undefined}
        aria-label={usePurposeFallback && purposeReason ? `Category ${cellV} — ${purposeReason}` : undefined}
      >
        <div className="k">Category</div>
        <div className={`v${tone ? " " + tone : ""}`}>{cellV}</div>
      </div>
    );
  }

  return (
    <div
      className="cell cat-hover"
      data-testid={testid}
      ref={cellRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        // Keep open while focus is within the popover subtree.
        const next = e.relatedTarget as HTMLElement | null;
        if (!cellRef.current?.contains(next)) setOpen(false);
      }}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-haspopup="true"
      aria-expanded={open}
      aria-controls={popoverId}
      aria-label={`Category ${cellV} — press Enter to reveal allocations`}
    >
      <div className="k">Category</div>
      <div className={`v${tone ? " " + tone : ""}`}>
        {cellV}
        <span className="cat-hover-caret" aria-hidden="true"> ▾</span>
      </div>
      {open ? (
        <div
          id={popoverId}
          role="dialog"
          className="cat-hover-popover"
          data-testid={testid ? `${testid}-popover` : undefined}
        >
          <div className="cat-hover-title">Allocations</div>
          <div className="cat-hover-list">
            {allocations.entries.map((e) => (
              <div key={e.id} className="cat-hover-row">
                <span className="cat-hover-acct">
                  {e.recommendedAccount
                    ? `GL ${e.recommendedAccount.accountNumber} ${e.recommendedAccount.accountName}`
                    : "Unresolved allocation"}
                </span>
                <span className="cat-hover-amt">
                  {formatAmount(e.amount, currency, currencyShowCode)}
                </span>
              </div>
            ))}
          </div>
          <div className="cat-hover-total">
            <span>Total</span>
            <span>{formatAmount(allocations.totals.grossTotal, currency, currencyShowCode)}</span>
          </div>
        </div>
      ) : null}
      <style jsx>{`
        .cat-hover { position: relative; cursor: help; }
        .cat-hover:focus-visible { outline: 2px solid var(--spectre-focus, #6b7c8f); outline-offset: 2px; }
        .cat-hover-caret { opacity: 0.55; font-size: 0.7em; margin-left: 3px; }
        .cat-hover-popover {
          position: absolute;
          top: calc(100% + 6px);
          left: 0;
          z-index: 20;
          min-width: 320px;
          max-width: 440px;
          padding: 10px 12px;
          background: var(--spectre-surface, #fbfaf7);
          color: var(--spectre-ink, #1a1e24);
          border: 1px solid rgba(0, 0, 0, 0.14);
          border-radius: 4px;
          box-shadow: 0 6px 22px -8px rgba(0, 0, 0, 0.24);
          font-size: 12px;
          line-height: 1.4;
        }
        .cat-hover-title {
          font-size: 10.5px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--spectre-muted, #566473);
          margin-bottom: 6px;
        }
        .cat-hover-list { display: flex; flex-direction: column; gap: 3px; }
        .cat-hover-row {
          display: flex;
          justify-content: space-between;
          gap: 12px;
          padding: 2px 0;
        }
        .cat-hover-acct { flex: 1 1 auto; }
        .cat-hover-amt { flex: 0 0 auto; font-variant-numeric: tabular-nums; }
        .cat-hover-total {
          margin-top: 6px;
          padding-top: 5px;
          border-top: 1px solid rgba(0, 0, 0, 0.08);
          display: flex;
          justify-content: space-between;
          font-weight: 600;
          font-variant-numeric: tabular-nums;
        }
      `}</style>
    </div>
  );
}

function formatAmount(amount: number, currency: string, showCode: boolean): string {
  const abs = Math.abs(amount);
  const sign = amount < 0 ? "-" : "";
  const symbol = currency === "USD" ? "US$" : currency === "CAD" ? "CA$" : "$";
  const body = abs.toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const codeSuffix = showCode ? ` ${currency}` : "";
  return `${sign}${symbol}${body}${codeSuffix}`;
}
