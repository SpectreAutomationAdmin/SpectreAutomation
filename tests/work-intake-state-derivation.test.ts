// v206 Work Intake state correction (2026-08-15) — Defect A tests.
//
// Founder direction §5 action matrix. Verifies:
//   • Missing-vendor + core-facts-present + GL-committed  → VENDOR_MATCH_REQUIRED
//   • Missing supplier NAME                                 → MISSING_INFORMATION
//   • Missing invoice number                                → MISSING_INFORMATION
//   • Missing total                                         → MISSING_INFORMATION
//   • All required cleared                                  → READY_FOR_APPROVAL
//   • Duplicate risk                                        → POSSIBLE_DUPLICATE
//
// A "confidence deficit on a value that IS present" must NOT cause
// MISSING_INFORMATION. That was the #220824 root defect.

import { describe, it, expect } from "vitest";
import { mapPhase3ToLegacyDisplayState } from "@/lib/mission-control/intelligence-review-intakes";
import type { ApWorkflowDecision } from "@/lib/ap-intelligence/workflow/decision";
import type { ApAnalyseResult } from "@/lib/ap-intelligence/analyse";

// Minimum-shape analysis stub for the state-derivation tests. Only the
// fields the mapping actually reads are populated. Casts to
// ApAnalyseResult so the caller shape matches.
function mkAnalysis(opts: {
  supplierName?: string | null;
  invoiceNumber?: string | null;
  total?: number | null;
  glAccountNumber?: string | null;
}): ApAnalyseResult {
  return {
    extraction: {
      state: "STRUCTURED",
      vendor: { guessedName: opts.supplierName ?? null },
      invoiceNumber: opts.invoiceNumber ?? null,
      total: opts.total ?? null,
    },
    gl: { accountNumber: opts.glAccountNumber ?? null },
  } as unknown as ApAnalyseResult;
}

function mkDecision(state: ApWorkflowDecision["state"], blockerCodes: string[]): ApWorkflowDecision {
  return {
    state,
    dimensions: [],
    blockers: blockerCodes.map((code) => ({ code, message: code, dimensionKey: "test" })),
    warnings: [],
    rationale: [],
    autoApprovalExclusions: [],
  } as ApWorkflowDecision;
}

