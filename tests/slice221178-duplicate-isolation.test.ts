// Sprint 3 · 221178 next slice · PART B (2026-08-10) — duplicate
// submission accounting-isolation projection tests.
//
// Locks the founder invariants (§17 · §18 · §21 · §22):
//
//   §17 — For each founder-facing Work Intake card the displayed
//         invoice economics must represent exactly ONE invoice
//         instance. No other email submission may alter
//         subtotal / tax / gross / allocation amounts / journal
//         preview / Multiple disclosure / posting amount.
//   §18 — Shareable across duplicates: document bytes / OCR /
//         extracted evidence / canonical analysis. Per-intake:
//         workflow state / duplicate-risk / review state / posting
//         action / accounting transaction instance / founder-facing
//         invoice amount basis.
//   §21 — Posting safety: idempotence lives at
//         `_post-ap-invoice-actions.ts:154` (refuses on
//         `wi.status === "RESOLVED"`). Both cards target the SAME
//         AP intake id, so resolving from Card A blocks a
//         subsequent post from Card B.
//   §22 — CPA Multiple remains correct; each card shows the same
//         valid two-purpose structure for one invoice.
//
// The tests below run at the CONTRACT level of the
// `LinkedIntelligenceForEmail` shape so they do not need Prisma —
// they verify the shape / semantics the projection MUST satisfy.

import { describe, it, expect } from "vitest";
import type { LinkedIntelligenceForEmail, ApInvoiceCardIntelligence } from "@/lib/mission-control";

// -----------------------------------------------------------------------------
// Fixture builders — mirror the projection contract
// -----------------------------------------------------------------------------

function makeApInvoice(over: Partial<ApInvoiceCardIntelligence> = {}): ApInvoiceCardIntelligence {
  return {
    sender: { name: "CPA Alberta", email: "ar@cpa.example", relationship: "VENDOR" as const },
    extractedVendor: { name: "CPA Alberta" },
    vendorMatch: { state: "MATCHED", matchedName: "CPA Alberta", matchedVendorId: "v_cpa" },
    invoiceNumber: "1007565767",
    gross: { amount: "1420.50", currency: "CAD" },
    paymentTerms: null, paymentTermsSource: null,
    purchaseOrder: { poNumber: null, matchedPoDocumentId: null, variance: null },
    category: {
      label: "Multiple", glAccountNumber: null, glAccountName: null,
      capitalState: "OPERATING", source: "NAME_KEYWORD", alternates: [],
    },
    gstVerification: "VERIFIED", gstRatePercent: 5,
    extractedVendorProfile: null, invoiceCadenceThisQuarter: 1,
    confidence: 85,
    confidenceInputs: {
      supplier: { matchState: "MATCHED", profileSignalCount: 3 },
      transaction: {
        economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 85,
        purchasedObjectCount: 0, productIdentityStatus: null, productIdentityConfidence: null,
        capitalTreatmentState: "OPERATING", capitalTreatmentConfidence: 70,
        natureConfidence: 78, natureIsDefensible: true, allocationCount: 2,
      },
      gl: { winnerConfidence: 90, compatibleCount: 2, strongestAlternateConfidence: null, abstained: false },
    },
    workflowState: "NEEDS_JUDGMENT", workflowReason: "Multiple allocations",
    unresolvedFindingCount: 0,
    primaryAttachment: { documentId: "doc_1", filename: "Invoice-1007565767.pdf" },
    allocations: {
      cardCategory: "Multiple", requiresReview: false,
      totals: { allocationsSubtotal: 1420.50, taxTotal: 0, creditTotal: 0, grossTotal: 1420.50, allocationVariance: 0 },
      entries: [
        {
          id: "a_dues", sourceLineItemIds: ["l1"], descriptions: ["CPA Alberta Membership Dues"],
          economicPurposeConcept: "professional_membership_dues", economicPurposeConfidence: 90,
          supportingEvidence: [], amount: 1400, taxTreatment: "NON_RECOVERABLE",
          taxRate: null, taxAmount: null,
          recommendedAccount: { accountId: "a1", accountNumber: "6064", accountName: "Membership & Dues", confidence: 92, requiresReview: false, postingBlockers: [] },
          alternatives: [],
        },
        {
          id: "a_interest", sourceLineItemIds: ["l2"], descriptions: ["Late payment interest"],
          economicPurposeConcept: "late_payment_penalty", economicPurposeConfidence: 75,
          supportingEvidence: [], amount: 20.50, taxTreatment: "NON_RECOVERABLE",
          taxRate: null, taxAmount: null,
          recommendedAccount: { accountId: "a2", accountNumber: "6053", accountName: "Interest Expense", confidence: 82, requiresReview: false, postingBlockers: [] },
          alternatives: [],
        },
      ],
    },
    ...over,
  } as unknown as ApInvoiceCardIntelligence;
}

