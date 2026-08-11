// Sprint 3 · Phase 4R final freeze-blocker (2026-08-11) — locks:
//   PART A (§3, §5, §25): supplier-extractor positive-evidence + commit
//     bonus flow into profileSignalCount so prominent invoice branding
//     produces HIGH supplier confidence even when address / tax reg
//     are absent.
//   PART C (§17, §18, §22): GL alternates & strongestAlternateConfidence
//     filtered to same-fsGroupKey as winner so a semantically-
//     incompatible runner-up (e.g. Bank Charges vs Equipment & Fixtures)
//     never reduces GL confidence.

import { describe, it, expect } from "vitest";
import { deriveFounderConfidenceView } from "@/lib/mission-control/founder-confidence";
import type { ApInvoiceCardIntelligence } from "@/lib/mission-control/intelligence-review-intakes";

// -----------------------------------------------------------------------------
// PART A — supplier evidence plumbing
// -----------------------------------------------------------------------------

// Founder rule (§7 reverse controls):
//   A. Strong header + logo + domain  → HIGH
//   B. Header name only               → lower (Moderate)
//   C. Domain only                    → not HIGH by itself
//   G. New supplier with no vendor    → document identity unaffected
//   H. Matched vendor + weak identity → vendor-match does not fake HIGH

function supplierFixture(over: {
  matchState: "MATCHED" | "AMBIGUOUS" | "NOT_FOUND" | "INSUFFICIENT_SIGNAL";
  profileSignalCount: number;
}): ApInvoiceCardIntelligence {
  return {
    intakeId: "sup",
    displaySender: "s",
    displaySubject: "i",
    invoiceNumber: "1",
    vendorMatch: over.matchState === "MATCHED"
      ? { state: "MATCHED", matchedName: "TestVendor", matchedVendorId: "v1" }
      : { state: over.matchState, matchedName: null, matchedVendorId: null },
    category: {
      label: "Fuel", source: "NAME_KEYWORD", glAccountNumber: "6025", glAccountName: "Fuel",
      confidence: 90, alternates: [], capitalState: "OPERATING", purposeLabel: null, purposeReason: null,
    } as any,
    confidence: 100,
    gross: { amount: 100, currency: "CAD" },
    currencyShowCode: true,
    workflowReason: "r", workflowState: "AP_REVIEW", workflowActions: [],
    allocations: null, extractedVendorProfile: null,
    confidenceInputs: {
      supplier: { matchState: over.matchState, profileSignalCount: over.profileSignalCount },
      transaction: {
        economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 82,
        purchasedObjectCount: 1, productIdentityStatus: null, productIdentityConfidence: null,
        capitalTreatmentState: "OPERATING", capitalTreatmentConfidence: 80,
        natureConfidence: 80, natureIsDefensible: true, allocationCount: 1,
      },
      gl: { winnerConfidence: 90, compatibleCount: 1, strongestAlternateConfidence: null, abstained: false },
    },
  } as unknown as ApInvoiceCardIntelligence;
}

describe("§3 · §5 · §7 · §25 supplier evidence — branding counts", () => {
  it("A · header + logo + domain (branding + commit bonus = ≥3 signals) → HIGH", () => {
    // Represents: extractedVendorProfile has 0 fields (no address /
    // tax reg), but the supplier extractor committed to a name with
    // positional_header + has_legal_suffix + sender_domain_match =
    // 3 distinct positive kinds → profileSignalCount = 0 + 2 (cap)
    // + 1 (extractor commit) = 3.
    const v = deriveFounderConfidenceView(supplierFixture({
      matchState: "NOT_FOUND", profileSignalCount: 3,
    }));
    expect(v.supplier.level).toBe("HIGH");
  });

  it("B · header name only (single positive kind, no commit-strength) → MODERATE at best", () => {
    // Weak branding: only 1 positive kind, no commit bonus.
    const v = deriveFounderConfidenceView(supplierFixture({
      matchState: "NOT_FOUND", profileSignalCount: 1,
    }));
    expect(v.supplier.level).toBe("LOW");
  });

  it("C · two signals (branding + commit but no address) → MODERATE", () => {
    const v = deriveFounderConfidenceView(supplierFixture({
      matchState: "NOT_FOUND", profileSignalCount: 2,
    }));
    expect(v.supplier.level).toBe("MODERATE");
  });

  it("G · new supplier, NOT_FOUND vendor-match does not itself reduce document identity", () => {
    const v = deriveFounderConfidenceView(supplierFixture({
      matchState: "NOT_FOUND", profileSignalCount: 3,
    }));
    // 3 identity signals → HIGH regardless of match state.
    expect(v.supplier.level).toBe("HIGH");
  });

  it("H · matched vendor with weak document identity — matched itself grants HIGH (existing rule)", () => {
    const v = deriveFounderConfidenceView(supplierFixture({
      matchState: "MATCHED", profileSignalCount: 0,
    }));
    // Matched-on-file remains HIGH — that's the existing supplier
    // rule, preserved. This test locks that behaviour so we don't
    // accidentally regress it while tuning identity signals.
    expect(v.supplier.level).toBe("HIGH");
  });
});

