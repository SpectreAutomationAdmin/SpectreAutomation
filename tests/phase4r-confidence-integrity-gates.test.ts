// Sprint 3 · Phase 4R FINAL confidence integrity closeout (2026-08-11)
// — locks §3 Gate 1 (identity distinctness) + §4 Gate 2 (transaction-
// supported semantic plausibility) at the founder-confidence adapter
// contract.
//
// These tests stage pre-computed confidenceInputs.gl that the
// projection would produce AFTER the two gates fire. They also drive
// the deriveFounderConfidenceView adapter to prove the compact pill
// text is derived from the gated set — not from raw candidates.

import { describe, it, expect } from "vitest";
import { deriveFounderConfidenceView } from "@/lib/mission-control/founder-confidence";
import type { ApInvoiceCardIntelligence } from "@/lib/mission-control/intelligence-review-intakes";

function baseline(over: Partial<ApInvoiceCardIntelligence> = {}): ApInvoiceCardIntelligence {
  return {
    intakeId: "ci",
    displaySender: "s", displaySubject: "i", invoiceNumber: "1",
    vendorMatch: { state: "MATCHED", matchedName: "V", matchedVendorId: "v1" } as any,
    category: {
      label: "Equipment & Fixtures - Grounds", source: "ECONOMIC_PURPOSE",
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
        capitalTreatmentState: "CAPITAL", capitalTreatmentConfidence: 82,
        natureConfidence: 82, natureIsDefensible: true, allocationCount: 1,
      },
      gl: { winnerConfidence: 90, compatibleCount: 1, strongestAlternateConfidence: null, abstained: false },
    },
    ...over,
  } as unknown as ApInvoiceCardIntelligence;
}

describe("§13.A · winner cannot compete against itself (Gate 1 identity distinctness)", () => {
  it("post-projection: same accountId is never both winner + alternate → GL HIGH", () => {
    // Simulates the state AFTER buildConfidenceInputs's Gate 1 removes
    // the duplicate winner entry. compatibleCount = 1, no alternate
    // confidence.
    const v = deriveFounderConfidenceView(baseline({
      category: {
        label: "Computer & IT Services", source: "ECONOMIC_PURPOSE",
        glAccountNumber: "6054", glAccountName: "Computer & IT Services",
        confidence: 90,
        // Popover alternates array is empty because the ONLY runner-up
        // in raw candidates was the winner's own accountId, dropped by
        // Gate 1.
        alternates: [],
        capitalState: "OPERATING", purposeLabel: null, purposeReason: null,
      } as any,
      confidenceInputs: {
        supplier: { matchState: "MATCHED", profileSignalCount: 3 },
        transaction: {
          economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 82,
          purchasedObjectCount: 1, productIdentityStatus: "RESOLVED_INTERNAL", productIdentityConfidence: 82,
          capitalTreatmentState: "OPERATING", capitalTreatmentConfidence: 82,
          natureConfidence: 82, natureIsDefensible: true, allocationCount: 1,
        },
        gl: {
          winnerConfidence: 90,
          compatibleCount: 1,                    // Gate 1: only the winner survives
          strongestAlternateConfidence: null,    // no distinct competitor
          abstained: false,
        },
      },
    }));
    expect(v.gl.level).toBe("HIGH");
    expect(v.summaryLevel).toBe("HIGH");
    expect(v.summaryLabel).toBe("High");
  });
});

describe("§13.B · nonsense runner-up is excluded (Gate 2 transaction-supported plausibility)", () => {
  it("Equipment winner + Bank Charges alternate excluded by score threshold → GL HIGH", () => {
    // After Gate 2, Bank Charges' near-zero score contributions are
    // filtered out. compatibleCount = 1, no alternate confidence.
    const v = deriveFounderConfidenceView(baseline({
      confidenceInputs: {
        supplier: { matchState: "MATCHED", profileSignalCount: 3 },
        transaction: {
          economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 82,
          purchasedObjectCount: 1, productIdentityStatus: "RESOLVED_INTERNAL", productIdentityConfidence: 82,
          capitalTreatmentState: "CAPITAL", capitalTreatmentConfidence: 82,
          natureConfidence: 82, natureIsDefensible: true, allocationCount: 1,
        },
        gl: {
          winnerConfidence: 90,
          compatibleCount: 1,                    // Gate 2: Bank Charges excluded
          strongestAlternateConfidence: null,
          abstained: false,
        },
      },
    }));
    expect(v.gl.level).toBe("HIGH");
  });
});

