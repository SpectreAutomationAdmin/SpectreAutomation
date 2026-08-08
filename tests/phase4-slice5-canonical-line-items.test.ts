// Sprint 3 · Phase 4 Slice 5 (2026-08-07) — canonical line-item
// authority + region strategies + arithmetic + role classifier +
// purpose taxonomy.
//
// All test data is SYNTHETIC. No real invoice content. Ground-truth
// assertions test the ARCHITECTURE, not a specific vendor.

import { describe, it, expect } from "vitest";
import {
  classifyLineItemRole,
  validateRowArithmetic,
  reconcileCanonicalLineItems,
  type CanonicalLineItem,
} from "@/lib/ap-intelligence/evidence/canonical-line-item";
import { extractCanonicalLineItems } from "@/lib/ap-intelligence/canonical-line-item-extractor";
import {
  detectClassicColumnTableRegions,
  detectCategoryBlockRegions,
  reconstructClassicColumnTable,
  reconstructCategoryBlock,
  resolveRegions,
} from "@/lib/ap-intelligence/line-item-region-strategies";
import {
  DeterministicTaxonomyProvider,
} from "@/lib/ap-intelligence/economic-purpose-taxonomy";
import type { PdfLayout, LayoutTextItem } from "@/lib/ap-intelligence/pdf-layout-extract";

// -----------------------------------------------------------------------------
// Helper: build a synthetic PdfLayout (top-left y convention).
// -----------------------------------------------------------------------------
function makeItem(text: string, page: number, x: number, y: number, w: number = text.length * 6, h: number = 10): LayoutTextItem {
  return { text, page, x, y, width: w, height: h };
}
function makeLayout(items: LayoutTextItem[], pageCount: number = 1): PdfLayout {
  // Cluster into visualLines by y-band (same tolerance as extractor).
  const bands = new Map<string, LayoutTextItem[]>();
  for (const it of items) {
    const key = `${it.page}|${Math.round(it.y / 4) * 4}`;
    const arr = bands.get(key) ?? [];
    arr.push(it);
    bands.set(key, arr);
  }
  const visualLines = [...bands.values()]
    .map((arr) => {
      arr.sort((a, b) => a.x - b.x);
      return {
        page: arr[0].page,
        y: arr[0].y,
        text: arr.map((i) => i.text).join(" "),
        items: arr,
      };
    })
    .sort((a, b) => (a.page - b.page) || (a.y - b.y));
  return {
    pageCount,
    items,
    visualLines,
    flattenedText: visualLines.map((vl) => vl.text).join("\n"),
  };
}

// -----------------------------------------------------------------------------
// classifyLineItemRole
// -----------------------------------------------------------------------------
describe("Slice 5 · classifyLineItemRole", () => {
  it("classifies negative amount as CREDIT", () => {
    expect(classifyLineItemRole("Any description", -10).role).toBe("CREDIT");
  });
  it("classifies 'credit' keyword as CREDIT even on positive amount", () => {
    expect(classifyLineItemRole("Loyalty credit adjustment", 5).role).toBe("CREDIT");
  });
  it("classifies GST / HST keyword as TAX", () => {
    expect(classifyLineItemRole("GST / HST", 12).role).toBe("TAX");
    expect(classifyLineItemRole("Value-added tax", 3).role).toBe("TAX");
  });
  it("classifies dotted acronyms G.S.T. / H.S.T. as TAX (Slice 5 fix)", () => {
    expect(classifyLineItemRole("G.S.T./H.S.T.", 3706).role).toBe("TAX");
    expect(classifyLineItemRole("P.S.T.", 100).role).toBe("TAX");
  });
  it("classifies penalty / late-fee as PENALTY", () => {
    expect(classifyLineItemRole("Late payment penalty", 25).role).toBe("PENALTY");
  });
  it("classifies interest / finance charge as INTEREST", () => {
    expect(classifyLineItemRole("Finance charge", 4).role).toBe("INTEREST");
  });
  it("classifies freight / delivery as FREIGHT", () => {
    expect(classifyLineItemRole("Delivery charge", 15).role).toBe("FREIGHT");
    expect(classifyLineItemRole("Shipping", 8).role).toBe("FREIGHT");
  });
  it("classifies environmental / surcharge as SURCHARGE", () => {
    expect(classifyLineItemRole("Environmental fee", 3).role).toBe("SURCHARGE");
    expect(classifyLineItemRole("Fuel surcharge", 12).role).toBe("SURCHARGE");
    expect(classifyLineItemRole("Tire levy", 2).role).toBe("SURCHARGE");
  });
  it("classifies plain product description as PRIMARY_PURCHASE", () => {
    expect(classifyLineItemRole("Widget assembly", 50).role).toBe("PRIMARY_PURCHASE");
  });
  it("honours categoryHint from a category-block", () => {
    expect(classifyLineItemRole("anything", 10, { categoryHint: "SURCHARGE" }).role).toBe("SURCHARGE");
  });
});

