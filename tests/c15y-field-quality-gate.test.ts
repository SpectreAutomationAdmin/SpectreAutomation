// Sprint 3 · Checkpoint 15Y (2026-08-03) — regression tests for
// the field-quality validation and rescue layer.
//
// Founder §12 rule: NO acceptance-specific strings or identifiers
// appear in production logic. These tests use synthetic label-heavy
// and concatenated-identifier candidates that are structurally
// equivalent to the observed browser failures but do not name any
// real supplier / invoice / customer.

import { describe, expect, it } from "vitest";
import {
  applyFieldQualityGate,
  labelDensity,
  splitCrammedLabels,
  validatePayableReferenceCandidate,
  validateSupplierCandidate,
  rescueOrganizationFromText,
} from "@/lib/ap-intelligence/field-quality";
import type { ExtractedInvoice } from "@/lib/ap-intelligence/types";

// -----------------------------------------------------------------------------
// Supplier candidate validation
// -----------------------------------------------------------------------------

describe("15Y · supplier candidate validation", () => {
  it("rejects a crammed header-row supplier candidate", () => {
    // Structurally identical to the observed defect — but a SYNTHETIC
    // combination of field labels, not the specific string.
    const crammed = "PO DatePO #SalespersonSalesperson Phone";
    const res = validateSupplierCandidate(crammed, "");
    expect(res.action).toBe("rejected");
    expect(res.rejectionReason).toBe("LABEL_HEAVY");
    expect(res.labelDensity).toBeGreaterThan(0.5);
  });

  it("rejects a column-headings row as supplier", () => {
    const cols = "Quantity Description Unit Price Amount";
    const res = validateSupplierCandidate(cols, "");
    expect(res.action).toBe("rejected");
    expect(res.rejectionReason).toBe("LABEL_HEAVY");
  });

  it("rejects a metadata row containing multiple form labels", () => {
    const metadata = "Invoice # Date Due Terms Ship Via";
    const res = validateSupplierCandidate(metadata, "");
    expect(res.action).toBe("rejected");
  });

  it("keeps a real organization name with a legal suffix", () => {
    const res = validateSupplierCandidate("Northlake Turf Products Ltd.", "");
    expect(res.action).toBe("keep");
    expect(res.value).toBe("Northlake Turf Products Ltd.");
  });

  it("keeps an organization without a legal suffix that is not label-heavy", () => {
    const res = validateSupplierCandidate("Northlake Turf Products", "");
    expect(res.action).toBe("keep");
  });

  it("rescues a real supplier from the full text when the primary candidate is label-heavy", () => {
    const bad = "PO DateSalesperson Phone Terms";
    const fullText = [
      "Invoice # 12345",
      "PO Date | Salesperson | Phone",           // header row
      "4/6/26 | Jane Doe | 555-1212",             // values below
      "Northlake Turf Products Ltd.",             // supplier line
      "1234 Fairway Drive, Anywhere ST 55555",
      "Total: 1,234.56",
    ].join("\n");
    const res = validateSupplierCandidate(bad, fullText);
    expect(res.action).toBe("rescued");
    expect(res.value).toBe("Northlake Turf Products Ltd.");
    expect(res.rescueSource).toBe("text_scan_org_suffix");
  });

  it("returns null when no organization-suffix line exists in the full text", () => {
    const bad = "PO DateSalesperson Phone Terms";
    const fullText = "PO Date | Salesperson | Phone\n4/6/26 | Jane Doe | 555-1212\nTotal: 1,234.56";
    const res = validateSupplierCandidate(bad, fullText);
    expect(res.action).toBe("rejected");
    expect(res.value).toBeNull();
  });

  it("labelDensity computes deterministically across whitespace, punctuation, and case", () => {
    expect(labelDensity("PO DatePO #SalespersonSalesperson Phone")).toBeGreaterThan(0.5);
    expect(labelDensity("Northlake Turf Products Ltd.")).toBeLessThan(0.5);
  });

  it("splitCrammedLabels recovers boundary tokens from a crammed string", () => {
    const tokens = splitCrammedLabels("PO DatePO #SalespersonSalesperson Phone");
    expect(tokens).toContain("PO");
    expect(tokens).toContain("Date");
    expect(tokens).toContain("Salesperson");
    expect(tokens).toContain("Phone");
  });

  it("rescueOrganizationFromText scans past unrelated lines and finds the first defensible org", () => {
    const rescued = rescueOrganizationFromText([
      "PAGE 1 OF 1",
      "REMIT TO:",
      "Skyline Beverage Distribution Inc.",
      "PO Box 42",
    ].join("\n"));
    expect(rescued).toBe("Skyline Beverage Distribution Inc.");
  });

  it("rescueOrganizationFromText finds an org when the suffix was split onto the next line by the PDF extractor", () => {
    // flat-text PDF extractors frequently split "<company>\n<suffix>"
    // across a line break; the 2-line window rescues it.
    const rescued = rescueOrganizationFromText([
      "PAGE 1 OF 1",
      "Northlake Turf Products",
      "LP Phone: 555-1212",
      "PO Box 42",
    ].join("\n"));
    expect(rescued).toContain("Northlake Turf Products");
    expect(rescued).toContain("LP");
  });
});

// -----------------------------------------------------------------------------
// Payable-reference validation
// -----------------------------------------------------------------------------

