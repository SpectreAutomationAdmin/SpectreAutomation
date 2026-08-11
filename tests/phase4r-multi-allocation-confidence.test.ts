// Phase 4R final freeze-blocker (2026-08-11) — §11 multi-allocation
// confidence test matrix. Locks the invariant:
//
//   A MULTI-GL ANSWER IS NOT AN ABSTENTION IF SPECTRE CONFIDENTLY
//   KNOWS EACH ALLOCATION.
//
// The first-failure boundary was `founder-confidence.ts::deriveGlConfidence`
// which short-circuited on `!gl` (Correction D nulls `category.gl`
// for Multiple) before reaching the Multiple branch. Fix: Multiple
// branch runs first; abstention fallback runs only for single-
// allocation invoices.

import { describe, it, expect } from "vitest";
import { deriveFounderConfidenceView } from "@/lib/mission-control/founder-confidence";
import type { ApInvoiceCardIntelligence } from "@/lib/mission-control/intelligence-review-intakes";

// Base fixture — supplier HIGH, transaction HIGH, GL varies by test.
function multiFixture(over: {
  allocations: NonNullable<ApInvoiceCardIntelligence["allocations"]>["entries"];
  categoryGlAccountNumber?: string | null;   // Correction D nulls this for Multiple
  glAbstained?: boolean;                     // doc-level analysis.gl.accountNumber == null
  allocationCount?: number;
}): ApInvoiceCardIntelligence {
  const base = {
    intakeId: "ap-multi",
    displaySender: "Vendor",
    displaySubject: "Invoice.pdf",
    invoiceNumber: "INV-M",
    vendorMatch: { state: "MATCHED", matchedName: "TestVendor Inc", matchedVendorId: "v1" },
    category: {
      label: "Multiple",
      source: "ALLOCATIONS",
      // Correction D: null for Multiple
      glAccountNumber: over.categoryGlAccountNumber ?? null,
      glAccountName: over.categoryGlAccountNumber ? "some-name" : null,
      confidence: 90,
      alternates: [],
      capitalState: "OPERATING",
      purposeLabel: null,
      purposeReason: null,
    },
    confidence: 100,
    gross: { amount: 1420.5, currency: "CAD" },
    currencyShowCode: true,
    workflowReason: "Missing information",
    workflowState: "MISSING_INFORMATION",
    workflowActions: [],
    allocations: { entries: over.allocations },
    extractedVendorProfile: null,
    confidenceInputs: {
      supplier: { matchState: "MATCHED", profileSignalCount: 3 },
      transaction: {
        economicPurposeSource: "CANONICAL_COMMITTED",
        economicPurposeConfidence: 82,
        purchasedObjectCount: 2,
        productIdentityStatus: null,
        productIdentityConfidence: null,
        capitalTreatmentState: "OPERATING",
        capitalTreatmentConfidence: 80,
        natureConfidence: 80,
        natureIsDefensible: true,
        allocationCount: over.allocationCount ?? over.allocations.length,
      },
      gl: {
        winnerConfidence: 90,
        compatibleCount: 1,
        strongestAlternateConfidence: null,
        // Whether the DOCUMENT-LEVEL single-account recommender abstained.
        // For a Multiple invoice, this is IRRELEVANT — the fix asserts
        // multi-allocation authority overrides single-account abstention.
        abstained: over.glAbstained ?? false,
      },
    },
  };
  return base as unknown as ApInvoiceCardIntelligence;
}

// Helper — build allocation entries with the shape deriveGlConfidence expects.
function alloc(recommendedAccount: null | { requiresReview?: boolean; accountNumber?: string }): { recommendedAccount: null | { accountNumber: string; accountName: string; confidence: number; requiresReview: boolean; postingBlockers: unknown[] } } {
  if (recommendedAccount == null) {
    return { recommendedAccount: null };
  }
  return {
    recommendedAccount: {
      accountNumber: recommendedAccount.accountNumber ?? "6064",
      accountName: "Some account",
      confidence: 80,
      requiresReview: recommendedAccount.requiresReview ?? false,
      postingBlockers: [],
    },
  };
}

