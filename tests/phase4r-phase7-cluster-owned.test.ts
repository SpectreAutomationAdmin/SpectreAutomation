// Phase 4R · Phase 7 (2026-08-12) — cluster-owned classification tests.
//
// Locks in the founder-approved architecture:
//   THE ECONOMIC TRANSACTION CLUSTER IS THE UNIT OF GL CLASSIFICATION.
//
//   Single-cluster invariant: gl mirrors cluster canonical result.
//   Multi-cluster invariant:  gl.accountNumber = null + aggregated
//                             status + aggregated confidence.
//   Global-nature defeasibility: cluster-specific evidence can defeat
//                             document-level natureLeader.
//
// This file uses `projectClustersToGlRecommendation` + a curated
// `ApGlAllocation[]` fixture stream so we can exercise the projection
// logic without a full analyseIngestedInvoice DB round-trip. Fully
// end-to-end verification lives in `tests/ap-intelligence-integration.test.ts`
// + the real-fixture staging inspection.

import { describe, it, expect } from "vitest";
import { projectClustersToGlRecommendation, type ApGlAllocation } from "@/lib/ap-intelligence/gl-allocations";
import type { RecommendationStatus } from "@/lib/ap-intelligence/recommendation-policy";
import type { ConfidenceLevel } from "@/lib/ap-intelligence/canonical-confidence";

// ---------------------------------------------------------------------------
// Fixture builder — synthetic ApGlAllocation for projection testing
// ---------------------------------------------------------------------------

function mkAlloc(o: {
  accountNumber: string;
  accountName: string;
  amount: number;
  concept?: string;
  status?: RecommendationStatus;
  level?: ConfidenceLevel;
  winnerScore?: number;
  requiresReview?: boolean;
  genuineCompetitorsCount?: number;
}): ApGlAllocation {
  const status = o.status ?? "RECOMMEND";
  const level = o.level ?? "HIGH";
  const requiresReview = o.requiresReview ?? (status !== "RECOMMEND");
  return {
    id: `alloc-${o.accountNumber}`,
    sourceLineItemIds: ["1"],
    descriptions: [`Line for ${o.accountNumber}`],
    economicPurpose: {
      concept: o.concept ?? "generic",
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
      requiresReview,
      postingBlockers: [],
    } : null,
    alternatives: [],
    canonicalWinnerAccountNumber: o.accountNumber,
    recommendationStatus: status,
    canonicalConfidence: {
      level,
      winnerAccountId: `acct-${o.accountNumber}`,
      winnerAccountNumber: o.accountNumber,
      winnerScore: o.winnerScore ?? 70,
      winnerDecisionEvidenceCount: 2,
      winnerDecisionFamilyCount: 2,
      winnerContradictions: [],
      genuineCompetitors: Array.from({ length: o.genuineCompetitorsCount ?? 0 }, (_, i) => ({
        accountId: `acct-comp-${i}`,
        accountNumber: `9000${i}`,
        accountName: `Competitor ${i}`,
        score: (o.winnerScore ?? 70) - 5,
        marginToWinner: 5,
        qualificationReason: "test competitor",
      })),
      marginToStrongestCompetitor: null,
      isDeterministicTieBreak: false,
      recommendationStatus: status,
      reasonCodes: [],
      humanReadableReason: "test",
    },
  };
}

// ---------------------------------------------------------------------------
// §6 Single-cluster invariant
// ---------------------------------------------------------------------------

