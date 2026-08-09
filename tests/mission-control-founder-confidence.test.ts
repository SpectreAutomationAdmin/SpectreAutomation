// Sprint 3 · Phase 5 · Slice 2 (2026-08-09) — decision-specific
// founder-confidence adapter tests. Locks the §11 weakest-material-
// dimension summary AND the §10 workflow-vs-confidence separation.

import { describe, it, expect } from "vitest";
import { deriveFounderConfidenceView } from "@/lib/mission-control/founder-confidence";
import type { ApInvoiceCardIntelligence } from "@/lib/mission-control/intelligence-review-intakes";

function fixture(over: Partial<ApInvoiceCardIntelligence> = {}): ApInvoiceCardIntelligence {
  const base = {
    intakeId: "ap-1",
    displaySender: "Accounts payable",
    displaySubject: "Invoice.pdf",
    invoiceNumber: "INV-1",
    vendorMatch: { state: "MATCHED", matchedName: "TestVendor Inc", matchedVendorId: "v1" },
    category: {
      label: "Fuel ( Gas/Diesel )",
      source: "NAME_KEYWORD",
      glAccountNumber: "6025",
      glAccountName: "Fuel",
      confidence: 90,
      alternates: [],
      capitalState: "OPERATING",
      purposeLabel: null,
      purposeReason: null,
    },
    confidence: 100,
    gross: { amount: 100, currency: "CAD" },
    currencyShowCode: true,
    workflowReason: "Ready for review",
    workflowState: "AP_REVIEW",
    workflowActions: [],
    allocations: null,
    extractedVendorProfile: null,
    // §5 Slice 2 read-only projected inputs
    confidenceInputs: {
      supplier: { matchState: "MATCHED", profileSignalCount: 3 },
      transaction: {
        economicPurposeSource: "CANONICAL_COMMITTED",
        economicPurposeConfidence: 82,
        purchasedObjectCount: 1,
        productIdentityStatus: null,
        productIdentityConfidence: null,
        capitalTreatmentState: "OPERATING",
        capitalTreatmentConfidence: 80,
        natureConfidence: 80,
        natureIsDefensible: true,
        allocationCount: 1,
      },
      gl: {
        winnerConfidence: 90,
        compatibleCount: 1,
        strongestAlternateConfidence: null,
        abstained: false,
      },
    },
  };
  return { ...base, ...over } as unknown as ApInvoiceCardIntelligence;
}

// -----------------------------------------------------------------
// §10 workflow-vs-confidence SEPARATION
// -----------------------------------------------------------------

describe("§10 workflow does NOT override intelligence confidence", () => {
  it("phase3 blockers present + all intelligence HIGH → summary High (not Needs review)", () => {
    const v = deriveFounderConfidenceView(fixture({
      phase3Decision: { blockers: [{ key: "VENDOR_ID_MISSING" }] } as any,
    }));
    expect(v.summaryLevel).toBe("HIGH");
    expect(v.summaryLabel).toBe("High");
    // Workflow surface still reports the blocker separately
    expect(v.workflow.hasBlockers).toBe(true);
  });

  it("phase3 blockers + supplier LOW → summary 'Low · Supplier'", () => {
    const v = deriveFounderConfidenceView(fixture({
      vendorMatch: { state: "NOT_FOUND", matchedName: null, matchedVendorId: null } as any,
      confidenceInputs: {
        supplier: { matchState: "NOT_FOUND", profileSignalCount: 0 },
        transaction: {
          economicPurposeSource: "CANONICAL_COMMITTED",
          economicPurposeConfidence: 82,
          purchasedObjectCount: 1,
          productIdentityStatus: null,
          productIdentityConfidence: null,
          capitalTreatmentState: "OPERATING",
          capitalTreatmentConfidence: 80,
          natureConfidence: 80,
          natureIsDefensible: true,
          allocationCount: 1,
        },
        gl: {
          winnerConfidence: 90,
          compatibleCount: 1,
          strongestAlternateConfidence: null,
          abstained: false,
        },
      },
      phase3Decision: { blockers: [{ key: "SOMETHING" }] } as any,
    }));
    expect(v.summaryLevel).toBe("LOW");
    expect(v.summaryLabel).toBe("Low · Supplier");
    expect(v.workflow.hasBlockers).toBe(true);
  });
});

// -----------------------------------------------------------------
// §11 weakest-material-dimension summary
// -----------------------------------------------------------------

