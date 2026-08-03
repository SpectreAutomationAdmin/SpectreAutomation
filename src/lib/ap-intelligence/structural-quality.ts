// Sprint 3 · Checkpoint 15Y-Rejected (2026-08-03) — post-parse
// structural-quality reclassification.
//
// The founder's rejection of the initial 15Y report was on a real
// architectural point: "text presence is not sufficient evidence of
// usable document structure". The existing `document-class.ts`
// answers "can the parser get characters out?" (IMAGE_ONLY /
// TEXT_HEALTHY / etc.). It cannot answer "did the characters
// preserve enough structure to be usable?".
//
// This module runs AFTER parseInvoiceText + field-quality gate and
// classifies the RESULT rather than the raw text. When the result
// shows signs that the extractor collapsed columns, merged
// identifiers, or lost table rows, we mark the doc as structurally
// degraded and TRIGGER a Textract escalation — even if the doc
// contained embedded text.
//
// The trigger is idempotent: it calls the existing OCR persistence
// layer (§6 rule) which guarantees at most one paid provider call
// per (clubId, sha, provider, extractionVersion).
//
// GENERAL logic — no invoice / supplier / filename specificity.

import type { ExtractedInvoice } from "./types";
import type { DocumentClass } from "./document-class";
import type { QualityGateResult } from "./field-quality";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type DocumentStructureQuality =
  | "STRUCTURED_TEXT"    // parseable + coherent supplier + coherent identifiers
  | "COLLAPSED_COLUMNS"  // multiple columns concatenated into one line
  | "FRAGMENTED_TEXT"    // text present but fragmentary
  | "UNRECOVERED_TABLE"  // total present but no line-items reconstructed
  | "IMAGE_ONLY"         // mirrors DocumentClass — OCR is the primary path
  | "MIXED"              // partial degradation
  | "UNSUPPORTED";       // can't help even with OCR

export type StructuralEscalationStrategy =
  | "NONE"                // structurally coherent; no escalation needed
  | "POSITIONED_LAYOUT"   // try positioned-text row/column association
  | "AWS_TEXTRACT_EXPENSE"; // fall through to provider OCR

export interface StructuralQualityAssessment {
  quality: DocumentStructureQuality;
  reasons: string[];
  shouldEscalate: boolean;
  recommendedEscalation: StructuralEscalationStrategy;
  // Diagnostic-only. Never persisted; never rendered in the browser
  // (§UI-not-modified). Consumed by tests, diagnostics, and the
  // strategy router.
  degradationSignalCount: number;
}

export interface StructuralQualityInputs {
  documentClass: DocumentClass;
  fieldQualityGate: QualityGateResult;
  extraction: ExtractedInvoice;
  layoutItemCount: number;
  layoutHasVisualLines: boolean;
  // TRUE when the field-quality gate REJECTED (not merely trimmed)
  // the supplier candidate. Used as the strongest degradation
  // signal.
  supplierWasRejected: boolean;
  // TRUE when the reference was rejected outright.  Trimmed
  // references are lower-severity signals.
  referenceWasRejected: boolean;
  // Distinct from the above — captures the "reference had to be
  // rescued from concatenation" case.
  referenceWasContaminated: boolean;
}

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

/**
 * Reclassify a document's usable structure AFTER text parsing has
 * completed. When degradation is detected, recommend the correct
 * next strategy (positioned layout OR Textract).
 *
 * Rules — GENERAL, no invoice-specific triggers:
 *   * documentClass IMAGE_ONLY / UNSUPPORTED → preserve; provider
 *     classification is the primary source.
 *   * supplier rejected AS LABEL_HEAVY / structural nonsense → the
 *     extractor picked a header row → COLLAPSED_COLUMNS.
 *   * reference contamination (concatenated dates / multiple IDs
 *     glued) → COLLAPSED_COLUMNS.
 *   * printed total present but zero line items extracted → the
 *     table wasn't recovered → UNRECOVERED_TABLE.
 *   * multiple degradation signals → escalate to Textract even if
 *     positioned layout is available (positioned layout may have
 *     the same collapse pattern).
 */
