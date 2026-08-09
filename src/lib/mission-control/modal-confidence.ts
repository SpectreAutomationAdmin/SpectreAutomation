// Sprint 3 · Phase 5 · Slice 3 (2026-08-09) — modal-context founder
// confidence adapters. These are THIN wrappers over the Slice 2
// `deriveFounderConfidenceView` that select and focus the fields
// each modal step actually needs.
//
//   VENDOR PROFILE step (§5-§8): focus on SUPPLIER IDENTITY.
//     Distinguish supplier identity confidence (does the document
//     identify the vendor?) from tenant vendor-match state (is there
//     an on-file vendor row?). Do NOT show transaction / GL
//     confidence on this step — that is the wrong decision surface
//     to load here.
//
//   AP CODING step (§9-§18): focus on TRANSACTION UNDERSTANDING,
//     GL RECOMMENDATION, and ALLOCATION QUALITY (per allocation).
//     The recommended account stays visible even when confidence is
//     Moderate; confidence explains the strength of the
//     recommendation, it does NOT replace it (§10).
//
// PRESENTATION ONLY. No frozen decision changes. No paid provider
// calls. Same qualitative taxonomy as Slices 1 & 2 (HIGH / MODERATE
// / LOW / NEEDS_REVIEW).

import type { ApInvoiceCardIntelligence } from "./intelligence-review-intakes";
import {
  deriveFounderConfidenceView,
  type FounderConfidence,
  type DecisionConfidence,
} from "./founder-confidence";

// -----------------------------------------------------------------------------
// Vendor Profile step
// -----------------------------------------------------------------------------

export type VendorMatchDescriptor =
  | { state: "MATCHED"; label: string }
  | { state: "AMBIGUOUS"; label: string }
  | { state: "NOT_FOUND"; label: string };

export interface VendorStepConfidenceView {
  /** Supplier IDENTITY confidence — how sure Spectre is the document
   *  identifies the correct supplier. Independent of §6 tenant
   *  vendor-match state. */
  supplier: DecisionConfidence;
  /** Founder-facing vendor name Spectre proposes. */
  proposedName: string;
  /** §6 — SEPARATE from supplier identity. Answers "is there an
   *  existing vendor row on file?" without downgrading the identity
   *  score when the answer is 'no'. */
  vendorMatch: VendorMatchDescriptor;
}

export function deriveVendorStepConfidence(
  ap: ApInvoiceCardIntelligence,
): VendorStepConfidenceView {
  const view = deriveFounderConfidenceView(ap);
  const proposedName =
    ap.vendorMatch?.matchedName
    ?? ap.extractedVendor?.name
    ?? "Unnamed supplier";

  const matchState = ap.confidenceInputs?.supplier?.matchState
    ?? ap.vendorMatch?.state
    ?? "NOT_FOUND";

  let vendorMatch: VendorMatchDescriptor;
  switch (matchState) {
    case "MATCHED":
      vendorMatch = {
        state: "MATCHED",
        label: ap.vendorMatch?.matchedName
          ? `Matched to existing vendor: ${ap.vendorMatch.matchedName}`
          : "Matched to existing vendor",
      };
      break;
    case "AMBIGUOUS":
      vendorMatch = {
        state: "AMBIGUOUS",
        label: "Multiple potential vendor matches on file",
      };
      break;
    case "NOT_FOUND":
    default:
      vendorMatch = {
        state: "NOT_FOUND",
        label: "No existing vendor found",
      };
      break;
  }

  return { supplier: view.supplier, proposedName, vendorMatch };
}

// -----------------------------------------------------------------------------
// AP Coding step
// -----------------------------------------------------------------------------

export type AllocationConfidenceLevel = "HIGH" | "MODERATE" | "NEEDS_REVIEW";

export interface AllocationConfidenceRow {
  entryId: string;
  concept: string;
  amount: number;
  recommendedAccountNumber: string | null;
  recommendedAccountName: string | null;
  level: AllocationConfidenceLevel;
  label: string;
  /** Optional italicised reason when not HIGH. */
  reason: string | null;
}

