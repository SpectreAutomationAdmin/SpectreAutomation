// Sprint 3 · Phase 5 · Slice 2 (2026-08-09) — decision-specific
// founder-confidence adapter, rewritten to separate WORKFLOW STATE
// from INTELLIGENCE CONFIDENCE.
//
// Founder rule (Slice 2 §1, §10):
//   WORKFLOW STATE       = What does the founder need to do?
//   INTELLIGENCE CONFIDENCE = Where is Spectre least certain about
//                             the conclusions it is showing?
//
// These two concepts must remain independent. Workflow blockers no
// longer downgrade the compact confidence summary — they are shown
// separately (see the popover Workflow section).
//
// The adapter consumes the read-only `confidenceInputs` projection
// added to `ApInvoiceCardIntelligence` (Slice 2 §4-§5). It does NOT
// consume `category.source` as the primary transaction signal (§6);
// it uses purpose confidence + purchased-object count + product
// identity + capital treatment + allocations instead (§7).
//
// PRESENTATION ONLY. No decision is changed.

import type {
  ApInvoiceCardIntelligence,
} from "./intelligence-review-intakes";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type FounderConfidence = "HIGH" | "MODERATE" | "LOW" | "NEEDS_REVIEW";

export type ConfidenceDimensionKey = "supplier" | "transaction" | "gl";

export interface DecisionConfidence {
  level: FounderConfidence;
  /** Long-form label for the popover ("High confidence"). */
  label: string;
  /** Humanised evidence bullets rendered in the popover. */
  supporting: string[];
  /** Optional short reason (italicised in the popover) — used on
   *  LOW / MODERATE / NEEDS_REVIEW. Never on HIGH. */
  reason?: string | null;
}

export interface FounderConfidenceView {
  /** Weakest MATERIAL intelligence dimension. Does NOT consider
   *  workflow blockers (§10). */
  summaryLevel: FounderConfidence;
  /** Compact card label — either "High" or "<Level> · <Dimension>". */
  summaryLabel: string;
  /** The dimension that drove the summary (null when all HIGH). */
  weakestDimension: ConfidenceDimensionKey | null;
  supplier: DecisionConfidence;
  transaction: DecisionConfidence;
  gl: DecisionConfidence;
  /** Read-only workflow snapshot for the popover Workflow section.
   *  Rendered ADJACENT to the intelligence rows, not as part of the
   *  confidence calculation. Sourced from the phase3Decision. */
  workflow: {
    /** Compact copy of `phase3Decision.state` when present, else
     *  falls back to `workflowState`. */
    label: string | null;
    /** True when Phase 3 has committed blockers. UI may show a
     *  "Review required" chip; the adapter does NOT change the
     *  intelligence confidence based on this. */
    hasBlockers: boolean;
  };
}

// -----------------------------------------------------------------------------
// Levels
// -----------------------------------------------------------------------------

const LONG_LABEL: Record<FounderConfidence, string> = {
  HIGH: "High confidence",
  MODERATE: "Moderate confidence",
  LOW: "Low confidence",
  NEEDS_REVIEW: "Needs review",
};

const COMPACT_LEVEL_LABEL: Record<FounderConfidence, string> = {
  HIGH: "High",
  MODERATE: "Moderate",
  LOW: "Low",
  NEEDS_REVIEW: "Needs review",
};

const DIMENSION_COMPACT_LABEL: Record<ConfidenceDimensionKey, string> = {
  supplier: "Supplier",
  transaction: "Category",   // §12 founder-facing name for the middle dimension
  gl: "GL",
};

/** Worst → best order for the summary calculation. */
const ORDER: Record<FounderConfidence, number> = {
  NEEDS_REVIEW: 0,
  LOW: 1,
  MODERATE: 2,
  HIGH: 3,
};

function weakestOf(candidates: Array<{ key: ConfidenceDimensionKey; level: FounderConfidence }>): { key: ConfidenceDimensionKey; level: FounderConfidence } {
  return candidates.reduce((acc, c) => (ORDER[c.level] < ORDER[acc.level] ? c : acc));
}

