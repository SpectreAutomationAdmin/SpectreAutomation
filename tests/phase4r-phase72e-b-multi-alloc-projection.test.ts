// Phase 4R · Phase 7.2E-b (2026-08-13) — multi-cluster projection tests.
//
// Founder §8 mandatory:
//   - membership + penalty: both resolved → Multiple, no false ambiguity, no review
//   - goods + freight + tax: distinct accounting, resolved allocations remain resolved
//   - one clear + one ambiguous: clear stays resolved, whole doc requires review
//   - two ambiguous: review required, cluster-level reasons preserved
//
// Tests exercise `projectClustersToGlRecommendation` directly with
// synthetic `ApGlAllocation` fixtures. No vendor/invoice/account literals.

import { describe, it, expect } from "vitest";
import { projectClustersToGlRecommendation, type ApGlAllocation } from "@/lib/ap-intelligence/gl-allocations";
import type { RecommendationStatus } from "@/lib/ap-intelligence/recommendation-policy";
import type { ConfidenceLevel } from "@/lib/ap-intelligence/canonical-confidence";

function mkAlloc(o: {
  accountNumber: string;
  accountName: string;
  amount: number;
  status?: RecommendationStatus;
  level?: ConfidenceLevel;
  winnerScore?: number;
}): ApGlAllocation {
  const status = o.status ?? "RECOMMEND";
  const level = o.level ?? "HIGH";
  return {
    id: `alloc-${o.accountNumber}`,
    sourceLineItemIds: ["1"],
    descriptions: [`Line for ${o.accountNumber}`],
    economicPurpose: {
      concept: "generic",
      confidence: 80,
      supportingEvidence: [],
    },
    amount: o.amount,
    taxTreatment: "TAXABLE",
    taxRate: null,
    taxAmount: null,
    recommendedAccount: status === "RECOMMEND" ? {
      accountId: `acct-${o.accountNumber}`,
      accountNumber: o.accountNumber,
      accountName: o.accountName,
      confidence: o.winnerScore ?? 70,
      requiresReview: false,
      postingBlockers: [],
    } : null,
    alternatives: [],
    canonicalWinnerAccountNumber: status === "RECOMMEND" ? o.accountNumber : null,
    recommendationStatus: status,
    canonicalConfidence: {
      level,
      winnerAccountId: status === "RECOMMEND" ? `acct-${o.accountNumber}` : null,
      winnerAccountNumber: status === "RECOMMEND" ? o.accountNumber : null,
      winnerScore: o.winnerScore ?? 70,
      winnerDecisionEvidenceCount: 2,
      winnerDecisionFamilyCount: 2,
      winnerContradictions: [],
      genuineCompetitors: [],
      marginToStrongestCompetitor: null,
      isDeterministicTieBreak: false,
      recommendationStatus: status,
      reasonCodes: [],
      humanReadableReason: "test",
    },
  };
}

const OPTS = { fieldQualityEligible: true, fieldQualityAbstentionReasons: [], totalAccountsEvaluated: 30 };

