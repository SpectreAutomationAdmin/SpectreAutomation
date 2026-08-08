// Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — OCR-as-first-class
// evidence provider — architecture regression tests.
//
// All test data is SYNTHETIC. Ground-truth per-supplier assertions
// live in the acceptance suite; this file tests the ARCHITECTURE.

import { describe, it, expect } from "vitest";
import {
  evaluateOcrTriggers,
  OCR_TRIGGER_ENABLED,
} from "@/lib/ap-intelligence/ocr/ocr-trigger-reasons";
import {
  fuseNativeAndOcrLineItems,
} from "@/lib/ap-intelligence/ocr/native-ocr-fusion";
import {
  normalizeTextractLineItemsToSlice5,
} from "@/lib/ap-intelligence/ocr/textract-to-slice5-line-items";
import {
  extractVisualBrandingEvidence,
} from "@/lib/ap-intelligence/ocr/visual-branding-extractor";
import {
  ocrIdempotencyKey,
} from "@/lib/ap-intelligence/ocr/persistence";
import {
  resolveDailyTargetedOcrCap,
  TARGETED_OCR_TRIGGERS,
} from "@/lib/ap-intelligence/ocr/config";
import {
  apInvoiceReanalyseIdempotencyKey,
} from "@/lib/ap-intelligence/reanalyse-worker";
import type { CanonicalLineItem } from "@/lib/ap-intelligence/evidence/canonical-line-item";
import type { PdfLayout, LayoutTextItem, PdfPageDescriptor } from "@/lib/ap-intelligence/pdf-layout-extract";
import type { CanonicalDocumentExtraction } from "@/lib/ap-intelligence/document-extractors/canonical-model";
import type { LineItemRegion } from "@/lib/ap-intelligence/line-item-region-strategies";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

function nativeLi(over: Partial<CanonicalLineItem>): CanonicalLineItem {
  return {
    description: "widget",
    extension: 100,
    role: "PRIMARY_PURCHASE",
    page: 1,
    sourceStrategy: "POSITIONED_CLASSIC_TABLE",
    validationConfidence: 78,
    arithmetic: "UNVALIDATED",
    evidence: [],
    ...over,
  };
}

function ocrLi(over: Partial<CanonicalLineItem>): CanonicalLineItem {
  return {
    description: "widget",
    extension: 100,
    role: "PRIMARY_PURCHASE",
    page: 1,
    sourceStrategy: "TEXTRACT_LINE_ITEM",
    providerConfidence: 90,
    validationConfidence: 65,
    arithmetic: "UNVALIDATED",
    evidence: [],
    ...over,
  };
}

// -----------------------------------------------------------------------------
// §7 idempotency key — page-aware
// -----------------------------------------------------------------------------
describe("Slice 5.1 · persistence key includes pageNumber", () => {
  it("differentiates keys by pageNumber", () => {
    const a = ocrIdempotencyKey({ clubId: "c1", documentSha256: "s", provider: "p", extractionVersion: 1, pageNumber: 1 });
    const b = ocrIdempotencyKey({ clubId: "c1", documentSha256: "s", provider: "p", extractionVersion: 1, pageNumber: 2 });
    const c = ocrIdempotencyKey({ clubId: "c1", documentSha256: "s", provider: "p", extractionVersion: 1 });
    expect(a).not.toBe(b);
    expect(c).toContain(":p0");
    expect(a).toContain(":p1");
  });
});