// -----------------------------------------------------------------------------
// Supplier — mostly unchanged from Slice 1, now also reads
// confidenceInputs.supplier when present.
// -----------------------------------------------------------------------------

function deriveSupplierConfidence(ap: ApInvoiceCardIntelligence): DecisionConfidence {
  const vm = ap.vendorMatch;
  const inputs = ap.confidenceInputs?.supplier;
  const supporting: string[] = [];
  let level: FounderConfidence = "MODERATE";
  let reason: string | null = null;

  const matchState = inputs?.matchState ?? vm?.state ?? null;
  const signalCount = inputs?.profileSignalCount ?? 0;

  switch (matchState) {
    case "MATCHED": {
      level = "HIGH";
      supporting.push(`Existing vendor on file${vm?.matchedName ? `: ${vm.matchedName}` : ""}`);
      if (signalCount >= 2) supporting.push("Invoice header identifies the supplier");
      break;
    }
    case "AMBIGUOUS": {
      level = "MODERATE";
      reason = "Multiple potential vendor matches";
      supporting.push("More than one on-file vendor could match this invoice");
      break;
    }
    case "NOT_FOUND":
    default: {
      if (signalCount >= 3) {
        level = "HIGH";
        supporting.push("Invoice header, business address, and tax registration identify the supplier");
      } else if (signalCount >= 2) {
        level = "MODERATE";
        supporting.push("Invoice header and secondary identifiers indicate the supplier");
        reason = "New vendor — not yet on file";
      } else {
        level = "LOW";
        reason = "Supplier identity is based on limited invoice evidence and no vendor match exists";
        supporting.push("Only the invoice header identifies the supplier");
      }
      break;
    }
  }

  return { level, label: LONG_LABEL[level], supporting, reason };
}

// -----------------------------------------------------------------------------
// Transaction understanding (§7) — supersedes Slice 1's
// category.source-based mapping. Uses purpose confidence + purchased-
// object count + product identity + capital treatment + allocations.
// -----------------------------------------------------------------------------

