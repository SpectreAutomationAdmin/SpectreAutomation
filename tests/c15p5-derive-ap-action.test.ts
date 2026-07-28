// Sprint 3 · Checkpoint 15P-5 (2026-07-28) — deriveApAction unit
// tests. Founder rule (§Modal routing must use the same source of
// truth): "the action button and the modal must never disagree."
//
// Every scenario proves that the SAME projection produces the SAME
// action shape — label + icon + modal decision are one function
// call away from the canonical vendor + workflow state.

import { describe, expect, it } from "vitest";
import { deriveApAction } from "@/lib/mission-control/ap-action";
import type { ApInvoiceCardIntelligence } from "@/lib/mission-control";

// Minimal ApInvoiceCardIntelligence factory. Only the fields
// deriveApAction reads are set to real values; everything else gets
// safe defaults so the test suite doesn't grow when other fields
// are added to the projection.
function mkAp(overrides: Partial<ApInvoiceCardIntelligence> & {
  workflowState: ApInvoiceCardIntelligence["workflowState"];
  vendorMatch?: Partial<ApInvoiceCardIntelligence["vendorMatch"]>;
}): ApInvoiceCardIntelligence {
  const vm = overrides.vendorMatch ?? { state: "NOT_FOUND" as const, matchedName: null, matchedVendorId: null };
  return {
    sender: { name: null, email: null, relationship: "OTHER" },
    extractedVendor: { name: "Test Vendor" },
    vendorMatch: {
      state: vm.state ?? "NOT_FOUND",
      matchedName: vm.matchedName ?? null,
      matchedVendorId: vm.matchedVendorId ?? null,
    },
    invoiceNumber: null,
    gross: { amount: null, currency: null },
    paymentTerms: null,
    paymentTermsSource: null,
    purchaseOrder: { poNumber: null, matchedPoDocumentId: null, variance: null },
    category: { label: null, glAccountNumber: null, glAccountName: null, capitalState: null, source: null, alternates: [] },
    gstVerification: null,
    gstRatePercent: null,
    extractedVendorProfile: null,
    invoiceCadenceThisQuarter: null,
    confidence: null,
    // Note: `overrides.workflowState` is applied via the spread
    // below. Adding it here first would duplicate the property and
    // TypeScript flags that as TS2783.
    workflowReason: "",
    unresolvedFindingCount: 0,
    primaryAttachment: null,
    ...overrides,
  } as ApInvoiceCardIntelligence;
}

describe("15P-5 · APPROVE_AND_POST — single-step auto-resolved", () => {
  const ap = mkAp({
    workflowState: "READY_FOR_APPROVAL",
    vendorMatch: { state: "MATCHED", matchedVendorId: "v_ms", matchedName: "Microsoft Corporation" },
  });
  const a = deriveApAction(ap);
  it("kind = APPROVE_AND_POST", () => {
    expect(a.kind).toBe("APPROVE_AND_POST");
  });
  it("label = 'Approve & post'", () => {
    expect(a.label).toBe("Approve & post");
  });
  it("modal opens at AP_CODING with vendor preselected and autoResolved=true", () => {
    if (a.kind !== "APPROVE_AND_POST") throw new Error("expected APPROVE_AND_POST");
    expect(a.modal.open).toBe(true);
    expect(a.modal.initialStep).toBe("AP_CODING");
    expect(a.modal.vendorId).toBe("v_ms");
    expect(a.modal.vendorName).toBe("Microsoft Corporation");
    expect(a.modal.autoResolved).toBe(true);
  });
});

describe("15P-5 · REVIEW_CODING — matched vendor + coding needs review", () => {
  const ap = mkAp({
    workflowState: "NEEDS_JUDGMENT",
    vendorMatch: { state: "MATCHED", matchedVendorId: "v_ms", matchedName: "Microsoft Corporation" },
  });
  const a = deriveApAction(ap);
  it("kind = REVIEW_CODING", () => {
    expect(a.kind).toBe("REVIEW_CODING");
  });
  it("modal opens at AP_CODING with autoResolved=false (two-step header available)", () => {
    if (a.kind !== "REVIEW_CODING") throw new Error("expected REVIEW_CODING");
    expect(a.modal.autoResolved).toBe(false);
    expect(a.modal.initialStep).toBe("AP_CODING");
  });
});

describe("15P-5 · CREATE_VENDOR_AND_POST — no vendor row yet", () => {
  const ap = mkAp({
    workflowState: "VENDOR_MATCH_REQUIRED",
    vendorMatch: { state: "NOT_FOUND", matchedName: null, matchedVendorId: null },
  });
  const a = deriveApAction(ap);
  it("kind = CREATE_VENDOR_AND_POST", () => {
    expect(a.kind).toBe("CREATE_VENDOR_AND_POST");
  });
  it("modal opens at PROFILE", () => {
    if (a.kind !== "CREATE_VENDOR_AND_POST") throw new Error("expected CREATE_VENDOR_AND_POST");
    expect(a.modal.open).toBe(true);
    expect(a.modal.initialStep).toBe("PROFILE");
  });
});

