// Sprint 3 · Post-16H Phase 4 Slice 3 (2026-08-06) — supplier
// ranker v2, canonical line items, tax components, replay-endpoint
// security surface. Every assertion is a distilled Slice-3
// requirement from the founder brief §3, §7, §8, §9, §15.

import { describe, it, expect } from "vitest";
import { parseInvoiceText } from "@/lib/ap-intelligence/parse-invoice";
import {
  rankSuppliers,
  deriveSignals,
} from "@/lib/ap-intelligence/evidence/supplier-ranker";
import {
  extractLineItemsFromText,
  reconcileLineItems,
} from "@/lib/ap-intelligence/evidence/line-items";
import {
  extractStructuredTaxComponents,
  selectTaxTotal,
} from "@/lib/ap-intelligence/evidence/tax-components";

describe("Phase 4 · Slice 3 · §3 supplier ranker v2 — scored composition", () => {
  it("no single weak signal defeats several contradictory signals", () => {
    // Candidate A: strong org-name-shape + header position but also
    // has a bill-to proximity negative (should lose).
    // Candidate B: no positives except header, no negatives (should
    // not automatically win either — margin insufficient).
    const r = rankSuppliers([
      { value: "Coulee Ridge Golf & Country Club", positive: ["ORG_NAME_SHAPE", "HEADER_POSITION"], negative: ["BILL_TO_PROXIMITY"] },
      { value: "Prairie Greens Landscape Ltd.", positive: ["ORG_NAME_SHAPE", "HEADER_POSITION", "ADDRESS_ADJACENT", "TAX_REGISTRATION_OWNER"], negative: [] },
    ]);
    expect(r.winner?.value).toBe("Prairie Greens Landscape Ltd.");
    expect(r.ambiguous).toBe(false);
  });
  it("marks ambiguous when top and runner-up scores are within margin threshold", () => {
    const r = rankSuppliers([
      { value: "Foo Ltd.", positive: ["ORG_NAME_SHAPE", "HEADER_POSITION"], negative: [] },
      { value: "Bar Inc.", positive: ["ORG_NAME_SHAPE", "HEADER_POSITION"], negative: [] },
    ]);
    expect(r.ambiguous).toBe(true);
  });
  it("BILL_TO_PROXIMITY dominates positives", () => {
    const r = rankSuppliers([
      { value: "Coulee Ridge Golf & Country Club", positive: ["ORG_NAME_SHAPE", "HEADER_POSITION", "ADDRESS_ADJACENT", "TAX_REGISTRATION_OWNER"], negative: ["BILL_TO_PROXIMITY"] },
    ]);
    expect(r.winner).toBeNull();     // negative sum > positive → not a survivor
    expect(r.ranked[0].survivedNegatives).toBe(false);
  });
  it("deriveSignals detects TABLE_HEADING for bare product-heading tokens", () => {
    const sig = deriveSignals("DESCRIPTION", { text: "DESCRIPTION\nItem 1  100.00\n" });
    expect(sig.negative).toContain("TABLE_HEADING");
  });
  it("deriveSignals detects DOCUMENT_TITLE for bare 'INVOICE'", () => {
    const sig = deriveSignals("INVOICE", { text: "INVOICE\nBody\n" });
    expect(sig.negative).toContain("DOCUMENT_TITLE");
  });
});

describe("Phase 4 · Slice 3 · §7 canonical line-item extraction", () => {
  it("captures qty × unit × extension for a fuel invoice", () => {
    const r = extractLineItemsFromText(
      "Diesel biodégradable dyed low-sulphur   1700    1.4190     2412.30\nSubtotal:     2412.30\nGST (5%):      120.62\nTotal:      2532.92",
    );
    expect(r.lineItems).toHaveLength(1);
    expect(r.lineItems[0].description.value).toMatch(/Diesel/i);
    expect(r.lineItems[0].quantity?.value).toBe(1700);
    expect(r.lineItems[0].unitPrice?.value).toBe(1.4190);
    expect(r.lineItems[0].amount.value).toBe(2412.30);
  });
  it("routes negative amounts into credits", () => {
    const r = extractLineItemsFromText(
      "Return of unopened fertilizer, tote                -1200.00\nSubtotal:  -1200.00\nGST (5%):    -60.00\nCredit Total: -1260.00",
    );
    expect(r.credits.length).toBeGreaterThanOrEqual(1);
    expect(r.credits[0].amount.value).toBe(-1200);
  });
  it("does NOT treat Subtotal / Tax / Total rows as line items", () => {
    const r = extractLineItemsFromText(
      "Widget A     100.00\nSubtotal:  100.00\nGST:  5.00\nTotal: 105.00",
    );
    expect(r.lineItems).toHaveLength(1);
    expect(r.lineItems[0].description.value).toBe("Widget A");
  });
});