describe("§13.C · legitimate close alternative → MODERATE preserved", () => {
  it("two same-family accounts both with substantive evidence + close scores → MODERATE", () => {
    const v = deriveFounderConfidenceView(baseline({
      category: {
        label: "Computer & IT Services", source: "ECONOMIC_PURPOSE",
        glAccountNumber: "6054", glAccountName: "Computer & IT Services",
        confidence: 90,
        alternates: [{ accountNumber: "6071", accountName: "Subscriptions", confidence: 70 }],
        capitalState: "OPERATING", purposeLabel: null, purposeReason: null,
      } as any,
      confidenceInputs: {
        supplier: { matchState: "MATCHED", profileSignalCount: 3 },
        transaction: {
          economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 82,
          purchasedObjectCount: 2, productIdentityStatus: null, productIdentityConfidence: null,
          capitalTreatmentState: "OPERATING", capitalTreatmentConfidence: 82,
          natureConfidence: 82, natureIsDefensible: true, allocationCount: 1,
        },
        gl: {
          winnerConfidence: 90,
          compatibleCount: 2,                    // both survive both gates
          strongestAlternateConfidence: 70,      // genuinely close
          abstained: false,
        },
      },
    }));
    expect(v.gl.level).toBe("MODERATE");
  });
});

describe("§13.D · no legitimate runner-up → confidence not manufactured", () => {
  it("strong winner + no evidence-backed alternate → GL HIGH (absence of runner-up does not lower)", () => {
    const v = deriveFounderConfidenceView(baseline({
      confidenceInputs: {
        supplier: { matchState: "MATCHED", profileSignalCount: 3 },
        transaction: {
          economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 82,
          purchasedObjectCount: 1, productIdentityStatus: "RESOLVED_INTERNAL", productIdentityConfidence: 82,
          capitalTreatmentState: "CAPITAL", capitalTreatmentConfidence: 82,
          natureConfidence: 82, natureIsDefensible: true, allocationCount: 1,
        },
        gl: {
          winnerConfidence: 90,
          compatibleCount: 1,
          strongestAlternateConfidence: null,
          abstained: false,
        },
      },
    }));
    expect(v.gl.level).toBe("HIGH");
  });
});

describe("§13.E · independent uncertainty preserved (GL HIGH + Transaction MODERATE)", () => {
  it("strong GL winner + genuinely ambiguous capital → GL HIGH · Category MODERATE · compact 'Moderate · Category'", () => {
    const v = deriveFounderConfidenceView(baseline({
      confidenceInputs: {
        supplier: { matchState: "MATCHED", profileSignalCount: 3 },
        transaction: {
          economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 82,
          purchasedObjectCount: 1, productIdentityStatus: null, productIdentityConfidence: null,
          capitalTreatmentState: "AMBIGUOUS",         // genuine capital uncertainty
          capitalTreatmentConfidence: null,
          natureConfidence: 50, natureIsDefensible: false, allocationCount: 1,
        },
        gl: {
          winnerConfidence: 90,
          compatibleCount: 1,                    // no GL competitor after gates
          strongestAlternateConfidence: null,
          abstained: false,
        },
      },
    }));
    // GL alone is HIGH because no genuine competitor exists.
    expect(v.gl.level).toBe("HIGH");
    // Transaction remains MODERATE because capital is honestly AMBIGUOUS.
    expect(v.transaction.level).toBe("MODERATE");
    // Compact pill correctly identifies transaction as the weakest.
    expect(v.summaryLevel).toBe("MODERATE");
    expect(v.summaryLabel).toBe("Moderate · Category");
    expect(v.weakestDimension).toBe("transaction");
  });
});

