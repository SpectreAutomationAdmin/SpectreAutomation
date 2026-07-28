// Sprint 3 · Checkpoint 15P-4 (2026-07-28) — the ONE shared function
// that decides how the Create-Vendor / AP-Coding modal opens.
//
// Founder rule (§Existing high-certainty vendor must bypass Vendor
// Profile): "Define and document the exact routing decision in one
// shared function rather than duplicating conditions in the work-
// card action, modal initialization and API response handling."
//
// Callers:
//   • EmailIntakeCard    — decides which primary-action click
//                          opens which modal shape.
//   • CreateVendorAndPostModal — reads the resolution and either
//                          renders a single-step AP-Coding modal
//                          (auto-resolved) or the two-step guided
//                          flow (Vendor Profile → AP Coding).
//
// Auto-resolve rule (ALL must be true):
//
//   1. classification === "exact" OR "strong"
//   2. leading candidate has NO differed fields on any conflict-
//      critical field (that would be caught by classification but
//      we assert it explicitly)
//   3. no second candidate is within AMBIGUITY_MATCHED_WEIGHT_GAP
//      of the leader's matched weight (default 15). This ensures
//      the leader is not just marginally ahead of a plausible
//      alternative.
//
// If any of the three fails → status "review_required" with a
// reason enum the modal uses to render the right hint.

import type { MatchClassification } from "./evaluate";

// Minimum matched-weight gap between the leader and the runner-up
// before we accept the leader as unambiguous. 15 was chosen so that:
//   • A leader that carries a strong identifier (tax id +25 or
//     legal name +25 more than a runner-up) auto-resolves.
//   • Two records where the only difference is one weak field
//     (city 5, country 2, ptDays 2) do NOT auto-resolve.
export const AMBIGUITY_MATCHED_WEIGHT_GAP = 15;

// The subset of VendorSearchMatch fields the resolver needs. Kept
// narrow so `resolveModalEntry` never depends on the full API row
// shape and stays testable in isolation.
export interface CandidateForResolution {
  id: string;
  legalName: string;
  classification: MatchClassification;
  matchedWeight: number;
  differedFields: string[];
}

export type ResolveModalEntryReason =
  | "no_match"
  | "limited_evidence"
  | "ambiguous"
  | "conflicting";

export type ResolveModalEntry =
  | {
      status: "resolved";
      vendorId: string;
      vendorLegalName: string;
      candidate: CandidateForResolution;
      allCandidates: CandidateForResolution[];
    }
  | {
      status: "review_required";
      reason: ResolveModalEntryReason;
      allCandidates: CandidateForResolution[];
    };

/**
 * Given the ranked candidate list from /api/vendors/search, return
 * the modal-entry resolution.
 *
 * Assumes `candidates` is already sorted best-first (the API sorts
 * by classification → rankingScore → matchedWeight before returning).
 */
export function resolveModalEntry(candidates: CandidateForResolution[]): ResolveModalEntry {
  // (1) Empty candidate list → new-vendor path.
  if (candidates.length === 0) {
    return { status: "review_required", reason: "no_match", allCandidates: [] };
  }

  const leader = candidates[0];

  // (2) Leader classification must be a strong positive.
  if (leader.classification === "conflicting") {
    return { status: "review_required", reason: "conflicting", allCandidates: candidates };
  }
  if (leader.classification === "possible") {
    return { status: "review_required", reason: "limited_evidence", allCandidates: candidates };
  }
  if (leader.differedFields.length > 0) {
    // Belt-and-braces: any non-empty differedFields on the leader
    // means the record disagrees on at least one comparable field.
    // Fall to review even for classifications that would otherwise
    // pass.
    return { status: "review_required", reason: "conflicting", allCandidates: candidates };
  }

  // (3) Ambiguity check — the leader must be materially ahead of
  //     every runner-up that could plausibly BE the same vendor.
  //     "Plausible" = classification exact or strong.
  const rivals = candidates.slice(1).filter((c) => c.classification === "exact" || c.classification === "strong");
  for (const rival of rivals) {
    if (leader.matchedWeight - rival.matchedWeight < AMBIGUITY_MATCHED_WEIGHT_GAP) {
      return { status: "review_required", reason: "ambiguous", allCandidates: candidates };
    }
  }

  return {
    status: "resolved",
    vendorId: leader.id,
    vendorLegalName: leader.legalName,
    candidate: leader,
    allCandidates: candidates,
  };
}