export function assessStructuralQuality(inputs: StructuralQualityInputs): StructuralQualityAssessment {
  const reasons: string[] = [];

  // Provider-level classifications take precedence.
  if (inputs.documentClass === "IMAGE_ONLY") {
    return {
      quality: "IMAGE_ONLY",
      reasons: ["provider_class_image_only"],
      shouldEscalate: false,
      recommendedEscalation: "AWS_TEXTRACT_EXPENSE",
      degradationSignalCount: 0,
    };
  }
  if (inputs.documentClass === "UNSUPPORTED" || inputs.documentClass === "ENCRYPTED") {
    return {
      quality: "UNSUPPORTED",
      reasons: [`provider_class_${inputs.documentClass.toLowerCase()}`],
      shouldEscalate: false,
      recommendedEscalation: "NONE",
      degradationSignalCount: 0,
    };
  }

  // Now assess degradation signals on top of parsed output.
  if (inputs.supplierWasRejected) reasons.push("supplier_rejected_as_structural_nonsense");
  if (inputs.referenceWasRejected) reasons.push("reference_rejected_as_contaminated");
  if (inputs.referenceWasContaminated && !inputs.referenceWasRejected) reasons.push("reference_trimmed_from_contamination");

  const totalPresent = inputs.extraction.total != null;
  const linesEmpty = inputs.extraction.lineItems.length === 0;
  if (totalPresent && linesEmpty) reasons.push("total_present_but_no_line_items");

  // Subtotal + tax present but no line-item sum reconciliation is a
  // weaker signal of table collapse.
  const subtotalPresent = inputs.extraction.subtotal != null;
  const taxPresent = inputs.extraction.taxTotal != null;
  if (subtotalPresent && taxPresent && linesEmpty) reasons.push("subtotal_and_tax_but_no_lines");

  const signalCount = reasons.length;
  if (signalCount === 0) {
    return {
      quality: "STRUCTURED_TEXT",
      reasons: ["no_degradation_signals"],
      shouldEscalate: false,
      recommendedEscalation: "NONE",
      degradationSignalCount: 0,
    };
  }

  // Choose the classification that most severely reflects the
  // degradation. Order: COLLAPSED_COLUMNS (supplier/ref) >
  // UNRECOVERED_TABLE (total-without-lines) > MIXED.
  let quality: DocumentStructureQuality = "MIXED";
  if (reasons.includes("supplier_rejected_as_structural_nonsense") ||
      reasons.includes("reference_rejected_as_contaminated") ||
      reasons.includes("reference_trimmed_from_contamination")) {
    quality = "COLLAPSED_COLUMNS";
  } else if (reasons.includes("total_present_but_no_line_items")) {
    quality = "UNRECOVERED_TABLE";
  }

  // Recommendation:
  //   * When positioned layout is available AND the collapse is
  //     shallow (single signal), try positioned first (free, no
  //     provider call).
  //   * Otherwise escalate to Textract.
  //
  // "Multiple signals" == 2+ distinct degradation types (supplier +
  // reference + no-lines + …). One signal alone can often be
  // rescued by positioned-layout; two signals usually can't.
  const distinctSignalCategories = new Set<string>();
  if (inputs.supplierWasRejected) distinctSignalCategories.add("supplier");
  if (inputs.referenceWasRejected || inputs.referenceWasContaminated) distinctSignalCategories.add("reference");
  if (totalPresent && linesEmpty) distinctSignalCategories.add("lines");
  const distinct = distinctSignalCategories.size;

  const recommendedEscalation: StructuralEscalationStrategy =
    distinct >= 2 || !inputs.layoutHasVisualLines
      ? "AWS_TEXTRACT_EXPENSE"
      : "POSITIONED_LAYOUT";

  return {
    quality,
    reasons,
    shouldEscalate: true,
    recommendedEscalation,
    degradationSignalCount: signalCount,
  };
}