function deriveTransactionConfidence(ap: ApInvoiceCardIntelligence): DecisionConfidence {
  const t = ap.confidenceInputs?.transaction;
  const cat = ap.category;
  const supporting: string[] = [];
  let level: FounderConfidence = "MODERATE";
  let reason: string | null = null;

  // No label at all → the founder cannot see what the invoice is
  // for. NEEDS_REVIEW regardless of purpose confidence.
  const categoryLabel = cat?.label ?? null;
  if (!categoryLabel && !cat?.purposeLabel) {
    level = "NEEDS_REVIEW";
    reason = "Transaction category could not be committed";
    supporting.push("Line-item content did not commit to a single category");
    return { level, label: LONG_LABEL[level], supporting, reason };
  }

  // Multiple allocations — evaluate per-allocation quality.
  if (categoryLabel === "Multiple") {
    const anyReview = (ap.allocations?.entries ?? []).some(
      (e) => e.recommendedAccount?.requiresReview === true,
    );
    const anyUnresolved = (ap.allocations?.entries ?? []).some(
      (e) => e.recommendedAccount == null,
    );
    if (anyUnresolved) {
      level = "NEEDS_REVIEW";
      reason = "One allocation could not commit to a GL account";
      supporting.push("Hover the Category cell for the allocation breakdown");
    } else if (anyReview) {
      level = "MODERATE";
      reason = "One allocation flagged for review";
      supporting.push(`Invoice covers ${t?.allocationCount ?? "multiple"} distinct accounting purposes`);
      supporting.push("Hover the Category cell for the allocation breakdown");
    } else {
      level = "HIGH";
      supporting.push(`Invoice covers ${t?.allocationCount ?? "multiple"} distinct accounting purposes`);
      supporting.push("Each allocation identifies a defensible category");
    }
    return { level, label: LONG_LABEL[level], supporting, reason };
  }

  // Single-category — score by the FROZEN evidence surface:
  //   - economic purpose confidence (Slice 5.2)
  //   - purchased-object count (Slice 5.3)
  //   - product identity status/confidence (Slice 5.4)
  //   - capital treatment state (Slice 5.7A)
  //
  // Rules (§7 + §16 "do not overclaim"):
  //   1. If capital treatment is AMBIGUOUS → transaction can't be HIGH
  //      (even when object identity is strong). Cap at MODERATE.
  //   2. If purpose is committed (source != null && != "ABSTAIN") AND
  //      purpose confidence >= 60 → HIGH.
  //   3. If capital treatment is committed (OPERATING or CAPITAL) AND
  //      purchased-object count >= 1 → HIGH.
  //   4. If purchased-object count >= 1 or product identity resolved →
  //      MODERATE.
  //   5. Else MODERATE (default when we have some category signal).
  //   6. Weak evidence (no committed purpose AND no purchased object
  //      AND no product identity) → LOW.
  const purposeCommitted = !!t?.economicPurposeSource
    && t.economicPurposeSource !== "ABSTAIN"
    && t.economicPurposeSource !== "NONE";
  const strongPurpose = purposeCommitted && (t?.economicPurposeConfidence ?? 0) >= 60;
  const hasPurchasedObjects = (t?.purchasedObjectCount ?? 0) >= 1;
  const productResolved = t?.productIdentityStatus === "RESOLVED_INTERNAL"
    || t?.productIdentityStatus === "RESOLVED_WITH_EXTERNAL_CORROBORATION";
  const capitalAmbiguous = t?.capitalTreatmentState === "AMBIGUOUS"
    || t?.capitalTreatmentState === "INSUFFICIENT_EVIDENCE";
  const capitalCommitted = t?.capitalTreatmentState === "OPERATING"
    || t?.capitalTreatmentState === "CAPITAL";

  // Build evidence prose from what we have.
  if (categoryLabel) supporting.push(`Line-item content indicates ${categoryLabel}`);
  else if (cat?.purposeLabel) supporting.push(`Purpose identified: ${cat.purposeLabel}`);
  if (hasPurchasedObjects) {
    supporting.push(`Purchased object${(t?.purchasedObjectCount ?? 0) > 1 ? "s" : ""} recovered from line items`);
  }
  if (productResolved) supporting.push("Product identity resolved");

  if (strongPurpose && capitalCommitted) {
    level = "HIGH";
  } else if (strongPurpose && !capitalAmbiguous) {
    level = "HIGH";
  } else if (capitalCommitted && hasPurchasedObjects) {
    level = "HIGH";
  } else if (capitalAmbiguous) {
    level = "MODERATE";
    reason = "Spectre identified the transaction, but capital-vs-operating treatment still requires judgment";
  } else if (hasPurchasedObjects || productResolved || categoryLabel) {
    level = "MODERATE";
    if (!reason) reason = "Category is defensible but purpose evidence is limited";
  } else {
    level = "LOW";
    reason = "Little primary evidence about the purchase";
  }

  return { level, label: LONG_LABEL[level], supporting, reason };
}

// -----------------------------------------------------------------------------
// GL (§9) — uses winner confidence + candidate separation from
// confidenceInputs.gl. Falls back to alternates when confidenceInputs
// is absent (e.g., older cached projections).
// -----------------------------------------------------------------------------