// -----------------------------------------------------------------------------
// §2 trigger reasons — enum + evaluator
// -----------------------------------------------------------------------------
describe("Slice 5.1 · OCR triggers are machine-readable + extensible", () => {
  it("all documented trigger keys have an enabled flag", () => {
    for (const key of Object.keys(OCR_TRIGGER_ENABLED)) {
      expect(typeof OCR_TRIGGER_ENABLED[key as keyof typeof OCR_TRIGGER_ENABLED]).toBe("boolean");
    }
  });
  it("PAGE_IMAGE_ONLY fires when page has 0 positioned items", () => {
    const pd: PdfPageDescriptor = { page: 1, pageWidth: 612, pageHeight: 792, itemCount: 0, distinctYBandCount: 0, pageClass: "IMAGE_ONLY" };
    const decision = evaluateOcrTriggers({
      layout: { pageCount: 1, items: [], visualLines: [], flattenedText: "" },
      pageDescriptor: pd,
      regionsOnPage: [],
      nativeItemsOnPage: [],
    });
    expect(decision.triggered).toContain("PAGE_IMAGE_ONLY");
    expect(decision.shouldOcr).toBe(true);
  });
  it("CLASSIC_TABLE_FUSED_ROW fires when classic region + zero native rows + fused item spans columns", () => {
    const items: LayoutTextItem[] = [
      { text: "fused row spans two columns", page: 1, x: 50, y: 150, width: 400, height: 12 },
    ];
    const layout: PdfLayout = { pageCount: 1, items, visualLines: [], flattenedText: "" };
    const region: LineItemRegion = {
      kind: "CLASSIC_COLUMN_TABLE", page: 1, yTop: 100, yBottom: 300,
      confidence: 80, diagnostic: "test", payload: {
        columns: [
          { role: "description", xCenter: 100 },
          { role: "amount", xCenter: 400 },
        ],
      },
    };
    const pd: PdfPageDescriptor = { page: 1, pageWidth: 612, pageHeight: 792, itemCount: 1, distinctYBandCount: 1, pageClass: "DIGITAL_TEXT" };
    const decision = evaluateOcrTriggers({ layout, pageDescriptor: pd, regionsOnPage: [region], nativeItemsOnPage: [] });
    expect(decision.triggered).toContain("CLASSIC_TABLE_FUSED_ROW");
  });
  it("does NOT fire fused-row when native rows exist", () => {
    const items: LayoutTextItem[] = [
      { text: "fused", page: 1, x: 50, y: 150, width: 400, height: 12 },
    ];
    const layout: PdfLayout = { pageCount: 1, items, visualLines: [], flattenedText: "" };
    const region: LineItemRegion = {
      kind: "CLASSIC_COLUMN_TABLE", page: 1, yTop: 100, yBottom: 300,
      confidence: 80, diagnostic: "test", payload: {
        columns: [{ role: "description", xCenter: 100 }, { role: "amount", xCenter: 400 }],
      },
    };
    const pd: PdfPageDescriptor = { page: 1, pageWidth: 612, pageHeight: 792, itemCount: 1, distinctYBandCount: 1, pageClass: "DIGITAL_TEXT" };
    const decision = evaluateOcrTriggers({
      layout, pageDescriptor: pd, regionsOnPage: [region],
      nativeItemsOnPage: [nativeLi({})],
    });
    expect(decision.triggered).not.toContain("CLASSIC_TABLE_FUSED_ROW");
  });
});

