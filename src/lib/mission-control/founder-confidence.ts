// Sprint 3 · Phase 5 · Slice 1 (2026-08-09) — founder-facing
// confidence adapter.
//
// This module maps the FROZEN Phase 4 backend confidence signals into
// qualitative labels the founder can act on. It is PRESENTATION ONLY:
//
//   NEVER changes a canonical accounting decision.
//   NEVER moves an item through a workflow gate.
//   NEVER computes new numeric scores that could compete with the
//     Phase 3 workflow decision.
//   NEVER hardcodes supplier/invoice/product literals.
//
// Its sole job is to translate:
//   ApInvoiceCardIntelligence  →  { supplier, category, gl } confidence
//                                  levels + humanised evidence phrases
// so the compact AP card can display "High confidence" / "Moderate
// confidence" / "Needs review" per decision instead of a single generic
// percentage.
//
// The Phase 3 workflow decision (`phase3Decision.state` and
// `.blockers`) is authoritative for workflow-level readiness. This
// adapter respects it (§16 acceptance rule: cannot show
// "Low confidence / Ready for approval").

import type {
  ApInvoiceCardIntelligence,
} from "./intelligence-review-intakes";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type FounderConfidence = "HIGH" | "MODERATE" | "LOW" | "NEEDS_REVIEW";

export interface DecisionConfidence {
  level: FounderConfidence;
  /** One-line summary displayed under the value ("High confidence"). */
  label: string;
  /** Humanised evidence bullets rendered in the disclosure popover.
   *  Each string is founder-facing prose — never a debug field name. */
  supporting: string[];
  /** For NEEDS_REVIEW / LOW: a short explanation. Ignored on HIGH. */
  reason?: string | null;
}

export interface FounderConfidenceView {
  /** Worst-of the three visible decisions — drives the summary label on
   *  the closed card. */
  summaryLevel: FounderConfidence;
  summaryLabel: string;
  supplier: DecisionConfidence;
  category: DecisionConfidence;
  gl: DecisionConfidence;
}

// -----------------------------------------------------------------------------
// Level utilities
// -----------------------------------------------------------------------------

const LABELS: Record<FounderConfidence, string> = {
  HIGH: "High confidence",
  MODERATE: "Moderate confidence",
  LOW: "Low confidence",
  NEEDS_REVIEW: "Needs review",
};

/** Ordered worst → best so we can pick the weakest of a set. */
const ORDER: Record<FounderConfidence, number> = {
  NEEDS_REVIEW: 0,
  LOW: 1,
  MODERATE: 2,
  HIGH: 3,
};

function worst(...levels: FounderConfidence[]): FounderConfidence {
  return levels.reduce((acc, l) => (ORDER[l] < ORDER[acc] ? l : acc), "HIGH" as FounderConfidence);
}

// -----------------------------------------------------------------------------
// Supplier
// -----------------------------------------------------------------------------

function deriveSupplierConfidence(ap: ApInvoiceCardIntelligence): DecisionConfidence {
  const vm = ap.vendorMatch;
  const supporting: string[] = [];
  let level: FounderConfidence = "MODERATE";
  let reason: string | null = null;

  switch (vm?.state) {
    case "MATCHED": {
      level = "HIGH";
      supporting.push(`Existing vendor on file${vm.matchedName ? `: ${vm.matchedName}` : ""}`);
      // Extraction evidence supplements the match.
      if (ap.extractedVendorProfile?.address?.line1?.value) {
        supporting.push("Invoice header identifies the supplier");
      }
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
      // Not-on-file is not necessarily low — extraction may still be
      // strong. Assess based on extracted profile signals available on
      // the frozen projection. Uses ExtractedVendorProfile field names.
      const p = ap.extractedVendorProfile;
      const signalCount = [
        p?.address?.line1?.value,
        p?.website?.value,
        p?.taxRegistrationNumber?.value,
        p?.phone?.value,
      ].filter(Boolean).length;
      if (signalCount >= 3) {
        level = "HIGH";
        supporting.push("Invoice header, business address, and tax registration identify the supplier");
      } else if (signalCount >= 2) {
        level = "MODERATE";
        supporting.push("Invoice header and secondary identifiers indicate the supplier");
        reason = "New vendor — not yet on file";
      } else {
        level = "LOW";
        reason = "Limited supplier evidence on the invoice";
        supporting.push("Only the invoice header identifies the supplier");
      }
      break;
    }
  }

  return { level, label: LABELS[level], supporting, reason };
}

// -----------------------------------------------------------------------------
// Category / purpose
// -----------------------------------------------------------------------------