// -----------------------------------------------------------------------------
// The guarded-fallback: workflowState says READY_FOR_APPROVAL but the
// projection has no matchedVendorId (a state we shouldn't normally
// see, but the vendor could be deleted mid-render). Falling back to
// CREATE_VENDOR_AND_POST keeps the modal openable and lets the user
// re-create the vendor without a mysterious empty modal.
// -----------------------------------------------------------------------------

describe("15P-5 · vendor-deletion race — projection says READY but vendor gone", () => {
  const ap = mkAp({
    workflowState: "READY_FOR_APPROVAL",
    vendorMatch: { state: "MATCHED", matchedVendorId: null, matchedName: null },
  });
  const a = deriveApAction(ap);
  it("falls back to CREATE_VENDOR_AND_POST rather than opening on a null vendor", () => {
    expect(a.kind).toBe("CREATE_VENDOR_AND_POST");
  });
});

describe("15P-5 · NEEDS_JUDGMENT with no matched vendor (rare race) → also falls back", () => {
  const ap = mkAp({
    workflowState: "NEEDS_JUDGMENT",
    vendorMatch: { state: "MATCHED", matchedVendorId: null, matchedName: null },
  });
  const a = deriveApAction(ap);
  it("falls back to CREATE_VENDOR_AND_POST rather than opening on a null vendor", () => {
    expect(a.kind).toBe("CREATE_VENDOR_AND_POST");
  });
});

// -----------------------------------------------------------------------------
// Non-modal actions
// -----------------------------------------------------------------------------

describe("15P-5 · non-modal actions (duplicate / missing info / COA required)", () => {
  it("POSSIBLE_DUPLICATE → REVIEW_DUPLICATE, modal.open = false", () => {
    const a = deriveApAction(mkAp({ workflowState: "POSSIBLE_DUPLICATE" }));
    expect(a.kind).toBe("REVIEW_DUPLICATE");
    expect(a.modal.open).toBe(false);
  });
  it("MISSING_INFORMATION → REQUEST_INFORMATION, modal.open = false", () => {
    const a = deriveApAction(mkAp({ workflowState: "MISSING_INFORMATION" }));
    expect(a.kind).toBe("REQUEST_INFORMATION");
    expect(a.modal.open).toBe(false);
  });
  it("CHART_OF_ACCOUNTS_REQUIRED → COA_REQUIRED, modal.open = false", () => {
    const a = deriveApAction(mkAp({ workflowState: "CHART_OF_ACCOUNTS_REQUIRED" }));
    expect(a.kind).toBe("COA_REQUIRED");
    expect(a.modal.open).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// The founder's central invariant: LABEL and MODAL derive from ONE
// function call. If the projection changes (delete vendor, create
// vendor, post invoice), a subsequent call returns a NEW ApAction —
// no need for either the button or the modal to be told separately.
// -----------------------------------------------------------------------------

describe("15P-5 · label + modal derive from the SAME function", () => {
  const matched = mkAp({
    workflowState: "READY_FOR_APPROVAL",
    vendorMatch: { state: "MATCHED", matchedVendorId: "v_ms", matchedName: "Microsoft" },
  });
  const deletedRace = mkAp({
    workflowState: "VENDOR_MATCH_REQUIRED",   // projection recomputed after delete
    vendorMatch: { state: "NOT_FOUND", matchedName: null, matchedVendorId: null },
  });
  it("matched projection → label 'Approve & post' + modal AP_CODING", () => {
    const a = deriveApAction(matched);
    expect(a.label).toBe("Approve & post");
    if (a.modal.open && a.modal.initialStep === "AP_CODING") {
      expect(a.modal.vendorId).toBe("v_ms");
    } else {
      throw new Error("expected AP_CODING modal");
    }
  });
  it("deleted-race projection → label 'Create vendor & post' + modal PROFILE", () => {
    const a = deriveApAction(deletedRace);
    expect(a.label).toBe("Create vendor & post");
    if (a.modal.open) {
      expect(a.modal.initialStep).toBe("PROFILE");
    } else {
      throw new Error("expected modal to open");
    }
  });
  it("label and modal derive from a SINGLE call — no way to disagree", () => {
    // Structural proof: the ApAction type's `modal` block is a
    // discriminated field carried on the same object as `label`.
    // Callers reading `a.label` cannot get one action's label with
    // another action's modal, by construction.
    const a = deriveApAction(matched);
    if (a.kind === "APPROVE_AND_POST") {
      expect(a.label).toBe("Approve & post");
      expect(a.modal.initialStep).toBe("AP_CODING");
    } else {
      throw new Error("expected APPROVE_AND_POST");
    }
  });
});
