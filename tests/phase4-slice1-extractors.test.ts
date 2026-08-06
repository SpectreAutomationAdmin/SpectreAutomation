// Sprint 3 · Post-16H Phase 4 Slice 1 (2026-08-05) — regression
// tests for the four extractor bug fixes + the canonical evidence
// reconciler. Every case here is a distilled version of a
// benchmark failure captured in the frozen-baseline scorecard;
// each test is designed to fail on the pre-Slice-1 extractor.

import { describe, it, expect } from "vitest";
import { parseInvoiceText } from "@/lib/ap-intelligence/parse-invoice";
import {
  emptyEvidence,
  reconcileAmounts,
} from "@/lib/ap-intelligence/evidence/canonical-invoice-evidence";

const dmmEnergyText = [
  "DMM Energy Inc.",
  "Les Produits DMM Energy",
  "1234, boulevard de l'Industrie · Rouyn-Noranda QC J9X 5B7",
  "No TPS: 812345678 RT0001",
  "",
  "FACTURE / INVOICE",
  "Invoice B0037FC",
  "Date: 2026-08-04",
  "Due Date: 2026-08-19",
  "",
  "BILL TO:",
  "Coulee Ridge Golf & Country Club",
  "",
  "PRODUIT                            QUANTITÉ    PRIX      MONTANT",
  "Diesel biodégradable dyed low-sulphur   1700    1.4190     2412.30",
  "",
  "                                              Subtotal:     2412.30",
  "                                              GST (5%):      120.62",
  "                                              PST:             0.00",
  "                                              Invoice Total: 2532.92 CAD",
  "",
  "Remit to: DMM Energy Inc.",
].join("\n");

function parse(text: string) {
  return parseInvoiceText({ extractedText: text });
}

describe("Phase 4 · Slice 1 · extractInvoiceNumber — OICE bug is fixed", () => {
  it("does not surface 'OICE' from the word INVOICE", () => {
    const r = parse("This document is an INVOICE for services rendered.");
    expect(r.invoice.invoiceNumber).toBeNull();
  });
  it("does not surface 'OICE' when INVOICE appears alone at top-of-doc", () => {
    const r = parse("INVOICE\n\nSome body content.");
    expect(r.invoice.invoiceNumber).toBeNull();
  });
  it("captures a valid label-space value (Invoice B0037FC)", () => {
    const r = parse("Invoice B0037FC\nDate: 2026-08-04");
    expect(r.invoice.invoiceNumber).toBe("B0037FC");
  });
  it("captures the DMM Energy fuel-invoice reference end-to-end", () => {
    const r = parse(dmmEnergyText);
    expect(r.invoice.invoiceNumber).toBe("B0037FC");
  });
  it("captures bilingual 'Facture' shape", () => {
    const r = parse("Facture: FA-2026-0042\nDate: 2026-08-04");
    expect(r.invoice.invoiceNumber).toBe("FA-2026-0042");
  });
  it("rejects a formatted North-American phone shape (1-800-555-1234)", () => {
    const r = parse("Invoice #: 1-800-555-1234");
    // The layout-aware payable-reference extractor may accept the
    // value as a candidate, but the plausibility filter rejects
    // formatted-phone shapes. A downstream Slice 2 phone-vs-invoice
    // disambiguator will tighten this further.
    // 10-digit BARE numeric strings are still accepted as invoice
    // references (many billing systems use them).
    expect(r.invoice.invoiceNumber).not.toBe("1-800-555-1234");
  });
});

describe("Phase 4 · Slice 1 · MONEY_TOKEN accepts trailing currency word", () => {
  it("extracts total from 'Invoice Total: 2532.92 CAD' (trailing CAD)", () => {
    const r = parse(dmmEnergyText);
    expect(r.invoice.total).toBe("2532.92");
  });
  it("extracts total from 'Invoice Total: 1500.00 USD' (trailing USD)", () => {
    const r = parse("Subtotal: 1400.00\nGST (5%): 100.00\nInvoice Total: 1500.00 USD");
    expect(r.invoice.total).toBe("1500.00");
  });
});

describe("Phase 4 · Slice 1 · extractCurrency Canadian tax inference", () => {
  it("infers CAD from GST context when no $ is present", () => {
    const r = parse("Total: 1050.00\nSubtotal: 1000.00\nGST 5%: 50.00");
    expect(r.invoice.currency).toBe("CAD");
  });
  it("infers CAD from QST/TPS bilingual tax lines", () => {
    const r = parse("Sous-total: 1000.00\nTPS 5%: 50.00\nTVQ 9.975%: 99.75\nTotal: 1149.75");
    expect(r.invoice.currency).toBe("CAD");
  });
  it("still recognises explicit CAD/USD/EUR/GBP", () => {
    expect(parse("Invoice Total: 1000.00 EUR").invoice.currency).toBe("EUR");
  });
  it("returns null when no currency evidence exists (still-safe abstention)", () => {
    expect(parse("Amount: 100").invoice.currency).toBeNull();
  });
});