// -----------------------------------------------------------------------------
// validateRowArithmetic
// -----------------------------------------------------------------------------
describe("Slice 5 · validateRowArithmetic", () => {
  const base = (over: Partial<CanonicalLineItem>): CanonicalLineItem => ({
    description: "x", extension: 0, role: "PRIMARY_PURCHASE", page: 1,
    sourceStrategy: "POSITIONED_CLASSIC_TABLE", validationConfidence: 50,
    arithmetic: "UNVALIDATED", evidence: [], ...over,
  });
  it("returns ARITHMETIC_OK when qty × unit matches extension", () => {
    const li = base({ quantity: 4, unitPrice: 25, extension: 100 });
    expect(validateRowArithmetic(li).arithmetic).toBe("ARITHMETIC_OK");
  });
  it("returns ARITHMETIC_OK within 2-cent tolerance", () => {
    const li = base({ quantity: 3, unitPrice: 1.379, extension: 4.14 });
    expect(validateRowArithmetic(li).arithmetic).toBe("ARITHMETIC_OK");
  });
  it("returns ARITHMETIC_MISMATCH when values disagree", () => {
    const li = base({ quantity: 2, unitPrice: 10, extension: 25 });
    expect(validateRowArithmetic(li).arithmetic).toBe("ARITHMETIC_MISMATCH");
  });
  it("returns INSUFFICIENT_DATA when qty or unitPrice is missing", () => {
    expect(validateRowArithmetic(base({ extension: 50 })).arithmetic)
      .toBe("ARITHMETIC_INSUFFICIENT_DATA");
    expect(validateRowArithmetic(base({ quantity: 2, extension: 50 })).arithmetic)
      .toBe("ARITHMETIC_INSUFFICIENT_DATA");
  });
});

// -----------------------------------------------------------------------------
// reconcileCanonicalLineItems
// -----------------------------------------------------------------------------
describe("Slice 5 · reconcileCanonicalLineItems", () => {
  it("MATCHES_CLAIMED when primary sums equal subtotal + tax", () => {
    const items: CanonicalLineItem[] = [
      { description: "A", extension: 100, role: "PRIMARY_PURCHASE", page: 1, sourceStrategy: "POSITIONED_CLASSIC_TABLE", validationConfidence: 80, arithmetic: "ARITHMETIC_OK", evidence: [] },
      { description: "B", extension: 50, role: "PRIMARY_PURCHASE", page: 1, sourceStrategy: "POSITIONED_CLASSIC_TABLE", validationConfidence: 80, arithmetic: "ARITHMETIC_OK", evidence: [] },
    ];
    const r = reconcileCanonicalLineItems(items, { subtotal: 150, tax: 7.5, total: 157.5 });
    expect(r.status).toBe("MATCHES_CLAIMED");
    expect(r.primarySum).toBe(150);
  });
  it("subtracts credits from reconciled subtotal", () => {
    const items: CanonicalLineItem[] = [
      { description: "A", extension: 100, role: "PRIMARY_PURCHASE", page: 1, sourceStrategy: "POSITIONED_CLASSIC_TABLE", validationConfidence: 80, arithmetic: "ARITHMETIC_OK", evidence: [] },
      { description: "Credit", extension: -20, role: "CREDIT", page: 1, sourceStrategy: "POSITIONED_CLASSIC_TABLE", validationConfidence: 80, arithmetic: "ARITHMETIC_OK", evidence: [] },
    ];
    const r = reconcileCanonicalLineItems(items, { subtotal: 80, tax: 4, total: 84 });
    expect(r.status).toBe("MATCHES_CLAIMED");
    expect(r.creditSum).toBe(20);
    expect(r.reconciledSubtotal).toBe(80);
  });
  it("returns NO_LINE_ITEMS on empty", () => {
    const r = reconcileCanonicalLineItems([], { subtotal: 100, tax: 5, total: 105 });
    expect(r.status).toBe("NO_LINE_ITEMS");
  });
  it("returns MISMATCH when totals diverge beyond tolerance", () => {
    const items: CanonicalLineItem[] = [
      { description: "A", extension: 100, role: "PRIMARY_PURCHASE", page: 1, sourceStrategy: "POSITIONED_CLASSIC_TABLE", validationConfidence: 80, arithmetic: "ARITHMETIC_OK", evidence: [] },
    ];
    const r = reconcileCanonicalLineItems(items, { subtotal: 200, tax: 10, total: 210 });
    expect(r.status).toBe("MISMATCH");
  });
});