function deriveCategoryConfidence(ap: ApInvoiceCardIntelligence): DecisionConfidence {
  const cat = ap.category;
  const supporting: string[] = [];
  let level: FounderConfidence = "MODERATE";
  let reason: string | null = null;

  const label = cat?.label ?? null;

  if (!label) {
    level = "NEEDS_REVIEW";
    reason = "Category evidence is limited";
    supporting.push("Line-item content did not commit to a single category");
    return { level, label: LABELS[level], supporting, reason };
  }

  if (label === "Multiple") {
    // Multiple is INTENTIONAL. Each allocation has its own confidence,
    // surfaced via the CategoryHoverAllocations popover on the Category
    // cell itself. Summarise: if any allocation requiresReview, the
    // Category dimension is Moderate; otherwise High.
    const anyReview = (ap.allocations?.entries ?? []).some(
      (e) => e.recommendedAccount?.requiresReview === true,
    );
    level = anyReview ? "MODERATE" : "HIGH";
    supporting.push(`Invoice covers ${ap.allocations?.entries?.length ?? "multiple"} distinct accounting purposes`);
    supporting.push("Hover the Category cell for the allocation breakdown");
    return { level, label: LABELS[level], supporting, reason: anyReview ? "One allocation requires review" : null };
  }

  // Single-category cases — level depends on source strength.
  switch (cat.source) {
    case "PRIOR_CODING":
    case "VENDOR_DEFAULT":
      level = "HIGH";
      supporting.push("Consistent with this vendor's typical coding");
      break;
    case "NAME_KEYWORD":
    case "CAPITAL_CLASS_MAP":
      level = "HIGH";
      supporting.push("Line-item content indicates " + label);
      break;
    case "NONE":
    default:
      // The label is present but the source is thin. Downgrade unless
      // there's another positive signal.
      if ((cat.alternates?.length ?? 0) === 0) {
        level = "MODERATE";
        supporting.push("Line-item content indicates " + label);
      } else {
        level = "MODERATE";
        reason = "One or more alternative categories were considered";
        supporting.push("Line-item content indicates " + label);
      }
      break;
  }

  return { level, label: LABELS[level], supporting, reason };
}

// -----------------------------------------------------------------------------
// GL
// -----------------------------------------------------------------------------

function deriveGlConfidence(ap: ApInvoiceCardIntelligence): DecisionConfidence {
  const cat = ap.category;
  const gl = cat?.glAccountNumber ?? null;
  const alts = cat?.alternates ?? [];
  const supporting: string[] = [];
  let level: FounderConfidence = "MODERATE";
  let reason: string | null = null;

  if (!gl) {
    level = "NEEDS_REVIEW";
    reason = "GL abstention";
    supporting.push(
      "Spectre understands the purchase but cannot distinguish between remaining eligible accounts with enough confidence",
    );
    return { level, label: LABELS[level], supporting, reason };
  }

  // Multiple allocations — evaluate the worst allocation's GL state.
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
      supporting.push("Hover the Category cell for the allocation-level breakdown");
    } else if (anyReview) {
      level = "MODERATE";
      reason = "One allocation flagged for review";
      supporting.push("Each allocation has an accepted GL account");
      supporting.push("Hover the Category cell for the allocation-level breakdown");
    } else {
      level = "HIGH";
      supporting.push(`All ${ap.allocations?.entries?.length ?? ""} allocations commit to accepted GL accounts`.trim());
    }
    return { level, label: LABELS[level], supporting, reason };
  }

  // Single-allocation candidate separation. The projection exposes
  // `alternates[]` — each with its own numeric confidence. The
  // winner's confidence isn't reified as a top-line field, so we use
  // the presence and strength of alternates to characterize the
  // decision:
  //   0 alts    → HIGH ("only compatible account")
  //   1+ alt with alt-confidence < 50 → HIGH (materially weaker
  //                                             alternates exist but
  //                                             don't compete)
  //   1+ alt with alt-confidence >= 50 → MODERATE (a semantically
  //                                                  compatible
  //                                                  alternative is
  //                                                  competitive)
  const strongestAlt = alts[0];
  const strongestAltConf = strongestAlt?.confidence ?? 0;
  if (alts.length === 0) {
    level = "HIGH";
    supporting.push("Only compatible posting account for this classification");
  } else if (strongestAltConf < 50) {
    level = "HIGH";
    supporting.push(`Best of ${alts.length + 1} compatible account${alts.length === 0 ? "" : "s"} — the recommended account is materially stronger`);
  } else {
    level = "MODERATE";
    reason = "Another compatible account is close in strength";
    supporting.push(`Best of ${alts.length + 1} compatible accounts — the recommended account is preferred`);
    if (strongestAlt) {
      supporting.push(`Nearest alternative: ${strongestAlt.accountNumber} · ${strongestAlt.accountName}`);
    }
  }

  return { level, label: LABELS[level], supporting, reason };
}

// -----------------------------------------------------------------------------
// Composition
// -----------------------------------------------------------------------------

/** Adapter — pure function. Frozen backend unchanged.
 *
 *  Special §7/§16 rule: the workflow decision remains authoritative. If
 *  the Phase 3 decision has committed blockers or requires review, the
 *  summary level cannot exceed the dimension confidences AND the summary
 *  label bubbles up "Needs review" so the founder never sees
 *  "High confidence" on an item the workflow is actually blocking.
 */
export function deriveFounderConfidenceView(
  ap: ApInvoiceCardIntelligence,
): FounderConfidenceView {
  const supplier = deriveSupplierConfidence(ap);
  const category = deriveCategoryConfidence(ap);
  const gl = deriveGlConfidence(ap);

  let summaryLevel = worst(supplier.level, category.level, gl.level);

  // §7/§16 workflow authority. If Phase 3 has BLOCKING requirements,
  // never promote the summary above Needs Review.
  const phase3 = ap.phase3Decision;
  const hasHardBlocker = (phase3?.blockers?.length ?? 0) > 0;
  if (hasHardBlocker) summaryLevel = worst(summaryLevel, "NEEDS_REVIEW");

  return {
    summaryLevel,
    summaryLabel: LABELS[summaryLevel],
    supplier,
    category,
    gl,
  };
}
