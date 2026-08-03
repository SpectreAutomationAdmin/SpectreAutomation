// Sprint 3 · Checkpoint 15Y-Rejected (2026-08-03) — regression
// tests for structural-quality reclassification.
//
// Founder rule: text presence is not sufficient evidence of usable
// document structure. When the parsed RESULT shows degradation
// (rejected supplier / contaminated reference / total-without-lines),
// the doc is reclassified and the next strategy is recommended
// (POSITIONED_LAYOUT or AWS_TEXTRACT_EXPENSE).
//
// No invoice / supplier / filename specificity in fixtures.

import { describe, expect, it } from "vitest";
import { assessStructuralQuality } from "@/lib/ap-intelligence/structural-quality";
import type { ExtractedInvoice } from "@/lib/ap-intelligence/types";
import type { QualityGateResult } from "@/lib/ap-intelligence/field-quality";

// -----------------------------------------------------------------------------
// Fixtures
// -----------------------------------------------------------------------------

function baseExtraction(overrides: Partial<ExtractedInvoice> = {}): ExtractedInvoice {
  return {
    state: "STRUCTURED",
    ruleVersion: 1,
    extractedTextChars: 500,
    vendor: { guessedName: "Fairway Supply Co.", guessedEmail: null, guessedTaxNumber: null, guessedDomain: null },
    invoiceNumber: "INV-000123",
    payableReferenceType: "INVOICE_NUMBER",
    invoiceDate: "2026-01-01",
    dueDate: null,
    paymentTerms: null,
    purchaseOrder: null,
    description: null,
    currency: null,
    subtotal: "100.00",
    taxTotal: "5.00",
    total: "105.00",
    lineItems: [{ description: "Item", quantity: null, unitCost: null, amount: "105.00" }],
    remittance: { address: null, email: null },
    warnings: [],
    ...overrides,
  };
}

function cleanGate(): QualityGateResult {
  return {
    supplier: { action: "keep", value: "Fairway Supply Co.", labelDensity: 0 },
    reference: { action: "keep", value: "INV-000123" },
    glEligible: true,
    abstentionReasons: [],
  };
}

function rejectedSupplierGate(): QualityGateResult {
  return {
    supplier: { action: "rejected", value: null, rejectionReason: "LABEL_HEAVY", labelDensity: 0.75 },
    reference: { action: "keep", value: "INV-000123" },
    glEligible: false,
    abstentionReasons: ["supplier_LABEL_HEAVY"],
  };
}

function contaminatedRefGate(): QualityGateResult {
  return {
    supplier: { action: "keep", value: "Fairway Supply Co.", labelDensity: 0 },
    reference: { action: "trimmed", value: "1234-00", rejectionReason: "CONCATENATED_DATES", originalValue: "1/2/261/3/261234-00" },
    glEligible: true,
    abstentionReasons: [],
  };
}

// -----------------------------------------------------------------------------
// Provider-class precedence
// -----------------------------------------------------------------------------

describe("15Y-R · structural-quality provider-class precedence", () => {
  it("IMAGE_ONLY doc: preserves provider class; no re-escalation needed", () => {
    const res = assessStructuralQuality({
      documentClass: "IMAGE_ONLY",
      fieldQualityGate: cleanGate(),
      extraction: baseExtraction(),
      layoutItemCount: 0,
      layoutHasVisualLines: false,
      supplierWasRejected: false,
      referenceWasRejected: false,
      referenceWasContaminated: false,
    });
    expect(res.quality).toBe("IMAGE_ONLY");
    expect(res.shouldEscalate).toBe(false);
  });

  it("UNSUPPORTED doc: no escalation recommendation", () => {
    const res = assessStructuralQuality({
      documentClass: "UNSUPPORTED",
      fieldQualityGate: cleanGate(),
      extraction: baseExtraction(),
      layoutItemCount: 0,
      layoutHasVisualLines: false,
      supplierWasRejected: false,
      referenceWasRejected: false,
      referenceWasContaminated: false,
    });
    expect(res.quality).toBe("UNSUPPORTED");
    expect(res.recommendedEscalation).toBe("NONE");
  });
});

// -----------------------------------------------------------------------------
// TEXT_HEALTHY + degradation → reclassify + escalate
// -----------------------------------------------------------------------------