// -----------------------------------------------------------------------------
// CLASSIC_COLUMN_TABLE region detection + reconstruction
// -----------------------------------------------------------------------------
describe("Slice 5 · CLASSIC_COLUMN_TABLE strategy", () => {
  it("detects a header row + reconstructs one product row (top-left y)", () => {
    // Simulate a classic column table where header is at y=100 (near
    // top) and product row at y=140 (below).
    const items: LayoutTextItem[] = [
      makeItem("Description", 1, 50, 100, 60), makeItem("Qty", 1, 200, 100, 30),
      makeItem("Price", 1, 260, 100, 40), makeItem("Amount", 1, 340, 100, 50),
      makeItem("Widget", 1, 50, 140, 60), makeItem("4", 1, 200, 140, 10),
      makeItem("25.00", 1, 260, 140, 40), makeItem("100.00", 1, 340, 140, 40),
    ];
    const layout = makeLayout(items);
    const regions = detectClassicColumnTableRegions(layout);
    expect(regions.length).toBe(1);
    expect(regions[0].kind).toBe("CLASSIC_COLUMN_TABLE");
    const rows = reconstructClassicColumnTable(regions[0], layout);
    expect(rows.length).toBe(1);
    expect(rows[0].description).toContain("Widget");
    expect(rows[0].extension).toBe(100);
    expect(rows[0].role).toBe("PRIMARY_PURCHASE");
  });
  it("does NOT emit rows ABOVE the header (verifies y-inversion fix)", () => {
    // Under bottom-up y the old reconstructor picked up letterhead
    // (rows PHYSICALLY above the header). With top-left y + strictly-
    // below filter, letterhead rows never enter the region.
    const items: LayoutTextItem[] = [
      makeItem("ACME CO", 1, 50, 40, 80),
      makeItem("123 Main St", 1, 50, 60, 100),
      makeItem("Description", 1, 50, 100, 60), makeItem("Qty", 1, 200, 100, 30),
      makeItem("Price", 1, 260, 100, 40), makeItem("Amount", 1, 340, 100, 50),
      makeItem("Widget", 1, 50, 140, 60), makeItem("1", 1, 200, 140, 10),
      makeItem("50.00", 1, 260, 140, 40), makeItem("50.00", 1, 340, 140, 40),
    ];
    const layout = makeLayout(items);
    const regions = detectClassicColumnTableRegions(layout);
    const rows = reconstructClassicColumnTable(regions[0], layout);
    for (const r of rows) {
      expect(r.description.toLowerCase()).not.toContain("acme");
      expect(r.description.toLowerCase()).not.toContain("main st");
    }
  });
  it("stops at a summary row (Subtotal / Total / Tax)", () => {
    const items: LayoutTextItem[] = [
      makeItem("Description", 1, 50, 100, 60), makeItem("Amount", 1, 340, 100, 50),
      makeItem("Item A", 1, 50, 140, 40), makeItem("10.00", 1, 340, 140, 40),
      makeItem("Item B", 1, 50, 160, 40), makeItem("20.00", 1, 340, 160, 40),
      makeItem("Subtotal", 1, 50, 200, 60), makeItem("30.00", 1, 340, 200, 40),
      makeItem("Item C after subtotal", 1, 50, 220, 100), makeItem("99.99", 1, 340, 220, 40),
    ];
    const layout = makeLayout(items);
    const regions = detectClassicColumnTableRegions(layout);
    const rows = reconstructClassicColumnTable(regions[0], layout);
    for (const r of rows) {
      expect(r.description.toLowerCase()).not.toContain("after subtotal");
    }
  });
});

