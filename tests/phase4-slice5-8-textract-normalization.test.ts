// Sprint 3 · Phase 4 Slice 5.8 (2026-08-09) — Textract line-item
// normalization tests.
//
// All test data is SYNTHETIC. Verifies the §1 first-cause correction:
// Textract lineItems with amount=0 but recoverable qty × unitPrice
// must NOT be silently dropped.

import { describe, it, expect } from "vitest";
import { normalizeTextractLineItemsToSlice5 } from "@/lib/ap-intelligence/ocr/textract-to-slice5-line-items";
import type { CanonicalDocumentExtraction } from "@/lib/ap-intelligence/document-extractors/canonical-model";

function extractionWith(lineItems: any[]): CanonicalDocumentExtraction {
  return {
    strategy: "AWS_TEXTRACT_EXPENSE",
    documentClass: "IMAGE_ONLY",
    pages: [{ page: 1, itemCount: lineItems.length }],
    fields: {},
    lineItems,
    confidence: 85,
    warnings: [],
  } as unknown as CanonicalDocumentExtraction;
}

function conf(value: any, providerConfidence = 100): any {
  return { value, providerConfidence, validationConfidence: providerConfidence, sourceStrategy: "AWS_TEXTRACT_EXPENSE" };
}

// -----------------------------------------------------------------------------
// §1 first-cause correction — computed extension
// -----------------------------------------------------------------------------

describe("§1 amount=0 but qty × unitPrice recoverable → computed extension", () => {
  it("computes extension from qty × unitPrice and cites arithmetic evidence", () => {
    const ex = extractionWith([{
      description: conf("100-5703\nSPACER AND BEARING ASM"),
      quantity: conf(5),
      unitPrice: conf(140.48),
      amount: conf(0),
      productCode: conf("100-5703", 35),
    }]);
    const items = normalizeTextractLineItemsToSlice5(ex);
    expect(items).toHaveLength(1);
    expect(items[0].extension).toBe(702.40);
    expect(items[0].arithmetic).toBe("ARITHMETIC_OK");
    expect(items[0].evidence.some((e) => e.kind === "arithmetic_qty_times_unit_equals_extension")).toBe(true);
    expect(items[0].sku).toBe("100-5703");
    expect(items[0].description).toContain("SPACER");
  });

  it("keeps the provider-reported amount when non-zero (no computation)", () => {
    const ex = extractionWith([{
      description: conf("Widget"),
      quantity: conf(2),
      unitPrice: conf(50),
      amount: conf(999.99),   // provider says $999.99 (overriding 2×50)
    }]);
    const items = normalizeTextractLineItemsToSlice5(ex);
    expect(items[0].extension).toBe(999.99);
    // The new "computed from provider amount=0" evidence must NOT be
    // present — provider gave us a valid amount. Existing
    // validateRowArithmetic evidence about mismatch may still appear.
    expect(items[0].evidence.some((e) => e.detail?.includes("computed extension="))).toBe(false);
  });
});

// -----------------------------------------------------------------------------
// §8 description-only rows preserved (extension=null → 0 with provenance)
// -----------------------------------------------------------------------------

describe("§8 description-only rows preserved for downstream identity", () => {
  it("preserves a row with description + productCode but no numeric fields", () => {
    const ex = extractionWith([{
      description: conf("SPACER AND BEARING ASM"),
      amount: conf(0),
      productCode: conf("100-5703"),
    }]);
    const items = normalizeTextractLineItemsToSlice5(ex);
    expect(items).toHaveLength(1);
    expect(items[0].description).toContain("SPACER");
    // extension is 0 (from null coalesce) but evidence records amount was unrecoverable
    expect(items[0].evidence.some((e) => e.detail?.includes("unrecoverable"))).toBe(true);
    expect(items[0].sku).toBe("100-5703");
  });
});

// -----------------------------------------------------------------------------
// Skip only genuinely-empty rows
// -----------------------------------------------------------------------------

describe("skip only rows with NO description + NO numeric signal", () => {
  it("drops fully empty rows", () => {
    const ex = extractionWith([{
      description: conf(""),
      amount: conf(0),
    }]);
    const items = normalizeTextractLineItemsToSlice5(ex);
    expect(items).toHaveLength(0);
  });
  it("keeps rows with any numeric signal", () => {
    const ex = extractionWith([{
      description: conf(""),
      quantity: conf(3),
      unitPrice: conf(25),
      amount: conf(0),
    }]);
    const items = normalizeTextractLineItemsToSlice5(ex);
    expect(items).toHaveLength(1);
    expect(items[0].extension).toBe(75);
  });
});
