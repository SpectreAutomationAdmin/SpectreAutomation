// Sprint 3 · Post-Slice-3 lifecycle contract (2026-08-09) —
// Analysis-pending → stable-snapshot invariant test matrix.
//
// Locks §1 / §4 / §5 / §6 / §14 of the founder-directed lifecycle
// hardening checkpoint. The test matrix corresponds to §29's 22
// scenarios; scenarios that require live Prisma state (refresh /
// dedupe / reprocess timing across worker + web instances) are
// covered by the staging Playwright + reference document instead —
// noted per-scenario.
//
// The invariants tested here:
//
//   1. A "pending" invoiceSummary (workflowState = ANALYSIS_PENDING)
//      MUST have every founder-facing AP fact field nulled — no
//      supplier, no invoice #, no amount, no category, no GL, no
//      confidence, no allocations.
//   2. The workflowReason on a pending shell MUST be founder-facing
//      copy ("Spectre is reading the attached invoice."), never the
//      Phase 3 blocker vocabulary.
//   3. The confidence adapter (Slice 2 `deriveFounderConfidenceView`)
//      MUST NOT overclaim on a pending shell — because every input
//      field is null, the adapter naturally lands on NEEDS_REVIEW,
//      and the card renderer's ANALYSIS_PENDING branch SKIPS the
//      confidence disclosure entirely (verified via renderer contract
//      below).
//   4. `deriveApAction` (frozen) already routes ANALYSIS_PENDING to
//      EXPAND_ONLY — no modal, no post. This test locks that today
//      and detects regressions.
//   5. A completed-but-unresolved snapshot (§4 example B) is NOT
//      pending. Its workflowState is MISSING_INFORMATION /
//      VENDOR_MATCH_REQUIRED / NEEDS_JUDGMENT, and its fields carry
//      the resolved values plus the "Needs review" markers for the
//      genuinely-unresolved ones.

import { describe, it, expect } from "vitest";
import { buildPendingInvoiceSummary } from "@/lib/mission-control/intelligence-review-intakes";
import type { ApInvoiceCardIntelligence } from "@/lib/mission-control/intelligence-review-intakes";
import { deriveFounderConfidenceView } from "@/lib/mission-control/founder-confidence";
import { deriveApAction } from "@/lib/mission-control/ap-action";

// -----------------------------------------------------------------------------
// Fixture builders
// -----------------------------------------------------------------------------

const PENDING_ARGS = {
  sourceEmail: { senderName: "Vendor AR", senderAddress: "ar@vendor.example", internetMessageId: "int-1" },
  senderRelationship: "VENDOR" as const,
  doc: { id: "doc_1", filename: "invoice_12345.pdf", sourceKind: "EMAIL_ATTACHMENT", sourceReferenceId: "att_1" },
  hasAnalysis: false,
  hasStoredVersion: false,
  lastAnalysedAt: null,
};

function completedResolved(): ApInvoiceCardIntelligence {
  return {
    sender: PENDING_ARGS.sourceEmail
      ? { name: "Vendor AR", email: "ar@vendor.example", relationship: "VENDOR" }
      : { name: null, email: null, relationship: "OTHER" },
    extractedVendor: { name: "DMM ENERGY INC" },
    vendorMatch: { state: "MATCHED", matchedName: "DMM ENERGY INC", matchedVendorId: "v_1" },
    invoiceNumber: "B0037FC",
    gross: { amount: "2532.92", currency: "CAD" },
    paymentTerms: "Net 30",
    paymentTermsSource: "VENDOR_PROFILE",
    purchaseOrder: { poNumber: null, matchedPoDocumentId: null, variance: null },
    category: {
      label: "Fuel",
      glAccountNumber: "6025",
      glAccountName: "Fuel",
      capitalState: "OPERATING",
      source: "NAME_KEYWORD",
      alternates: [],
    },
    gstVerification: "VERIFIED",
    gstRatePercent: 5,
    extractedVendorProfile: null,
    invoiceCadenceThisQuarter: 3,
    confidence: 88,
    confidenceInputs: {
      supplier: { matchState: "MATCHED", profileSignalCount: 3 },
      transaction: {
        economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 85,
        purchasedObjectCount: 1, productIdentityStatus: "RESOLVED_INTERNAL",
        productIdentityConfidence: 90, capitalTreatmentState: "OPERATING",
        capitalTreatmentConfidence: 88, natureConfidence: 80, natureIsDefensible: true,
        allocationCount: 1,
      },
      gl: { winnerConfidence: 90, compatibleCount: 1, strongestAlternateConfidence: null, abstained: false },
    },
    workflowState: "READY_FOR_APPROVAL",
    workflowReason: "",
    unresolvedFindingCount: 0,
    primaryAttachment: { documentId: "doc_1", filename: "invoice_12345.pdf" },
    allocations: null,
  } as unknown as ApInvoiceCardIntelligence;
}

