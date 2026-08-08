// Sprint 3 · Phase 4 Slice 5.3 completion (2026-08-08) — token-aware
// numeric-cell resolution tests. Verifies that when the header
// detector produces coarse semantic columns and multiple physical
// tokens fall into the same cell, the reconstructor selects the
// correct semantic value instead of concatenating and failing to
// parse.
//
// All test data is SYNTHETIC. No supplier / product / SKU / model
// literal. Assertions verify the generic parsing behaviour.

import { describe, it, expect } from "vitest";
import {
  detectClassicColumnTableRegions,
  reconstructClassicColumnTable,
} from "@/lib/ap-intelligence/line-item-region-strategies";
import type { PdfLayout, LayoutTextItem } from "@/lib/ap-intelligence/pdf-layout-extract";

function item(text: string, page: number, x: number, y: number, w?: number): LayoutTextItem {
  return { text, page, x, y, width: w ?? text.length * 6, height: 10 };
}

function layoutFromItems(items: LayoutTextItem[]): PdfLayout {
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
    .sort((a, b) => a.page - b.page || a.y - b.y);
  return {
    pageCount: 1,
    items,
    visualLines,
    flattenedText: visualLines.map((l) => l.text).join("\n"),
    pages: [{ page: 1, pageClass: "TEXT_HEALTHY", itemCount: items.length }],
    layoutExtraction: "PDFJS_NATIVE",
  } as unknown as PdfLayout;
}

