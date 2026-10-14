// AP-UX-1a (2026-10-13) — "What Spectre has done" progressive
// intelligence strip.
//
// Compact (not an oversized dashboard card) summary row that reads
// authoritative state off the real `RealReviewData.invoice` + the
// optional `linked` AP intelligence surface.  Each stage carries
// ONE of five directive-mandated statuses:
//
//   • COMPLETED  — a verified result (e.g. vendor matched to a
//                  Spectre vendor record; GL arithmetic verified).
//   • SUGGESTED  — AI output pending human confirmation (e.g. a
//                  category source like VENDOR_DEFAULT without
//                  manual verification).
//   • PROCESSING — a genuinely in-flight operation.  We don't
//                  stream status here, so this is reserved for the
//                  rare case where a field is explicitly in a
//                  pending-processing state.
//   • ATTENTION  — a known exception (vendor-match NOT_FOUND /
//                  AMBIGUOUS / INSUFFICIENT_SIGNAL; validation
//                  failures).
//   • UNEVALUATED — the stage has not yet produced a value.
//
// The strip NEVER infers completion from presence alone.  A vendor
// NAME extracted from the PDF is NOT proof the vendor was MATCHED;
// that's a different authoritative signal.
//
// Visual posture: compact row of chips above the Invoice Details
// card.  No oversized card chrome.  Icons restrained; the chip
// background carries the status language rather than colour.

import type { ReactNode } from "react";
import type { RealReviewData } from "@/lib/work-intake/review-detail-view-model";

type StageStatus =
  | "COMPLETED"
  | "SUGGESTED"
  | "PROCESSING"
  | "ATTENTION"
  | "UNEVALUATED";

interface StageDef {
  key: string;
  label: string;
  status: StageStatus;
  /** Optional short qualifier shown after the label (e.g. a vendor
   *  name, a GL code).  Composed from authoritative state only. */
  detail?: string;
}

/**
 * Derive the 5 stages from `data` using AUTHORITATIVE state only.
 *
 * Rules (per directive refinement):
 *   - Presence of a vendor name alone is NOT completion.  Only a
 *     MATCHED vendor-record resolution counts as completed.
 *   - A GL account suggestion with a non-NONE source is SUGGESTED
 *     (not completed); it awaits human confirmation on the
 *     Mission Control posting workflow.
 *   - Line-item extraction completion is anchored on the extractor
 *     producing a non-null array (that's the extractor's own
 *     completion signal — not inference).
 *   - Workflow readiness reads `workflowStateLabel`; absence
 *     without extraction = UNEVALUATED, with extraction = still
 *     SUGGESTED pending human action.
 */
export function deriveStages(data: RealReviewData): StageDef[] {
  const i = data.invoice;
  const hasExtraction = i.hasExtraction;

  // Stage 1 — document analysis.
  const analysisStatus: StageStatus = hasExtraction ? "COMPLETED" : "UNEVALUATED";

  // Stage 2 — vendor identification (NOT just presence of a name).
  let vendorStatus: StageStatus;
  let vendorDetail: string | undefined;
  if (i.vendorMatchState === "MATCHED") {
    vendorStatus = "COMPLETED";
    vendorDetail = i.vendorMatchedName ?? i.vendor ?? undefined;
  } else if (
    i.vendorMatchState === "AMBIGUOUS" ||
    i.vendorMatchState === "NOT_FOUND" ||
    i.vendorMatchState === "INSUFFICIENT_SIGNAL"
  ) {
    vendorStatus = "ATTENTION";
    vendorDetail = i.vendor ?? undefined;
  } else if (hasExtraction) {
    // Extraction done but no vendor-match signal persisted → the
    // matcher hasn't evaluated yet.
    vendorStatus = "UNEVALUATED";
    vendorDetail = i.vendor ?? undefined;
  } else {
    vendorStatus = "UNEVALUATED";
  }

  // Stage 3 — GL classification.  AI suggestions are never
  // auto-promoted to COMPLETED here — a human still has to review
  // on the Mission Control posting workflow.
  let classificationStatus: StageStatus;
  let classificationDetail: string | undefined;
  if (i.glAccountLabel) {
    classificationStatus = "SUGGESTED";
    const conf = i.glConfidencePercent;
    classificationDetail =
      typeof conf === "number"
        ? `${i.glAccountLabel} · ${conf}% confidence`
        : i.glAccountLabel;
  } else if (hasExtraction) {
    classificationStatus = "UNEVALUATED";
  } else {
    classificationStatus = "UNEVALUATED";
  }

  // Stage 4 — line-item extraction completion.
  let lineItemsStatus: StageStatus;
  let lineItemsDetail: string | undefined;
  if (i.lineItems && i.lineItems.length > 0) {
    lineItemsStatus = "COMPLETED";
    const n = i.lineItems.length;
    lineItemsDetail = `${n} line item${n === 1 ? "" : "s"}`;
  } else if (hasExtraction) {
    lineItemsStatus = "UNEVALUATED";
  } else {
    lineItemsStatus = "UNEVALUATED";
  }

  // Stage 5 — ready-for-review signal from the workflow.  When the
  // workflow has told us a human action is required (any non-null
  // workflowStateLabel), we treat it as SUGGESTED (awaiting human
  // confirmation) rather than COMPLETED — Spectre has done its
  // part; the human hasn't acted yet.
  let readyStatus: StageStatus;
  let readyDetail: string | undefined;
  if (i.workflowStateLabel) {
    readyStatus = "SUGGESTED";
    readyDetail = i.workflowStateLabel;
  } else if (hasExtraction) {
    readyStatus = "UNEVALUATED";
  } else {
    readyStatus = "UNEVALUATED";
  }

  return [
    { key: "analysis", label: "Document analyzed", status: analysisStatus },
    { key: "vendor", label: "Vendor identified", status: vendorStatus, detail: vendorDetail },
    { key: "classification", label: "GL classification", status: classificationStatus, detail: classificationDetail },
    { key: "lineitems", label: "Line items extracted", status: lineItemsStatus, detail: lineItemsDetail },
    { key: "ready", label: "Review readiness", status: readyStatus, detail: readyDetail },
  ];
}

function CheckGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M3 7.3l2.4 2.4L11 4" stroke="currentColor" strokeWidth="1.7" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
function SparkleGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 2l1 2.5L10.5 5.5 8 6.5 7 9 6 6.5 3.5 5.5 6 4.5z" fill="currentColor" />
    </svg>
  );
}
function AttentionGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
      <path d="M7 2.5L12.5 11.5H1.5L7 2.5z" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M7 5.5v2.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
      <circle cx="7" cy="9.8" r="0.7" fill="currentColor" />
    </svg>
  );
}
function PendingGlyph() {
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" strokeWidth="1.3" strokeDasharray="1.5 2" />
    </svg>
  );
}
function ProcessingGlyph() {
  // Three-dot spinner.  Animates ONLY when the stage is
  // genuinely in-flight (status === PROCESSING).  The animation
  // is CSS-defined in globals.css and honours
  // `prefers-reduced-motion`.
  return (
    <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden="true" className="ap-ux-intel-strip-processing-glyph">
      <circle cx="3.5" cy="7" r="1.2" fill="currentColor" />
      <circle cx="7" cy="7" r="1.2" fill="currentColor" />
      <circle cx="10.5" cy="7" r="1.2" fill="currentColor" />
    </svg>
  );
}

function statusGlyph(s: StageStatus): ReactNode {
  switch (s) {
    case "COMPLETED": return <CheckGlyph />;
    case "SUGGESTED": return <SparkleGlyph />;
    case "ATTENTION": return <AttentionGlyph />;
    case "PROCESSING": return <ProcessingGlyph />;
    case "UNEVALUATED": return <PendingGlyph />;
  }
}

function statusLabel(s: StageStatus): string {
  switch (s) {
    case "COMPLETED": return "Verified";
    case "SUGGESTED": return "AI suggested";
    case "ATTENTION": return "Needs attention";
    case "PROCESSING": return "Processing";
    case "UNEVALUATED": return "Not yet evaluated";
  }
}

export default function IntelligenceStrip({ data }: { data: RealReviewData }) {
  const stages = deriveStages(data);
  // Only render the strip when there is at least one non-UNEVALUATED
  // stage — otherwise it's just a row of "Not yet evaluated" chips
  // which is noise.  If the extractor hasn't produced ANY signal,
  // the Invoice Details card's own Pending placeholders already
  // communicate the empty state.
  const anySignal = stages.some((s) => s.status !== "UNEVALUATED");
  if (!anySignal) return null;
  return (
    <section
      className="ap-ux-intel-strip"
      aria-label="What Spectre has done"
      data-testid="ap-ux-intel-strip"
    >
      <div className="ap-ux-intel-strip-heading">
        <span className="ap-ux-intel-strip-heading-eyebrow">What Spectre has done</span>
      </div>
      <ol className="ap-ux-intel-strip-list">
        {stages.map((s) => (
          <li
            key={s.key}
            className={`ap-ux-intel-strip-item ap-ux-intel-strip-item--${s.status.toLowerCase()}`}
            data-stage={s.key}
            data-status={s.status}
          >
            <span className="ap-ux-intel-strip-item-glyph" aria-hidden="true">
              {statusGlyph(s.status)}
            </span>
            <span className="ap-ux-intel-strip-item-body">
              <span className="ap-ux-intel-strip-item-label">{s.label}</span>
              <span className="ap-ux-intel-strip-item-status">
                {statusLabel(s.status)}
                {s.detail ? <span className="ap-ux-intel-strip-item-detail"> · {s.detail}</span> : null}
              </span>
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