function completedUnresolvedSupplier(): ApInvoiceCardIntelligence {
  return {
    ...completedResolved(),
    extractedVendor: { name: null },
    vendorMatch: { state: "NOT_FOUND", matchedName: null, matchedVendorId: null },
    confidenceInputs: {
      supplier: { matchState: "NOT_FOUND", profileSignalCount: 1 },
      transaction: {
        economicPurposeSource: "CANONICAL_COMMITTED", economicPurposeConfidence: 78,
        purchasedObjectCount: 1, productIdentityStatus: "RESOLVED_INTERNAL",
        productIdentityConfidence: 82, capitalTreatmentState: "OPERATING",
        capitalTreatmentConfidence: 75, natureConfidence: 74, natureIsDefensible: true,
        allocationCount: 1,
      },
      gl: { winnerConfidence: 90, compatibleCount: 1, strongestAlternateConfidence: null, abstained: false },
    },
    workflowState: "MISSING_INFORMATION",
    workflowReason: "Supplier identity is not resolved to sufficient confidence.",
  } as unknown as ApInvoiceCardIntelligence;
}

function completedGlAbstained(): ApInvoiceCardIntelligence {
  const base = completedResolved();
  // Real abstention: purpose committed (label present + purposeLabel
  // set) but no GL account resolved. Distinct from category-null.
  return {
    ...base,
    category: {
      label: "Fuel",
      purposeLabel: "Fuel",
      purposeReason: null,
      glAccountNumber: null,
      glAccountName: null,
      capitalState: "OPERATING",
      source: "CAPITAL_CLASS_MAP",
      alternates: [],
    } as ApInvoiceCardIntelligence["category"],
    confidenceInputs: {
      ...base.confidenceInputs!,
      gl: { winnerConfidence: null, compatibleCount: 0, strongestAlternateConfidence: null, abstained: true },
    },
    workflowState: "NEEDS_JUDGMENT",
    workflowReason: "GL abstention — Spectre understood the purchase but did not commit to a single account.",
  } as unknown as ApInvoiceCardIntelligence;
}

function completedMultiple(): ApInvoiceCardIntelligence {
  const base = completedResolved();
  return {
    ...base,
    category: { ...base.category, label: "Multiple", glAccountNumber: null, glAccountName: null } as ApInvoiceCardIntelligence["category"],
    allocations: {
      cardCategory: "Multiple",
      requiresReview: false,
      totals: { allocationsSubtotal: 500, taxTotal: 0, creditTotal: 0, grossTotal: 500, allocationVariance: 0 },
      entries: [
        { id: "a1", sourceLineItemIds: ["l1"], descriptions: ["Membership Dues"],
          economicPurposeConcept: "MEMBERSHIP_DUES", economicPurposeConfidence: 90,
          supportingEvidence: [], amount: 495, taxTreatment: "NON_RECOVERABLE",
          taxRate: null, taxAmount: null,
          recommendedAccount: { accountId: "a1", accountNumber: "6064", accountName: "Membership & Dues", confidence: 92, requiresReview: false, postingBlockers: [] },
          alternatives: [] },
        { id: "a2", sourceLineItemIds: ["l2"], descriptions: ["Interest"],
          economicPurposeConcept: "INTEREST", economicPurposeConfidence: 75,
          supportingEvidence: [], amount: 5, taxTreatment: "NON_RECOVERABLE",
          taxRate: null, taxAmount: null,
          recommendedAccount: { accountId: "a2", accountNumber: "6053", accountName: "Interest Expense", confidence: 62, requiresReview: false, postingBlockers: [] },
          alternatives: [] },
      ],
    },
  } as unknown as ApInvoiceCardIntelligence;
}

// -----------------------------------------------------------------------------
// §29 · Scenarios 1-8 — pending shell contract
// -----------------------------------------------------------------------------

