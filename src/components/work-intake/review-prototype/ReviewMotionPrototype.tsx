// AP-MOTION-1 (2026-10-13) — isolated motion prototype of the AP
// Invoice Review page.  Preserves the restored pre-AP-UX-1a
// layout; all motion is field-level and scene-driven.
//
// Isolation guarantees (per directive §2 and §7):
//   - This component ships only on the dedicated prototype route
//     `/app/admin/work-intake/review-prototype` — a route that is
//     intentionally kept outside the production AP review path.
//   - Every value rendered here is a demo constant (DEMO_INVOICE).
//     Zero DB reads, zero server-action imports, zero mutation
//     calls, zero Mission Control linkage.
//   - A persistent "PROTOTYPE — demonstration only" banner is
//     stamped at the top-right of the viewport so no one can
//     mistake this surface for the production review page.
//
// Layout parity (per directive §1):
//   The prototype deliberately mirrors the pre-AP-UX-1a
//   WorkIntakeReviewReal composition (header → tabs → body with
//   InvoiceDetails + Workflow; right-rail Spectre AI) using the
//   SAME .wi-review-* CSS namespace.  Nothing is added to the
//   layout — the entire demonstration happens WITHIN those
//   components via per-field state swaps and small per-field
//   animations.
//
// Motion vocabulary (per directive §4):
//   - `.ap-motion-field--processing`  — shimmer on a value that's
//     being read right now (processing status).
//   - `.ap-motion-field--populated`   — a one-shot cross-fade +
//     slide-in when a value transitions from processing to
//     verified.
//   - `.ap-motion-field--attention`   — a persistent warm-gold
//     left-border + muted gold value colour on the vendor field
//     during the exception scene.  Not a banner.
//   - `.ap-motion-doc-highlight`      — a short bright-outline
//     flash on the document region a hovered field corresponds
//     to (document-to-data visual relationship).
//   - `.ap-motion-rail-swap`          — a brief fade-rise on the
//     AI rail body each time the scene transitions.
//   - `.ap-motion-stage-complete`     — a satisfying green dot
//     fill-in on the workflow stage when it completes.
//
// Playback controls (per directive §5):
//   Play / Pause / Replay / Next / Prev + a dot indicator for
//   each of the six scenes with a label.
//
// All motion observes `prefers-reduced-motion` — see globals.css.

"use client";

import { useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { buildScenes, DEMO_INVOICE, DEMO_FIELD_REGIONS, type FieldKey, type SceneState } from "./scenes";
import { useScenePlayback } from "./useScenePlayback";

// ---------------------------------------------------------------------------
// Icons — restrained strokes, matching the review namespace.
// ---------------------------------------------------------------------------
function BackArrow() {
  return (
    <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M8 3l-4 4 4 4M4 7h7" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function DocIcon() {
  return (
    <svg viewBox="0 0 30 30" aria-hidden="true">
      <path d="M8 5h10l5 5v15H8z" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M18 5v5h5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M11 15h8M11 18.5h8M11 22h5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}
function Sparkle() {
  return (
    <svg width="18" height="18" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M10 2.5l1.3 3.7 3.7 1.3-3.7 1.3L10 12.5l-1.3-3.7L5 7.5l3.7-1.3z" fill="#c9a24a" />
    </svg>
  );
}
function Play() { return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3 2.5l6 3.5-6 3.5z" fill="currentColor"/></svg>; }
function Pause() { return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="3" y="2.5" width="2.2" height="7" fill="currentColor"/><rect x="6.8" y="2.5" width="2.2" height="7" fill="currentColor"/></svg>; }
function Replay() { return <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true"><path d="M11 3.5a4.5 4.5 0 1 1-4.5-2.5" stroke="currentColor" strokeWidth="1.4" fill="none" strokeLinecap="round"/><path d="M8 1l3 2.5-3 2.5z" fill="currentColor"/></svg>; }
function Prev() { return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M4 6l5-3.5v7z" fill="currentColor"/><rect x="3" y="2.5" width="1.2" height="7" fill="currentColor"/></svg>; }
function Next() { return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M8 6l-5-3.5v7z" fill="currentColor"/><rect x="7.8" y="2.5" width="1.2" height="7" fill="currentColor"/></svg>; }

// ---------------------------------------------------------------------------
// Field cell — the central motion-driven building block.
// ---------------------------------------------------------------------------
interface FieldCellProps {
  label: string;
  fieldKey: FieldKey;
  scene: SceneState;
  onHover: (f: FieldKey | null) => void;
  renderValue: () => React.ReactNode;
}

function FieldCell({ label, fieldKey, scene, onHover, renderValue }: FieldCellProps) {
  const isPopulated = scene.populated.has(fieldKey);
  const isProcessing = scene.processing.has(fieldKey);
  const isAttention = fieldKey === "vendor" && scene.vendorMatchState === "attention";
  const isResolved = fieldKey === "vendor" && scene.vendorMatchState === "resolved";

  // The populated class is keyed by the sceneKey + field so React
  // re-fires the one-shot CSS animation on every scene change
  // where the field is newly populated.
  const populatedKey = `${scene.key}-${fieldKey}-${isPopulated ? "pop" : "proc"}`;

  const stateClass = isResolved
    ? "ap-motion-field--resolved"
    : isAttention
      ? "ap-motion-field--attention"
      : isProcessing
        ? "ap-motion-field--processing"
        : isPopulated
          ? "ap-motion-field--populated"
          : "ap-motion-field--waiting";

  return (
    <div
      className={`ap-motion-field ${stateClass}`}
      data-field={fieldKey}
      onMouseEnter={() => isPopulated && onHover(fieldKey)}
      onMouseLeave={() => onHover(null)}
    >
      <div className="ap-motion-field-label">{label}</div>
      <div className="ap-motion-field-value" key={populatedKey}>
        {isPopulated ? renderValue() : (
          <span className="ap-motion-field-waiting-text">
            {isProcessing ? "Reading…" : "Not yet extracted"}
          </span>
        )}
      </div>
      {isAttention && (
        <span className="ap-motion-field-attention-dot" aria-label="Attention required" />
      )}
      {isResolved && (
        <span className="ap-motion-field-resolved-check" aria-label="Resolved">
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
            <path d="M3 7.3l2.4 2.4L11 4" stroke="currentColor" strokeWidth="1.9" fill="none" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </span>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document panel — demo invoice SVG + overlay for hovered field.
// ---------------------------------------------------------------------------
function DocumentPanel({ hoverField, scene }: { hoverField: FieldKey | null; scene: SceneState }) {
  const region = hoverField ? DEMO_FIELD_REGIONS[hoverField] : null;
  return (
    <div className="ap-motion-doc">
      <svg
        viewBox="0 0 400 560"
        className="ap-motion-doc-svg"
        aria-label="Demo invoice document"
      >
        {/* Page */}
        <rect x="0" y="0" width="400" height="560" fill="#fdfbf4" />
        {/* Header band */}
        <rect x="20" y="20" width="150" height="22" fill="#c9a24a" opacity="0.9" />
        <text x="24" y="36" fontFamily="Georgia, serif" fontSize="12" fill="#1a1a1a" fontWeight="700">
          Club Support Inc
        </text>
        <text x="24" y="52" fontFamily="Georgia, serif" fontSize="8" fill="rgba(0,0,0,0.6)">
          314 Harbour Road · Vancouver BC V6A 1J1
        </text>
        <text x="240" y="36" fontFamily="Georgia, serif" fontSize="10" fill="rgba(0,0,0,0.75)">INVOICE # {DEMO_INVOICE.invoiceNumber}</text>
        <text x="240" y="52" fontFamily="Georgia, serif" fontSize="9" fill="rgba(0,0,0,0.6)">Issued   {DEMO_INVOICE.invoiceDate}</text>
        <text x="240" y="66" fontFamily="Georgia, serif" fontSize="9" fill="rgba(0,0,0,0.6)">Due      {DEMO_INVOICE.dueDate}</text>

        <line x1="20" y1="86" x2="380" y2="86" stroke="rgba(0,0,0,0.1)" strokeWidth="0.6" />
        <text x="20" y="100" fontFamily="Georgia, serif" fontSize="9" fill="rgba(0,0,0,0.6)">Bill to  Coulee Ridge Golf &amp; Country Club</text>
        <text x="20" y="112" fontFamily="Georgia, serif" fontSize="9" fill="rgba(0,0,0,0.6)">         Attn: Accounts Payable</text>

        <line x1="20" y1="130" x2="380" y2="130" stroke="rgba(0,0,0,0.1)" strokeWidth="0.6" />

        {/* Line items table — header */}
        <text x="20" y="148" fontFamily="Georgia, serif" fontSize="9" fill="rgba(0,0,0,0.55)" fontWeight="600">DESCRIPTION</text>
        <text x="260" y="148" fontFamily="Georgia, serif" fontSize="9" fill="rgba(0,0,0,0.55)" fontWeight="600" textAnchor="end">QTY</text>
        <text x="320" y="148" fontFamily="Georgia, serif" fontSize="9" fill="rgba(0,0,0,0.55)" fontWeight="600" textAnchor="end">UNIT</text>
        <text x="380" y="148" fontFamily="Georgia, serif" fontSize="9" fill="rgba(0,0,0,0.55)" fontWeight="600" textAnchor="end">AMOUNT</text>
        <line x1="20" y1="152" x2="380" y2="152" stroke="rgba(0,0,0,0.1)" strokeWidth="0.6" />

        {/* Line items */}
        {DEMO_INVOICE.lineItems.map((li, i) => {
          const y = 166 + i * 16;
          return (
            <g key={i}>
              <text x="20" y={y} fontFamily="Georgia, serif" fontSize="9.5" fill="rgba(0,0,0,0.8)">{li.description}</text>
              <text x="260" y={y} fontFamily="Georgia, serif" fontSize="9.5" fill="rgba(0,0,0,0.75)" textAnchor="end">{li.quantity}</text>
              <text x="320" y={y} fontFamily="Georgia, serif" fontSize="9.5" fill="rgba(0,0,0,0.75)" textAnchor="end">{li.unitCost}</text>
              <text x="380" y={y} fontFamily="Georgia, serif" fontSize="9.5" fill="rgba(0,0,0,0.75)" textAnchor="end">{li.amount}</text>
            </g>
          );
        })}

        {/* Subtotal / tax / total */}
        <line x1="200" y1="246" x2="380" y2="246" stroke="rgba(0,0,0,0.1)" strokeWidth="0.6" />
        <text x="260" y="262" fontFamily="Georgia, serif" fontSize="9.5" fill="rgba(0,0,0,0.65)" textAnchor="end">Subtotal</text>
        <text x="380" y="262" fontFamily="Georgia, serif" fontSize="9.5" fill="rgba(0,0,0,0.8)" textAnchor="end">$749.20</text>
        <text x="260" y="278" fontFamily="Georgia, serif" fontSize="9.5" fill="rgba(0,0,0,0.65)" textAnchor="end">{DEMO_INVOICE.taxLabel}</text>
        <text x="380" y="278" fontFamily="Georgia, serif" fontSize="9.5" fill="rgba(0,0,0,0.8)" textAnchor="end">{DEMO_INVOICE.taxAmount}</text>
        <line x1="260" y1="286" x2="380" y2="286" stroke="rgba(0,0,0,0.15)" strokeWidth="0.6" />
        <text x="260" y="304" fontFamily="Georgia, serif" fontSize="11" fill="#1a1a1a" fontWeight="700" textAnchor="end">TOTAL</text>
        <text x="380" y="304" fontFamily="Georgia, serif" fontSize="11" fill="#1a1a1a" fontWeight="700" textAnchor="end">{DEMO_INVOICE.total}</text>

        {/* Field-highlight overlay */}
        {region ? (
          <rect
            className="ap-motion-doc-highlight"
            x={(region.x / 100) * 400}
            y={(region.y / 100) * 560}
            width={(region.w / 100) * 400}
            height={(region.h / 100) * 560}
            fill="none"
            stroke="#c9a24a"
            strokeWidth="2"
            rx="3"
          />
        ) : null}
      </svg>
      {/* Scene-progress ribbon at the bottom of the doc panel. */}
      <div className="ap-motion-doc-ribbon">
        Scene {scene.key.replace("scene-", "").replace(/-.*$/, "")} / 6 · {scene.title}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Vendor-match popover — opens inline next to the Vendor field in
// Scene 5.  Mock options only; selecting "Resolve match" advances
// the scene to Scene 6 (resolved state).  Zero mutation surface.
// ---------------------------------------------------------------------------
function VendorMatchPopover({ onResolve, onClose }: { onResolve: () => void; onClose: () => void }) {
  return (
    <div className="ap-motion-popover" role="dialog" aria-label="Match vendor" data-testid="ap-motion-popover">
      <div className="ap-motion-popover-head">
        <span className="ap-motion-popover-eyebrow">Match vendor · prototype</span>
        <button type="button" className="ap-motion-popover-close" onClick={onClose} aria-label="Close">×</button>
      </div>
      <div className="ap-motion-popover-body">
        <p className="ap-motion-popover-copy">
          Spectre found three candidate vendor records matching <strong>Club Support Inc</strong>.
          Select one to confirm the match (demo only — no record is created).
        </p>
        <ul className="ap-motion-popover-list">
          <li>
            <button type="button" className="ap-motion-popover-item" onClick={onResolve}>
              <span className="ap-motion-popover-item-name">Club Support Inc.</span>
              <span className="ap-motion-popover-item-meta">Operating · 2 prior invoices</span>
            </button>
          </li>
          <li>
            <button type="button" className="ap-motion-popover-item" onClick={onResolve}>
              <span className="ap-motion-popover-item-name">Clubhouse Supplies Co.</span>
              <span className="ap-motion-popover-item-meta">Operating · 11 prior invoices</span>
            </button>
          </li>
          <li>
            <button type="button" className="ap-motion-popover-item" onClick={onResolve}>
              <span className="ap-motion-popover-item-name">Club &amp; Resort Partners</span>
              <span className="ap-motion-popover-item-meta">Operating · 1 prior invoice</span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AI rail (prototype) — contents swap smoothly between scenes.
// ---------------------------------------------------------------------------
function AiRail({ scene }: { scene: SceneState }) {
  return (
    <aside className="wi-review-rail" aria-label="Spectre assistant">
      <div className="wi-review-rail-head">
        <div className="wi-review-rail-brand">
          <Sparkle />
          <div>
            <div className="wi-review-rail-brand-name">Spectre</div>
            <div className="wi-review-rail-brand-slug">Autonomous accounting assistant · prototype</div>
          </div>
        </div>
      </div>
      <div className="ap-motion-rail-swap" key={scene.key}>
        <p className="wi-review-rail-lead">{scene.ai.lead}</p>
        <section className="wi-review-rail-section">
          <h3 className="wi-review-rail-section-title">Key insights</h3>
          <ul className="ap-motion-rail-list">
            {scene.ai.bullets.map((b, i) => (
              <li key={i}>{b}</li>
            ))}
          </ul>
        </section>
        <section className="wi-review-rail-section">
          <h3 className="wi-review-rail-section-title">Recommended next action</h3>
          <p className="ap-motion-rail-reco">
            {scene.ai.recommendation ?? "No action required right now."}
          </p>
        </section>
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Playback controls (bottom-centre).
// ---------------------------------------------------------------------------
function PlaybackControls({
  playback,
  scenes,
}: {
  playback: ReturnType<typeof useScenePlayback>;
  scenes: SceneState[];
}) {
  const scene = scenes[playback.index];
  return (
    <div className="ap-motion-controls" data-testid="ap-motion-controls">
      <div className="ap-motion-controls-caption">
        <span className="ap-motion-controls-eyebrow">Scene {playback.index + 1} of {playback.total}</span>
        <span className="ap-motion-controls-title">{scene.title}</span>
        <span className="ap-motion-controls-copy">{scene.caption}</span>
      </div>
      <div className="ap-motion-controls-buttons">
        <button type="button" className="ap-motion-controls-btn" onClick={playback.prev} aria-label="Previous scene"><Prev /></button>
        {playback.playing ? (
          <button type="button" className="ap-motion-controls-btn ap-motion-controls-btn--primary" onClick={playback.pause} aria-label="Pause"><Pause /></button>
        ) : (
          <button type="button" className="ap-motion-controls-btn ap-motion-controls-btn--primary" onClick={playback.play} aria-label="Play"><Play /></button>
        )}
        <button type="button" className="ap-motion-controls-btn" onClick={playback.next} aria-label="Next scene"><Next /></button>
        <button type="button" className="ap-motion-controls-btn" onClick={playback.replay} aria-label="Replay"><Replay /></button>
      </div>
      <div className="ap-motion-controls-dots" role="tablist" aria-label="Scenes">
        {scenes.map((s, i) => (
          <button
            key={s.key}
            type="button"
            role="tab"
            aria-selected={i === playback.index}
            className={`ap-motion-controls-dot${i === playback.index ? " ap-motion-controls-dot--active" : ""}${i < playback.index ? " ap-motion-controls-dot--done" : ""}`}
            onClick={() => playback.goTo(i)}
            title={s.title}
            data-testid={`ap-motion-dot-${i + 1}`}
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Scene-driven invoice panel (right half of Invoice Details).
// Mirrors pre-AP-UX-1a Classification + Line items layout — the
// motion lives in the field cells, not in extra layout wrappers.
// ---------------------------------------------------------------------------
function ClassificationPanel({
  scene,
  onHover,
  onOpenMatch,
  popoverOpen,
  onResolve,
  onClosePopover,
}: {
  scene: SceneState;
  onHover: (f: FieldKey | null) => void;
  onOpenMatch: () => void;
  popoverOpen: boolean;
  onResolve: () => void;
  onClosePopover: () => void;
}) {
  const anyPopulated = scene.populated.size > 0;
  return (
    <div className="ap-motion-info">
      <h3 className="wi-review-details-subhead">Invoice intelligence</h3>
      <div className="ap-motion-fields">
        <div className="ap-motion-field-wrap" style={{ position: "relative" }}>
          <FieldCell
            label="Vendor"
            fieldKey="vendor"
            scene={scene}
            onHover={onHover}
            renderValue={() => (
              <>
                {DEMO_INVOICE.vendor}
                {scene.vendorMatchState === "attention" ? (
                  <button
                    type="button"
                    className="ap-motion-field-match-btn"
                    onClick={onOpenMatch}
                    data-testid="ap-motion-match-vendor-btn"
                  >
                    Match vendor →
                  </button>
                ) : null}
                {scene.vendorMatchState === "resolved" ? (
                  <span className="ap-motion-field-match-resolved">matched to Club Support Inc.</span>
                ) : null}
              </>
            )}
          />
          {popoverOpen && scene.vendorMatchState === "attention" ? (
            <VendorMatchPopover onResolve={onResolve} onClose={onClosePopover} />
          ) : null}
        </div>
        <FieldCell label="Invoice #"       fieldKey="invoiceNumber" scene={scene} onHover={onHover} renderValue={() => DEMO_INVOICE.invoiceNumber} />
        <FieldCell label="Invoice Date"    fieldKey="invoiceDate"   scene={scene} onHover={onHover} renderValue={() => DEMO_INVOICE.invoiceDate} />
        <FieldCell label="Due Date"        fieldKey="dueDate"       scene={scene} onHover={onHover} renderValue={() => DEMO_INVOICE.dueDate} />
        <FieldCell label="Total Amount"    fieldKey="total"         scene={scene} onHover={onHover} renderValue={() => DEMO_INVOICE.total} />
        <div className="ap-motion-field-divider" />
        <FieldCell label="Category"        fieldKey="category"      scene={scene} onHover={onHover} renderValue={() => DEMO_INVOICE.category} />
        <FieldCell label="GL Suggestion"   fieldKey="glAccount"     scene={scene} onHover={onHover} renderValue={() => DEMO_INVOICE.glAccount} />
      </div>
      {anyPopulated ? (
        <div className="ap-motion-info-foot">
          Hover a populated field to highlight its region on the invoice document.
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Workflow — reads scene.activeStageIndex; completed stages get a
// one-shot fill-in on scene change.
// ---------------------------------------------------------------------------
const STAGES = [
  { index: 1, label: "Intake" },
  { index: 2, label: "Review" },
  { index: 3, label: "Route" },
  { index: 4, label: "Execute" },
  { index: 5, label: "Complete" },
];

function WorkflowStrip({ scene }: { scene: SceneState }) {
  return (
    <section className="wi-review-card wi-review-card--workflow" aria-label="Workflow">
      <div className="wi-review-card-head">
        <h2 className="wi-review-card-title">Workflow</h2>
      </div>
      <ol className="wi-review-flow" data-testid="ap-motion-flow">
        {STAGES.map((s) => {
          const state =
            s.index < scene.activeStageIndex ? "done" :
            s.index === scene.activeStageIndex ? "active" : "pending";
          return (
            <li
              key={s.index}
              className={`wi-review-flow-stage wi-review-flow-stage--${state} ap-motion-stage ap-motion-stage--${state}`}
              data-stage-state={state}
            >
              {s.index > 1 && <span className="wi-review-flow-conn" aria-hidden="true" />}
              <div className="wi-review-flow-head">
                <span className="wi-review-flow-circle" aria-hidden="true">
                  {state === "done" ? (
                    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
                      <path d="M3 7.3l2.4 2.4L11 4" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                  ) : s.index}
                </span>
                <span className="wi-review-flow-label">{s.label}</span>
              </div>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Top-level prototype shell.
// ---------------------------------------------------------------------------
export default function ReviewMotionPrototype() {
  const scenes = useMemo(() => buildScenes(), []);
  const playback = useScenePlayback(scenes.length);
  const scene = scenes[playback.index];
  const [hoverField, setHoverField] = useState<FieldKey | null>(null);
  const [popoverOpen, setPopoverOpen] = useState(false);

  // When the scene is NOT scene-5, keep the popover closed.  When
  // the user opens it in scene-5, keep it open until they choose
  // a vendor (which advances to scene-6) or close it.
  const handleOpenMatch = useCallback(() => {
    if (scene.key === "scene-5-intervention") setPopoverOpen(true);
  }, [scene.key]);
  const handleResolve = useCallback(() => {
    setPopoverOpen(false);
    playback.goTo(5); // scene-6-resolution
  }, [playback]);
  const handleClosePopover = useCallback(() => setPopoverOpen(false), []);

  return (
    <div
      className="wi-review-root ap-motion-root"
      data-testid="ap-motion-prototype"
      data-scene={scene.key}
      data-reduced-motion-safe="true"
    >
      <div className="ap-motion-ribbon" role="status">
        PROTOTYPE — demonstration only · no financial records are affected
      </div>
      <div className="wi-review-grid">
        <div className="wi-review-main">
          {/* Header — pre-AP-UX-1a composition, static for the prototype. */}
          <header className="wi-review-header">
            <Link href="/app/admin/work-intake" className="wi-review-back">
              <BackArrow />
              <span>Back to Work Intake</span>
            </Link>
            <div className="wi-review-header-row">
              <div className="wi-review-header-icon" aria-hidden="true"><DocIcon /></div>
              <div className="wi-review-header-body">
                <div className="wi-review-eyebrow">AP INVOICE REVIEW · PROTOTYPE</div>
                <h1 className="wi-review-title">Invoice from Club Support Inc</h1>
                <div className="wi-review-meta">
                  <span className="wi-review-meta-item">Scene {playback.index + 1} of {playback.total}</span>
                  <span className="wi-review-meta-chip wi-review-meta-chip--amber-outline"><span>Motion prototype</span></span>
                </div>
              </div>
              <div className="wi-review-header-actions">
                <button type="button" className="wi-review-btn wi-review-btn--ghost" disabled>Send back</button>
                <button type="button" className="wi-review-btn wi-review-btn--primary" disabled>Approve &amp; Start</button>
              </div>
            </div>
          </header>

          <div className="wi-review-body">
            {/* Invoice Details — SAME two-column shape as production. */}
            <section className="wi-review-card wi-review-card--details" aria-label="Invoice Details">
              <div className="wi-review-card-head">
                <h2 className="wi-review-card-title">Invoice Details</h2>
              </div>
              <div className="wi-review-details-grid">
                <div className="wi-review-details-doc">
                  <DocumentPanel hoverField={hoverField} scene={scene} />
                </div>
                <div className="wi-review-details-info">
                  <div className="wi-review-details-upper">
                    <div className="wi-review-details-metadata">
                      <ClassificationPanel
                        scene={scene}
                        onHover={setHoverField}
                        onOpenMatch={handleOpenMatch}
                        popoverOpen={popoverOpen}
                        onResolve={handleResolve}
                        onClosePopover={handleClosePopover}
                      />
                    </div>
                  </div>
                </div>
              </div>
            </section>

            <WorkflowStrip scene={scene} />
          </div>
        </div>
        <AiRail scene={scene} />
      </div>
      <PlaybackControls playback={playback} scenes={scenes} />
    </div>
  );
}