describe("15Y-R · TEXT_HEALTHY reclassification on parse-result degradation", () => {
  it("clean parse → STRUCTURED_TEXT, no escalation", () => {
    const res = assessStructuralQuality({
      documentClass: "TEXT_HEALTHY",
      fieldQualityGate: cleanGate(),
      extraction: baseExtraction(),
      layoutItemCount: 200,
      layoutHasVisualLines: true,
      supplierWasRejected: false,
      referenceWasRejected: false,
      referenceWasContaminated: false,
    });
    expect(res.quality).toBe("STRUCTURED_TEXT");
    expect(res.shouldEscalate).toBe(false);
    expect(res.recommendedEscalation).toBe("NONE");
  });

  it("supplier rejected → COLLAPSED_COLUMNS + escalate to POSITIONED_LAYOUT (has layout)", () => {
    const res = assessStructuralQuality({
      documentClass: "TEXT_HEALTHY",
      fieldQualityGate: rejectedSupplierGate(),
      extraction: baseExtraction({ vendor: { guessedName: null, guessedEmail: null, guessedTaxNumber: null, guessedDomain: null } }),
      layoutItemCount: 200,
      layoutHasVisualLines: true,
      supplierWasRejected: true,
      referenceWasRejected: false,
      referenceWasContaminated: false,
    });
    expect(res.quality).toBe("COLLAPSED_COLUMNS");
    expect(res.shouldEscalate).toBe(true);
    expect(res.recommendedEscalation).toBe("POSITIONED_LAYOUT");
  });

  it("supplier rejected + reference contaminated → COLLAPSED_COLUMNS + escalate to AWS_TEXTRACT_EXPENSE (2+ signals)", () => {
    const res = assessStructuralQuality({
      documentClass: "TEXT_HEALTHY",
      fieldQualityGate: rejectedSupplierGate(),
      extraction: baseExtraction({ vendor: { guessedName: null, guessedEmail: null, guessedTaxNumber: null, guessedDomain: null }, invoiceNumber: "1234-00", warnings: ["reference_trimmed:CONCATENATED_DATES"] }),
      layoutItemCount: 200,
      layoutHasVisualLines: true,
      supplierWasRejected: true,
      referenceWasRejected: false,
      referenceWasContaminated: true,
    });
    expect(res.quality).toBe("COLLAPSED_COLUMNS");
    expect(res.shouldEscalate).toBe(true);
    expect(res.recommendedEscalation).toBe("AWS_TEXTRACT_EXPENSE");
  });

  it("total present but zero line items → UNRECOVERED_TABLE + escalate", () => {
    const res = assessStructuralQuality({
      documentClass: "TEXT_HEALTHY",
      fieldQualityGate: cleanGate(),
      extraction: baseExtraction({ lineItems: [], total: "500.00" }),
      layoutItemCount: 100,
      layoutHasVisualLines: true,
      supplierWasRejected: false,
      referenceWasRejected: false,
      referenceWasContaminated: false,
    });
    expect(res.quality).toBe("UNRECOVERED_TABLE");
    expect(res.shouldEscalate).toBe(true);
  });

  it("no layout available + degradation → escalate directly to Textract", () => {
    const res = assessStructuralQuality({
      documentClass: "TEXT_HEALTHY",
      fieldQualityGate: rejectedSupplierGate(),
      extraction: baseExtraction({ vendor: { guessedName: null, guessedEmail: null, guessedTaxNumber: null, guessedDomain: null } }),
      layoutItemCount: 0,
      layoutHasVisualLines: false,
      supplierWasRejected: true,
      referenceWasRejected: false,
      referenceWasContaminated: false,
    });
    expect(res.recommendedEscalation).toBe("AWS_TEXTRACT_EXPENSE");
  });
});

// -----------------------------------------------------------------------------
// Contamination reasons are surfaced for diagnostics
// -----------------------------------------------------------------------------

describe("15Y-R · degradation reasons list is populated for diagnostics", () => {
  it("each detected signal appears in reasons", () => {
    const res = assessStructuralQuality({
      documentClass: "TEXT_HEALTHY",
      fieldQualityGate: {
        supplier: { action: "rejected", value: null, rejectionReason: "LABEL_HEAVY", labelDensity: 0.7 },
        reference: { action: "rejected", value: null, rejectionReason: "CONCATENATED_DATES", originalValue: "junk" },
        glEligible: false,
        abstentionReasons: [],
      },
      extraction: baseExtraction({ lineItems: [], total: "100.00" }),
      layoutItemCount: 100,
      layoutHasVisualLines: true,
      supplierWasRejected: true,
      referenceWasRejected: true,
      referenceWasContaminated: false,
    });
    expect(res.reasons).toContain("supplier_rejected_as_structural_nonsense");
    expect(res.reasons).toContain("reference_rejected_as_contaminated");
    expect(res.reasons).toContain("total_present_but_no_line_items");
    expect(res.degradationSignalCount).toBeGreaterThanOrEqual(3);
  });
});