describe("§11 compact summary reports weakest material intelligence dimension", () => {
  it("all HIGH → 'High'", () => {
    const v = deriveFounderConfidenceView(fixture());
    expect(v.summaryLabel).toBe("High");
    expect(v.weakestDimension).toBeNull();
  });

  it("transaction MODERATE (capital ambiguous) → 'Moderate · Category'", () => {
    const v = deriveFounderConfidenceView(fixture({
      confidenceInputs: {
        supplier: { matchState: "MATCHED", profileSignalCount: 3 },
        transaction: {
          economicPurposeSource: "CANONICAL_COMMITTED",
          economicPurposeConfidence: 82,
          purchasedObjectCount: 1,
          productIdentityStatus: null,
          productIdentityConfidence: null,
          capitalTreatmentState: "AMBIGUOUS",
          capitalTreatmentConfidence: null,
          natureConfidence: 50,
          natureIsDefensible: false,
          allocationCount: 1,
        },
        gl: {
          winnerConfidence: 90,
          compatibleCount: 1,
          strongestAlternateConfidence: null,
          abstained: false,
        },
      },
    }));
    expect(v.summaryLevel).toBe("MODERATE");
    expect(v.summaryLabel).toBe("Moderate · Category");
    expect(v.weakestDimension).toBe("transaction");
  });

  it("GL abstention → 'Needs review · GL'", () => {
    const v = deriveFounderConfidenceView(fixture({
      category: {
        label: "Fuel", source: "NAME_KEYWORD", glAccountNumber: null, glAccountName: null,
        confidence: null, alternates: [], capitalState: "OPERATING", purposeLabel: null, purposeReason: null,
      } as any,
      confidenceInputs: {
        supplier: { matchState: "MATCHED", profileSignalCount: 3 },
        transaction: {
          economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 82,
          purchasedObjectCount: 1, productIdentityStatus: null, productIdentityConfidence: null,
          capitalTreatmentState: "OPERATING", capitalTreatmentConfidence: 80,
          natureConfidence: 80, natureIsDefensible: true, allocationCount: 1,
        },
        gl: { winnerConfidence: null, compatibleCount: 0, strongestAlternateConfidence: null, abstained: true },
      },
    }));
    expect(v.summaryLevel).toBe("NEEDS_REVIEW");
    expect(v.summaryLabel).toBe("Needs review · GL");
    expect(v.weakestDimension).toBe("gl");
  });

  it("GL close alternate (>=50) → 'Moderate · GL'", () => {
    const v = deriveFounderConfidenceView(fixture({
      category: {
        label: "R&M", source: "NAME_KEYWORD", glAccountNumber: "6031", glAccountName: "R&M",
        confidence: 65,
        alternates: [{ accountNumber: "6025", accountName: "Grounds Supplies", confidence: 60 } as any],
        capitalState: "OPERATING", purposeLabel: null, purposeReason: null,
      } as any,
      confidenceInputs: {
        supplier: { matchState: "MATCHED", profileSignalCount: 3 },
        transaction: {
          economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 82,
          purchasedObjectCount: 1, productIdentityStatus: null, productIdentityConfidence: null,
          capitalTreatmentState: "OPERATING", capitalTreatmentConfidence: 80,
          natureConfidence: 80, natureIsDefensible: true, allocationCount: 1,
        },
        gl: { winnerConfidence: 65, compatibleCount: 2, strongestAlternateConfidence: 60, abstained: false },
      },
    }));
    expect(v.summaryLevel).toBe("MODERATE");
    expect(v.summaryLabel).toBe("Moderate · GL");
    expect(v.weakestDimension).toBe("gl");
  });
});

// -----------------------------------------------------------------
// §7 transaction understanding (not category.source)
// -----------------------------------------------------------------

