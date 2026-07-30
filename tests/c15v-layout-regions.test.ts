// Sprint 3 · Checkpoint 15V Addendum-2 (2026-07-30) — layout-region
// classification regression suite.
//
// Real-invoice layouts commonly place the supplier letterhead in a
// different SPATIAL region than the recipient block. Flattened text
// interleaves them and destroys the association. The layout-region
// model must distinguish them using x-position clustering + vertical
// gap detection + optional label vocabulary.
//
// Fixtures below use SANITIZED positioned-item payloads that mirror
// the real founder-observed docs' spatial signatures (approximate
// x/y coordinates, real text patterns without vendor identities).

import { describe, expect, it } from "vitest";
import { detectLayoutRegions, pickSupplierRegion } from "@/lib/ap-intelligence/layout-regions";
import type { LayoutVisualLine } from "@/lib/ap-intelligence/pdf-layout-extract";

function mkLine(page: number, y: number, xStart: number, text: string): LayoutVisualLine {
  return {
    page, y, text,
    items: [{ page, x: xStart, y, width: text.length * 5, height: 10, text }],
  };
}

// -----------------------------------------------------------------------------
// Test 1 — CPA-shape: supplier top-right + recipient left
// -----------------------------------------------------------------------------

describe("15V Addendum-2 · layout-region classification", () => {
  it("splits supplier-top-right from recipient-left on a two-column header", () => {
    const lines: LayoutVisualLine[] = [
      // Top INVOICE stamp
      mkLine(1, 682, 360, "INVOICE"),
      // Supplier block (top-right, x >= 285)
      mkLine(1, 650, 285, "BODY ACRONYM"),
      mkLine(1, 636, 285, "Suite 800, 444 - 7 th Ave SW Calgary, AB T  2P  0X8 Canada"),
      mkLine(1, 621, 285, "T. 403-555-0100  F. 403-555-0200  www.example.org"),
      // Recipient block (left, x ~ 49)
      mkLine(1, 597, 49, "Invoice To :"),
      mkLine(1, 574, 53, "Recipient Person, CPA"),
      mkLine(1, 505, 49, "Member #: 999999"),
      mkLine(1, 490, 49, "1515 Sample Ave"),
      mkLine(1, 476, 49, "Calgary, AB T  2T  0Z7"),
      // Summary block (right, x ~ 490)
      mkLine(1, 562, 490, "Invoice #: 999999999"),
      mkLine(1, 535, 490, "Date: Oct 07, 2025"),
      // Body
      mkLine(1, 430, 62, "Description  Total"),
      mkLine(1, 400, 62, "Membership fee  $810.00"),
    ];
    const regions = detectLayoutRegions(lines);
    const supplier = regions.find((r) => r.kind === "SUPPLIER_BLOCK");
    const recipient = regions.find((r) => r.kind === "RECIPIENT_BLOCK");
    expect(supplier).toBeDefined();
    expect(recipient).toBeDefined();
    // Supplier region must NOT contain the recipient's Calgary/T2T postal.
    expect(supplier!.text).not.toContain("T  2T  0Z7");
    // Recipient region must NOT contain the supplier's Suite 800.
    expect(recipient!.text).not.toContain("Suite 800");
  });

  it("selects the supplier region as pickSupplierRegion for two-column headers", () => {
    const lines: LayoutVisualLine[] = [
      mkLine(1, 650, 285, "BODY ACRONYM"),
      mkLine(1, 636, 285, "Suite 800, 444 - 7 th Ave SW Calgary, AB T  2P  0X8 Canada"),
      mkLine(1, 597, 49, "Invoice To :"),
      mkLine(1, 574, 53, "Recipient Person"),
      mkLine(1, 490, 49, "1515 Sample Ave, Calgary, AB T  2T  0Z7"),
    ];
    const regions = detectLayoutRegions(lines);
    const supplier = pickSupplierRegion(regions);
    expect(supplier).not.toBeNull();
    // Supplier text must contain the supplier postal, not the recipient postal.
    expect(supplier!.text).toContain("T  2P  0X8");
    expect(supplier!.text).not.toContain("T  2T  0Z7");
  });

  it("selects the top-of-page block on a single-column layout (statement-shape)", () => {
    // OXIO-shape: supplier at the very top, recipient just below,
    // both in the same x column. Vertical gap distinguishes them.
    // Body content included below so the header-boundary calculation
    // has enough y-range to differentiate top-of-page from body.
    const lines: LayoutVisualLine[] = [
      mkLine(1, 705, 43, "BODY-ACRONYM"),
      mkLine(1, 680, 43, "1 PLACE VILLE MARIE #3301"),
      mkLine(1, 665, 43, "MONTREAL, QC, H3B 3N2"),
      // 40+ unit gap → separate region
      mkLine(1, 620, 43, "RECIPIENT PERSON"),
      mkLine(1, 605, 43, "24-15 Sample Hts SW"),
      mkLine(1, 590, 43, "CALGARY, AB, T3H 0E3"),
      // Body content — the invoice body extends the page's y-range
      // so header/footer boundaries land where they should.
      mkLine(1, 400, 43, "Statement number   BODY-99999"),
      mkLine(1, 380, 43, "Total amount due    CA$100.00"),
      mkLine(1, 200, 43, "Description  Amount"),
      mkLine(1, 180, 43, "Ongoing charges   $99.00"),
      mkLine(1, 100, 43, "Payment due date"),
      mkLine(1, 50,  43, "Thank you for your payment"),
    ];
    const regions = detectLayoutRegions(lines);
    // Two distinct entity regions expected in the header.
    const entityRegions = regions.filter((r) => r.kind === "SUPPLIER_BLOCK" || r.kind === "RECIPIENT_BLOCK");
    expect(entityRegions.length).toBeGreaterThanOrEqual(2);
    const supplier = pickSupplierRegion(regions);
    expect(supplier).not.toBeNull();
    // Top-of-page region should win as supplier — its text contains
    // the FIRST address (Montreal), not the second (Calgary).
    expect(supplier!.text).toContain("MONTREAL");
    expect(supplier!.text).not.toContain("CALGARY");
  });
});
