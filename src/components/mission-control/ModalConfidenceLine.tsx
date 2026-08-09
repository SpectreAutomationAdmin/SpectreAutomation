// Sprint 3 · Phase 5 · Slice 3 (2026-08-09) — inline confidence
// disclosure primitive reused by the Vendor Profile and AP Coding
// modal steps.
//
// Founder rule (§26): the modal must stay compact — small qualitative
// label + subtle disclosure caret + short popover. No traffic-light
// dashboards, no giant confidence cards. Reuses the same interaction
// pattern as ApCardConfidenceDisclosure (Slice 1/2): hover, focus,
// Enter/Space, Escape.
//
// PRESENTATION ONLY. Never renders a percentage.

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DecisionConfidence } from "@/lib/mission-control/founder-confidence";
import { compactConfidenceLabel } from "@/lib/mission-control/modal-confidence";

interface Props {
  label: string;
  decision: DecisionConfidence;
  testid: string;
}

export default function ModalConfidenceLine({ label, decision, testid }: Props) {
  const [open, setOpen] = useState(false);
  const cellRef = useRef<HTMLSpanElement | null>(null);
  const popoverId = `mcline-${testid}`;

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
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

  const compact = compactConfidenceLabel(decision.level);

  return (
    <span
      className="spectre-mcline"
      data-testid={testid}
      data-confidence-level={decision.level}
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
      aria-label={`${label}: ${decision.label} — press Enter to reveal the evidence`}
    >
      <span className="spectre-mcline-label">{label}</span>
      <span className={`spectre-mcline-value lvl-${decision.level.toLowerCase()}`}>
        {compact}
      </span>
      <span className="spectre-mcline-caret" aria-hidden="true"> ▾</span>
      {open ? (
        <span
          id={popoverId}
          role="dialog"
          className="spectre-mcline-popover"
          data-testid={`${testid}-popover`}
        >
          <span className="spectre-mcline-popover-heading">{decision.label}</span>
          {decision.reason ? (
            <span className="spectre-mcline-popover-reason">{decision.reason}</span>
          ) : null}
          {decision.supporting.length > 0 ? (
            <ul className="spectre-mcline-popover-list">
              {decision.supporting.map((s, i) => <li key={i}>{s}</li>)}
            </ul>
          ) : null}
        </span>
      ) : null}
      <style jsx>{`
        .spectre-mcline {
          position: relative;
          display: inline-flex;
          align-items: baseline;
          gap: 6px;
          font-size: 12px;
          line-height: 1.4;
          cursor: help;
        }
        .spectre-mcline:focus-visible {
          outline: 2px solid var(--spectre-focus, #6b7c8f);
          outline-offset: 2px;
        }
        .spectre-mcline-label {
          font-size: 10.5px;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          color: var(--spectre-muted, #566473);
        }
        .spectre-mcline-value {
          font-weight: 500;
          color: var(--spectre-ink, #1a1e24);
        }
        .spectre-mcline-value.lvl-high { color: var(--spectre-status-success, #2f5832); }
        .spectre-mcline-value.lvl-needs_review,
        .spectre-mcline-value.lvl-low { color: var(--spectre-status-warning, #a86200); }
        .spectre-mcline-caret {
          opacity: 0.55;
          font-size: 0.7em;
        }
        .spectre-mcline-popover {
          position: absolute;
          top: calc(100% + 6px);
          left: 0;
          z-index: 40;
          min-width: 260px;
          max-width: 400px;
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
          gap: 6px;
          text-align: left;
        }
        .spectre-mcline-popover-heading { font-weight: 500; }
        .spectre-mcline-popover-reason {
          font-style: italic;
          color: var(--spectre-muted, #566473);
        }
        .spectre-mcline-popover-list {
          margin: 0;
          padding-left: 16px;
        }
        .spectre-mcline-popover-list li { margin-bottom: 2px; }
      `}</style>
    </span>
  );
}