describe("Phase 4 · Slice 1 · multi-tax sum (GST + PST)", () => {
  it("sums GST and PST into a single taxTotal", () => {
    const r = parse("Subtotal: 1000.00\nGST 5%: 50.25\nPST 7%: 70.35\nTotal: 1120.60");
    expect(Number(r.invoice.taxTotal)).toBeCloseTo(120.60, 2);
  });
  it("keeps a valid single-line result when only one non-zero tax exists", () => {
    const r = parse("Subtotal: 1000.00\nGST 5%: 50.00\nPST: 0.00\nTotal: 1050.00");
    expect(r.invoice.taxTotal).toBe("50.00");
  });
});

describe("Phase 4 · Slice 1 · canonical evidence reconcileAmounts", () => {
  it("prefers the printed total when it agrees with subtotal + tax − credits", () => {
    const ev = emptyEvidence("EMBEDDED_TEXT");
    ev.fields.subtotalCandidates.push({ value: 1000, confidence: 90, strategy: "EMBEDDED_TEXT" });
    ev.fields.taxCandidates.push({ value: 50, confidence: 90, strategy: "EMBEDDED_TEXT" });
    ev.fields.totalCandidates.push({ value: 1050, confidence: 95, strategy: "EMBEDDED_TEXT" });
    const r = reconcileAmounts(ev);
    expect(r.chosenTotal).toBe(1050);
    expect(r.chosenSource).toBe("PRINTED_TOTAL");
    expect(r.reconciliationDelta).toBe(0);
    expect(r.conflicts).toHaveLength(0);
  });
  it("flags a conflict when printed total disagrees with reconciled beyond tolerance", () => {
    const ev = emptyEvidence("EMBEDDED_TEXT");
    ev.fields.subtotalCandidates.push({ value: 1000, confidence: 90, strategy: "EMBEDDED_TEXT" });
    ev.fields.taxCandidates.push({ value: 50, confidence: 90, strategy: "EMBEDDED_TEXT" });
    ev.fields.totalCandidates.push({ value: 999.99, confidence: 95, strategy: "EMBEDDED_TEXT" });
    const r = reconcileAmounts(ev);
    expect(r.conflicts).toHaveLength(1);
    expect(r.conflicts[0].code).toBe("AMOUNT_MISMATCH_SUBTOTAL_PLUS_TAX_VS_TOTAL");
  });
  it("falls back to reconciled (subtotal + tax − credits) when printed total is missing", () => {
    const ev = emptyEvidence("EMBEDDED_TEXT");
    ev.fields.subtotalCandidates.push({ value: 1000, confidence: 90, strategy: "EMBEDDED_TEXT" });
    ev.fields.taxCandidates.push({ value: 50, confidence: 90, strategy: "EMBEDDED_TEXT" });
    const r = reconcileAmounts(ev);
    expect(r.chosenTotal).toBe(1050);
    expect(r.chosenSource).toBe("RECONCILED");
  });
  it("falls back to subtotal when no total AND no tax", () => {
    const ev = emptyEvidence("EMBEDDED_TEXT");
    ev.fields.subtotalCandidates.push({ value: 800, confidence: 90, strategy: "EMBEDDED_TEXT" });
    const r = reconcileAmounts(ev);
    expect(r.chosenTotal).toBe(800);
    expect(r.chosenSource).toBe("RECONCILED");
  });
  it("returns NONE + null when there is no amount evidence at all", () => {
    const r = reconcileAmounts(emptyEvidence("EMBEDDED_TEXT"));
    expect(r.chosenTotal).toBeNull();
    expect(r.chosenSource).toBe("NONE");
  });
  it("respects the credits subtraction on reconciled path", () => {
    const ev = emptyEvidence("EMBEDDED_TEXT");
    ev.fields.subtotalCandidates.push({ value: 1000, confidence: 90, strategy: "EMBEDDED_TEXT" });
    ev.fields.taxCandidates.push({ value: 50, confidence: 90, strategy: "EMBEDDED_TEXT" });
    ev.credits.push({
      description: { value: "Loyalty rebate", confidence: 80, strategy: "EMBEDDED_TEXT" },
      amount: { value: 100, confidence: 80, strategy: "EMBEDDED_TEXT" },
    });
    const r = reconcileAmounts(ev);
    expect(r.chosenTotal).toBe(950);
    expect(r.chosenSource).toBe("RECONCILED");
  });
});