describe("Phase 4 · Slice 3 · §8 line-item reconciliation", () => {
  it("agrees when line extensions sum to the claimed subtotal", () => {
    const r = extractLineItemsFromText(
      "Widget A    100.00\nWidget B     50.00\nSubtotal: 150.00\nTotal:    150.00",
    );
    const rec = reconcileLineItems(r.lineItems, r.credits, r.surcharges, 150);
    expect(rec).not.toBeNull();
    expect(rec!.sum).toBe(150);
    expect(rec!.delta).toBe(0);
    expect(rec!.conflict).toBeNull();
  });
  it("records a conflict when line extensions do NOT sum to the claimed subtotal", () => {
    const r = extractLineItemsFromText(
      "Widget A     100.00\nWidget B      75.00\nSubtotal: 100.00\nTotal:   100.00",
    );
    const rec = reconcileLineItems(r.lineItems, r.credits, r.surcharges, 100);
    expect(rec!.conflict?.code).toBe("LINE_ITEMS_DO_NOT_SUM_TO_SUBTOTAL");
  });
});

describe("Phase 4 · Slice 3 · §9 tax-component structured metadata", () => {
  it("extracts GST + PST as distinct duplicate groups + sums each once", () => {
    const c = extractStructuredTaxComponents(
      "Subtotal: 1000.00\nGST 5%: 50.00\nPST 7%: 70.00\nTotal: 1120.00",
    );
    expect(c.length).toBe(2);
    const sel = selectTaxTotal(c);
    expect(sel.total).toBeCloseTo(120, 2);
  });
  it("normalises TPS → GST so bilingual invoices do not double-count", () => {
    const c = extractStructuredTaxComponents("GST 5%: 50.00\nTPS 5%: 50.00");
    const distinctGroups = new Set(c.map((x) => x.duplicateGroupId));
    // TPS collapses to GST equivalent; identical amount + rate → same duplicate group.
    expect(distinctGroups.size).toBe(1);
    const sel = selectTaxTotal(c);
    expect(sel.total).toBe(50);
  });
  it("prefers SUMMARY level over REMITTANCE when the same amount appears at both", () => {
    const c = extractStructuredTaxComponents(
      "GST 5%: 225.00\nRemittance stub — please return with payment\nGST 5%: 225.00",
    );
    const sel = selectTaxTotal(c);
    expect(sel.total).toBe(225);       // NOT 450
    expect(sel.used[0].level).toBe("SUMMARY");
    expect(sel.suppressed[0].level).toBe("REMITTANCE");
  });
});

describe("Phase 4 · Slice 3 · integration — parseInvoiceText carries line items + tax components", () => {
  it("attaches Slice-3 evidence to the canonical evidence object", async () => {
    // Slice 5 (2026-08-07): buildCanonicalEvidence no longer extracts
    // line items independently — the analyser is the ONE authority.
    // This test simulates the analyser flow: run the canonical
    // extractor first, then thread its output into parseInvoiceText.
    const text = [
      "Prairie Greens Landscape Ltd.",
      "1500 Fairway Rd · Regina SK",
      "GST: 843210987 RT0001",
      "Invoice Number: PG-001",
      "",
      "Sand-cap dressing, greens            400   2.15    860.00",
      "Aerator rental, half-day               1 140.00    140.00",
      "",
      "Subtotal: 1000.00",
      "GST 5%: 50.00",
      "Total:   1050.00",
    ].join("\n");
    const { extractCanonicalLineItems } = await import(
      "@/lib/ap-intelligence/canonical-line-item-extractor"
    );
    const canonical = await extractCanonicalLineItems({ flattenedText: text, pageCount: 1 });
    const r = parseInvoiceText({
      extractedText: text,
      canonicalLineItems: canonical.lineItems,
    });
    expect(r.canonicalEvidence?.lineItems.length).toBeGreaterThanOrEqual(1);
    // Slice 3 attaches tax components on the extension bag.
    const ev = r.canonicalEvidence as { taxComponents?: unknown[] };
    expect(Array.isArray(ev.taxComponents)).toBe(true);
    expect((ev.taxComponents ?? []).length).toBeGreaterThanOrEqual(1);
  });
});
