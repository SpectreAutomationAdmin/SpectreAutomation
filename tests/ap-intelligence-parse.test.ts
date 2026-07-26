// Sprint 3 Checkpoint 15E (2026-07-24) — Pure-function tests for
// PDF-text parsing (no PDF needed — feeds raw text) and the
// capital/operating classifier.

import { describe, expect, it } from "vitest";
import { parseInvoiceText } from "@/lib/ap-intelligence/parse-invoice";
import { validateExtractedArithmetic } from "@/lib/ap-intelligence/validate";
import { classifyCapitalVsOperating } from "@/lib/ap-intelligence/capital-vs-operating";
import { EXTRACTION_RULE_VERSION } from "@/lib/ap-intelligence/types";

// A realistic-shaped invoice-body text — matches what pdf-parse
// typically produces from a landscape PDF.
const FAKE_INVOICE_TEXT = `
Northside Course Maintenance Inc.
1234 Fairway Drive
Calgary, AB T2N 1N4
HST: 123456789 RT 0001

INVOICE
Invoice Number: INV-2026-0742
Invoice Date: 2026-06-01
Due Date: 2026-07-01

Bill To:
Spectre Staging Club
Attn: Accounts Payable

Description: Monthly grounds contract — June

Item                                     Qty     Unit         Amount
Fairway mowing service                   1       850.00       850.00
Bunker maintenance                       1       320.00       320.00

                                                Subtotal:     1170.00
                                                HST (5%):     58.50
                                                Total Due:    1228.50
`;

describe("parseInvoiceText — happy path", () => {
  it("extracts invoice number, dates, totals, currency, vendor identity", () => {
    const { invoice, hints } = parseInvoiceText({ extractedText: FAKE_INVOICE_TEXT });
    expect(invoice.state).toBe("STRUCTURED");
    expect(invoice.ruleVersion).toBe(EXTRACTION_RULE_VERSION);
    expect(invoice.invoiceNumber).toBe("INV-2026-0742");
    expect(invoice.invoiceDate).toBe("2026-06-01");
    expect(invoice.dueDate).toBe("2026-07-01");
    expect(invoice.subtotal).toBe("1170.00");
    expect(invoice.taxTotal).toBe("58.50");
    expect(invoice.total).toBe("1228.50");
    expect(invoice.vendor.guessedName).toContain("Northside");
    expect(invoice.vendor.guessedTaxNumber).toContain("123456789");
    expect(invoice.lineItems.length).toBeGreaterThanOrEqual(1);
    // Every extraction records at least one hint per matched field.
    expect(hints.map((h) => h.field)).toEqual(expect.arrayContaining(["invoiceNumber", "invoiceDate", "total", "subtotal"]));
  });
});

describe("parseInvoiceText — Microsoft-format PDF (C15H remediation)", () => {
  // Real pdf-parse output from the founder's actual Microsoft invoice.
  // See the Sprint 3 C15H remediation for context on the specific
  // problems this exercises: vendor name was "July 2026", subtotal
  // was null, PO captured the label "PO Number" instead of a value.
  const MICROSOFT_TEXT = `
Invoice
July 2026
Invoice Date: 2026-07-22
Invoice Number: E0701097E3
Due Date: 2026-07-22
31.29 CAD
Sold-ToBill-ToService Usage Address
Spectre Automation
1515 25th Ave SW
Order Details
Product:Online Services
Customer PO Number:
Order Number:103851cc-2dea-42be-b32b-64fceed2e42f
Billing Summary
Charges:29.80
Discounts:0.00
Credits:0.00
GST/HST:1.49
QST/PST:0.00
Total:31.29
Microsoft Corporation, One Microsoft Way, Redmond, WA 98052, United States
GST/HST 135625069RT0001
`;

  it("recognises Microsoft Corporation from the corporate-suffix footer, not 'July 2026'", () => {
    const { invoice } = parseInvoiceText({ extractedText: MICROSOFT_TEXT });
    expect(invoice.vendor.guessedName).toBe("Microsoft Corporation");
    expect(invoice.vendor.guessedName).not.toBe("July 2026");
  });

  it("extracts invoice number, dates, total, tax, currency from Microsoft-style layout", () => {
    const { invoice } = parseInvoiceText({ extractedText: MICROSOFT_TEXT });
    expect(invoice.invoiceNumber).toBe("E0701097E3");
    expect(invoice.invoiceDate).toBe("2026-07-22");
    expect(invoice.dueDate).toBe("2026-07-22");
    expect(invoice.total).toBe("31.29");
    expect(invoice.taxTotal).toBe("1.49");
    expect(invoice.currency).toBe("CAD");
  });

  it("extracts subtotal from 'Charges' label (Microsoft terminology)", () => {
    const { invoice } = parseInvoiceText({ extractedText: MICROSOFT_TEXT });
    expect(invoice.subtotal).toBe("29.80");
  });

  it("extracts Microsoft's HST tax number from the footer", () => {
    const { invoice } = parseInvoiceText({ extractedText: MICROSOFT_TEXT });
    expect(invoice.vendor.guessedTaxNumber).toBe("135625069RT0001");
  });

  it("does NOT falsely capture 'PO Number' as the purchase-order value when the field is blank", () => {
    const { invoice } = parseInvoiceText({ extractedText: MICROSOFT_TEXT });
    // Real value is blank on this invoice — either null OR a real digit-bearing string, never the label word.
    expect(invoice.purchaseOrder).not.toBe("PO Number");
    if (invoice.purchaseOrder !== null) {
      expect(/\d/.test(invoice.purchaseOrder)).toBe(true);
    }
  });
});

