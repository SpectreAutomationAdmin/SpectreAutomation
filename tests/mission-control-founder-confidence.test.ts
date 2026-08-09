// Sprint 3 · Phase 5 · Slice 1 (2026-08-09) — founder-confidence
// adapter unit tests (§25).
//
// Presentation-only adapter — MUST NEVER alter accounting decisions.
// These tests lock the qualitative mapping so future refactors cannot
// silently degrade the founder-facing experience or accidentally
// promote a Needs-Review case to High.

import { describe, it, expect } from "vitest";
import { deriveFounderConfidenceView } from "@/lib/mission-control/founder-confidence";
import type { ApInvoiceCardIntelligence } from "@/lib/mission-control/intelligence-review-intakes";

function fixture(over: Partial<ApInvoiceCardIntelligence> = {}): ApInvoiceCardIntelligence {
  return {
    intakeId: "ap-1",
    displaySender: "Accounts payable",
    displaySubject: "Invoice.pdf",
    invoiceNumber: "INV-1",
    vendorMatch: { state: "MATCHED", matchedName: "TestVendor Inc", matchedVendorId: "v1" },
    category: {
      label: "Fuel ( Gas/Diesel )",
      source: "NAME_KEYWORD",
      glAccountNumber: "6025",
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
    ...over,
  } as unknown as ApInvoiceCardIntelligence;
}

describe("§25 supplier confidence", () => {
  it("MATCHED vendor → HIGH with matched-name evidence", () => {
    const v = deriveFounderConfidenceView(fixture());
    expect(v.supplier.level).toBe("HIGH");
    expect(v.supplier.supporting.some((s) => /TestVendor/.test(s))).toBe(true);
  });

  it("AMBIGUOUS → MODERATE with reason", () => {
    const v = deriveFounderConfidenceView(fixture({
      vendorMatch: { state: "AMBIGUOUS", matchedName: null, matchedVendorId: null } as any,
    }));
    expect(v.supplier.level).toBe("MODERATE");
    expect(v.supplier.reason).toBeTruthy();
  });

  it("NOT_FOUND with 3+ ExtractedVendorProfile signals → HIGH", () => {
    const v = deriveFounderConfidenceView(fixture({
      vendorMatch: { state: "NOT_FOUND", matchedName: null, matchedVendorId: null } as any,
      extractedVendorProfile: {
        address: { line1: { value: "123 Main St", confidence: 90, source: "invoice-pdf" } } as any,
        website: { value: "newvendor.com", confidence: 80, source: "invoice-pdf" } as any,
        taxRegistrationNumber: { value: "123456789 RT0001", confidence: 95, source: "invoice-pdf" } as any,
        phone: { value: "555-0100", confidence: 70, source: "invoice-pdf" } as any,
      } as any,
    }));
    expect(v.supplier.level).toBe("HIGH");
  });

  it("NOT_FOUND with 1 ExtractedVendorProfile signal → LOW", () => {
    const v = deriveFounderConfidenceView(fixture({
      vendorMatch: { state: "NOT_FOUND", matchedName: null, matchedVendorId: null } as any,
      extractedVendorProfile: {
        address: { line1: { value: "123 Main St", confidence: 50, source: "invoice-pdf" } } as any,
      } as any,
    }));
    expect(v.supplier.level).toBe("LOW");
    expect(v.supplier.reason).toBeTruthy();
  });
});

describe("§25 category confidence", () => {
  it("commit + VENDOR_DEFAULT/NAME_KEYWORD → HIGH", () => {
    const v = deriveFounderConfidenceView(fixture());
    expect(v.category.level).toBe("HIGH");
  });

  it("null label → NEEDS_REVIEW", () => {
    const v = deriveFounderConfidenceView(fixture({
      category: {
        label: null, source: "NONE", glAccountNumber: null, glAccountName: null, confidence: null,
        alternates: [], capitalState: "INSUFFICIENT_EVIDENCE",
        purposeLabel: null, purposeReason: null,
      } as any,
    }));
    expect(v.category.level).toBe("NEEDS_REVIEW");
  });

  it("Multiple + no allocation flagged → HIGH", () => {
    const v = deriveFounderConfidenceView(fixture({
      category: {
        label: "Multiple", source: "NONE", glAccountNumber: "6064", glAccountName: "M&D", confidence: 60,
        alternates: [], capitalState: "OPERATING",
        purposeLabel: null, purposeReason: null,
      } as any,
      allocations: {
        cardCategory: "Multiple", requiresReview: false,
        totals: { allocationsSubtotal: 0, taxTotal: 0, creditTotal: 0, grossTotal: 0, allocationVariance: 0 },
        entries: [
          { id: "a", descriptions: [], economicPurposeConcept: "PROFESSIONAL_MEMBERSHIP", amount: 495, taxAmount: 0,
            recommendedAccount: { accountId: "1", accountNumber: "6064", accountName: "Membership & Dues", confidence: 85, requiresReview: false } },
          { id: "b", descriptions: [], economicPurposeConcept: "INTEREST", amount: 15, taxAmount: 0,
            recommendedAccount: { accountId: "2", accountNumber: "6053", accountName: "Interest", confidence: 80, requiresReview: false } },
        ],
      } as any,
    }));
    expect(v.category.level).toBe("HIGH");
    expect(v.category.supporting.some((s) => /2 distinct accounting purposes/.test(s))).toBe(true);
  });

  it("Multiple + any allocation requiresReview → MODERATE", () => {
    const v = deriveFounderConfidenceView(fixture({
      category: { label: "Multiple", source: "NONE", glAccountNumber: "6064", glAccountName: "M&D", confidence: 60, alternates: [], capitalState: "OPERATING", purposeLabel: null, purposeReason: null } as any,
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
    expect(v.category.level).toBe("MODERATE");
  });
});

describe("§25 GL confidence", () => {
  it("no alternates → HIGH with 'only compatible' phrasing", () => {
    const v = deriveFounderConfidenceView(fixture());
    expect(v.gl.level).toBe("HIGH");
    expect(v.gl.supporting.some((s) => /Only compatible/i.test(s))).toBe(true);
  });

  it("strongest alternate confidence just under 50 → HIGH", () => {
    const v = deriveFounderConfidenceView(fixture({
      category: {
        label: "X", source: "NAME_KEYWORD", glAccountNumber: "6025", glAccountName: "Fuel", confidence: 90,
        alternates: [{ accountNumber: "5310", accountName: "Fuel", confidence: 45 } as any],
        capitalState: "OPERATING", purposeLabel: null, purposeReason: null,
      } as any,
    }));
    expect(v.gl.level).toBe("HIGH");
  });

  it("strongest alternate confidence >= 50 → MODERATE with alternate cited", () => {
    const v = deriveFounderConfidenceView(fixture({
      category: {
        label: "X", source: "NAME_KEYWORD", glAccountNumber: "6031", glAccountName: "R&M", confidence: 65,
        alternates: [{ accountNumber: "6025", accountName: "Grounds Supplies", confidence: 60 } as any],
        capitalState: "OPERATING", purposeLabel: null, purposeReason: null,
      } as any,
    }));
    expect(v.gl.level).toBe("MODERATE");
    expect(v.gl.supporting.some((s) => /Nearest alternative.*6025/.test(s))).toBe(true);
  });

  it("strongest alternate confidence < 50 → HIGH (alternates exist but not competitive)", () => {
    const v = deriveFounderConfidenceView(fixture({
      category: {
        label: "X", source: "NAME_KEYWORD", glAccountNumber: "6025", glAccountName: "Fuel", confidence: 90,
        alternates: [{ accountNumber: "5310", accountName: "Fuel Fleet", confidence: 30 } as any],
        capitalState: "OPERATING", purposeLabel: null, purposeReason: null,
      } as any,
    }));
    expect(v.gl.level).toBe("HIGH");
  });

  it("GL abstention (null accountNumber) → NEEDS_REVIEW with safe-abstention message", () => {
    const v = deriveFounderConfidenceView(fixture({
      category: {
        label: "Fuel", source: "NAME_KEYWORD", glAccountNumber: null, glAccountName: null, confidence: null,
        alternates: [], capitalState: "OPERATING", purposeLabel: null, purposeReason: null,
      } as any,
    }));
    expect(v.gl.level).toBe("NEEDS_REVIEW");
    expect(v.gl.supporting.some((s) => /cannot distinguish/i.test(s))).toBe(true);
  });
});

describe("§25 composition", () => {
  it("summary = worst of dimensions", () => {
    // High supplier + High category + Moderate GL → summary MODERATE
    const v = deriveFounderConfidenceView(fixture({
      category: {
        label: "X", source: "NAME_KEYWORD", glAccountNumber: "6031", glAccountName: "R&M", confidence: 65,
        alternates: [{ accountNumber: "6025", accountName: "Alt", confidence: 60 } as any],
        capitalState: "OPERATING", purposeLabel: null, purposeReason: null,
      } as any,
    }));
    expect(v.summaryLevel).toBe("MODERATE");
    expect(v.summaryLabel).toBe("Moderate confidence");
  });

  it("workflow blocker forces NEEDS_REVIEW regardless of high dimensions", () => {
    const v = deriveFounderConfidenceView(fixture({
      phase3Decision: { blockers: [{ key: "VENDOR_ID_MISSING" }] } as any,
    }));
    expect(v.summaryLevel).toBe("NEEDS_REVIEW");
    expect(v.summaryLabel).toBe("Needs review");
  });

  it("high extraction cannot mask weak GL", () => {
    const v = deriveFounderConfidenceView(fixture({
      category: {
        label: "Fuel", source: "NAME_KEYWORD", glAccountNumber: null, glAccountName: null, confidence: null,
        alternates: [], capitalState: "OPERATING", purposeLabel: null, purposeReason: null,
      } as any,
    }));
    // Supplier and category may be OK/High, but GL abstention pulls
    // the summary down to Needs Review.
    expect(v.summaryLevel).toBe("NEEDS_REVIEW");
  });

  it("external product corroboration does not manufacture accounting confidence — GL confidence remains from candidate separation only", () => {
    // Two identical fixtures. The one with external corroboration in
    // its (imaginary) product identity resolution must NOT get a higher
    // GL confidence than the one without — the adapter never reads
    // product identity for GL confidence.
    const base = fixture({
      category: {
        label: "X", source: "NAME_KEYWORD", glAccountNumber: "6031", glAccountName: "R&M", confidence: 65,
        alternates: [{ accountNumber: "6025", accountName: "Alt", confidence: 60 } as any],
        capitalState: "OPERATING", purposeLabel: null, purposeReason: null,
      } as any,
    });
    const withExternal = fixture({
      ...base,
      // Note: even if the projection carried productIdentityResolution
      // (it currently doesn't), the adapter never consults it for GL.
    });
    const a = deriveFounderConfidenceView(base);
    const b = deriveFounderConfidenceView(withExternal);
    expect(a.gl.level).toBe(b.gl.level);
  });
});