// -----------------------------------------------------------------------------
// §12 + §13 fusion
// -----------------------------------------------------------------------------
describe("Slice 5.1 · fuseNativeAndOcrLineItems", () => {
  it("merges matching native + OCR rows preserving both evidence chains", () => {
    const n = nativeLi({ description: "Diesel fuel", extension: 2344.30 });
    const o = ocrLi({ description: "Diesel LS Dyed 1700 L", extension: 2344.30, quantity: 1700, unitPrice: 1.379, arithmetic: "ARITHMETIC_OK" });
    const res = fuseNativeAndOcrLineItems([n], [o]);
    expect(res.diagnostic.mergedCount).toBe(1);
    expect(res.items).toHaveLength(1);
    const li = res.items[0];
    expect(li.description).toContain("Diesel LS Dyed"); // OCR desc preferred (longer)
    // Both evidence chains retained.
    const hasNative = li.evidence.some((e) => e.kind === "textract_expense_line" && (e.detail ?? "").includes("fused"));
    expect(hasNative).toBe(true);
  });
  it("admits strong unmatched OCR rows WITHOUT requiring arithmetic (amendment #3)", () => {
    const n = nativeLi({ description: "unrelated", extension: 500 });
    const o = ocrLi({ description: "New item OCR only", extension: 99, providerConfidence: 88, arithmetic: "ARITHMETIC_INSUFFICIENT_DATA" });
    const res = fuseNativeAndOcrLineItems([n], [o]);
    expect(res.diagnostic.ocrOnlyAdmittedCount).toBe(1);
    expect(res.items).toContainEqual(expect.objectContaining({ description: "New item OCR only" }));
  });
  it("REJECTS unmatched OCR rows with weak provider evidence", () => {
    const o = ocrLi({ description: "Weak", extension: 5, providerConfidence: 30 });
    const res = fuseNativeAndOcrLineItems([], [o]);
    expect(res.diagnostic.ocrOnlyRejectedCount).toBe(1);
    expect(res.items).toHaveLength(0);
  });
  it("preserves native-only rows when no OCR row matches", () => {
    const n = nativeLi({ description: "native item", extension: 42 });
    const res = fuseNativeAndOcrLineItems([n], []);
    expect(res.diagnostic.nativeOnlyCount).toBe(1);
    expect(res.items[0].description).toBe("native item");
  });
  it("arithmetic OK on either side boosts merged confidence", () => {
    const n = nativeLi({ description: "row A", extension: 100, validationConfidence: 60, arithmetic: "ARITHMETIC_INSUFFICIENT_DATA" });
    const o = ocrLi({ description: "row A", extension: 100, validationConfidence: 60, arithmetic: "ARITHMETIC_OK" });
    const res = fuseNativeAndOcrLineItems([n], [o]);
    expect(res.items[0].validationConfidence).toBeGreaterThan(60);
    expect(res.items[0].arithmetic).toBe("ARITHMETIC_OK");
  });
});

// -----------------------------------------------------------------------------
// §12 Textract normalization
// -----------------------------------------------------------------------------
describe("Slice 5.1 · normalizeTextractLineItemsToSlice5", () => {
  it("converts Textract CanonicalLineItem into Slice-5 shape with TEXTRACT_LINE_ITEM strategy", () => {
    const extraction: CanonicalDocumentExtraction = {
      strategy: "AWS_TEXTRACT_EXPENSE",
      documentClass: "TEXT_HEALTHY",
      pages: [{ pageNumber: 1 }],
      fields: {},
      lineItems: [{
        description: { value: "Widget", providerConfidence: 90, validationConfidence: 85, sourceStrategy: "AWS_TEXTRACT_EXPENSE" },
        amount: { value: 50, providerConfidence: 90, validationConfidence: 85, sourceStrategy: "AWS_TEXTRACT_EXPENSE" },
        quantity: { value: 2, providerConfidence: 88, validationConfidence: 80, sourceStrategy: "AWS_TEXTRACT_EXPENSE" },
        unitPrice: { value: 25, providerConfidence: 88, validationConfidence: 80, sourceStrategy: "AWS_TEXTRACT_EXPENSE" },
      }],
      confidence: 88,
      warnings: [],
    };
    const items = normalizeTextractLineItemsToSlice5(extraction, { sourcePageNumber: 3 });
    expect(items).toHaveLength(1);
    expect(items[0].sourceStrategy).toBe("TEXTRACT_LINE_ITEM");
    expect(items[0].page).toBe(3);
    expect(items[0].arithmetic).toBe("ARITHMETIC_OK");
    expect(items[0].role).toBe("PRIMARY_PURCHASE");
  });
});