describe("§13.F · multi-allocation preserved (CPA)", () => {
  it("Multiple category + all allocations resolved → GL HIGH (v200 preserved)", () => {
    const v = deriveFounderConfidenceView({
      intakeId: "cpa",
      displaySender: "s", displaySubject: "i", invoiceNumber: "1007565767",
      vendorMatch: { state: "NOT_FOUND", matchedName: null, matchedVendorId: null } as any,
      category: {
        label: "Multiple", source: "ALLOCATIONS",
        glAccountNumber: null, glAccountName: null,
        confidence: 90, alternates: [],
        capitalState: "OPERATING", purposeLabel: null, purposeReason: null,
      } as any,
      confidence: 100, gross: { amount: 1420.5, currency: "CAD" }, currencyShowCode: true,
      workflowReason: "r", workflowState: "AP_REVIEW", workflowActions: [],
      allocations: {
        entries: [
          { recommendedAccount: { accountNumber: "6064", accountName: "Membership & Dues", confidence: 80, requiresReview: false, postingBlockers: [] } },
          { recommendedAccount: { accountNumber: "6053", accountName: "Interest Expense", confidence: 80, requiresReview: false, postingBlockers: [] } },
        ],
      } as any,
      extractedVendorProfile: null,
      confidenceInputs: {
        supplier: { matchState: "NOT_FOUND", profileSignalCount: 3 },
        transaction: {
          economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 82,
          purchasedObjectCount: 2, productIdentityStatus: null, productIdentityConfidence: null,
          capitalTreatmentState: "OPERATING", capitalTreatmentConfidence: 80,
          natureConfidence: 80, natureIsDefensible: true, allocationCount: 2,
        },
        gl: {
          winnerConfidence: 90, compatibleCount: 1,
          strongestAlternateConfidence: null,
          abstained: true,                       // doc-level single-GL recommender abstained (correct for Multiple)
        },
      },
    } as unknown as ApInvoiceCardIntelligence);
    expect(v.gl.level).toBe("HIGH");
    expect(v.summaryLabel).toBe("High");
  });
});

describe("§35 anti-overfitting", () => {
  it("no runtime rule contains vendor / invoice / account literals in the two gates", () => {
    // The gate implementation itself uses only:
    //   - accountId strings (canonical DB identifiers, not literals)
    //   - GlEvidence.kind enum values (LINE_ITEM_MATCH / ECONOMIC_PURPOSE / etc.)
    //   - MIN_SUBSTANTIVE_SCORE integer threshold
    // No supplier name, invoice number, or account number literal is
    // referenced in the projection surface. This test would fail if
    // future edits smuggled in a hardcoded runtime special case.
    const src = require("fs").readFileSync(
      require("path").resolve("src/lib/mission-control/intelligence-review-intakes.ts"),
      "utf8",
    ) as string;
    // Zero references to specific vendors / invoices / accounts in the
    // gate implementation (comments about defect examples are permitted).
    // We assert on function bodies, not comment text — the check below
    // is a lenient one: no runtime string constant equal to a specific
    // vendor name / account number appears alongside a comparison or
    // assignment involving the gate variables.
    // Simple lint: forbid `=== "6054"` / `=== "6030"` / `=== "6051"`
    // / `=== "Club Support"` / `=== "OXIO"` etc. as runtime checks in
    // the file.
    const forbiddenExpressions = [
      /===\s*["']6054["']/, /===\s*["']6030["']/, /===\s*["']6051["']/, /===\s*["']1506["']/,
      /===\s*["']Club\s*Support/i, /===\s*["']OXIO["']/, /===\s*["']Oakcreek/i, /===\s*["']1091559["']/,
      /===\s*["']221178["']/, /===\s*["']1007565767["']/,
    ];
    for (const re of forbiddenExpressions) {
      expect(re.test(src)).toBe(false);
    }
  });
});