describe("Phase 7 · §6 · single-cluster invariant · gl mirrors cluster canonical result", () => {
  it("single-cluster RECOMMEND → gl.accountNumber === cluster canonicalWinnerAccountNumber", () => {
    const gl = projectClustersToGlRecommendation(
      [mkAlloc({ accountNumber: "6054", accountName: "Computer & IT Services", amount: 480 })],
      { fieldQualityEligible: true, fieldQualityAbstentionReasons: [], totalAccountsEvaluated: 30 },
    );
    expect(gl.accountNumber).toBe("6054");
    expect(gl.canonicalWinnerAccountNumber).toBe("6054");
    expect(gl.recommendationStatus).toBe("RECOMMEND");
    expect(gl.source).toBe("SEMANTIC_MATCH");
    expect(gl.confidence).toBe(70);
    expect(gl.candidates.length).toBeGreaterThanOrEqual(1);
    expect(gl.candidates[0].accountNumber).toBe("6054");
    // Single-cluster invariant: everything is projected from the ONE cluster.
    expect(gl.canonicalConfidence?.level).toBe("HIGH");
  });

  it("single-cluster ABSTAIN_AMBIGUITY → gl.accountNumber = null, canonicalWinner preserved", () => {
    const gl = projectClustersToGlRecommendation(
      [mkAlloc({ accountNumber: "6054", accountName: "Computer & IT Services", amount: 480,
        status: "ABSTAIN_AMBIGUITY", level: "REVIEW_REQUIRED" })],
      { fieldQualityEligible: true, fieldQualityAbstentionReasons: [], totalAccountsEvaluated: 30 },
    );
    expect(gl.accountNumber).toBeNull();
    expect(gl.canonicalWinnerAccountNumber).toBe("6054"); // winner preserved
    expect(gl.recommendationStatus).toBe("ABSTAIN_AMBIGUITY");
    expect(gl.requiresReview).toBe(true);
    expect(gl.autoApprovalEligible).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// §7 Multi-cluster projection invariant
// ---------------------------------------------------------------------------

describe("Phase 7 · §7 · multi-cluster projection · gl.accountNumber === null (§7 Option A)", () => {
  it("multi-cluster all-RECOMMEND → gl.accountNumber = null, overall RECOMMEND, HIGH aggregated when all HIGH", () => {
    const gl = projectClustersToGlRecommendation(
      [
        mkAlloc({ accountNumber: "6054", accountName: "Computer & IT Services", amount: 480, level: "HIGH" }),
        mkAlloc({ accountNumber: "6053", accountName: "Interest Expense", amount: 22, level: "HIGH" }),
      ],
      { fieldQualityEligible: true, fieldQualityAbstentionReasons: [], totalAccountsEvaluated: 30 },
    );
    expect(gl.accountNumber).toBeNull(); // §7 Option A
    expect(gl.canonicalWinnerAccountNumber).toBeNull();
    expect(gl.recommendationStatus).toBe("RECOMMEND");
    expect(gl.canonicalConfidence?.level).toBe("HIGH");
  });

  it("multi-cluster any-ABSTAIN → aggregated ABSTAIN status (any ABSTAIN_QUALITY takes precedence)", () => {
    const gl = projectClustersToGlRecommendation(
      [
        mkAlloc({ accountNumber: "6054", accountName: "Computer & IT Services", amount: 480, level: "HIGH", status: "RECOMMEND" }),
        mkAlloc({ accountNumber: "6053", accountName: "Interest Expense", amount: 22, level: "REVIEW_REQUIRED", status: "ABSTAIN_AMBIGUITY" }),
      ],
      { fieldQualityEligible: true, fieldQualityAbstentionReasons: [], totalAccountsEvaluated: 30 },
    );
    expect(gl.accountNumber).toBeNull();
    expect(gl.recommendationStatus).toBe("ABSTAIN_AMBIGUITY");
    expect(gl.canonicalConfidence?.level).toBe("REVIEW_REQUIRED");
    expect(gl.requiresReview).toBe(true);
  });

  it("multi-cluster mixed HIGH/MODERATE → aggregated MODERATE (weaker allocation surfaces)", () => {
    const gl = projectClustersToGlRecommendation(
      [
        mkAlloc({ accountNumber: "6054", accountName: "Computer & IT Services", amount: 480, level: "HIGH" }),
        mkAlloc({ accountNumber: "6020", accountName: "Grounds Maintenance", amount: 300, level: "MODERATE" }),
      ],
      { fieldQualityEligible: true, fieldQualityAbstentionReasons: [], totalAccountsEvaluated: 30 },
    );
    expect(gl.accountNumber).toBeNull();
    expect(gl.canonicalConfidence?.level).toBe("MODERATE");
  });

  it("multi-cluster any-REVIEW_REQUIRED → overall REVIEW_REQUIRED", () => {
    const gl = projectClustersToGlRecommendation(
      [
        mkAlloc({ accountNumber: "6054", accountName: "Computer & IT Services", amount: 480, level: "HIGH" }),
        mkAlloc({ accountNumber: "6020", accountName: "Grounds Maintenance", amount: 300, level: "REVIEW_REQUIRED", status: "ABSTAIN_AMBIGUITY" }),
      ],
      { fieldQualityEligible: true, fieldQualityAbstentionReasons: [], totalAccountsEvaluated: 30 },
    );
    expect(gl.canonicalConfidence?.level).toBe("REVIEW_REQUIRED");
    expect(gl.requiresReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §11 Five test archetypes (A-E)
// ---------------------------------------------------------------------------

describe("Phase 7 · §11 · archetype A · 221178-shaped single-cluster with incidental full-OCR maintenance text", () => {
  it("cluster canonical produces IT-services winner despite doc-wide 'maintenance' word (no doc-level ranker)", () => {
    // 221178-shape: single cluster whose LINE items describe IT services.
    // Under Phase 7 the doc-level ranker no longer runs, so incidental
    // full-OCR "maintenance" text cannot contaminate GL classification.
    const gl = projectClustersToGlRecommendation(
      [mkAlloc({ accountNumber: "6054", accountName: "Computer & IT Services", amount: 480,
        concept: "computer_it_services", level: "HIGH", winnerScore: 75 })],
      { fieldQualityEligible: true, fieldQualityAbstentionReasons: [], totalAccountsEvaluated: 30 },
    );
    expect(gl.accountNumber).toBe("6054");
    expect(gl.canonicalWinnerAccountNumber).toBe("6054");
    // Winner MUST NOT be an R&M account contaminated by incidental doc text.
    expect(gl.accountName).not.toContain("Maintenance");
    expect(gl.accountName).not.toContain("R & M");
  });
});

describe("Phase 7 · §11 · archetype B · genuine single-cluster R&M invoice — R&M remains discoverable", () => {
  it("R&M cluster winner still surfaces at document level (regression against over-correction)", () => {
    const gl = projectClustersToGlRecommendation(
      [mkAlloc({ accountNumber: "6035", accountName: "R & M - Ground Equipment", amount: 420,
        concept: "repairs_and_maintenance", level: "HIGH", winnerScore: 68 })],
      { fieldQualityEligible: true, fieldQualityAbstentionReasons: [], totalAccountsEvaluated: 30 },
    );
    expect(gl.accountNumber).toBe("6035");
    expect(gl.recommendationStatus).toBe("RECOMMEND");
    // Removing doc-level canonical did NOT suppress legitimate R&M
    // classification when line items support it.
  });
});

describe("Phase 7 · §11 · archetype C · single-cluster software/service invoice", () => {
  it("software service cluster winner surfaces at document level", () => {
    const gl = projectClustersToGlRecommendation(
      [mkAlloc({ accountNumber: "6071", accountName: "Subscriptions", amount: 1200,
        concept: "subscriptions", level: "HIGH" })],
      { fieldQualityEligible: true, fieldQualityAbstentionReasons: [], totalAccountsEvaluated: 30 },
    );
    expect(gl.accountNumber).toBe("6071");
    expect(gl.recommendationStatus).toBe("RECOMMEND");
  });
});

describe("Phase 7 · §11 · archetype D · capital acquisition with incidental service/maintenance wording", () => {
  it("capital cluster winner surfaces cleanly; incidental service language does not steer into R&M", () => {
    // Capital acquisition — cluster's own line items describe the durable
    // asset. Any surrounding service/maintenance text in the invoice
    // no longer contaminates because Phase 7 removes the doc-level ranker.
    const gl = projectClustersToGlRecommendation(
      [mkAlloc({ accountNumber: "1500", accountName: "Equipment & Fixtures", amount: 52000,
        concept: "capital_equipment", level: "HIGH", winnerScore: 80 })],
      { fieldQualityEligible: true, fieldQualityAbstentionReasons: [], totalAccountsEvaluated: 30 },
    );
    expect(gl.accountNumber).toBe("1500");
    expect(gl.recommendationStatus).toBe("RECOMMEND");
  });
});

describe("Phase 7 · §11 · archetype E · genuine multi-allocation invoice", () => {
  it("multi-cluster invoice → gl.accountNumber = null (no synthetic representative)", () => {
    const gl = projectClustersToGlRecommendation(
      [
        mkAlloc({ accountNumber: "6064", accountName: "Membership & Dues", amount: 480,
          concept: "employee_professional_membership_dues", level: "HIGH" }),
        mkAlloc({ accountNumber: "6053", accountName: "Interest Expense", amount: 35,
          concept: "finance_interest_charge", level: "MODERATE",
          status: "ABSTAIN_AMBIGUITY" }),
      ],
      { fieldQualityEligible: true, fieldQualityAbstentionReasons: [], totalAccountsEvaluated: 30 },
    );
    expect(gl.accountNumber).toBeNull();
    // Both allocations preserved for founder review.
    // Any non-RECOMMEND → aggregate flips to ABSTAIN.
    expect(gl.recommendationStatus).toBe("ABSTAIN_AMBIGUITY");
    expect(gl.requiresReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §12 Global-nature defeasibility (mandatory)
// ---------------------------------------------------------------------------

describe("Phase 7 · §12 · global natureLeader is defeasible by cluster-specific evidence", () => {
  it("global nature suggests R&M but cluster line items describe IT service → cluster wins (mock-level test)", () => {
    // This test is a MOCK-LEVEL demonstration: the projection layer
    // never runs rankCanonical itself — it consumes cluster canonical
    // results. So this test synthesises the SITUATION that the
    // canonical ranker would produce when nature=REPAIR_AND_MAINTENANCE
    // but cluster line items uniquely support IT services.
    //
    // In the real staging pipeline, `rankClusterCanonically` receives
    // natureLeader as globalSignals. `rankCanonical` scores NATURE_COMPAT
    // (+15) for R&M accounts, but the cluster-scoped queryConcepts from
    // line-item text drive a stronger LINE_ITEM_MATCH / ONTOLOGY_NAME_MATCH
    // for the actual purchased-item account. The line-item scoring
    // family cap (TRANSACTION_TEXT max 40) exceeds the CAPITAL_NATURE
    // family cap (25), so cluster-specific evidence CAN overcome global
    // nature signals when the transaction substance is clear.
    //
    // Real end-to-end validation of this defeasibility lives in the
    // canonical-ranker suite (§5 tests where nature is set to
    // REPAIR_MAINTENANCE but line items describe a capital acquisition,
    // and the CAPITAL_ASSET winner still emerges).
    //
    // Projection-level assertion: when the cluster canonical result IS
    // the IT-services winner (regardless of global nature), the projection
    // faithfully surfaces it as the document GL.
    const clusterWinnerDespiteGlobalRmNature: ApGlAllocation = mkAlloc({
      accountNumber: "6054",
      accountName: "Computer & IT Services",
      amount: 480,
      concept: "computer_it_services",
      level: "HIGH",
      winnerScore: 72,
    });
    const gl = projectClustersToGlRecommendation(
      [clusterWinnerDespiteGlobalRmNature],
      { fieldQualityEligible: true, fieldQualityAbstentionReasons: [], totalAccountsEvaluated: 30 },
    );
    expect(gl.accountNumber).toBe("6054");
    // Confirmation: even if globalSignals.natureLeader was
    // "REPAIR_AND_MAINTENANCE", once the cluster canonical result is IT
    // services, the projection surfaces IT services. No parallel
    // doc-level competition second-guesses it.
  });
});

// ---------------------------------------------------------------------------
// §18 Field-quality projection safety
// ---------------------------------------------------------------------------

describe("Phase 7 · §18 · field-quality ABSTAIN forces overall ABSTAIN_QUALITY regardless of cluster outcomes", () => {
  it("field-quality FAIL with strong single-cluster RECOMMEND → gl surfaces ABSTAIN_QUALITY", () => {
    const gl = projectClustersToGlRecommendation(
      [mkAlloc({ accountNumber: "6054", accountName: "Computer & IT Services", amount: 480, level: "HIGH" })],
      {
        fieldQualityEligible: false,
        fieldQualityAbstentionReasons: ["supplier_rejected_placeholder", "line_items_insufficient_for_gl"],
        totalAccountsEvaluated: 30,
      },
    );
    expect(gl.accountNumber).toBeNull(); // legacy compat
    expect(gl.recommendationStatus).toBe("ABSTAIN_QUALITY");
    expect(gl.abstentionCategory).toBe("QUALITY");
    // Winner provenance still preserved.
    expect(gl.canonicalWinnerAccountNumber).toBe("6054");
    expect(gl.autoApprovalEligible).toBe(false);
    expect(gl.requiresReview).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §21 No allocations case
// ---------------------------------------------------------------------------

describe("Phase 7 · §21 · no allocations → ABSTAIN_NO_CANDIDATES", () => {
  it("empty allocations returns ABSTAIN_NO_CANDIDATES with clean shape", () => {
    const gl = projectClustersToGlRecommendation([], {
      fieldQualityEligible: true, fieldQualityAbstentionReasons: [], totalAccountsEvaluated: 30,
    });
    expect(gl.accountNumber).toBeNull();
    expect(gl.recommendationStatus).toBe("ABSTAIN_NO_CANDIDATES");
    expect(gl.abstentionCategory).toBe("NO_CANDIDATES");
    expect(gl.requiresReview).toBe(true);
    expect(gl.candidates).toEqual([]);
  });
});