describe("parseInvoiceText — partial extraction", () => {
  it("returns PARTIAL when critical fields missing", () => {
    const { invoice } = parseInvoiceText({ extractedText: "Some random PDF text with no fields.\nJust prose.\nNo money.\n" });
    expect(invoice.state).toBe("PARTIAL");
    expect(invoice.warnings.length).toBeGreaterThan(0);
  });
  it("returns DOCUMENT_UNREADABLE when text is empty", () => {
    const { invoice } = parseInvoiceText({ extractedText: "" });
    expect(invoice.state).toBe("DOCUMENT_UNREADABLE");
    expect(invoice.extractedTextChars).toBe(0);
  });
});

describe("validateExtractedArithmetic", () => {
  it("no findings for a clean invoice", () => {
    const { invoice } = parseInvoiceText({ extractedText: FAKE_INVOICE_TEXT });
    const findings = validateExtractedArithmetic(invoice);
    // Note: the demo invoice claims 5% HST but 58.50 / 1170.00 = 5% exactly —
    // the arithmetic (subtotal + tax = total) holds.
    const criticalKeys = findings.filter((f) => f.severity === "HIGH" || f.severity === "CRITICAL").map((f) => f.key);
    expect(criticalKeys).toEqual([]);
  });
  it("flags total_mismatch when subtotal + tax != total", () => {
    const { invoice } = parseInvoiceText({ extractedText: FAKE_INVOICE_TEXT.replace("1228.50", "1500.00") });
    const findings = validateExtractedArithmetic(invoice);
    expect(findings.map((f) => f.key)).toContain("ap.invoice.total_mismatch");
  });
  it("flags negative_total when total is negative", () => {
    const { invoice } = parseInvoiceText({ extractedText: FAKE_INVOICE_TEXT.replace("1228.50", "-125.00").replace("1170.00", "-125.00").replace("58.50", "0.00") });
    // The extractor may pick the negative up; run through validator
    if (invoice.total) {
      const findings = validateExtractedArithmetic({ ...invoice, total: "-125.00", subtotal: "-125.00", taxTotal: "0.00" });
      expect(findings.map((f) => f.key)).toContain("ap.invoice.negative_total");
    }
  });
});

describe("classifyCapitalVsOperating", () => {
  const base = { total: "10000.00", state: "STRUCTURED" as const, ruleVersion: 1, extractedTextChars: 100,
    vendor: { guessedName: null, guessedEmail: null, guessedTaxNumber: null, guessedDomain: null },
    invoiceNumber: "X", invoiceDate: "2026-06-01", dueDate: null, paymentTerms: null, purchaseOrder: null,
    description: null as string | null,
    currency: "CAD", subtotal: "10000.00", taxTotal: "0.00",
    lineItems: [] as Array<{description:string;quantity:string|null;unitCost:string|null;amount:string}>,
    remittance: { address: null, email: null }, warnings: [] };

  it("CAPITAL when total ≥ threshold + capital keyword + class recognised", () => {
    const rec = classifyCapitalVsOperating({
      extraction: { ...base, description: "Install replacement irrigation pump on 6th hole" },
      clubCapitalMinCents: 500000,
    });
    expect(rec.state).toBe("CAPITAL");
    expect(rec.capitalClass).toBe("IRRIGATION");
    expect(rec.supportingEvidence.length).toBeGreaterThan(0);
  });

  it("OPERATING when clearly a repair, even at high total", () => {
    const rec = classifyCapitalVsOperating({
      extraction: { ...base, description: "Monthly maintenance service for course equipment" },
      clubCapitalMinCents: 500000,
    });
    expect(rec.state).toBe("OPERATING");
  });

  it("AMBIGUOUS when over threshold but no keywords", () => {
    const rec = classifyCapitalVsOperating({
      extraction: { ...base, description: "General services rendered" },
      clubCapitalMinCents: 500000,
    });
    expect(rec.state).toBe("AMBIGUOUS");
  });

  it("OPERATING when under threshold and no capital keywords", () => {
    const rec = classifyCapitalVsOperating({
      extraction: { ...base, total: "150.00", subtotal: "150.00", description: "Office supplies" },
      clubCapitalMinCents: 500000,
    });
    expect(rec.state).toBe("OPERATING");
  });

  it("INSUFFICIENT_EVIDENCE on unreadable document", () => {
    const rec = classifyCapitalVsOperating({
      extraction: { ...base, state: "DOCUMENT_UNREADABLE", total: null, subtotal: null, taxTotal: null, extractedTextChars: 0 },
      clubCapitalMinCents: 500000,
    });
    expect(rec.state).toBe("INSUFFICIENT_EVIDENCE");
  });
});