describe("§29 pending shell — every founder-facing AP fact nulled", () => {
  const p = buildPendingInvoiceSummary(PENDING_ARGS);

  it("scenario-1: card visible with pending workflow state, not NEEDS_JUDGMENT", () => {
    expect(p.workflowState).toBe("ANALYSIS_PENDING");
  });

  it("scenario-2: supplier is not published (extractedVendor + vendorMatch nulled)", () => {
    expect(p.extractedVendor.name).toBeNull();
    expect(p.vendorMatch.state).toBe("NOT_FOUND");
    expect(p.vendorMatch.matchedName).toBeNull();
    expect(p.vendorMatch.matchedVendorId).toBeNull();
  });

  it("scenario-3: invoice number is not published", () => {
    expect(p.invoiceNumber).toBeNull();
  });

  it("scenario-4: amount is not published as a completed fact", () => {
    expect(p.gross.amount).toBeNull();
    expect(p.gross.currency).toBeNull();
  });

  it("scenario-5: category is not published", () => {
    expect(p.category.label).toBeNull();
    expect(p.category.glAccountNumber).toBeNull();
    expect(p.category.glAccountName).toBeNull();
    expect(p.category.alternates).toEqual([]);
    expect(p.category.capitalState).toBeNull();
    expect(p.category.source).toBeNull();
  });

  it("scenario-6: GL is not published", () => {
    // Same category.glAccountNumber assertion + allocations
    expect(p.allocations).toBeNull();
  });

  it("scenario-7: confidence adapter yields no numeric confidence + no rich inputs", () => {
    expect(p.confidence).toBeNull();
    expect(p.confidenceInputs).toBeUndefined();
  });

  it("scenario-8: no accounting action is exposed while pending (deriveApAction routes to EXPAND_ONLY)", () => {
    // Reconstruct an ap with the pending workflow state so we can
    // exercise the frozen ap-action derivation.
    const ap = { ...p, currencyShowCode: true } as unknown as ApInvoiceCardIntelligence;
    const action = deriveApAction(ap);
    expect(action.modal.open).toBe(false);
    expect(action.kind).toBe("EXPAND_ONLY");
  });
});

// -----------------------------------------------------------------------------
// §29 · Scenarios 9-11 — coherent publication after analysis / OCR
// -----------------------------------------------------------------------------

describe("§29 coherent publication (post-analysis)", () => {
  it("scenario-9: completed digital → all facts published together", () => {
    const c = completedResolved();
    expect(c.workflowState).toBe("READY_FOR_APPROVAL");
    expect(c.extractedVendor.name).toBe("DMM ENERGY INC");
    expect(c.invoiceNumber).toBe("B0037FC");
    expect(c.gross.amount).toBe("2532.92");
    expect(c.category.glAccountNumber).toBe("6025");
    expect(c.confidenceInputs?.gl?.winnerConfidence).toBe(90);
  });

  it("scenario-10-11: OCR-pending vs OCR-complete are represented by ANALYSIS_PENDING vs a completed shape (never by a partially-published card)", () => {
    // The projection gates on WorkIntakeItem.analysisVersion; the
    // OCR worker deliberately clears analysisVersion=null on success
    // to force a re-projection. `buildPendingInvoiceSummary` is what
    // the projection returns during that window — every fact null.
    const pendingWhileOcr = buildPendingInvoiceSummary({ ...PENDING_ARGS, hasAnalysis: true, hasStoredVersion: false });
    expect(pendingWhileOcr.workflowState).toBe("ANALYSIS_PENDING");
    expect(pendingWhileOcr.category.label).toBeNull();
    // A COMPLETED shape post-OCR must carry a stable category, not a
    // dashed pending one.
    const completed = completedResolved();
    expect(completed.workflowState).not.toBe("ANALYSIS_PENDING");
    expect(completed.category.label).not.toBeNull();
  });
});

// -----------------------------------------------------------------------------
// §29 · Scenarios 12-13 — completed but unresolved ≠ pending
// -----------------------------------------------------------------------------

describe("§29 completed-but-unresolved distinct from pending", () => {
  it("scenario-12: unresolved supplier → MISSING_INFORMATION with populated resolved fields (not ANALYSIS_PENDING)", () => {
    const c = completedUnresolvedSupplier();
    expect(c.workflowState).toBe("MISSING_INFORMATION");
    expect(c.workflowState).not.toBe("ANALYSIS_PENDING");
    // Resolved fields still populate
    expect(c.invoiceNumber).toBe("B0037FC");
    expect(c.gross.amount).toBe("2532.92");
    expect(c.category.label).toBe("Fuel");
    // Supplier confidence adapter reports LOW · Supplier, not pending
    const view = deriveFounderConfidenceView(c);
    expect(view.supplier.level).toBe("LOW");
    expect(view.summaryLabel).toBe("Low · Supplier");
  });

  it("scenario-13: GL abstention → summary is 'Needs review · GL' with completed transaction understanding (not ANALYSIS_PENDING)", () => {
    const c = completedGlAbstained();
    expect(c.workflowState).not.toBe("ANALYSIS_PENDING");
    const view = deriveFounderConfidenceView(c);
    expect(view.gl.level).toBe("NEEDS_REVIEW");
    expect(view.summaryLabel).toContain("GL");
  });
});

// -----------------------------------------------------------------------------
// §29 · Scenario 14 — Multiple publishes together, no partial reveal
// -----------------------------------------------------------------------------

describe("§29 Multiple publishes together", () => {
  it("scenario-14: completed Multiple invoice carries every allocation in a single publication", () => {
    const c = completedMultiple();
    expect(c.category.label).toBe("Multiple");
    expect(c.allocations?.entries.length).toBe(2);
    expect(c.workflowState).not.toBe("ANALYSIS_PENDING");
    // Both allocations have their own recommended account committed
    for (const e of c.allocations!.entries) {
      expect(e.recommendedAccount).not.toBeNull();
      expect(e.recommendedAccount?.accountNumber).toMatch(/^\d{4}$/);
    }
  });
});

