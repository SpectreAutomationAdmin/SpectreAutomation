// Sprint 3 · Phase 5 · Slice 1 (2026-08-09) — founder-facing
// confidence disclosure for the AP Work Intake card.
//
// This component REPLACES the prior generic "Confidence: 95 %" cell
// with:
//
//   • Closed card: qualitative summary label ("High confidence" /
//     "Moderate confidence" / "Needs review") derived from the
//     WORST of the three visible decisions (Supplier / Category / GL).
//     This mirrors the founder-perspective rule that a weak GL is
//     surfaced immediately even when supplier + category are strong.
//
//   • Hover / focus / Enter / Space: opens a compact popover showing
//     per-decision confidence + humanised evidence phrases.
//
//   • Escape or focus-out: dismisses.
//
// Interaction pattern MIRRORS the existing CategoryHoverAllocations
// component (accessibility, ARIA, keyboard, focus retention). No new
// interaction idiom introduced.
//
// PRESENTATION ONLY. The frozen Phase 4 backend is untouched.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApInvoiceCardIntelligence } from "@/lib/mission-control/intelligence-review-intakes";
import { deriveFounderConfidenceView } from "@/lib/mission-control/founder-confidence";

interface Props {
  ap: ApInvoiceCardIntelligence;
  /** Preserved for the c15i2-variant-d source-contract test. */
  testid?: string;
}

export function ApCardConfidenceDisclosure(props: Props) {
  const { ap, testid = "ap-readout-confidence" } = props;
  const view = deriveFounderConfidenceView(ap);
  const [open, setOpen] = useState(false);
  const cellRef = useRef<HTMLDivElement | null>(null);
  const popoverId = "conf-hover-" + testid;

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") { setOpen(false); }
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      setOpen((v) => !v);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  const toneClass = view.summaryLevel === "HIGH"
    ? "confidence"
    : view.summaryLevel === "NEEDS_REVIEW"
      ? "observation"
      : ""; // Moderate / Low → no accent (Instrument neutrality per §13)

  return (
    <div
      className="cell conf-hover"
      data-testid={testid}
      data-confidence-level={view.summaryLevel}
      ref={cellRef}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={(e) => {
        const next = e.relatedTarget as HTMLElement | null;
        if (!cellRef.current?.contains(next)) setOpen(false);
      }}
      onKeyDown={handleKeyDown}
      tabIndex={0}
      role="button"
      aria-haspopup="true"
      aria-expanded={open}
      aria-controls={popoverId}
      aria-label={`${view.summaryLabel} — press Enter to reveal per-decision evidence`}
    >
      <div className="k">Confidence</div>
      <div className={`v${toneClass ? " " + toneClass : ""}`}>
        {view.summaryLabel}
        <span className="conf-hover-caret" aria-hidden="true"> ▾</span>
      </div>
      {open ? (
        <div
          id={popoverId}
          role="dialog"
          className="conf-hover-popover"
          data-testid={`${testid}-popover`}
        >
          <Row testid={`${testid}-supplier`} label="Supplier" d={view.supplier} />
          <Row testid={`${testid}-category`} label="Category" d={view.category} />
          <Row testid={`${testid}-gl`} label="GL" d={view.gl} />
        </div>
      ) : null}
      <style jsx>{`
        .conf-hover { position: relative; cursor: help; }
        .conf-hover:focus-visible { outline: 2px solid var(--spectre-focus, #6b7c8f); outline-offset: 2px; }
        .conf-hover-caret { opacity: 0.55; font-size: 0.7em; margin-left: 3px; }
        .conf-hover-popover {
          position: absolute;
          top: calc(100% + 6px);
          right: 0;
          z-index: 20;
          min-width: 320px;
          max-width: 480px;
          padding: 10px 12px;
          background: var(--spectre-surface, #fbfaf7);
          color: var(--spectre-ink, #1a1e24);
          border: 1px solid rgba(0, 0, 0, 0.14);
          border-radius: 4px;
          box-shadow: 0 6px 22px -8px rgba(0, 0, 0, 0.24);
          font-size: 12px;
          line-height: 1.4;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
      `}</style>
    </div>
  );
}

interface RowProps {
  testid: string;
  label: string;
  d: ReturnType<typeof deriveFounderConfidenceView>["supplier"];
}
function Row({ testid, label, d }: RowProps) {
  return (
    <div className="row" data-testid={testid} data-confidence-level={d.level}>
      <div className="row-head">
        <span className="row-label">{label}</span>
        <span className={`row-level lvl-${d.level.toLowerCase()}`}>{d.label}</span>
      </div>
      {d.reason ? <div className="row-reason">{d.reason}</div> : null}
      {d.supporting.length > 0 ? (
        <ul className="row-supporting">
          {d.supporting.map((s, i) => <li key={i}>{s}</li>)}
        </ul>
      ) : null}
      <style jsx>{`
        .row { border-top: 1px solid rgba(0, 0, 0, 0.06); padding-top: 6px; }
        .row:first-child { border-top: 0; padding-top: 0; }
        .row-head { display: flex; justify-content: space-between; gap: 12px; }
        .row-label {
          font-size: 10.5px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--spectre-muted, #566473);
        }
        .row-level { font-weight: 500; }
        .row-level.lvl-high    { color: var(--spectre-status-success, #2f5832); }
        .row-level.lvl-needs_review { color: var(--spectre-status-warning, #a86200); }
        .row-level.lvl-low     { color: var(--spectre-status-warning, #a86200); }
        .row-reason { margin-top: 2px; font-style: italic; color: var(--spectre-muted, #566473); }
        .row-supporting { margin: 4px 0 0 14px; padding: 0; }
        .row-supporting li { margin-bottom: 2px; }
      `}</style>
    </div>
  );
}