describe("Phase 7.2E-b · §8 multi-allocation projection semantics", () => {
  it("Membership + penalty: both RECOMMEND HIGH → MULTIPLE_RESOLVED, no false ambiguity, no review", () => {
    const gl = projectClustersToGlRecommendation(
      [
        mkAlloc({ accountNumber: "6064", accountName: "Membership & Dues", amount: 400 }),
        mkAlloc({ accountNumber: "6065", accountName: "Late Payment Penalty", amount: 150 }),
      ],
      OPTS,
    );
    expect(gl.accountNumber).toBeNull(); // §4 — no doc-level winner
    expect(gl.recommendationStatus).toBe("RECOMMEND"); // §3 all-RECOMMEND
    expect(gl.abstentionCategory).toBeNull(); // NOT ambiguity
    expect(gl.requiresReview).toBe(false); // §3 no review for MULTIPLE_RESOLVED
    // §9 per-allocation winners preserved in candidates
    expect(gl.candidates.length).toBe(2);
    expect(gl.candidates.map((c) => c.accountNumber).sort()).toEqual(["6064", "6065"]);
    // §5 aggregate confidence = HIGH (both HIGH)
    expect(gl.canonicalConfidence?.level).toBe("HIGH");
    expect(gl.canonicalConfidence?.reasonCodes).toContain("multiple_resolved");
  });

  it("Goods + freight + tax: all RECOMMEND → MULTIPLE_RESOLVED", () => {
    const gl = projectClustersToGlRecommendation(
      [
        mkAlloc({ accountNumber: "6025", accountName: "Grounds Supplies", amount: 2000 }),
        mkAlloc({ accountNumber: "5030", accountName: "Delivery & Freight", amount: 150 }),
      ],
      OPTS,
    );
    expect(gl.accountNumber).toBeNull();
    expect(gl.recommendationStatus).toBe("RECOMMEND");
    expect(gl.requiresReview).toBe(false);
    expect(gl.candidates.length).toBe(2);
  });

  it("One clear + one ambiguous: doc requires review; clear stays RECOMMEND in candidates", () => {
    const gl = projectClustersToGlRecommendation(
      [
        mkAlloc({ accountNumber: "6064", accountName: "Membership & Dues", amount: 400, status: "RECOMMEND", level: "HIGH" }),
        mkAlloc({ accountNumber: "6065", accountName: "Ambiguous Cluster", amount: 150, status: "ABSTAIN_AMBIGUITY", level: "REVIEW_REQUIRED" }),
      ],
      OPTS,
    );
    expect(gl.accountNumber).toBeNull();
    expect(gl.recommendationStatus).toBe("ABSTAIN_AMBIGUITY"); // §3 propagates the ambiguity
    expect(gl.requiresReview).toBe(true);
    // §3 clear allocation preserved in candidates (only 1 has recommendedAccount)
    expect(gl.candidates.length).toBe(1);
    expect(gl.candidates[0].accountNumber).toBe("6064");
    expect(gl.canonicalConfidence?.reasonCodes).toContain("multiple_review_required");
  });

  it("Two ambiguous clusters: review required, no candidates surfaced", () => {
    const gl = projectClustersToGlRecommendation(
      [
        mkAlloc({ accountNumber: "6064", accountName: "A", amount: 400, status: "ABSTAIN_AMBIGUITY", level: "REVIEW_REQUIRED" }),
        mkAlloc({ accountNumber: "6065", accountName: "B", amount: 150, status: "ABSTAIN_AMBIGUITY", level: "REVIEW_REQUIRED" }),
      ],
      OPTS,
    );
    expect(gl.accountNumber).toBeNull();
    expect(gl.recommendationStatus).toBe("ABSTAIN_AMBIGUITY");
    expect(gl.requiresReview).toBe(true);
    expect(gl.candidates.length).toBe(0);
  });

  it("HIGH + MODERATE → aggregate MODERATE (§5 weakest material)", () => {
    const gl = projectClustersToGlRecommendation(
      [
        mkAlloc({ accountNumber: "6064", accountName: "A", amount: 400, level: "HIGH" }),
        mkAlloc({ accountNumber: "6065", accountName: "B", amount: 150, level: "MODERATE" }),
      ],
      OPTS,
    );
    expect(gl.canonicalConfidence?.level).toBe("MODERATE");
    expect(gl.recommendationStatus).toBe("RECOMMEND");
    expect(gl.requiresReview).toBe(false);
  });

  it("gl.accountNumber must be null even when 2 clusters resolve to same account (§4 no majority selection)", () => {
    const gl = projectClustersToGlRecommendation(
      [
        mkAlloc({ accountNumber: "6054", accountName: "Computer & IT Services", amount: 300 }),
        mkAlloc({ accountNumber: "6054", accountName: "Computer & IT Services", amount: 200 }),
      ],
      OPTS,
    );
    // Even though both clusters agree, projection must NOT select
    // 6054 as doc-level winner. Allocations are the coding.
    expect(gl.accountNumber).toBeNull();
    expect(gl.recommendationStatus).toBe("RECOMMEND");
    expect(gl.requiresReview).toBe(false);
    expect(gl.candidates.length).toBe(2);
  });

  it("§17 SAFETY: non-RECOMMEND cluster forces requiresReview=true even if others resolve", () => {
    const gl = projectClustersToGlRecommendation(
      [
        mkAlloc({ accountNumber: "6064", accountName: "A", amount: 400, status: "RECOMMEND", level: "HIGH" }),
        mkAlloc({ accountNumber: "1", accountName: "B", amount: 150, status: "ABSTAIN_QUALITY", level: "REVIEW_REQUIRED" }),
      ],
      OPTS,
    );
    expect(gl.requiresReview).toBe(true);
    expect(gl.recommendationStatus).toBe("ABSTAIN_QUALITY");
    expect(gl.autoApprovalEligible).toBeFalsy();
  });
});
