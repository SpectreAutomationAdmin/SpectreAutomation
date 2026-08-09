// Sprint 3 · Phase 5 · Slice 2 (2026-08-09) — decision-specific
// founder-confidence disclosure. Slice 2 rewrite separates WORKFLOW
// STATE from INTELLIGENCE CONFIDENCE per §1/§10:
//
//   Compact card: qualitative weakest-material-dimension summary
//     ("High" · "Moderate · Category" · "Low · Supplier" ·
//      "Needs review · GL"). Workflow blockers no longer override it.
//
//   Popover: two sections —
//     Intelligence: Supplier · Transaction understanding · GL
//     Workflow:     Review required / other Phase 3 state
//
// Interaction pattern unchanged from Slice 1 (mirrors
// CategoryHoverAllocations for accessibility parity).

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ApInvoiceCardIntelligence } from "@/lib/mission-control/intelligence-review-intakes";
import { deriveFounderConfidenceView } from "@/lib/mission-control/founder-confidence";

interface Props {
  ap: ApInvoiceCardIntelligence;
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

  // §13 — no aggressive status colors. HIGH gets the muted success
  // accent; NEEDS_REVIEW gets the muted warning accent; MODERATE and
  // LOW get no accent (typography differentiates them).
  const toneClass = view.summaryLevel === "HIGH"
    ? "confidence"
    : view.summaryLevel === "NEEDS_REVIEW"
      ? "observation"
      : "";

  return (
    <div
      className="cell conf-hover"
      data-testid={testid}
      data-confidence-level={view.summaryLevel}
      data-confidence-dimension={view.weakestDimension ?? ""}
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
          <div className="section">
            <div className="section-heading">Intelligence</div>
            <Row testid={`${testid}-supplier`} label="Supplier" d={view.supplier} />
            <Row testid={`${testid}-category`} label="Transaction understanding" d={view.transaction} />
            <Row testid={`${testid}-gl`} label="GL recommendation" d={view.gl} />
          </div>
          {view.workflow.hasBlockers ? (
            <div className="section" data-testid={`${testid}-workflow`}>
              <div className="section-heading">Workflow</div>
              <div className="workflow-line">Review required</div>
            </div>
          ) : null}
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
          min-width: 340px;
          max-width: 500px;
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
          gap: 12px;
        }
        .section { display: flex; flex-direction: column; gap: 8px; }
        .section-heading {
          font-size: 10px;
          text-transform: uppercase;
          letter-spacing: 0.08em;
          color: var(--spectre-muted, #566473);
          border-bottom: 1px solid rgba(0, 0, 0, 0.08);
          padding-bottom: 3px;
        }
        .workflow-line { font-style: italic; color: var(--spectre-muted, #566473); }
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
        .row { }
        .row-head { display: flex; justify-content: space-between; gap: 12px; align-items: baseline; }
        .row-label {
          font-size: 10.5px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--spectre-muted, #566473);
        }
        .row-level { font-weight: 500; }
        .row-level.lvl-high { color: var(--spectre-status-success, #2f5832); }
        .row-level.lvl-needs_review { color: var(--spectre-status-warning, #a86200); }
        .row-level.lvl-low { color: var(--spectre-status-warning, #a86200); }
        .row-reason { margin-top: 2px; font-style: italic; color: var(--spectre-muted, #566473); }
        .row-supporting { margin: 4px 0 0 14px; padding: 0; }
        .row-supporting li { margin-bottom: 2px; }
      `}</style>
    </div>
  );
}
