// Sprint 3 · Phase 5 · Slice 3 (2026-08-09) — modal-context
// confidence adapter tests. Prove that:
//
//   1. Vendor step focuses on SUPPLIER IDENTITY and reports vendor
//      MATCH state separately (§6). A strong document identity is
//      not downgraded to LOW merely because there is no on-file
//      vendor row.
//   2. Coding step exposes transaction + gl confidence AS
//      DISTINCT DIMENSIONS. The recommended account stays visible
//      even when GL confidence is Moderate (§10). NEEDS_REVIEW is
//      set only when the frozen analyser abstains.
//   3. Multiple-allocation invoices carry per-allocation confidence
//      that is INDEPENDENT of the overall category (§16-§17).
//   4. GL alternatives ship with a humanised rejection reason
//      (never a score / weight), and are capped at 3 (§13).

import { describe, it, expect } from "vitest";
import type { ApInvoiceCardIntelligence } from "@/lib/mission-control/intelligence-review-intakes";
import {
  deriveVendorStepConfidence,
  deriveCodingStepConfidence,
} from "@/lib/mission-control/modal-confidence";

// -----------------------------------------------------------------------------
// Fixture builder — matches ApInvoiceCardIntelligence field shape
// -----------------------------------------------------------------------------

function makeAp(over: Partial<ApInvoiceCardIntelligence> = {}): ApInvoiceCardIntelligence {
  const base = {
    sender: { name: "AR@vendor.com", email: "ar@vendor.com", relationship: "VENDOR" as const },
    extractedVendor: { name: "Fixture Vendor Ltd." },
    vendorMatch: { state: "MATCHED" as const, matchedName: "Fixture Vendor Ltd.", matchedVendorId: "v_1" },
    invoiceNumber: "INV-001",
    gross: { amount: "500.00", currency: "CAD" },
    paymentTerms: "Net 30",
    paymentTermsSource: "VENDOR_PROFILE" as const,
    purchaseOrder: { poNumber: null, matchedPoDocumentId: null, variance: null },
    category: {
      label: "Fuel",
      glAccountNumber: "6025",
      glAccountName: "Fuel",
      capitalState: "OPERATING" as const,
      source: "NAME_KEYWORD" as const,
      alternates: [] as Array<{ accountNumber: string; accountName: string; confidence: number }>,
    },
    gstVerification: "VERIFIED" as const,
    gstRatePercent: 5,
    extractedVendorProfile: null,
    invoiceCadenceThisQuarter: 1,
    confidence: 82,
    confidenceInputs: {
      supplier: { matchState: "MATCHED" as const, profileSignalCount: 3 },
      transaction: {
        economicPurposeSource: "CANONICAL_COMMITTED",
        economicPurposeConfidence: 82,
        purchasedObjectCount: 1,
        productIdentityStatus: "RESOLVED_INTERNAL",
        productIdentityConfidence: 88,
        capitalTreatmentState: "OPERATING" as const,
        capitalTreatmentConfidence: 70,
        natureConfidence: 78,
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
    workflowState: "READY_FOR_APPROVAL" as const,
    workflowReason: "",
    unresolvedFindingCount: 0,
    primaryAttachment: null,
    allocations: null,
  } as unknown as ApInvoiceCardIntelligence;
  return { ...base, ...over } as ApInvoiceCardIntelligence;
}

// -----------------------------------------------------------------------------
// §5-§8 Vendor step
// -----------------------------------------------------------------------------

describe("deriveVendorStepConfidence — §5-§8", () => {
  it("reports HIGH supplier identity when matched vendor + strong evidence (DMM-shape)", () => {
    const v = deriveVendorStepConfidence(makeAp());
    expect(v.supplier.level).toBe("HIGH");
    expect(v.vendorMatch.state).toBe("MATCHED");
    expect(v.vendorMatch.label).toContain("Matched to existing vendor");
    expect(v.proposedName).toBe("Fixture Vendor Ltd.");
  });

  it("§6 — no-vendor-match does NOT collapse into LOW when identity evidence is strong (unmatched with 3 signals)", () => {
    const v = deriveVendorStepConfidence(makeAp({
      vendorMatch: { state: "NOT_FOUND", matchedName: null, matchedVendorId: null },
      confidenceInputs: {
        supplier: { matchState: "NOT_FOUND", profileSignalCount: 3 },
        transaction: undefined as never,
        gl: undefined as never,
      } as any,
    }));
    expect(v.supplier.level).toBe("HIGH");
    expect(v.vendorMatch.state).toBe("NOT_FOUND");
    expect(v.vendorMatch.label).toBe("No existing vendor found");
  });

  it("§7 — OXIO-shape: LOW supplier identity + NOT_FOUND vendor match with named reason", () => {
    const v = deriveVendorStepConfidence(makeAp({
      vendorMatch: { state: "NOT_FOUND", matchedName: null, matchedVendorId: null },
      confidenceInputs: {
        supplier: { matchState: "NOT_FOUND", profileSignalCount: 1 },
        transaction: undefined as never,
        gl: undefined as never,
      } as any,
    }));
    expect(v.supplier.level).toBe("LOW");
    expect(v.supplier.reason).toContain("limited invoice evidence");
    expect(v.vendorMatch.state).toBe("NOT_FOUND");
  });
});

// -----------------------------------------------------------------------------
// §9-§15 AP Coding step
// -----------------------------------------------------------------------------

describe("deriveCodingStepConfidence — §9-§15", () => {
  it("DMM-shape (all HIGH): keeps recommended 6025 · Fuel visible with HIGH gl confidence", () => {
    const c = deriveCodingStepConfidence(makeAp());
    expect(c.transaction.level).toBe("HIGH");
    expect(c.gl.level).toBe("HIGH");
    expect(c.recommendedAccount).toEqual({ number: "6025", name: "Fuel" });
    expect(c.recommendedAccountAbstained).toBe(false);
  });

  it("§10 — 1091559-shape: capital AMBIGUOUS keeps 1506 recommendation visible with MODERATE confidence", () => {
    const c = deriveCodingStepConfidence(makeAp({
      category: {
        label: "Equipment",
        glAccountNumber: "1506",
        glAccountName: "Equipment & Fixtures - Grounds",
        capitalState: "AMBIGUOUS",
        source: "CAPITAL_CLASS_MAP",
        alternates: [
          { accountNumber: "1502", accountName: "Construction in Progress", confidence: 55 },
        ],
      } as ApInvoiceCardIntelligence["category"],
      confidenceInputs: {
        supplier: { matchState: "MATCHED", profileSignalCount: 3 },
        transaction: {
          economicPurposeSource: "CANONICAL_COMMITTED",
          economicPurposeConfidence: 78,
          purchasedObjectCount: 3,
          productIdentityStatus: "RESOLVED_INTERNAL",
          productIdentityConfidence: 82,
          capitalTreatmentState: "AMBIGUOUS",
          capitalTreatmentConfidence: 55,
          natureConfidence: 74,
          natureIsDefensible: true,
          allocationCount: 1,
        },
        gl: { winnerConfidence: 72, compatibleCount: 2, strongestAlternateConfidence: 55, abstained: false },
      },
    }));
    expect(c.transaction.level).toBe("MODERATE");
    expect(c.transaction.reason).toContain("capital-vs-operating");
    expect(c.gl.level).toBe("MODERATE");
    expect(c.recommendedAccount).toEqual({ number: "1506", name: "Equipment & Fixtures - Grounds" });
    expect(c.recommendedAccountAbstained).toBe(false);
  });

  it("§14 — abstention: recommendedAccount is null and abstain flag set with NEEDS_REVIEW gl", () => {
    const c = deriveCodingStepConfidence(makeAp({
      category: {
        label: null,
        glAccountNumber: null,
        glAccountName: null,
        capitalState: null,
        source: null,
        alternates: [],
      } as ApInvoiceCardIntelligence["category"],
      confidenceInputs: {
        supplier: { matchState: "MATCHED", profileSignalCount: 3 },
        transaction: {
          economicPurposeSource: "ABSTAIN",
          economicPurposeConfidence: 0,
          purchasedObjectCount: 0,
          productIdentityStatus: null,
          productIdentityConfidence: null,
          capitalTreatmentState: null,
          capitalTreatmentConfidence: null,
          natureConfidence: null,
          natureIsDefensible: false,
          allocationCount: 0,
        },
        gl: { winnerConfidence: null, compatibleCount: 0, strongestAlternateConfidence: null, abstained: true },
      },
    }));
    expect(c.gl.level).toBe("NEEDS_REVIEW");
    expect(c.recommendedAccount).toBeNull();
    expect(c.recommendedAccountAbstained).toBe(true);
  });

  it("§13 — GL alternatives ship humanised rejection reason (never a score) and cap at 3", () => {
    const c = deriveCodingStepConfidence(makeAp({
      category: {
        label: "Equipment",
        glAccountNumber: "1506",
        glAccountName: "Equipment & Fixtures - Grounds",
        capitalState: "CAPITAL",
        source: "CAPITAL_CLASS_MAP",
        alternates: [
          { accountNumber: "1502", accountName: "Construction in Progress", confidence: 55 },
          { accountNumber: "6180", accountName: "Repairs and Maintenance", confidence: 30 },
          { accountNumber: "1408", accountName: "Prepaid Expenses", confidence: 12 },
          { accountNumber: "6301", accountName: "Consumable Supplies", confidence: 10 },
        ],
      } as ApInvoiceCardIntelligence["category"],
    }));
    expect(c.glAlternatives).toHaveLength(3);
    for (const a of c.glAlternatives) {
      expect(a.rejectionReason).not.toMatch(/\d{1,3}\s*%|score|weight|penalty|gate/i);
      expect(a.rejectionReason.length).toBeGreaterThan(20);
    }
    expect(c.glAlternatives[0].rejectionReason).toContain("complete");
  });
});

// -----------------------------------------------------------------------------
// §16-§17 CPA per-allocation confidence
// -----------------------------------------------------------------------------

describe("deriveCodingStepConfidence — CPA §16-§17 per-allocation", () => {
  const cpa = makeAp({
    category: {
      label: "Multiple",
      glAccountNumber: null,
      glAccountName: null,
      capitalState: null,
      source: "NAME_KEYWORD",
      alternates: [],
    } as ApInvoiceCardIntelligence["category"],
    allocations: {
      cardCategory: "Multiple",
      requiresReview: false,
      totals: { allocationsSubtotal: 500, taxTotal: 0, creditTotal: 0, grossTotal: 500, allocationVariance: 0 },
      entries: [
        {
          id: "alloc-membership",
          sourceLineItemIds: ["l1"],
          descriptions: ["CPA Alberta Membership Dues"],
          economicPurposeConcept: "MEMBERSHIP_DUES",
          economicPurposeConfidence: 90,
          supportingEvidence: [],
          amount: 495,
          taxTreatment: "NON_RECOVERABLE",
          taxRate: null,
          taxAmount: null,
          recommendedAccount: {
            accountId: "a1", accountNumber: "6064", accountName: "Membership & Dues",
            confidence: 92, requiresReview: false, postingBlockers: [],
          },
          alternatives: [],
        },
        {
          id: "alloc-interest",
          sourceLineItemIds: ["l2"],
          descriptions: ["Late payment interest"],
          economicPurposeConcept: "INTEREST",
          economicPurposeConfidence: 75,
          supportingEvidence: [],
          amount: 5,
          taxTreatment: "NON_RECOVERABLE",
          taxRate: null,
          taxAmount: null,
          recommendedAccount: {
            accountId: "a2", accountNumber: "6053", accountName: "Interest Expense",
            confidence: 62, requiresReview: true, postingBlockers: [],
          },
          alternatives: [],
        },
      ],
    } as ApInvoiceCardIntelligence["allocations"],
  });

  it("each allocation row carries its own confidence level with distinct GL account", () => {
    const c = deriveCodingStepConfidence(cpa);
    expect(c.allocations).toHaveLength(2);
    const [a1, a2] = c.allocations;
    expect(a1.recommendedAccountNumber).toBe("6064");
    expect(a1.level).toBe("HIGH");
    expect(a2.recommendedAccountNumber).toBe("6053");
    expect(a2.level).toBe("MODERATE");
    expect(a2.reason).toContain("flagged for review");
  });

  it("§16 — Multiple does not collapse into a single GL recommendation on the coding step", () => {
    const c = deriveCodingStepConfidence(cpa);
    expect(c.recommendedAccount).toBeNull();
    expect(c.recommendedAccountAbstained).toBe(false);
  });

  it("unresolved allocation → NEEDS_REVIEW at the allocation row (independent of overall transaction)", () => {
    const modified = { ...cpa, allocations: {
      ...cpa.allocations!,
      entries: [
        cpa.allocations!.entries[0],
        { ...cpa.allocations!.entries[1], recommendedAccount: null },
      ],
    } };
    const c = deriveCodingStepConfidence(modified as ApInvoiceCardIntelligence);
    expect(c.allocations[1].level).toBe("NEEDS_REVIEW");
    expect(c.allocations[1].recommendedAccountNumber).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// §37 Generic-% audit — the adapters must never emit a raw percentage
// in any user-facing string.
// -----------------------------------------------------------------------------

describe("§37 no-percentage guarantee", () => {
  it("vendor step user-facing strings never contain NN%", () => {
    for (const shape of [
      makeAp(),
      makeAp({ vendorMatch: { state: "NOT_FOUND", matchedName: null, matchedVendorId: null } }),
    ]) {
      const v = deriveVendorStepConfidence(shape);
      const s = [v.supplier.label, v.supplier.reason ?? "", ...v.supplier.supporting, v.vendorMatch.label].join(" | ");
      expect(s).not.toMatch(/\d{1,3}\s*%/);
    }
  });

  it("coding step user-facing strings never contain NN%", () => {
    const c = deriveCodingStepConfidence(makeAp({
      category: {
        label: "Equipment",
        glAccountNumber: "1506",
        glAccountName: "Equipment & Fixtures - Grounds",
        capitalState: "AMBIGUOUS",
        source: "CAPITAL_CLASS_MAP",
        alternates: [{ accountNumber: "1502", accountName: "Construction in Progress", confidence: 55 }],
      } as ApInvoiceCardIntelligence["category"],
    }));
    const s = [
      c.transaction.label, c.transaction.reason ?? "", ...c.transaction.supporting,
      c.gl.label, c.gl.reason ?? "", ...c.gl.supporting,
      ...c.glAlternatives.map((a) => a.rejectionReason),
      ...c.allocations.map((a) => `${a.label} ${a.reason ?? ""}`),
    ].join(" | ");
    expect(s).not.toMatch(/\d{1,3}\s*%/);
  });
});
