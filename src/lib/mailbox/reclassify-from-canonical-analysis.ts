// Sprint 3 · Post-16H P0-repair (2026-08-06) — canonical-analysis
// driven WorkIntakeItem reclassification.
//
// Founder-mandated invariant (P0 §3):
//   "When the canonical document result becomes available, notify /
//    recompute the parent email Work Intake item. Use the canonical
//    analysis to determine whether the message becomes AP invoice
//    work / vendor statement work / another accounting-document
//    workflow / informational / unsupported / another legitimate
//    classification. The document evidence that was unavailable at
//    initial arrival must now participate in the decision."
//
// This module is called whenever the mission-control projection
// successfully produces a canonical invoice / statement summary
// for a child AP intake. If the PARENT email WorkIntakeItem is
// still on a stale initial classification (INFORMATIONAL default),
// promote it in place — no duplicate WI, no new AP intake.
//
// The reclassification is CANONICAL-AWARE: it only fires when the
// child AP intake analyser produced enough evidence to justify an
// AP-flavoured classification. Insufficient evidence leaves the WI
// alone so that the founder-visible card correctly stays "analysis
// pending" rather than being wrongly promoted.
//
// This is a small, idempotent write — safe to call from any read
// path.

import { prisma } from "@/lib/prisma";
import { logger } from "@/lib/observability/logger";

const REPAIR_RULE_KEY = "reclassify_from_canonical_analysis";

export interface ReclassifyArgs {
  clubId: string;
  parentWorkIntakeItemId: string;
  /** True when analyseIngestedInvoice returned a STRUCTURED /
   *  PARTIAL extraction (evidence exists) — not DOCUMENT_UNREADABLE. */
  canonicalAnalysisSucceeded: boolean;
  /** Optional finer-grained document class from the canonical
   *  analysis: INVOICE / STATEMENT / CREDIT_MEMO / OTHER. */
  canonicalDocumentClass?: "INVOICE" | "STATEMENT" | "CREDIT_MEMO" | "OTHER";
}

export interface ReclassifyResult {
  updated: boolean;
  fromClassification: string | null;
  toClassification: string | null;
  fromStatus: string | null;
  toStatus: string | null;
}

/**
 * Idempotent reclassification: promote a parent EmailWorkIntakeItem
 * out of stale INFORMATIONAL when its child canonical AP analysis
 * produced evidence. NOP if:
 *   * the parent is already OPEN / IN_PROGRESS / RESOLVED
 *   * the parent is already classified as INVOICE_LIKELY /
 *     VENDOR_COMMUNICATION / a non-INFORMATIONAL label
 *   * the canonical analysis did NOT succeed (no evidence to justify
 *     promotion — leave the WI alone rather than force a wrong label)
 *   * the WI was manually assigned / resolved / suppressed (never
 *     overwrite operator state)
 */
export async function reclassifyFromCanonicalAnalysis(args: ReclassifyArgs): Promise<ReclassifyResult> {
  if (!args.canonicalAnalysisSucceeded) {
    return { updated: false, fromClassification: null, toClassification: null, fromStatus: null, toStatus: null };
  }
  const wi = await prisma.workIntakeItem.findFirst({
    where: { id: args.parentWorkIntakeItemId, clubId: args.clubId },
    select: {
      id: true, status: true, classification: true, classificationMethod: true,
      classificationRuleKey: true, ownerUserId: true, resolvedAt: true,
    },
  });
  if (!wi) {
    return { updated: false, fromClassification: null, toClassification: null, fromStatus: null, toStatus: null };
  }
  // Never overwrite operator state.
  if (wi.status === "RESOLVED" || wi.status === "SUPPRESSED") {
    return { updated: false, fromClassification: wi.classification, toClassification: wi.classification, fromStatus: wi.status, toStatus: wi.status };
  }
  if (wi.ownerUserId) {
    // Someone claimed it — respect assignment.
    return { updated: false, fromClassification: wi.classification, toClassification: wi.classification, fromStatus: wi.status, toStatus: wi.status };
  }
  // Only correct STALE INFORMATIONAL when there is canonical
  // evidence. Any other classification stays as-is — we do not
  // downgrade INVOICE_LIKELY to INFORMATIONAL from here.
  if (wi.classification !== "INFORMATIONAL") {
    return { updated: false, fromClassification: wi.classification, toClassification: wi.classification, fromStatus: wi.status, toStatus: wi.status };
  }
  // Pick the target classification from the document class.
  const targetClassification =
    args.canonicalDocumentClass === "STATEMENT" ? "VENDOR_COMMUNICATION"
    : args.canonicalDocumentClass === "CREDIT_MEMO" ? "INVOICE_LIKELY"
    : args.canonicalDocumentClass === "INVOICE" ? "INVOICE_LIKELY"
    : "INVOICE_LIKELY";     // OTHER / undefined defaults to invoice-likely
  const targetStatus = wi.status === "INFORMATIONAL" ? "OPEN" : wi.status;

  await prisma.workIntakeItem.update({
    where: { id: wi.id },
    data: {
      status: targetStatus,
      classification: targetClassification,
      classificationMethod: "RULE",
      classificationRuleKey: REPAIR_RULE_KEY,
      classificationReason: "Canonical document analysis produced evidence — promoted from initial INFORMATIONAL default.",
      classificationConfidence: 0.85,
      judgmentRequired: true,
    },
  });
  logger.info("mission-control.reclassify_from_canonical_analysis", {
    clubId: args.clubId,
    workIntakeItemIdTail: wi.id.slice(-8),
    from: wi.classification,
    to: targetClassification,
    fromStatus: wi.status,
    toStatus: targetStatus,
  });
  return {
    updated: true,
    fromClassification: wi.classification,
    toClassification: targetClassification,
    fromStatus: wi.status,
    toStatus: targetStatus,
  };
}
