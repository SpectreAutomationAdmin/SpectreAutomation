// Phase 4R · single-GL-authority refactor · Phase 3.6 (Group E) —
// recommendation-policy contract tests.
//
// Locks in the separation between the two founder-approved questions:
//   Classification: canonical ranker
//   Automation policy: this module
//
// Also locks in the safety invariants: winner provenance preserved
// under ABSTAIN, autoApprovalEligible false unless RECOMMEND, etc.

import { describe, it, expect } from "vitest";
import { evaluateRecommendationPolicy } from "@/lib/ap-intelligence/recommendation-policy";

describe("Phase 3.6 · §9 · recommendation-policy contract", () => {
  it("strong interpretation + canonical RECOMMEND → RECOMMEND, autoApprovalEligible=true, winner projected", () => {
    const decision = evaluateRecommendationPolicy({
      canonicalStatus: "RECOMMEND",
      canonicalWinnerAccountNumber: "6035",
      canonicalAbstentionReason: null,
      fieldQualityEligible: true,
      fieldQualityAbstentionReasons: [],
    });
    expect(decision.status).toBe("RECOMMEND");
    expect(decision.abstentionCategory).toBeNull();
    expect(decision.abstentionReasons).toEqual([]);
    expect(decision.canonicalWinnerAccountNumber).toBe("6035");
    expect(decision.autoApprovalEligible).toBe(true);
    expect(decision.requiresReview).toBe(false);
  });

  it("weak interpretation + canonical RECOMMEND → ABSTAIN_QUALITY, winner provenance preserved, no auto-approval", () => {
    const decision = evaluateRecommendationPolicy({
      canonicalStatus: "RECOMMEND",
      canonicalWinnerAccountNumber: "6035",
      canonicalAbstentionReason: null,
      fieldQualityEligible: false,
      fieldQualityAbstentionReasons: ["supplier_rejected_placeholder", "line_items_insufficient_for_gl"],
    });
    expect(decision.status).toBe("ABSTAIN_QUALITY");
    expect(decision.abstentionCategory).toBe("QUALITY");
    // §5: distinct reason preserved
    expect(decision.abstentionReasons).toEqual([
      "supplier_rejected_placeholder",
      "line_items_insufficient_for_gl",
    ]);
    // §4: canonical winner provenance preserved through ABSTAIN
    expect(decision.canonicalWinnerAccountNumber).toBe("6035");
    // §11: safety invariant — no auto-approval under any ABSTAIN
    expect(decision.autoApprovalEligible).toBe(false);
    expect(decision.requiresReview).toBe(true);
  });

  it("canonical ABSTAIN (genuine ambiguity) + strong field quality → ABSTAIN_AMBIGUITY, winner provenance preserved", () => {
    const decision = evaluateRecommendationPolicy({
      canonicalStatus: "ABSTAIN",
      canonicalWinnerAccountNumber: "6033",
      canonicalAbstentionReason: "top_score_below_commit_floor:26<30",
      fieldQualityEligible: true,
      fieldQualityAbstentionReasons: [],
    });
    expect(decision.status).toBe("ABSTAIN_AMBIGUITY");
    expect(decision.abstentionCategory).toBe("AMBIGUITY");
    expect(decision.abstentionReasons).toEqual(["top_score_below_commit_floor:26<30"]);
    // §4: winner provenance preserved even without commit
    expect(decision.canonicalWinnerAccountNumber).toBe("6033");
    expect(decision.autoApprovalEligible).toBe(false);
    expect(decision.requiresReview).toBe(true);
  });

  it("canonical NO_ELIGIBLE_CANDIDATES → ABSTAIN_NO_CANDIDATES (NOT ABSTAIN_QUALITY)", () => {
    const decision = evaluateRecommendationPolicy({
      canonicalStatus: "NO_ELIGIBLE_CANDIDATES",
      canonicalWinnerAccountNumber: null,
      canonicalAbstentionReason: "eligible_accounts_list_empty",
      fieldQualityEligible: true,
      fieldQualityAbstentionReasons: [],
    });
    expect(decision.status).toBe("ABSTAIN_NO_CANDIDATES");
    expect(decision.abstentionCategory).toBe("NO_CANDIDATES");
    expect(decision.canonicalWinnerAccountNumber).toBeNull();
    expect(decision.autoApprovalEligible).toBe(false);
    expect(decision.requiresReview).toBe(true);
  });

  it("canonical NO_ELIGIBLE_CANDIDATES takes precedence over weak field quality (not collapsed into ABSTAIN_QUALITY)", () => {
    const decision = evaluateRecommendationPolicy({
      canonicalStatus: "NO_ELIGIBLE_CANDIDATES",
      canonicalWinnerAccountNumber: null,
      canonicalAbstentionReason: "eligible_accounts_list_empty",
      // Even with weak field quality, the STRUCTURAL "no candidates"
      // signal must remain visible per §5 (distinct abstention causes).
      fieldQualityEligible: false,
      fieldQualityAbstentionReasons: ["supplier_rejected_placeholder"],
    });
    expect(decision.status).toBe("ABSTAIN_NO_CANDIDATES");
    expect(decision.abstentionCategory).toBe("NO_CANDIDATES");
  });

  it("canonical ANALYSIS_FAILURE → ABSTAIN_ANALYSIS_FAILURE (NOT ABSTAIN_QUALITY)", () => {
    const decision = evaluateRecommendationPolicy({
      canonicalStatus: "ANALYSIS_FAILURE",
      canonicalWinnerAccountNumber: null,
      canonicalAbstentionReason: "canonical_ranker_threw:database_timeout",
      fieldQualityEligible: true,
      fieldQualityAbstentionReasons: [],
    });
    expect(decision.status).toBe("ABSTAIN_ANALYSIS_FAILURE");
    expect(decision.abstentionCategory).toBe("ANALYSIS_FAILURE");
    expect(decision.autoApprovalEligible).toBe(false);
    expect(decision.requiresReview).toBe(true);
  });

  it("§11 safety invariant — autoApprovalEligible is FALSE for every non-RECOMMEND status", () => {
    const statuses: Array<{ status: "ABSTAIN" | "NO_ELIGIBLE_CANDIDATES" | "ANALYSIS_FAILURE"; }> = [
      { status: "ABSTAIN" },
      { status: "NO_ELIGIBLE_CANDIDATES" },
      { status: "ANALYSIS_FAILURE" },
    ];
    for (const { status } of statuses) {
      const decision = evaluateRecommendationPolicy({
        canonicalStatus: status,
        canonicalWinnerAccountNumber: status === "ABSTAIN" ? "6035" : null,
        canonicalAbstentionReason: `${status.toLowerCase()}_test`,
        fieldQualityEligible: true,
        fieldQualityAbstentionReasons: [],
      });
      expect(decision.autoApprovalEligible).toBe(false);
      expect(decision.requiresReview).toBe(true);
      expect(decision.status.startsWith("ABSTAIN_")).toBe(true);
    }
  });

  it("§6 policy inspects ONLY status + quality — never account names or candidate identities", () => {
    // Two calls that differ ONLY in canonicalWinnerAccountNumber should
    // return the same status/category/auto-approval. Policy is agnostic
    // to which specific account won; it never contains
    // "if account name looks like X" logic.
    const a = evaluateRecommendationPolicy({
      canonicalStatus: "RECOMMEND",
      canonicalWinnerAccountNumber: "6035",
      canonicalAbstentionReason: null,
      fieldQualityEligible: true,
      fieldQualityAbstentionReasons: [],
    });
    const b = evaluateRecommendationPolicy({
      canonicalStatus: "RECOMMEND",
      canonicalWinnerAccountNumber: "1500",
      canonicalAbstentionReason: null,
      fieldQualityEligible: true,
      fieldQualityAbstentionReasons: [],
    });
    expect(a.status).toBe(b.status);
    expect(a.abstentionCategory).toBe(b.abstentionCategory);
    expect(a.autoApprovalEligible).toBe(b.autoApprovalEligible);
    expect(a.requiresReview).toBe(b.requiresReview);
    // Only the winner provenance field differs.
    expect(a.canonicalWinnerAccountNumber).not.toBe(b.canonicalWinnerAccountNumber);
  });
});

describe("Phase 3.6 · §15 · anti-overfitting", () => {
  it("no vendor/invoice/account literal string comparisons in recommendation-policy.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve("src/lib/ap-intelligence/recommendation-policy.ts"),
      "utf8",
    ) as string;
    // Forbidden patterns (same shape as canonical-ranker anti-overfitting).
    const forbidden = [
      /===\s*["'](6054|6030|6033|6035|6051|6053|6064|6071|6072|1500|1502|1506|1540)["']/,
      /===\s*["']Club\s*Support/i,
      /===\s*["']OXIO/i,
      /===\s*["']Oakcreek/i,
      // Policy MUST NOT reference specific account names or vendor names.
      /accountName\s*===\s*["']/,
      /accountName\s*\.\s*includes/,
    ];
    for (const re of forbidden) {
      expect(src.match(re)).toBeNull();
    }
  });
});