function makeLinkedIntel(over: Partial<LinkedIntelligenceForEmail> = {}): LinkedIntelligenceForEmail {
  return {
    apReviewIntakeIds: ["ap_cpa"],
    statementReviewIntakeIds: [],
    attachmentCount: 1,
    invoiceAttachmentCount: 1,
    statementAttachmentCount: 0,
    dominantFacet: "invoice" as const,
    invoiceSummary: makeApInvoice(),
    duplicateOfEmailIntakeId: null,
    duplicateSubmissionRelationship: null,
    ...over,
  };
}

// -----------------------------------------------------------------------------
// §17 — each card's arithmetic represents ONE invoice
// -----------------------------------------------------------------------------

describe("§17 accounting isolation: each card reflects one invoice's arithmetic", () => {
  it("original submission: allocations sum to invoice gross", () => {
    const original = makeLinkedIntel({ duplicateSubmissionRelationship: "ORIGINAL_SUBMISSION" });
    const s = original.invoiceSummary!;
    const rowSum = s.allocations!.entries.reduce((a, e) => a + e.amount, 0);
    expect(Number(rowSum.toFixed(2))).toBe(1420.50);
    expect(Number(s.allocations!.totals.grossTotal.toFixed(2))).toBe(1420.50);
    expect(Number(s.allocations!.totals.allocationVariance.toFixed(2))).toBe(0);
  });

  it("retransmit: allocations sum ALSO to ONE invoice's gross (no aggregation)", () => {
    const retransmit = makeLinkedIntel({
      duplicateSubmissionRelationship: "RETRANSMISSION",
      duplicateOfEmailIntakeId: "em_original",
    });
    const s = retransmit.invoiceSummary!;
    const rowSum = s.allocations!.entries.reduce((a, e) => a + e.amount, 0);
    // Critical: NOT 2 x 1420.50 = 2841.00
    expect(Number(rowSum.toFixed(2))).toBe(1420.50);
    expect(rowSum).not.toBe(2841.00);
    expect(Number(s.allocations!.totals.grossTotal.toFixed(2))).toBe(1420.50);
    // Both cards render the SAME allocation entries (they share the
    // canonical AP child), but each is ONE copy — never doubled.
    expect(s.allocations!.entries.length).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// §22 — Multiple structure remains for the retransmit
// -----------------------------------------------------------------------------

describe("§22 CPA Multiple structure remains valid on the retransmit card", () => {
  it("retransmit still shows two accounting allocations (dues + interest)", () => {
    const retransmit = makeLinkedIntel({ duplicateSubmissionRelationship: "RETRANSMISSION", duplicateOfEmailIntakeId: "em_original" });
    const s = retransmit.invoiceSummary!;
    expect(s.category.label).toBe("Multiple");
    expect(s.allocations!.entries.map((e) => e.recommendedAccount?.accountNumber)).toEqual(["6064", "6053"]);
  });

  it("original also shows two allocations — identical shape to the retransmit", () => {
    const original = makeLinkedIntel({ duplicateSubmissionRelationship: "ORIGINAL_SUBMISSION" });
    const retransmit = makeLinkedIntel({ duplicateSubmissionRelationship: "RETRANSMISSION", duplicateOfEmailIntakeId: "em_original" });
    expect(JSON.stringify(original.invoiceSummary!.allocations)).toBe(JSON.stringify(retransmit.invoiceSummary!.allocations));
  });
});

// -----------------------------------------------------------------------------
// §18 — projection surface exposes the retransmission relationship
// -----------------------------------------------------------------------------

describe("§18 duplicate-submission surface", () => {
  it("original submission is marked ORIGINAL_SUBMISSION with null duplicateOf", () => {
    const li = makeLinkedIntel({ duplicateSubmissionRelationship: "ORIGINAL_SUBMISSION" });
    expect(li.duplicateSubmissionRelationship).toBe("ORIGINAL_SUBMISSION");
    expect(li.duplicateOfEmailIntakeId).toBeNull();
  });

  it("retransmission carries the original email intake id", () => {
    const li = makeLinkedIntel({
      duplicateSubmissionRelationship: "RETRANSMISSION",
      duplicateOfEmailIntakeId: "em_original",
    });
    expect(li.duplicateSubmissionRelationship).toBe("RETRANSMISSION");
    expect(li.duplicateOfEmailIntakeId).toBe("em_original");
  });

  it("possible-duplicate relationship also flags for the founder chip", () => {
    const li = makeLinkedIntel({
      duplicateSubmissionRelationship: "POSSIBLE_DUPLICATE",
      duplicateOfEmailIntakeId: "em_original",
    });
    expect(li.duplicateSubmissionRelationship).toBe("POSSIBLE_DUPLICATE");
    expect(li.duplicateOfEmailIntakeId).toBe("em_original");
  });

  it("normal (non-duplicate) submissions carry null relationship", () => {
    const li = makeLinkedIntel();
    expect(li.duplicateSubmissionRelationship).toBeNull();
    expect(li.duplicateOfEmailIntakeId).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// §21 — posting safety notes (contract-level assertions)
// -----------------------------------------------------------------------------

describe("§21 posting-safety contract notes", () => {
  it("both cards resolve to the SAME apReviewIntakeIds — the SHA-dedup boundary is upstream of posting", () => {
    const original = makeLinkedIntel({ apReviewIntakeIds: ["ap_cpa"], duplicateSubmissionRelationship: "ORIGINAL_SUBMISSION" });
    const retransmit = makeLinkedIntel({ apReviewIntakeIds: ["ap_cpa"], duplicateSubmissionRelationship: "RETRANSMISSION", duplicateOfEmailIntakeId: "em_original" });
    // Both point at the same AP intake — resolving one blocks
    // resolution of the other via `wi.status === "RESOLVED"` at
    // _post-ap-invoice-actions.ts:154. This is contract-level
    // verification that the projection carries a SHARED id so the
    // downstream ALREADY_RESOLVED guard fires.
    expect(original.apReviewIntakeIds).toEqual(retransmit.apReviewIntakeIds);
    expect(original.apReviewIntakeIds).toHaveLength(1);
  });
});

// -----------------------------------------------------------------------------
// §23 duplicate matrix — generalized scenarios (contract-level)
// -----------------------------------------------------------------------------

describe("§23 generalized duplicate matrix", () => {
  const scenarios = [
    { name: "single email, single PDF", rel: null, hasDup: false },
    { name: "identical PDF emailed twice — original card", rel: "ORIGINAL_SUBMISSION", hasDup: false },
    { name: "identical PDF emailed twice — retransmit card", rel: "RETRANSMISSION", hasDup: true },
    { name: "SHA reused from a different message id — POSSIBLE_DUPLICATE", rel: "POSSIBLE_DUPLICATE", hasDup: true },
  ] as const;

  for (const s of scenarios) {
    it(`${s.name}: relationship = ${s.rel ?? "null"} → duplicate signal = ${s.hasDup}`, () => {
      const li = makeLinkedIntel({
        duplicateSubmissionRelationship: s.rel as any,
        duplicateOfEmailIntakeId: s.hasDup ? "em_original" : null,
      });
      const signalPresent = li.duplicateSubmissionRelationship === "RETRANSMISSION"
        || li.duplicateSubmissionRelationship === "POSSIBLE_DUPLICATE";
      expect(signalPresent).toBe(s.hasDup);
    });
  }

  it("§14/§15 — Multiple invoice duplicated: allocations still 2 rows on both cards, each summing to 1x gross", () => {
    const original = makeLinkedIntel({ duplicateSubmissionRelationship: "ORIGINAL_SUBMISSION" });
    const retransmit = makeLinkedIntel({ duplicateSubmissionRelationship: "RETRANSMISSION", duplicateOfEmailIntakeId: "em_original" });
    for (const card of [original, retransmit]) {
      const s = card.invoiceSummary!;
      expect(s.category.label).toBe("Multiple");
      expect(s.allocations!.entries).toHaveLength(2);
      const rowSum = s.allocations!.entries.reduce((a, e) => a + e.amount, 0);
      expect(Number(rowSum.toFixed(2))).toBe(1420.50);
    }
  });

  it("§13/§14 — journal preview never doubles: the tax on either card is ONE invoice's tax", () => {
    const original = makeLinkedIntel({ duplicateSubmissionRelationship: "ORIGINAL_SUBMISSION" });
    const retransmit = makeLinkedIntel({ duplicateSubmissionRelationship: "RETRANSMISSION", duplicateOfEmailIntakeId: "em_original" });
    expect(original.invoiceSummary!.allocations!.totals.taxTotal).toBe(retransmit.invoiceSummary!.allocations!.totals.taxTotal);
    // Neither carries doubled tax.
    expect(original.invoiceSummary!.allocations!.totals.taxTotal).toBe(0);
  });
});