// -----------------------------------------------------------------------------
// §14 + §15 visual-branding extractor
// -----------------------------------------------------------------------------
describe("Slice 5.1 · extractVisualBrandingEvidence", () => {
  it("emits VISUAL_LOGO evidence from top-of-page supplier-name region", () => {
    const extraction: CanonicalDocumentExtraction = {
      strategy: "AWS_TEXTRACT_EXPENSE",
      documentClass: "TEXT_HEALTHY",
      pages: [{ pageNumber: 1, width: 612, height: 792 }],
      fields: {
        supplierName: {
          value: "ACME ENERGY INC",
          providerConfidence: 92, validationConfidence: 85,
          sourceStrategy: "AWS_TEXTRACT_EXPENSE",
          region: { page: 1, x: 40, y: 20, width: 200, height: 24 }, // top of page in top-left convention
        },
      },
      lineItems: [],
      confidence: 90,
      warnings: [],
    };
    const evidence = extractVisualBrandingEvidence(extraction);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].type).toBe("VISUAL_LOGO");
    expect(evidence[0].value).toBe("ACME ENERGY INC");
    expect(evidence[0].confidence).toBeLessThanOrEqual(75);
    expect(evidence[0].sourceStrategy).toBe("AWS_TEXTRACT_EXPENSE");
  });
  it("REJECTS document-form labels via frozen supplier-candidate veto", () => {
    const extraction: CanonicalDocumentExtraction = {
      strategy: "AWS_TEXTRACT_EXPENSE",
      documentClass: "TEXT_HEALTHY",
      pages: [{ pageNumber: 1, width: 612, height: 792 }],
      fields: {
        supplierName: {
          value: "Taxes/Fees",
          providerConfidence: 80, validationConfidence: 70,
          sourceStrategy: "AWS_TEXTRACT_EXPENSE",
          region: { page: 1, x: 40, y: 20, width: 100, height: 20 },
        },
      },
      lineItems: [],
      confidence: 80,
      warnings: [],
    };
    const evidence = extractVisualBrandingEvidence(extraction);
    expect(evidence).toHaveLength(0);
  });
  it("does NOT emit branding for supplier-name in the bottom of page", () => {
    const extraction: CanonicalDocumentExtraction = {
      strategy: "AWS_TEXTRACT_EXPENSE",
      documentClass: "TEXT_HEALTHY",
      pages: [{ pageNumber: 1, width: 612, height: 792 }],
      fields: {
        supplierName: {
          value: "Bottom Line Co",
          providerConfidence: 90, validationConfidence: 85,
          sourceStrategy: "AWS_TEXTRACT_EXPENSE",
          region: { page: 1, x: 40, y: 700, width: 100, height: 20 }, // near bottom in top-left convention
        },
      },
      lineItems: [],
      confidence: 88,
      warnings: [],
    };
    const evidence = extractVisualBrandingEvidence(extraction);
    expect(evidence).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// §7 async re-analyse idempotency
// -----------------------------------------------------------------------------
describe("Slice 5.1 · AP_INVOICE_REANALYSE idempotency key", () => {
  it("collapses multiple OCR completions for same doc into one enqueue", () => {
    const k1 = apInvoiceReanalyseIdempotencyKey({ clubId: "c1", ingestedDocumentId: "doc1" });
    const k2 = apInvoiceReanalyseIdempotencyKey({ clubId: "c1", ingestedDocumentId: "doc1" });
    expect(k1).toBe(k2);
  });
});

// -----------------------------------------------------------------------------
// §18 cost ceiling
// -----------------------------------------------------------------------------
describe("Slice 5.1 · configurable daily targeted-OCR cap", () => {
  it("returns null when SPECTRE_OCR_TARGETED_DAILY_CAP_PER_CLUB is unset", () => {
    const prev = process.env.SPECTRE_OCR_TARGETED_DAILY_CAP_PER_CLUB;
    delete process.env.SPECTRE_OCR_TARGETED_DAILY_CAP_PER_CLUB;
    expect(resolveDailyTargetedOcrCap()).toBeNull();
    if (prev != null) process.env.SPECTRE_OCR_TARGETED_DAILY_CAP_PER_CLUB = prev;
  });
  it("parses positive integer env value", () => {
    process.env.SPECTRE_OCR_TARGETED_DAILY_CAP_PER_CLUB = "50";
    expect(resolveDailyTargetedOcrCap()).toBe(50);
    delete process.env.SPECTRE_OCR_TARGETED_DAILY_CAP_PER_CLUB;
  });
  it("IMAGE_ONLY is NOT a targeted trigger (doesn't consume cap)", () => {
    expect(TARGETED_OCR_TRIGGERS.has("PAGE_IMAGE_ONLY")).toBe(false);
    expect(TARGETED_OCR_TRIGGERS.has("CLASSIC_TABLE_FUSED_ROW")).toBe(true);
  });
});