describe("Defect A · mapPhase3ToLegacyDisplayState — action-matrix rows", () => {

  it("READY_FOR_APPROVAL when the decision engine says so, regardless of vendor state", () => {
    const d = mkDecision("READY_FOR_APPROVAL", []);
    expect(mapPhase3ToLegacyDisplayState(d, mkAnalysis({
      supplierName: "Any", invoiceNumber: "X", total: 1, glAccountNumber: "6071",
    }))).toBe("READY_FOR_APPROVAL");
  });

  it("AUTO_APPROVAL_ELIGIBLE also displays as READY_FOR_APPROVAL", () => {
    const d = mkDecision("AUTO_APPROVAL_ELIGIBLE", []);
    expect(mapPhase3ToLegacyDisplayState(d)).toBe("READY_FOR_APPROVAL");
  });

  it("Only vendor blocker → VENDOR_MATCH_REQUIRED (legacy path preserved)", () => {
    const d = mkDecision("NEEDS_JUDGMENT", ["VENDOR_UNRESOLVED"]);
    expect(mapPhase3ToLegacyDisplayState(d, mkAnalysis({
      supplierName: "Club Support Inc", invoiceNumber: "220824",
      total: 778.16, glAccountNumber: "6071",
    }))).toBe("VENDOR_MATCH_REQUIRED");
  });

  // The #220824 root defect: supplier NAME extracted (Club Support Inc), invoice
  // number extracted (220824), total extracted ($778.16), GL committed (6071
  // Subscriptions) — but the decision engine also fires a SUPPLIER_UNRESOLVED
  // blocker because the supplierConfidence dimension is < 55 (there is no
  // Spectre Vendor row to raise the composite). Pre-fix behaviour returned
  // MISSING_INFORMATION. Post-fix must return VENDOR_MATCH_REQUIRED because the
  // supplier IS identified from invoice text — the missing piece is the Vendor
  // record, not information.
  it("Defect-A root case: supplier extracted + GL committed + vendor missing + SUPPLIER_UNRESOLVED confidence blocker → VENDOR_MATCH_REQUIRED, NOT MISSING_INFORMATION", () => {
    const d = mkDecision("NEEDS_JUDGMENT", ["VENDOR_UNRESOLVED", "SUPPLIER_UNRESOLVED"]);
    const analysis = mkAnalysis({
      supplierName: "Club Support Inc",
      invoiceNumber: "220824",
      total: 778.16,
      glAccountNumber: "6071",
    });
    expect(mapPhase3ToLegacyDisplayState(d, analysis)).toBe("VENDOR_MATCH_REQUIRED");
  });

  it("Vendor missing + tax-unreconciled confidence blocker (not info absence) + supplier name + GL known → VENDOR_MATCH_REQUIRED", () => {
    const d = mkDecision("NEEDS_JUDGMENT", ["VENDOR_UNRESOLVED", "TAX_UNRECONCILED"]);
    const analysis = mkAnalysis({
      supplierName: "Club Support Inc", invoiceNumber: "220824",
      total: 778.16, glAccountNumber: "6071",
    });
    expect(mapPhase3ToLegacyDisplayState(d, analysis)).toBe("VENDOR_MATCH_REQUIRED");
  });

  it("Supplier NAME actually absent (extraction.vendor.guessedName is null) → MISSING_INFORMATION", () => {
    const d = mkDecision("NEEDS_JUDGMENT", ["SUPPLIER_UNRESOLVED", "VENDOR_UNRESOLVED"]);
    const analysis = mkAnalysis({
      supplierName: null, invoiceNumber: "220824",
      total: 778.16, glAccountNumber: "6071",
    });
    expect(mapPhase3ToLegacyDisplayState(d, analysis)).toBe("MISSING_INFORMATION");
  });

  it("Invoice number actually absent → MISSING_INFORMATION", () => {
    const d = mkDecision("NEEDS_JUDGMENT", ["PAYABLE_REFERENCE_MISSING", "VENDOR_UNRESOLVED"]);
    const analysis = mkAnalysis({
      supplierName: "Club Support Inc", invoiceNumber: null,
      total: 778.16, glAccountNumber: "6071",
    });
    expect(mapPhase3ToLegacyDisplayState(d, analysis)).toBe("MISSING_INFORMATION");
  });

  it("Gross total actually absent → MISSING_INFORMATION", () => {
    const d = mkDecision("NEEDS_JUDGMENT", ["GROSS_TOTAL_UNRESOLVED", "VENDOR_UNRESOLVED"]);
    const analysis = mkAnalysis({
      supplierName: "Club Support Inc", invoiceNumber: "220824",
      total: null, glAccountNumber: "6071",
    });
    expect(mapPhase3ToLegacyDisplayState(d, analysis)).toBe("MISSING_INFORMATION");
  });

  it("Extracted supplier NAME but supplier-confidence-only issue with no vendor blocker → NEEDS_JUDGMENT (not MISSING_INFORMATION)", () => {
    // Legacy path would have returned MISSING_INFORMATION here. Post-fix
    // returns NEEDS_JUDGMENT: value IS present, human must judge.
    const d = mkDecision("NEEDS_JUDGMENT", ["SUPPLIER_UNRESOLVED"]);
    const analysis = mkAnalysis({
      supplierName: "Club Support Inc", invoiceNumber: "220824",
      total: 778.16, glAccountNumber: "6071",
    });
    expect(mapPhase3ToLegacyDisplayState(d, analysis)).toBe("NEEDS_JUDGMENT");
  });

  it("GL absent + supplier + invoice # + total present → NEEDS_JUDGMENT (Review coding, not Request information)", () => {
    const d = mkDecision("NEEDS_JUDGMENT", ["GL_BELOW_THRESHOLD"]);
    const analysis = mkAnalysis({
      supplierName: "Some Supplier", invoiceNumber: "INV-1",
      total: 100, glAccountNumber: null,
    });
    expect(mapPhase3ToLegacyDisplayState(d, analysis)).toBe("NEEDS_JUDGMENT");
  });

  it("Duplicate risk always wins → POSSIBLE_DUPLICATE", () => {
    const d = mkDecision("NEEDS_JUDGMENT", ["DUPLICATE_INVOICE_RISK", "VENDOR_UNRESOLVED"]);
    expect(mapPhase3ToLegacyDisplayState(d, mkAnalysis({
      supplierName: "X", invoiceNumber: "Y", total: 1, glAccountNumber: "6071",
    }))).toBe("POSSIBLE_DUPLICATE");
  });

  it("Backwards compatibility — mapping works when analysis is undefined", () => {
    // The legacy call signature (no analysis argument) still works;
    // when analysis is absent, all "value present" checks are false so
    // any info-absence blocker → MISSING_INFORMATION (conservative default).
    const d = mkDecision("NEEDS_JUDGMENT", ["SUPPLIER_UNRESOLVED"]);
    expect(mapPhase3ToLegacyDisplayState(d)).toBe("MISSING_INFORMATION");
  });

  it("EXTRACTION_PENDING → ANALYSIS_PENDING (unchanged)", () => {
    expect(mapPhase3ToLegacyDisplayState(mkDecision("EXTRACTION_PENDING", []))).toBe("ANALYSIS_PENDING");
  });

  it("UNSUPPORTED → UNSUPPORTED (unchanged)", () => {
    expect(mapPhase3ToLegacyDisplayState(mkDecision("UNSUPPORTED", ["DOCUMENT_UNREADABLE"]))).toBe("UNSUPPORTED");
  });

  it("null decision → NEEDS_JUDGMENT (unchanged safe default)", () => {
    expect(mapPhase3ToLegacyDisplayState(null)).toBe("NEEDS_JUDGMENT");
  });
});