describe("§11 multi-allocation confidence test matrix", () => {
  it("A · two allocations, both HIGH, arithmetic reconciled → GL HIGH → summary High", () => {
    const v = deriveFounderConfidenceView(multiFixture({
      allocations: [alloc({ accountNumber: "6064" }), alloc({ accountNumber: "6053" })] as any,
    }));
    expect(v.gl.level).toBe("HIGH");
    expect(v.summaryLabel).toBe("High");
    expect(v.summaryLevel).toBe("HIGH");
    expect(v.weakestDimension).toBeNull();
  });

  it("B · two allocations, one HIGH one requiresReview → GL MODERATE (summary weakest may be transaction OR gl — both are MODERATE on this shape)", () => {
    const v = deriveFounderConfidenceView(multiFixture({
      allocations: [alloc({ accountNumber: "6064" }), alloc({ accountNumber: "6053", requiresReview: true })] as any,
    }));
    expect(v.gl.level).toBe("MODERATE");
    expect(v.summaryLevel).toBe("MODERATE");
    // Founder-facing label is "Moderate · <weakest>" — either
    // dimension is a defensible weakest.
    expect(["Moderate · GL", "Moderate · Category"]).toContain(v.summaryLabel);
  });

  it("C · two allocations, one HIGH one requiresReview → GL MODERATE (same shape as B; no LOW state is emitted by the composer for allocation review)", () => {
    // The founder-confidence GL surface distinguishes:
    //   - unresolved (recommendedAccount == null) → NEEDS_REVIEW
    //   - requiresReview                          → MODERATE
    // A LOW state is not emitted for allocation review — per-alloc
    // winner confidence is not surfaced through requiresReview alone.
    const v = deriveFounderConfidenceView(multiFixture({
      allocations: [alloc({ accountNumber: "6064" }), alloc({ accountNumber: "6053", requiresReview: true })] as any,
    }));
    expect(v.gl.level).toBe("MODERATE");
  });

  it("D · two allocations, one unresolved (recommendedAccount null) → GL NEEDS_REVIEW", () => {
    const v = deriveFounderConfidenceView(multiFixture({
      allocations: [alloc({ accountNumber: "6064" }), alloc(null)] as any,
    }));
    expect(v.gl.level).toBe("NEEDS_REVIEW");
    expect(v.summaryLevel).toBe("NEEDS_REVIEW");
    // On this shape transaction is ALSO NEEDS_REVIEW (existing
    // deriveTransactionConfidence contract — locked by
    // mission-control-founder-confidence.test.ts). Summary label
    // tiebreaks to the leftmost weakest dimension.
    expect(["Needs review · GL", "Needs review · Category"]).toContain(v.summaryLabel);
  });

  it("E · three allocations, all HIGH → GL HIGH → summary High", () => {
    const v = deriveFounderConfidenceView(multiFixture({
      allocations: [alloc({ accountNumber: "6064" }), alloc({ accountNumber: "6053" }), alloc({ accountNumber: "6054" })] as any,
    }));
    expect(v.gl.level).toBe("HIGH");
    expect(v.summaryLabel).toBe("High");
  });

  it("F · one allocation, HIGH single-category → GL HIGH", () => {
    // Not a Multiple case; single allocation. Category label is a
    // concrete account (not 'Multiple'), glAccountNumber is set,
    // abstained is false.
    const v = deriveFounderConfidenceView({
      ...multiFixture({
        allocations: [alloc({ accountNumber: "6025" })] as any,
        categoryGlAccountNumber: "6025",
        allocationCount: 1,
      }),
      category: {
        label: "Fuel",
        source: "NAME_KEYWORD",
        glAccountNumber: "6025",
        glAccountName: "Fuel",
        confidence: 90,
        alternates: [],
        capitalState: "OPERATING",
        purposeLabel: null,
        purposeReason: null,
      } as any,
    });
    expect(v.gl.level).toBe("HIGH");
    expect(v.summaryLabel).toBe("High");
  });

  it("G · Multiple with all allocations HIGH but doc-level single-GL recommender ABSTAINED → GL HIGH (multi-allocation authority overrides single-account abstention)", () => {
    // THE MANDATORY TEST from §11: the exact CPA-shape defect.
    // Multi-account allocation authority = HIGH. Document-level
    // single-account recommender ABSTAINED because no single account
    // represents the invoice. Founder-facing GL confidence MUST be
    // HIGH, not "Needs review · GL". This is the invariant the fix
    // enforces.
    const v = deriveFounderConfidenceView(multiFixture({
      allocations: [alloc({ accountNumber: "6064" }), alloc({ accountNumber: "6053" })] as any,
      categoryGlAccountNumber: null,   // Correction D nulls this
      glAbstained: true,               // doc-level recommender abstained
    }));
    expect(v.gl.level).toBe("HIGH");
    expect(v.summaryLabel).toBe("High");
    expect(v.summaryLevel).toBe("HIGH");
    expect(v.weakestDimension).toBeNull();
  });

  it("§7 corollary · Multiple with all allocations HIGH and doc-level recommender COMMITTED to a single account → still GL HIGH (allocation authority owns the answer either way)", () => {
    // Same as G but doc-level recommender committed to a "best single
    // account" like 6064 (as CPA on v199 actually does). The Multiple
    // branch's decision must not be swayed by the doc-level answer.
    const v = deriveFounderConfidenceView(multiFixture({
      allocations: [alloc({ accountNumber: "6064" }), alloc({ accountNumber: "6053" })] as any,
      categoryGlAccountNumber: null,   // Correction D still nulls this for Multiple
      glAbstained: false,              // doc-level recommender did commit
    }));
    expect(v.gl.level).toBe("HIGH");
    expect(v.summaryLabel).toBe("High");
  });

  it("§14 no-confidence-by-outcome guard · Multiple with an unresolved allocation → NEEDS_REVIEW even though arithmetic reconciles perfectly", () => {
    // Even when the reconciliation math works out, an unresolved
    // allocation is real uncertainty. Confidence must not be inflated
    // just because subtotal + tax = total.
    const v = deriveFounderConfidenceView(multiFixture({
      allocations: [alloc({ accountNumber: "6064" }), alloc(null)] as any,
    }));
    expect(v.gl.level).toBe("NEEDS_REVIEW");
  });
});