describe("§7 transaction understanding uses richer evidence", () => {
  it("strong product identity + AMBIGUOUS capital → transaction MODERATE (not HIGH)", () => {
    const v = deriveFounderConfidenceView(fixture({
      confidenceInputs: {
        supplier: { matchState: "MATCHED", profileSignalCount: 3 },
        transaction: {
          economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 82,
          purchasedObjectCount: 1,
          productIdentityStatus: "RESOLVED_WITH_EXTERNAL_CORROBORATION",
          productIdentityConfidence: 95,
          capitalTreatmentState: "AMBIGUOUS", capitalTreatmentConfidence: null,
          natureConfidence: 40, natureIsDefensible: false, allocationCount: 1,
        },
        gl: { winnerConfidence: 65, compatibleCount: 2, strongestAlternateConfidence: 60, abstained: false },
      },
    }));
    expect(v.transaction.level).toBe("MODERATE");
    expect(v.transaction.reason).toMatch(/capital.*requires judgment/i);
  });

  it("strong purpose + committed capital → transaction HIGH", () => {
    const v = deriveFounderConfidenceView(fixture());
    expect(v.transaction.level).toBe("HIGH");
  });

  it("Multiple with 2 clean allocations → transaction HIGH", () => {
    const v = deriveFounderConfidenceView(fixture({
      category: {
        label: "Multiple", source: "NONE", glAccountNumber: "6064", glAccountName: "M&D",
        confidence: 60, alternates: [], capitalState: "OPERATING", purposeLabel: null, purposeReason: null,
      } as any,
      allocations: {
        cardCategory: "Multiple", requiresReview: false,
        totals: { allocationsSubtotal: 0, taxTotal: 0, creditTotal: 0, grossTotal: 0, allocationVariance: 0 },
        entries: [
          { id: "a", descriptions: [], economicPurposeConcept: "PROFESSIONAL_MEMBERSHIP", amount: 495, taxAmount: 0,
            recommendedAccount: { accountId: "1", accountNumber: "6064", accountName: "Membership", confidence: 85, requiresReview: false } },
          { id: "b", descriptions: [], economicPurposeConcept: "INTEREST", amount: 15, taxAmount: 0,
            recommendedAccount: { accountId: "2", accountNumber: "6053", accountName: "Interest", confidence: 80, requiresReview: false } },
        ],
      } as any,
      confidenceInputs: {
        supplier: { matchState: "MATCHED", profileSignalCount: 3 },
        transaction: {
          economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 82,
          purchasedObjectCount: 2, productIdentityStatus: null, productIdentityConfidence: null,
          capitalTreatmentState: "OPERATING", capitalTreatmentConfidence: 80,
          natureConfidence: 80, natureIsDefensible: true, allocationCount: 2,
        },
        gl: { winnerConfidence: 85, compatibleCount: 2, strongestAlternateConfidence: null, abstained: false },
      },
    }));
    expect(v.transaction.level).toBe("HIGH");
    expect(v.transaction.supporting.some((s) => /2 distinct accounting purposes/.test(s))).toBe(true);
  });

  it("Multiple with 1 uncertain allocation → transaction MODERATE", () => {
    const v = deriveFounderConfidenceView(fixture({
      category: {
        label: "Multiple", source: "NONE", glAccountNumber: "6064", glAccountName: "M&D",
        confidence: 60, alternates: [], capitalState: "OPERATING", purposeLabel: null, purposeReason: null,
      } as any,
      allocations: {
        cardCategory: "Multiple", requiresReview: true,
        totals: { allocationsSubtotal: 0, taxTotal: 0, creditTotal: 0, grossTotal: 0, allocationVariance: 0 },
        entries: [
          { id: "a", descriptions: [], economicPurposeConcept: "P", amount: 100, taxAmount: 0,
            recommendedAccount: { accountId: "1", accountNumber: "6064", accountName: "M", confidence: 85, requiresReview: false } },
          { id: "b", descriptions: [], economicPurposeConcept: "I", amount: 20, taxAmount: 0,
            recommendedAccount: { accountId: "2", accountNumber: "6053", accountName: "Int", confidence: 40, requiresReview: true } },
        ],
      } as any,
    }));
    expect(v.transaction.level).toBe("MODERATE");
  });
});

// -----------------------------------------------------------------
// §16 no overclaim + §8 supplier + §9 GL preservation
// -----------------------------------------------------------------

describe("§16 dimensions remain independent", () => {
  it("supplier remains LOW even when transaction + GL are HIGH", () => {
    const v = deriveFounderConfidenceView(fixture({
      vendorMatch: { state: "NOT_FOUND", matchedName: null, matchedVendorId: null } as any,
      confidenceInputs: {
        supplier: { matchState: "NOT_FOUND", profileSignalCount: 0 },
        transaction: {
          economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 82,
          purchasedObjectCount: 1, productIdentityStatus: null, productIdentityConfidence: null,
          capitalTreatmentState: "OPERATING", capitalTreatmentConfidence: 80,
          natureConfidence: 80, natureIsDefensible: true, allocationCount: 1,
        },
        gl: { winnerConfidence: 90, compatibleCount: 1, strongestAlternateConfidence: null, abstained: false },
      },
    }));
    expect(v.supplier.level).toBe("LOW");
    expect(v.transaction.level).toBe("HIGH");
    expect(v.gl.level).toBe("HIGH");
    // Weakest is supplier
    expect(v.summaryLabel).toBe("Low · Supplier");
  });

  it("strong GL does not manufacture supplier confidence", () => {
    // GL confidence has no path that raises supplier level; ensure
    // adapter treats dimensions independently.
    const strongGl = deriveFounderConfidenceView(fixture({
      vendorMatch: { state: "NOT_FOUND", matchedName: null } as any,
      confidenceInputs: {
        supplier: { matchState: "NOT_FOUND", profileSignalCount: 0 },
        transaction: fixture().confidenceInputs!.transaction!,
        gl: { winnerConfidence: 99, compatibleCount: 1, strongestAlternateConfidence: null, abstained: false },
      },
    }));
    expect(strongGl.supplier.level).toBe("LOW");
  });
});