function deriveGlConfidence(ap: ApInvoiceCardIntelligence): DecisionConfidence {
  const cat = ap.category;
  const g = ap.confidenceInputs?.gl;
  const gl = cat?.glAccountNumber ?? null;
  const supporting: string[] = [];
  let level: FounderConfidence = "MODERATE";
  let reason: string | null = null;

  if (g?.abstained || !gl) {
    level = "NEEDS_REVIEW";
    reason = "GL abstention";
    supporting.push(
      "Spectre understands the purchase but cannot distinguish between remaining eligible accounts with enough confidence",
    );
    return { level, label: LONG_LABEL[level], supporting, reason };
  }

  // Multiple → defer to allocation-level review states.
  if (cat?.label === "Multiple") {
    const anyUnresolved = (ap.allocations?.entries ?? []).some(
      (e) => e.recommendedAccount == null,
    );
    const anyReview = (ap.allocations?.entries ?? []).some(
      (e) => e.recommendedAccount?.requiresReview === true,
    );
    if (anyUnresolved) {
      level = "NEEDS_REVIEW";
      reason = "One allocation could not commit to a GL account";
    } else if (anyReview) {
      level = "MODERATE";
      reason = "One allocation flagged for review";
    } else {
      level = "HIGH";
      supporting.push(`All ${ap.allocations?.entries?.length ?? ""} allocations commit to accepted GL accounts`.trim());
    }
    return { level, label: LONG_LABEL[level], supporting, reason };
  }

  // Single-allocation — evaluate via winner confidence + strongest
  // alternate confidence.
  const winnerConf = g?.winnerConfidence ?? null;
  const strongestAltConf = g?.strongestAlternateConfidence
    ?? (cat?.alternates?.[0]?.confidence ?? null);
  const compatibleCount = g?.compatibleCount ?? ((cat?.alternates?.length ?? 0) + 1);

  if (compatibleCount <= 1) {
    level = "HIGH";
    supporting.push("Only compatible posting account for this classification");
  } else if (strongestAltConf != null && strongestAltConf >= 50) {
    level = "MODERATE";
    reason = "Another compatible account is close in strength";
    supporting.push(`Best of ${compatibleCount} compatible accounts — the recommended account is preferred`);
    if (cat?.alternates?.[0]) {
      supporting.push(`Nearest alternative: ${cat.alternates[0].accountNumber} · ${cat.alternates[0].accountName}`);
    }
  } else if (winnerConf != null && winnerConf >= 70) {
    level = "HIGH";
    supporting.push(`Best of ${compatibleCount} compatible accounts — the recommended account is materially stronger`);
  } else {
    // A committed winner with moderate confidence and no close
    // alternate — reasonable but not HIGH.
    level = "MODERATE";
    reason = "Recommended account is defensible but not decisive";
    supporting.push(`Best of ${compatibleCount} compatible accounts`);
  }

  return { level, label: LONG_LABEL[level], supporting, reason };
}

// -----------------------------------------------------------------------------
// Composition (§10-§11)
// -----------------------------------------------------------------------------

/** Pure adapter — frozen backend unchanged.
 *
 *  §10: workflow blockers do NOT override the intelligence summary.
 *  §11: summary reports the weakest MATERIAL intelligence dimension.
 */
export function deriveFounderConfidenceView(
  ap: ApInvoiceCardIntelligence,
): FounderConfidenceView {
  const supplier = deriveSupplierConfidence(ap);
  const transaction = deriveTransactionConfidence(ap);
  const gl = deriveGlConfidence(ap);

  const weakest = weakestOf([
    { key: "supplier", level: supplier.level },
    { key: "transaction", level: transaction.level },
    { key: "gl", level: gl.level },
  ]);

  // Compact label — "High" alone when all-HIGH, else "Level · Dim".
  const summaryLabel = weakest.level === "HIGH"
    ? COMPACT_LEVEL_LABEL.HIGH
    : `${COMPACT_LEVEL_LABEL[weakest.level]} · ${DIMENSION_COMPACT_LABEL[weakest.key]}`;

  // Workflow snapshot — REPORTED separately, does not gate summary.
  const phase3 = ap.phase3Decision;
  const hasBlockers = (phase3?.blockers?.length ?? 0) > 0;
  const workflow = {
    label: (phase3?.state as string | undefined) ?? ap.workflowState ?? null,
    hasBlockers,
  };

  return {
    summaryLevel: weakest.level,
    summaryLabel,
    weakestDimension: weakest.level === "HIGH" ? null : weakest.key,
    supplier,
    transaction,
    gl,
    workflow,
  };
}