describe("15Y · payable-reference validation", () => {
  it("rejects a candidate composed of multiple concatenated dates (invoice-shaped noise)", () => {
    const bad = "4/6/264/16/262381091559-00"; // structurally identical to observed defect
    const res = validatePayableReferenceCandidate(bad);
    // Either rejected outright OR trimmed to the trailing coherent segment.
    expect(["rejected", "trimmed"]).toContain(res.action);
    expect(res.rejectionReason).toBe("CONCATENATED_DATES");
    if (res.action === "trimmed") {
      // The rescued value must NOT contain the date fragments.
      expect(res.value).not.toMatch(/\d\/\d/);
    }
  });

  it("rejects a pure date as an invoice number", () => {
    const res = validatePayableReferenceCandidate("4/16/2026");
    expect(res.action).toBe("rejected");
    expect(res.rejectionReason).toBe("PURE_DATE");
  });

  it("keeps a coherent single invoice number", () => {
    const res = validatePayableReferenceCandidate("1087769-00");
    expect(res.action).toBe("keep");
    expect(res.value).toBe("1087769-00");
  });

  it("keeps an alphanumeric invoice number", () => {
    const res = validatePayableReferenceCandidate("INV-2026-000234");
    expect(res.action).toBe("keep");
  });

  it("rejects three or more long-digit runs (multiple identifiers glued)", () => {
    const res = validatePayableReferenceCandidate("12345-67890-11111-22222");
    expect(res.action).toBe("rejected");
    expect(res.rejectionReason).toBe("MULTIPLE_IDENTIFIERS_GLUED");
  });

  it("rejects null / empty", () => {
    expect(validatePayableReferenceCandidate(null).action).toBe("rejected");
    expect(validatePayableReferenceCandidate("   ").action).toBe("rejected");
  });
});

// -----------------------------------------------------------------------------
// Composed quality gate → force GL abstention
// -----------------------------------------------------------------------------

describe("15Y · applyFieldQualityGate (composed)", () => {
  function baseExtraction(overrides: Partial<ExtractedInvoice> = {}): ExtractedInvoice {
    return {
      state: "STRUCTURED",
      ruleVersion: 1,
      extractedTextChars: 200,
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

  it("contaminated supplier + contaminated reference → glEligible=false (supplier rejection alone is enough to gate GL)", () => {
    const gate = applyFieldQualityGate({
      extraction: baseExtraction({
        vendor: { guessedName: "PO DatePO #SalespersonSalesperson Phone", guessedEmail: null, guessedTaxNumber: null, guessedDomain: null },
        invoiceNumber: "4/6/264/16/262381091559-00",
      }),
      fullText: "PO Date | Salesperson | Phone\n4/6/26 | Jane\nTotal: 1,234.56",
    });
    // Supplier is rejected (no org-suffix in text to rescue from) → glEligible=false regardless of reference outcome.
    expect(gate.gate.glEligible).toBe(false);
    expect(gate.gate.abstentionReasons.length).toBeGreaterThan(0);
    expect(gate.gate.abstentionReasons.some((r) => r.startsWith("supplier_"))).toBe(true);
    expect(gate.extraction.vendor.guessedName).toBeNull();
    // Reference: either rejected outright OR trimmed to the trailing coherent segment.
    // The concatenated-dates prefix must not survive intact.
    expect(gate.extraction.invoiceNumber).not.toMatch(/\d\/\d/);
    if (gate.extraction.invoiceNumber !== null) {
      // A trimmed value MUST NOT be the original glued string.
      expect(gate.extraction.invoiceNumber.length).toBeLessThan("4/6/264/16/262381091559-00".length);
    }
  });

  it("clean supplier + clean reference → glEligible=true, values preserved", () => {
    const gate = applyFieldQualityGate({
      extraction: baseExtraction({
        vendor: { guessedName: "Fairway Supply Co.", guessedEmail: null, guessedTaxNumber: null, guessedDomain: null },
        invoiceNumber: "INV-000456",
      }),
      fullText: "Fairway Supply Co.\nInvoice # INV-000456\nTotal: 500.00",
    });
    expect(gate.gate.glEligible).toBe(true);
    expect(gate.extraction.vendor.guessedName).toBe("Fairway Supply Co.");
    expect(gate.extraction.invoiceNumber).toBe("INV-000456");
  });

  it("contaminated supplier BUT rescueable from fullText → glEligible=true, supplier rescued", () => {
    const gate = applyFieldQualityGate({
      extraction: baseExtraction({
        vendor: { guessedName: "PO DateSalesperson Phone Terms", guessedEmail: null, guessedTaxNumber: null, guessedDomain: null },
        invoiceNumber: "INV-000789",
      }),
      fullText: "PO Date | Salesperson | Phone\n4/6/26 | Jane\nFairway Supply Co.\nInvoice # INV-000789\nTotal: 500.00",
    });
    expect(gate.gate.glEligible).toBe(true);
    expect(gate.extraction.vendor.guessedName).toBe("Fairway Supply Co.");
    expect(gate.gate.supplier.action).toBe("rescued");
  });

  it("gate output contains warnings that trace the rejection reason (for diagnostics)", () => {
    const gate = applyFieldQualityGate({
      extraction: baseExtraction({
        vendor: { guessedName: "PO DateSalesperson Phone Terms", guessedEmail: null, guessedTaxNumber: null, guessedDomain: null },
        invoiceNumber: "4/6/264/16/2612345",
      }),
      fullText: "no org suffix here",
    });
    const warningStr = gate.extraction.warnings.join(" ");
    expect(warningStr).toMatch(/supplier_/);
    expect(warningStr).toMatch(/reference_/);
  });

  it("no acceptance-specific string constants appear in production code", async () => {
    // Guardrail: the field-quality module must not name the observed
    // failure fragments literally. Load its source and grep.
    const src = await (await import("node:fs")).promises.readFile(
      new URL("../src/lib/ap-intelligence/field-quality/index.ts", import.meta.url),
      "utf8",
    );
    expect(src).not.toContain("Oakcreek");
    expect(src).not.toContain("1091559");
    expect(src).not.toContain("1087769");
    expect(src).not.toContain("PO DatePO #Salesperson");
  });
});
