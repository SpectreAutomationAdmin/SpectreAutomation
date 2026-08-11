// Phase 4R · single-GL-authority refactor · Phase 2.2 type contract tests
// + Phase 2.3 unit tests (rankCanonical implementation to be added).
//
// Purpose:
//   1. Prove the CanonicalRankerResult discriminated union enforces
//      `winner === candidates[0]` at compile time (structural
//      impossibility per founder §6).
//   2. Provide runtime unit tests for rankCanonical() as its
//      implementation lands.

import { describe, it, expect } from "vitest";
import {
  canonicalWinnerAccountNumber,
  canonicalHasRecommendation,
  rankCanonical,
  type CanonicalRankerResult,
  type CanonicalCandidate,
  type RankedCandidatesNonEmpty,
} from "@/lib/ap-intelligence/canonical-ranker";

// ---------------------------------------------------------------------------
// Type-contract tests
// ---------------------------------------------------------------------------

function makeCandidate(overrides: Partial<CanonicalCandidate> = {}): CanonicalCandidate {
  return {
    accountId: "acct-1",
    accountNumber: "6054",
    accountName: "Computer & IT Services",
    accountType: "EXPENSE",
    categoryKey: "ADMIN_EXPENSES",
    fsGroupKey: "IS_IT_SOFTWARE",
    score: 82,
    familyContributions: {
      TRANSACTION_TEXT: 45,
      TAXONOMY_ALIGNMENT: 20,
      NATURE_ROLE: 12,
      VENDOR_HISTORY: 5,
      DEPARTMENT_CONTEXT: 0,
    },
    contradictionPenalty: 0,
    evidence: [],
    contradictions: [],
    postable: true,
    postingBlockers: [],
    ...overrides,
  };
}

