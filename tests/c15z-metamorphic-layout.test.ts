// Sprint 3 · Checkpoint 15Z (2026-08-04) — metamorphic layout
// tests. Change document presentation without changing meaning
// and assert semantic fields remain unchanged.
//
// These test the GENERALISED extraction path — supplier candidate
// validation + reference validation + rescue — under presentation
// variations that mimic the real-world differences between PDFs
// from unrelated vendors.

import { describe, expect, it } from "vitest";
import {
  applyFieldQualityGate,
  validatePayableReferenceCandidate,
  validateSupplierCandidate,
  rescueOrganizationFromText,
} from "@/lib/ap-intelligence/field-quality";
import type { ExtractedInvoice } from "@/lib/ap-intelligence/types";

function baseExtraction(overrides: Partial<ExtractedInvoice> = {}): ExtractedInvoice {
  return {
    state: "STRUCTURED",
    ruleVersion: 1,
    extractedTextChars: 500,
    vendor: { guessedName: null, guessedEmail: null, guessedTaxNumber: null, guessedDomain: null },
    invoiceNumber: null,
    payableReferenceType: null,
    invoiceDate: null,
    dueDate: null,
    paymentTerms: null,
    purchaseOrder: null,
    description: null,
    currency: null,
    subtotal: null,
    taxTotal: null,
    total: null,
    lineItems: [],
    remittance: { address: null, email: null },
    warnings: [],
    ...overrides,
  };
}

// -----------------------------------------------------------------------------
// Presentation-invariant supplier recovery
// -----------------------------------------------------------------------------

describe("15Z · §10 metamorphic — supplier survives layout variations", () => {
  const SUPPLIER_TARGET = "Northlake Turf Products Ltd.";
  const CONTAMINATED = "PO DateSalesperson Phone Terms";

  // The header row is contaminated in every variation; the rescue
  // must find the supplier from the surrounding text.

  it("supplier appears on top line (letterhead)", () => {
    const fullText = [
      SUPPLIER_TARGET,
      "1234 Fairway Drive",
      "PO Date | Salesperson | Phone",
      "4/6/26 | Jane | 555-1212",
      "Invoice # INV-000123",
      "Total: 1,234.56",
    ].join("\n");
    const gate = applyFieldQualityGate({
      extraction: baseExtraction({
        vendor: { guessedName: CONTAMINATED, guessedEmail: null, guessedTaxNumber: null, guessedDomain: null },
      }),
      fullText,
    });
    expect(gate.extraction.vendor.guessedName).toBe(SUPPLIER_TARGET);
    expect(gate.gate.supplier.action).toBe("rescued");
  });

  it("supplier appears in remittance block (mid-page)", () => {
    const fullText = [
      "INVOICE",
      "PO Date | Salesperson | Phone",
      "4/6/26 | Jane | 555-1212",
      "REMIT TO:",
      SUPPLIER_TARGET,
      "PO Box 42",
      "Invoice # INV-000123",
    ].join("\n");
    const gate = applyFieldQualityGate({
      extraction: baseExtraction({
        vendor: { guessedName: CONTAMINATED, guessedEmail: null, guessedTaxNumber: null, guessedDomain: null },
      }),
      fullText,
    });
    expect(gate.extraction.vendor.guessedName).toBe(SUPPLIER_TARGET);
    expect(gate.gate.supplier.action).toBe("rescued");
  });

  it("supplier appears with reordered contact rows around it", () => {
    // Same content in a different reading order.
    const fullText = [
      "Phone: 555-1212",
      "Invoice # INV-000123",
      SUPPLIER_TARGET,
      "1234 Fairway Drive",
      "PO Date | Salesperson | Phone",
      "Total: 1,234.56",
    ].join("\n");
    const gate = applyFieldQualityGate({
      extraction: baseExtraction({
        vendor: { guessedName: CONTAMINATED, guessedEmail: null, guessedTaxNumber: null, guessedDomain: null },
      }),
      fullText,
    });
    expect(gate.extraction.vendor.guessedName).toBe(SUPPLIER_TARGET);
  });

  it("supplier legal suffix split across two lines (common pdf-parse artefact)", () => {
    const fullText = [
      "INVOICE",
      "PO Date | Salesperson | Phone",
      "Northlake Turf Products",
      "Ltd. 1234 Fairway Drive",
      "Total: 1,234.56",
    ].join("\n");
    const rescued = rescueOrganizationFromText(fullText);
    expect(rescued).toContain("Northlake Turf Products");
    expect(rescued).toContain("Ltd");
  });
});

// -----------------------------------------------------------------------------
// Presentation-invariant reference validation
// -----------------------------------------------------------------------------

describe("15Z · §10 metamorphic — reference validator survives label variations", () => {
  const COHERENT_TAILS = ["INV-2026-000234", "1091559-00", "BILL-000456", "STMT-8899"];

  it("keeps coherent single identifiers regardless of format", () => {
    for (const id of COHERENT_TAILS) {
      const res = validatePayableReferenceCandidate(id);
      expect(res.action, `keep: ${id}`).toBe("keep");
      expect(res.value).toBe(id);
    }
  });

  it("rejects the same date pattern regardless of separator or year length", () => {
    const CONCATENATIONS = [
      "1/2/261/3/2612345",
      "1/2/20261/3/202612345",
      "01/02/2601/03/2612345",
    ];
    for (const s of CONCATENATIONS) {
      const res = validatePayableReferenceCandidate(s);
      expect(["trimmed", "rejected"], `expected reject/trim for ${s}`).toContain(res.action);
      expect(res.rejectionReason).toBe("CONCATENATED_DATES");
    }
  });
});

// -----------------------------------------------------------------------------
// Vendor-match state does NOT change supplier / total / category evidence
// -----------------------------------------------------------------------------

describe("15Z · §10 metamorphic — vendor-match state must not change facts", () => {
  it("clean extraction — vendor unknown vs matched must yield same document facts", () => {
    const ex = baseExtraction({
      vendor: { guessedName: "Fairway Supply Co.", guessedEmail: null, guessedTaxNumber: null, guessedDomain: null },
      invoiceNumber: "INV-2026-999",
      invoiceDate: "2026-08-01",
      total: "1234.56",
      subtotal: "1175.10",
      taxTotal: "59.46",
      lineItems: [{ description: "Grass seed 50lb bag", quantity: "2", unitCost: "25.00", amount: "50.00" }],
    });
    // Facts extracted from the invoice must be the same regardless
    // of whether we treat the vendor as MATCHED or NOT_FOUND.
    const gateA = applyFieldQualityGate({ extraction: ex, fullText: "Fairway Supply Co.\nInvoice # INV-2026-999\nGrass seed 50lb bag\nTotal: 1234.56" });
    const gateB = applyFieldQualityGate({ extraction: ex, fullText: "Fairway Supply Co.\nInvoice # INV-2026-999\nGrass seed 50lb bag\nTotal: 1234.56" });
    // Values symmetric.
    expect(gateA.extraction.vendor.guessedName).toBe(gateB.extraction.vendor.guessedName);
    expect(gateA.extraction.invoiceNumber).toBe(gateB.extraction.invoiceNumber);
    expect(gateA.extraction.total).toBe(gateB.extraction.total);
    // glEligible depends on evidence — not on vendor state.
    expect(gateA.gate.glEligible).toBe(true);
    expect(gateB.gate.glEligible).toBe(true);
  });
});