describe("resolveMonetaryCell / resolveQuantityCell — multi-token semantic cells", () => {
  it("recovers TORO-shape row: description in one visualLine + two amount tokens in the amount cell", () => {
    // Header at y=10, two "amount"-domain tokens (unit price + line
    // total) at rightmost positions.
    const items: LayoutTextItem[] = [
      // Header row — description + quantity + unitPrice + amount roles
      // are all matched by the standard header lexicon so 4 cols are
      // detected.
      item("Description", 1, 60, 10, 60),
      item("Shipped", 1, 260, 10, 40),   // matches quantity role
      item("Price", 1, 400, 10, 30),      // matches unitPrice role
      item("Amount", 1, 520, 10, 45),     // matches amount role

      // Body row: line# + sku fall into description cell; Order/Backorder/Shipped/Qty-UM
      // all cluster in the quantity cell; unit price + PriceUM in unitPrice cell;
      // discount + line total in the amount cell.
      item("1", 1, 30, 30, 6),
      item("30807", 1, 60, 30, 25),
      item("1.00", 1, 240, 30, 20),
      item("0.00", 1, 290, 30, 20),
      item("1.00", 1, 340, 30, 20),
      item("EA", 1, 380, 30, 12),
      item("74,112.00", 1, 420, 30, 45),   // unit price token — right-most in unitPrice cell
      item("EA", 1, 470, 30, 12),
      item("0.00", 1, 500, 30, 20),         // discount → coarse amount cell
      item("74,112.00", 1, 555, 30, 45),    // line total → coarse amount cell rightmost
    ];
    const layout = layoutFromItems(items);
    const regions = detectClassicColumnTableRegions(layout);
    expect(regions.length).toBeGreaterThan(0);
    const rows = reconstructClassicColumnTable(regions[0], layout);
    expect(rows.length).toBeGreaterThan(0);
    const primary = rows.find((r) => r.role === "PRIMARY_PURCHASE");
    expect(primary, "primary-purchase row emitted despite multi-token amount cell").toBeTruthy();
    expect(primary!.extension).toBe(74112);
    // Rightmost amount candidate — either 74,112.00 (line total) or
    // whichever the resolver picks; the important assertion is that
    // it's the rightmost valid amount, not the concatenation.
    // Unit tag EA present on the line — quantity resolver should
    // populate unit; canonical row may either carry unit or not
    // depending on which cell the tag fell into.
  });

  it("second product row with zero extension is still emitted (not silently discarded)", () => {
    const items: LayoutTextItem[] = [
      item("Description", 1, 60, 10, 60),
      item("Shipped", 1, 260, 10, 40),
      item("Price", 1, 400, 10, 30),
      item("Amount", 1, 520, 10, 45),

      // Product row with zero unit price and zero amount
      item("2", 1, 30, 30, 6),
      item("30629", 1, 60, 30, 25),
      item("1.00", 1, 240, 30, 20),
      item("0.00", 1, 290, 30, 20),
      item("1.00", 1, 340, 30, 20),
      item("EA", 1, 380, 30, 12),
      item("0.00", 1, 420, 30, 20),
      item("EA", 1, 470, 30, 12),
      item("0.00", 1, 500, 30, 20),
      item("0.00", 1, 555, 30, 20),

      // Description continuation
      item("Sample Product Name", 1, 60, 42, 90),
    ];
    const layout = layoutFromItems(items);
    const regions = detectClassicColumnTableRegions(layout);
    const rows = reconstructClassicColumnTable(regions[0], layout);
    // The row should be emitted with extension = 0.
    const primary = rows.find((r) => r.role === "PRIMARY_PURCHASE" || r.role === "CREDIT");
    expect(primary).toBeTruthy();
    expect(primary!.extension).toBe(0);
  });

  it("filters unit tags (EA) from numeric cells", () => {
    const items: LayoutTextItem[] = [
      item("Description", 1, 60, 10, 60),
      item("Qty", 1, 260, 10, 20),
      item("Price", 1, 400, 10, 30),
      item("Amount", 1, 520, 10, 45),

      // A cell containing "5.00" and "EA" — resolver picks 5.00 not
      // "5.00 EA" (which would fail parsing).
      item("Widget", 1, 60, 30, 40),
      item("5.00", 1, 250, 30, 20),
      item("EA", 1, 280, 30, 12),
      item("10.00", 1, 400, 30, 25),
      item("50.00", 1, 555, 30, 25),
    ];
    const layout = layoutFromItems(items);
    const regions = detectClassicColumnTableRegions(layout);
    const rows = reconstructClassicColumnTable(regions[0], layout);
    const primary = rows.find((r) => r.role === "PRIMARY_PURCHASE");
    expect(primary).toBeTruthy();
    expect(primary!.quantity).toBe(5);
    expect(primary!.extension).toBe(50);
    // Unit is captured on the row
    expect(primary!.unit).toBe("EA");
  });

  it("negative amount → CREDIT role, not dropped", () => {
    const items: LayoutTextItem[] = [
      item("Description", 1, 60, 10, 60),
      item("Qty", 1, 260, 10, 20),
      item("Price", 1, 400, 10, 30),
      item("Amount", 1, 520, 10, 45),

      item("Refund adjustment", 1, 60, 30, 90),
      item("1.00", 1, 250, 30, 20),
      item("-50.00", 1, 400, 30, 25),
      item("-50.00", 1, 555, 30, 25),
    ];
    const layout = layoutFromItems(items);
    const regions = detectClassicColumnTableRegions(layout);
    const rows = reconstructClassicColumnTable(regions[0], layout);
    const row = rows.find((r) => Math.abs(r.extension ?? 0) === 50);
    expect(row).toBeTruthy();
    expect(row!.role).toBe("CREDIT");
  });

  it("summary rows remain non-purchase evidence (§5 preserved)", () => {
    const items: LayoutTextItem[] = [
      item("Description", 1, 60, 10, 60),
      item("Qty", 1, 260, 10, 20),
      item("Price", 1, 400, 10, 30),
      item("Amount", 1, 520, 10, 45),

      // First substantive row
      item("Genuine product", 1, 60, 30, 90),
      item("1.00", 1, 250, 30, 20),
      item("100.00", 1, 400, 30, 25),
      item("100.00", 1, 555, 30, 25),

      // Summary row
      item("1", 1, 30, 50, 6),
      item("Lines Total", 1, 60, 50, 60),
      item("100.00", 1, 555, 50, 25),
    ];
    const layout = layoutFromItems(items);
    const regions = detectClassicColumnTableRegions(layout);
    const rows = reconstructClassicColumnTable(regions[0], layout);
    const summary = rows.find((r) => r.role === "SUMMARY_ROW_REJECTED");
    expect(summary, "summary row emitted with SUMMARY_ROW_REJECTED role").toBeTruthy();
    // Never becomes primary purchase
    const primaries = rows.filter((r) => r.role === "PRIMARY_PURCHASE");
    expect(primaries.some((p) => /Lines\s*Total/i.test(p.description))).toBe(false);
  });
});