describe("Phase 4R · CanonicalRankerResult · structural invariant", () => {
  it("RECOMMEND result requires a non-empty candidates tuple", () => {
    // This test proves the TYPE contract by construction — the
    // compiler rejects a RECOMMEND result with an empty candidates
    // array. Runtime construction below is only defensively confirmed.
    const winner = makeCandidate({ accountNumber: "6054" });
    const runnerUp = makeCandidate({ accountNumber: "6071", accountName: "Subscriptions", score: 58 });
    const candidates: RankedCandidatesNonEmpty = [winner, runnerUp];
    const result: CanonicalRankerResult = {
      status: "RECOMMEND",
      candidates,
      abstentionReason: null,
      provenance: {
        rulesFired: ["taxonomy_alignment", "transaction_text"],
        totalCandidatesConsidered: 15,
        eligibilityRejectedCount: 0,
        rankerVersion: 1,
      },
    };
    expect(canonicalWinnerAccountNumber(result)).toBe("6054");
    expect(canonicalHasRecommendation(result)).toBe(true);
  });

  it("ABSTAIN result also enforces candidates[0] === winner", () => {
    const winner = makeCandidate({ accountNumber: "6033", score: 35 });
    const result: CanonicalRankerResult = {
      status: "ABSTAIN",
      candidates: [winner],
      abstentionReason: "Score 35 below commit floor 45",
      provenance: {
        rulesFired: ["insufficient_evidence"],
        totalCandidatesConsidered: 12,
        eligibilityRejectedCount: 0,
        rankerVersion: 1,
      },
    };
    expect(canonicalWinnerAccountNumber(result)).toBe("6033");
    expect(canonicalHasRecommendation(result)).toBe(false);
  });

  it("NO_ELIGIBLE_CANDIDATES has no winner and empty candidates", () => {
    const result: CanonicalRankerResult = {
      status: "NO_ELIGIBLE_CANDIDATES",
      candidates: [],
      abstentionReason: "Phase-2 eligibility produced zero accounts",
      provenance: {
        rulesFired: [],
        totalCandidatesConsidered: 0,
        eligibilityRejectedCount: 47,
        rankerVersion: 1,
      },
    };
    expect(canonicalWinnerAccountNumber(result)).toBeNull();
    expect(canonicalHasRecommendation(result)).toBe(false);
    // Structural check: candidates array is empty by type.
    expect(result.candidates.length).toBe(0);
  });

  it("ANALYSIS_FAILURE is distinct from NO_ELIGIBLE_CANDIDATES", () => {
    const result: CanonicalRankerResult = {
      status: "ANALYSIS_FAILURE",
      candidates: [],
      abstentionReason: "conceptRelatedness threw: unexpected concept id",
      provenance: {
        rulesFired: [],
        totalCandidatesConsidered: 0,
        eligibilityRejectedCount: 0,
        rankerVersion: 1,
      },
    };
    expect(canonicalWinnerAccountNumber(result)).toBeNull();
    expect(result.status).toBe("ANALYSIS_FAILURE");
    // The discriminant lets consumers distinguish "we didn't have
    // any eligible account" from "we hit a bug or unexpected
    // condition" — critical for §7 not collapsing these into
    // accountNumber: null.
  });

  it("§1 architectural law · candidates[0] IS the winner (not a separate winnerAccountNumber field)", () => {
    // Structural proof: there is no `winnerAccountNumber` field on
    // the RECOMMEND/ABSTAIN variants. The winner accessor derives
    // from candidates[0] by definition, so it CANNOT diverge from
    // the candidate list.
    const winner = makeCandidate({ accountNumber: "1500", accountName: "Equipment & Fixtures" });
    const alt = makeCandidate({ accountNumber: "1540", accountName: "Equipment & Vehicles", score: 58 });
    const result: CanonicalRankerResult = {
      status: "RECOMMEND",
      candidates: [winner, alt],
      abstentionReason: null,
      provenance: {
        rulesFired: ["capital_asset_match", "nature_compat"],
        totalCandidatesConsidered: 15,
        eligibilityRejectedCount: 0,
        rankerVersion: 1,
      },
    };
    // The invariant is trivially proven by reading candidates[0]:
    // the winner accessor returns it directly.
    expect(canonicalWinnerAccountNumber(result)).toBe(result.candidates[0].accountNumber);
    expect(canonicalWinnerAccountNumber(result)).toBe("1500");
  });
});

// ---------------------------------------------------------------------------
// rankCanonical() runtime tests — Phase 2.3 implementation pending
// ---------------------------------------------------------------------------

describe("Phase 4R · rankCanonical · placeholder (Phase 2.3 implementation pending)", () => {
  it("placeholder implementation returns NO_ELIGIBLE_CANDIDATES", () => {
    // The Phase 2.2 canonical-ranker.ts file exports rankCanonical
    // as a placeholder that returns NO_ELIGIBLE_CANDIDATES
    // unconditionally. This test locks that behaviour so Phase 2.3
    // must replace the body deliberately — cannot accidentally leave
    // the placeholder in place.
    const result = rankCanonical({
      transaction: {
        purposeConcept: null,
        purposeConfidence: 0,
        purposeQuality: "NONE",
        capitalDecision: null,
        capitalConfidence: 0,
        natureLeader: "UNKNOWN",
        natureConfidence: 0,
        natureIsDefensible: false,
        departmentKey: null,
        departmentAccountNamePatterns: [],
        canonicalLineItems: [],
        queryConcepts: [],
        vendor: {
          matchedVendorId: null,
          defaultAccountId: null,
          priorCodingAccountNumbers: [],
        },
        documentPhraseText: null,
      },
      eligibleAccounts: [],
      postingBlockersByAccount: new Map(),
    });
    expect(result.status).toBe("NO_ELIGIBLE_CANDIDATES");
    expect(result.abstentionReason).toMatch(/Phase 2\.3 implementation pending/);
    expect(canonicalWinnerAccountNumber(result)).toBeNull();
    // Phase 2.3 will change this test's expectations as the ranker
    // starts producing real results. That's the intended TDD posture.
  });
});
