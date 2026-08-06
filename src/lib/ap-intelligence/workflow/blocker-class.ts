// Sprint 3 · Post-16H Phase 3.2 (2026-08-06) — blocker classification.
//
// Not every NEEDS_JUDGMENT blocker permanently prohibits posting.
// The founder's §2 taxonomy:
//   HARD_BLOCK               — never post; return structured refusal.
//   REQUIRES_EXPLICIT_REVIEW — post only if the caller supplies review
//                              evidence (`acknowledgedBlockers[]` +
//                              a persisted ApReviewOverride row).
//   WARNING_ONLY             — post proceeds; blocker exists as a
//                              warning + prevents AUTO_APPROVAL only.
//
// This module is used by the server-side posting endpoint AND by
// any diagnostic surface that wants to communicate posting-blocking
// severity truthfully.

import type { ApWorkflowBlockerCode } from "./decision";

export type BlockerSeverity = "HARD_BLOCK" | "REQUIRES_EXPLICIT_REVIEW" | "WARNING_ONLY";

const HARD_BLOCK_CODES: ReadonlySet<ApWorkflowBlockerCode> = new Set<ApWorkflowBlockerCode>([
  "DOCUMENT_UNREADABLE",
  "GROSS_TOTAL_UNRESOLVED",
  "GL_INELIGIBLE",
  "ALLOCATION_VARIANCE",
  "DUPLICATE_INVOICE_RISK",
  "ACCOUNTING_NATURE_UNSUPPORTED",
  "CONTRADICTORY_EVIDENCE",
]);

const REQUIRES_REVIEW_CODES: ReadonlySet<ApWorkflowBlockerCode> = new Set<ApWorkflowBlockerCode>([
  "TAX_UNRECONCILED",
  "GL_BELOW_THRESHOLD",
  "MULTI_ALLOCATION_NOT_PER_ALLOCATION",
  "CAPITAL_TREATMENT_REVIEW_REQUIRED",
  "VENDOR_UNRESOLVED",
  "PAYABLE_REFERENCE_MISSING",
  "SUPPLIER_UNRESOLVED",
]);

const WARNING_ONLY_CODES: ReadonlySet<ApWorkflowBlockerCode> = new Set<ApWorkflowBlockerCode>([
  "POSTING_BLOCKER_UNRESOLVED",   // e.g. FUND_APPLICABILITY_UNMAPPED — blocks auto, not posting
  "LINE_ITEMS_MISSING",
]);

export function classifyBlocker(code: ApWorkflowBlockerCode): BlockerSeverity {
  if (HARD_BLOCK_CODES.has(code)) return "HARD_BLOCK";
  if (REQUIRES_REVIEW_CODES.has(code)) return "REQUIRES_EXPLICIT_REVIEW";
  if (WARNING_ONLY_CODES.has(code)) return "WARNING_ONLY";
  // Unknown code → conservative posture: treat as HARD_BLOCK.
  // Founder §2: never silently downgrade a blocker.
  return "HARD_BLOCK";
}

export interface PostingGateVerdict {
  allowed: boolean;
  hardBlockers: ApWorkflowBlockerCode[];
  requiresReviewBlockers: ApWorkflowBlockerCode[];
  warningOnlyBlockers: ApWorkflowBlockerCode[];
  acknowledgedByReview: ApWorkflowBlockerCode[];
  unacknowledgedRequiresReview: ApWorkflowBlockerCode[];
  refusalCode: "OK" | "HARD_BLOCK" | "UNACKNOWLEDGED_REVIEW";
  refusalMessage: string | null;
}

/** Evaluate the canonical decision against acknowledgements the
 *  client sent + already-persisted review-override rows. */
export function evaluatePostingGate(
  blockerCodes: ApWorkflowBlockerCode[],
  acknowledgedBlockerCodes: ApWorkflowBlockerCode[],
): PostingGateVerdict {
  const hardBlockers: ApWorkflowBlockerCode[] = [];
  const requiresReviewBlockers: ApWorkflowBlockerCode[] = [];
  const warningOnlyBlockers: ApWorkflowBlockerCode[] = [];
  const ackSet = new Set(acknowledgedBlockerCodes);
  const acknowledgedByReview: ApWorkflowBlockerCode[] = [];
  const unacknowledgedRequiresReview: ApWorkflowBlockerCode[] = [];

  for (const code of blockerCodes) {
    const sev = classifyBlocker(code);
    if (sev === "HARD_BLOCK") hardBlockers.push(code);
    else if (sev === "REQUIRES_EXPLICIT_REVIEW") {
      requiresReviewBlockers.push(code);
      if (ackSet.has(code)) acknowledgedByReview.push(code);
      else unacknowledgedRequiresReview.push(code);
    } else {
      warningOnlyBlockers.push(code);
    }
  }

  if (hardBlockers.length > 0) {
    return {
      allowed: false,
      hardBlockers, requiresReviewBlockers, warningOnlyBlockers,
      acknowledgedByReview, unacknowledgedRequiresReview,
      refusalCode: "HARD_BLOCK",
      refusalMessage: `Cannot post — hard blocker(s): ${hardBlockers.join(", ")}. Correct the underlying evidence before posting.`,
    };
  }
  if (unacknowledgedRequiresReview.length > 0) {
    return {
      allowed: false,
      hardBlockers, requiresReviewBlockers, warningOnlyBlockers,
      acknowledgedByReview, unacknowledgedRequiresReview,
      refusalCode: "UNACKNOWLEDGED_REVIEW",
      refusalMessage: `Cannot post — the following blocker(s) require explicit review before posting: ${unacknowledgedRequiresReview.join(", ")}.`,
    };
  }
  return {
    allowed: true,
    hardBlockers, requiresReviewBlockers, warningOnlyBlockers,
    acknowledgedByReview, unacknowledgedRequiresReview,
    refusalCode: "OK",
    refusalMessage: null,
  };
}