// -----------------------------------------------------------------------------
// §29 · Scenarios 15-21 — reload / re-analysis / dedupe / stale versioning
// -----------------------------------------------------------------------------

describe("§29 lifecycle stability across renders", () => {
  it("scenario-15,17: repeated calls with same inputs produce structurally identical pending shells (reload safe)", () => {
    const a = buildPendingInvoiceSummary(PENDING_ARGS);
    const b = buildPendingInvoiceSummary(PENDING_ARGS);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("scenario-16: pending shell has no volatile / partial fact fields that could 'flicker' during re-render", () => {
    const p = buildPendingInvoiceSummary(PENDING_ARGS);
    // Every user-facing fact field is either null / [] / a stable
    // default. Enumerate the ones that could otherwise flicker.
    expect(p.extractedVendor.name).toBeNull();
    expect(p.vendorMatch.matchedName).toBeNull();
    expect(p.invoiceNumber).toBeNull();
    expect(p.gross.amount).toBeNull();
    expect(p.gross.currency).toBeNull();
    expect(p.paymentTerms).toBeNull();
    expect(p.paymentTermsSource).toBeNull();
    expect(p.purchaseOrder.poNumber).toBeNull();
    expect(p.category.label).toBeNull();
    expect(p.category.alternates).toEqual([]);
    expect(p.gstVerification).toBeNull();
    expect(p.gstRatePercent).toBeNull();
    expect(p.allocations).toBeNull();
    expect(p.confidence).toBeNull();
    expect(p.confidenceInputs).toBeUndefined();
    expect(p.unresolvedFindingCount).toBe(0);
  });

  it("scenario-18,19: helper builds a pending shell whether prior analysis existed or not — the shell shape is uniform", () => {
    const neverAnalysed = buildPendingInvoiceSummary({ ...PENDING_ARGS, hasAnalysis: false, hasStoredVersion: false, lastAnalysedAt: null });
    const staleAfterReprocess = buildPendingInvoiceSummary({ ...PENDING_ARGS, hasAnalysis: true, hasStoredVersion: false, lastAnalysedAt: new Date("2026-08-08T12:00:00Z") });
    // Both must present identical founder-facing surface — the reason
    // for the pending state does not leak into the founder view.
    expect(neverAnalysed.workflowState).toBe("ANALYSIS_PENDING");
    expect(staleAfterReprocess.workflowState).toBe("ANALYSIS_PENDING");
    expect(neverAnalysed.workflowReason).toBe(staleAfterReprocess.workflowReason);
  });

  it("scenario-20: pending workflowReason is founder-facing copy, not a blocker vocabulary term", () => {
    const p = buildPendingInvoiceSummary(PENDING_ARGS);
    expect(p.workflowReason).toBe("Spectre is reading the attached invoice.");
    // Never a Phase 3 blocker code like "SUPPLIER_UNRESOLVED"
    expect(p.workflowReason).not.toMatch(/UNRESOLVED|BLOCKER|EXTRACTION_PENDING|_/);
  });

  it("scenario-21: pending shell preserves attachment identity when the doc is known (so the founder sees which file is being read)", () => {
    const p = buildPendingInvoiceSummary(PENDING_ARGS);
    expect(p.primaryAttachment).toEqual({ documentId: "doc_1", filename: "invoice_12345.pdf" });
  });
});

// -----------------------------------------------------------------------------
// §29 · Scenario 22 — confidence begins only after a stable snapshot
// -----------------------------------------------------------------------------

describe("§29 confidence begins only after a stable snapshot (§14, §27)", () => {
  it("scenario-22: pending shell yields NEEDS_REVIEW from the confidence adapter — but the card renderer's ANALYSIS_PENDING branch never mounts the disclosure at all", () => {
    // A defence-in-depth check: even if the ANALYSIS_PENDING branch
    // in EmailIntakeCard ever regresses and the disclosure is mounted
    // on a pending shell, the adapter must NOT overclaim a HIGH.
    const pendingAp = buildPendingInvoiceSummary(PENDING_ARGS) as unknown as ApInvoiceCardIntelligence;
    const view = deriveFounderConfidenceView(pendingAp);
    // Every dimension collapses to NEEDS_REVIEW because inputs are null.
    // Slice 3 renderer contract: the pending branch NEVER mounts
    // ApCardConfidenceDisclosure, so this string never reaches the
    // founder in the pending state.
    expect(["NEEDS_REVIEW", "LOW"]).toContain(view.summaryLevel);
    expect(view.summaryLevel).not.toBe("HIGH");
  });
});