export interface CodingStepConfidenceView {
  /** Transaction understanding — what Spectre believes the invoice
   *  is for. Same source as Slice 2. */
  transaction: DecisionConfidence;
  /** GL recommendation — the strength of the recommended account. */
  gl: DecisionConfidence;
  /** Founder-facing recommended account (§10). Stays visible even
   *  when confidence is Moderate. Null only when the frozen analyser
   *  actually abstained. */
  recommendedAccount: { number: string; name: string } | null;
  /** True when the frozen analyser abstained from a GL recommendation. */
  recommendedAccountAbstained: boolean;
  /** §16-§17 — per-allocation confidence rows. Empty when the invoice
   *  is single-allocation. */
  allocations: AllocationConfidenceRow[];
  /** §12-§13 — humanised GL alternative disclosure entries. Uses
   *  frozen ap.category.alternates and canonical rejection reasons
   *  when available. Never carries raw score internals. */
  glAlternatives: Array<{
    accountNumber: string;
    accountName: string;
    /** Concise founder-facing reason WHY the alternative was not
     *  picked (§13). Never a score. */
    rejectionReason: string;
  }>;
}

const ALLOCATION_LABEL: Record<AllocationConfidenceLevel, string> = {
  HIGH: "High",
  MODERATE: "Moderate",
  NEEDS_REVIEW: "Needs review",
};

export function deriveCodingStepConfidence(
  ap: ApInvoiceCardIntelligence,
): CodingStepConfidenceView {
  const view = deriveFounderConfidenceView(ap);
  const cat = ap.category;
  const glAccountNumber = cat?.glAccountNumber ?? null;
  const glAccountName = cat?.glAccountName ?? null;
  const abstained = ap.confidenceInputs?.gl?.abstained === true
    || (!glAccountNumber && cat?.label !== "Multiple");

  const recommendedAccount = glAccountNumber && glAccountName
    ? { number: glAccountNumber, name: glAccountName }
    : null;

  // §16-§17 per-allocation confidence
  const allocations: AllocationConfidenceRow[] = (ap.allocations?.entries ?? []).map((e) => {
    let level: AllocationConfidenceLevel;
    let reason: string | null = null;
    if (!e.recommendedAccount) {
      level = "NEEDS_REVIEW";
      reason = "No compatible GL account could be recommended for this allocation";
    } else if (e.recommendedAccount.requiresReview) {
      level = "MODERATE";
      reason = "Recommended account is defensible but flagged for review before posting";
    } else {
      level = "HIGH";
    }
    return {
      entryId: e.id,
      concept: e.economicPurposeConcept,
      amount: e.amount,
      recommendedAccountNumber: e.recommendedAccount?.accountNumber ?? null,
      recommendedAccountName: e.recommendedAccount?.accountName ?? null,
      level,
      label: ALLOCATION_LABEL[level],
      reason,
    };
  });

  // §12-§13 GL alternatives — humanised rejection reason.
  const glAlternatives = (cat?.alternates ?? []).slice(0, 3).map((a) => ({
    accountNumber: a.accountNumber,
    accountName: a.accountName,
    rejectionReason: buildAlternativeReason(a.accountName, glAccountName),
  }));

  return {
    transaction: view.transaction,
    gl: view.gl,
    recommendedAccount,
    recommendedAccountAbstained: abstained,
    allocations,
    glAlternatives,
  };
}

// §13 — Explain WHY an alternative was not picked in founder language,
// derived from the account NAME semantics (never from score weights).
// Falls back to a neutral "less defensible" sentence when the account
// name is unrecognised.
function buildAlternativeReason(altName: string, winnerName: string | null): string {
  const n = altName.toLowerCase();
  if (/construction.in.progress|cip|work.in.progress|wip/.test(n)) {
    return "The invoice describes complete, in-service equipment rather than an incomplete project.";
  }
  if (/repairs?.and.maintenance|maintenance/.test(n)) {
    return "The invoice describes a capital purchase rather than a repair or maintenance service.";
  }
  if (/prepaid/.test(n)) {
    return "The invoice covers services already rendered rather than a prepayment.";
  }
  if (/supplies|consumables/.test(n)) {
    return "The invoice describes a durable asset rather than consumable supplies.";
  }
  if (/fuel/.test(n) && winnerName && !/fuel/i.test(winnerName)) {
    return "The invoice is not a fuel purchase.";
  }
  if (/rent|lease/.test(n)) {
    return "The invoice describes a purchase rather than a rental or lease charge.";
  }
  return `${altName} is a defensible alternative but is a weaker fit for the invoice's evidence than the recommended account.`;
}

// -----------------------------------------------------------------------------
// Small helpers exported for the component
// -----------------------------------------------------------------------------

const COMPACT_LEVEL_LABEL: Record<FounderConfidence, string> = {
  HIGH: "High",
  MODERATE: "Moderate",
  LOW: "Low",
  NEEDS_REVIEW: "Needs review",
};

export function compactConfidenceLabel(level: FounderConfidence): string {
  return COMPACT_LEVEL_LABEL[level];
}