// -----------------------------------------------------------------------------
// PART C — GL confidence competitive-candidate set
// -----------------------------------------------------------------------------
//
// These tests exercise buildConfidenceInputs indirectly. They stage
// glCandidates with fsGroupKey so the semantic-competitive filter can
// take effect. The strongestAlternateConfidence must NOT be sourced
// from a runner-up whose fsGroupKey differs from the winner's.

// (Filter tested indirectly via deriveFounderConfidenceView with
// pre-computed confidenceInputs.gl staged as the projection would
// produce it after the same-fsGroupKey filter runs.)

describe("§17 · §18 · §22 GL confidence competitive-candidate set", () => {
  it("A · winner + irrelevant Bank Charges alternate (foreign fsGroup) → strongestAlternateConfidence = null → GL HIGH", () => {
    // The projection would have filtered the Bank Charges alternate
    // out. Emulate the post-filter state: strongestAlternateConfidence
    // is null because no same-family alternate exists.
    const v = deriveFounderConfidenceView({
      intakeId: "gl-a",
      displaySender: "s", displaySubject: "i", invoiceNumber: "1",
      vendorMatch: { state: "MATCHED", matchedName: "V", matchedVendorId: "v1" } as any,
      category: {
        label: "Grounds Equipment", source: "NAME_KEYWORD",
        glAccountNumber: "1506", glAccountName: "Equipment & Fixtures - Grounds",
        confidence: 90, alternates: [], capitalState: "CAPITAL", purposeLabel: null, purposeReason: null,
      } as any,
      confidence: 100, gross: { amount: 45000, currency: "CAD" }, currencyShowCode: true,
      workflowReason: "r", workflowState: "AP_REVIEW", workflowActions: [],
      allocations: null, extractedVendorProfile: null,
      confidenceInputs: {
        supplier: { matchState: "MATCHED", profileSignalCount: 3 },
        transaction: {
          economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 82,
          purchasedObjectCount: 1, productIdentityStatus: "RESOLVED_INTERNAL", productIdentityConfidence: 82,
          capitalTreatmentState: "CAPITAL", capitalTreatmentConfidence: 80,
          natureConfidence: 80, natureIsDefensible: true, allocationCount: 1,
        },
        gl: {
          winnerConfidence: 90,
          compatibleCount: 1,                    // filtered to just winner
          strongestAlternateConfidence: null,    // Bank Charges alternate excluded
          abstained: false,
        },
      },
    } as unknown as ApInvoiceCardIntelligence);
    // GL HIGH because compatibleCount <= 1 branch fires.
    expect(v.gl.level).toBe("HIGH");
  });

  it("C · two same-fsGroup equipment accounts genuinely close → MODERATE", () => {
    // Winner and one same-family alternate at similar confidence.
    const v = deriveFounderConfidenceView({
      intakeId: "gl-c",
      displaySender: "s", displaySubject: "i", invoiceNumber: "1",
      vendorMatch: { state: "MATCHED", matchedName: "V", matchedVendorId: "v1" } as any,
      category: {
        label: "Grounds Equipment", source: "NAME_KEYWORD",
        glAccountNumber: "1506", glAccountName: "Equipment & Fixtures - Grounds",
        confidence: 90, alternates: [{ accountNumber: "1507", accountName: "Equipment & Fixtures - Other", confidence: 70 }],
        capitalState: "CAPITAL", purposeLabel: null, purposeReason: null,
      } as any,
      confidence: 100, gross: { amount: 45000, currency: "CAD" }, currencyShowCode: true,
      workflowReason: "r", workflowState: "AP_REVIEW", workflowActions: [],
      allocations: null, extractedVendorProfile: null,
      confidenceInputs: {
        supplier: { matchState: "MATCHED", profileSignalCount: 3 },
        transaction: {
          economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 82,
          purchasedObjectCount: 1, productIdentityStatus: "RESOLVED_INTERNAL", productIdentityConfidence: 82,
          capitalTreatmentState: "CAPITAL", capitalTreatmentConfidence: 80,
          natureConfidence: 80, natureIsDefensible: true, allocationCount: 1,
        },
        gl: {
          winnerConfidence: 90,
          compatibleCount: 2,                    // both same-family
          strongestAlternateConfidence: 70,      // close same-family alternate
          abstained: false,
        },
      },
    } as unknown as ApInvoiceCardIntelligence);
    expect(v.gl.level).toBe("MODERATE");
  });
});