// -----------------------------------------------------------------------------
// CATEGORY_BLOCK_STATEMENT region detection + reconstruction
// -----------------------------------------------------------------------------
describe("Slice 5 · CATEGORY_BLOCK_STATEMENT strategy", () => {
  it("detects an 'Ongoing charges' category + reconstructs a service row", () => {
    const items: LayoutTextItem[] = [
      makeItem("Ongoing charges", 1, 50, 100, 100),
      makeItem("Internet: 100 Mbps  CA$45.00", 1, 50, 130, 200),
    ];
    const layout = makeLayout(items);
    const regions = detectCategoryBlockRegions(layout);
    const ongoing = regions.find((r) => (r.payload as { categoryLabel: string }).categoryLabel === "Ongoing charges");
    expect(ongoing).toBeTruthy();
    const rows = reconstructCategoryBlock(ongoing!, layout);
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].role).toBe("PRIMARY_PURCHASE");
    expect(rows[0].extension).toBeGreaterThan(0);
  });
  it("classifies 'Credits' category rows as CREDIT with negative sign", () => {
    const items: LayoutTextItem[] = [
      makeItem("Credits", 1, 50, 100, 60),
      makeItem("Outage rebate  CA$5.00", 1, 50, 130, 200),
    ];
    const layout = makeLayout(items);
    const regions = detectCategoryBlockRegions(layout);
    const creditsRegion = regions.find((r) => (r.payload as { categoryLabel: string }).categoryLabel === "Credits");
    expect(creditsRegion).toBeTruthy();
    const rows = reconstructCategoryBlock(creditsRegion!, layout);
    expect(rows.length).toBe(1);
    expect(rows[0].role).toBe("CREDIT");
    expect(rows[0].extension).toBeLessThan(0);
  });
});

// -----------------------------------------------------------------------------
// resolveRegions overlap logic
// -----------------------------------------------------------------------------
describe("Slice 5 · region overlap resolution", () => {
  it("keeps CLASSIC over CATEGORY on tie", () => {
    const merged = resolveRegions([
      { kind: "CATEGORY_BLOCK_STATEMENT", page: 1, yTop: 100, yBottom: 300, confidence: 60, diagnostic: "cat", payload: {} },
      { kind: "CLASSIC_COLUMN_TABLE", page: 1, yTop: 120, yBottom: 280, confidence: 60, diagnostic: "cls", payload: {} },
    ]);
    expect(merged.length).toBe(1);
    expect(merged[0].kind).toBe("CLASSIC_COLUMN_TABLE");
  });
  it("keeps both when non-overlapping", () => {
    const merged = resolveRegions([
      { kind: "CLASSIC_COLUMN_TABLE", page: 1, yTop: 100, yBottom: 200, confidence: 80, diagnostic: "", payload: {} },
      { kind: "CATEGORY_BLOCK_STATEMENT", page: 1, yTop: 300, yBottom: 400, confidence: 60, diagnostic: "", payload: {} },
    ]);
    expect(merged.length).toBe(2);
  });
});

// -----------------------------------------------------------------------------
// One authority — extractCanonicalLineItems
// -----------------------------------------------------------------------------
describe("Slice 5 · extractCanonicalLineItems", () => {
  it("routes an IMAGE_ONLY (0-item) layout to OCR-pending", async () => {
    const layout: PdfLayout = { pageCount: 1, items: [], visualLines: [], flattenedText: "" };
    const out = await extractCanonicalLineItems({ layout });
    expect(out.lineItems.length).toBe(0);
    expect(out.ocrPending).toBe(true);
  });
  it("routes a DIGITAL_TEXT page to positioned reconstruction and produces items", async () => {
    const items: LayoutTextItem[] = [
      makeItem("Description", 1, 50, 100, 60), makeItem("Qty", 1, 200, 100, 30),
      makeItem("Price", 1, 260, 100, 40), makeItem("Amount", 1, 340, 100, 50),
      ...Array.from({ length: 25 }, (_, i) => [
        makeItem(`SKU-${i}`, 1, 50, 140 + i * 20, 40),
        makeItem("1", 1, 200, 140 + i * 20, 10),
        makeItem("10.00", 1, 260, 140 + i * 20, 40),
        makeItem("10.00", 1, 340, 140 + i * 20, 40),
      ]).flat(),
    ];
    const layout = makeLayout(items);
    const out = await extractCanonicalLineItems({ layout });
    expect(out.lineItems.length).toBeGreaterThanOrEqual(20);
    expect(out.ocrPending).toBe(false);
    expect(out.strategiesUsed).toContain("POSITIONED_CLASSIC_TABLE");
  });
  it("falls back to flattened text when layout produces no rows", async () => {
    const layout: PdfLayout = { pageCount: 1, items: [], visualLines: [], flattenedText: "" };
    const out = await extractCanonicalLineItems({
      layout,
      flattenedText: "Widget assembly    50.00\nSecond product    25.00\n",
    });
    expect(out.lineItems.length).toBeGreaterThanOrEqual(1);
    // Should route as FLATTENED_TEXT_FALLBACK when nothing else works.
    expect(out.strategiesUsed).toContain("FLATTENED_TEXT_FALLBACK");
  });
});

// -----------------------------------------------------------------------------
// Deterministic taxonomy provider
// -----------------------------------------------------------------------------
describe("Slice 5 · DeterministicTaxonomyProvider", () => {
  const provider = new DeterministicTaxonomyProvider();
  const li = (desc: string, ext: number = 100, role: CanonicalLineItem["role"] = "PRIMARY_PURCHASE"): CanonicalLineItem => ({
    description: desc, extension: ext, role, page: 1, sourceStrategy: "POSITIONED_CLASSIC_TABLE",
    validationConfidence: 80, arithmetic: "ARITHMETIC_OK", evidence: [],
  });

  it("classifies 'Diesel LS Dyed' as FUEL from line-item description", () => {
    const c = provider.classify([li("Diesel LS Dyed 1700 L")], {});
    expect(c[0].concept).toBe("FUEL");
    expect(c[0].confidence).toBeGreaterThan(50);
    expect(c[0].supporting.length).toBeGreaterThan(0);
    expect(c[0].supporting[0].strength).toBe("strong");
  });
  it("classifies 'Internet 100 Mbps' as INTERNET_CONNECTIVITY", () => {
    const c = provider.classify([li("Internet: 100 Mbps service")], {});
    expect(c[0].concept).toBe("INTERNET_CONNECTIVITY");
  });
  it("classifies 'membership dues' as PROFESSIONAL_MEMBERSHIP", () => {
    const c = provider.classify([li("Annual membership fee")], {});
    expect(c[0].concept).toBe("PROFESSIONAL_MEMBERSHIP");
  });
  it("classifies 'bearing / seal / filter' as EQUIPMENT_PARTS (repair)", () => {
    const c = provider.classify([li("Replacement bearing"), li("Oil filter"), li("Rear seal")], {});
    expect(c[0].concept).toBe("EQUIPMENT_PARTS");
  });
  it("returns UNKNOWN when no line-item cue matches", () => {
    const c = provider.classify([li("Generic thing")], {});
    expect(c[0].concept).toBe("UNKNOWN");
  });
  it("supplier name alone (weak evidence) does NOT originate a concept", () => {
    const c = provider.classify([li("Generic thing")], { supplierName: "Diesel Supply Co" });
    expect(c[0].concept).toBe("UNKNOWN");
  });
  it("returns cited evidence with line-item index for every strong hit", () => {
    const c = provider.classify([li("Diesel fuel")], {});
    const strongCites = c[0].supporting.filter((s) => s.strength === "strong");
    expect(strongCites.length).toBeGreaterThan(0);
    expect(strongCites[0].lineItemIndex).toBe(0);
  });
});
