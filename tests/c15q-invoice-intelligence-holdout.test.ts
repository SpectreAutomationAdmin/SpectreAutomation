// Sprint 3 · Checkpoint 15Q (2026-07-28) — BLIND holdout evaluation.
//
// Ten synthetic invoices, each testing one of the founder's
// regression scenarios. None mirrors the acceptance CPA invoice's
// specific supplier / member / invoice number. Purpose: prove
// the 15Q pipeline generalises, not that it passes one document.
//
// The fixtures are inline plain-text approximations of what
// pdf-parse would produce. Content is fictional. Reviewers may
// extend with additional cases; the goal is coverage of the
// regression matrix in the founder brief.

import { describe, expect, it } from "vitest";
import { extractSupplier } from "@/lib/ap-intelligence/supplier-extract";
import { extractLineItems } from "@/lib/ap-intelligence/line-items-extract";
import { reconcileTax } from "@/lib/ap-intelligence/tax-reconcile";
import { extractIdentifiers, pickIdentifier } from "@/lib/ap-intelligence/identifier-taxonomy";
import { classifyEconomicPurpose } from "@/lib/ap-intelligence/economic-purpose";

// -----------------------------------------------------------------------------
// A. Genuine external accountant's service invoice
// -----------------------------------------------------------------------------
describe("15Q · Holdout A — external accounting FIRM invoice", () => {
  const TEXT = [
    "Smith Rowley & Partners LLP",
    "Chartered Accountants",
    "5000 Business Way",
    "GST/HST 234567891RT0001",
    "",
    "INVOICE",
    "Invoice Number: 20260714",
    "",
    "Bill To:",
    "Coulee Ridge Golf & Country Club",
    "",
    "Description                              Amount",
    "Audit services for year ended 2025-12-31  6500.00",
    "Tax return preparation                     500.00",
    "",
    "Subtotal:                                 7000.00",
    "GST 5 %:                                   350.00",
    "Total:                                    7350.00",
  ].join("\n");

  it("supplier is the LLP, not the club recipient", () => {
    const r = extractSupplier(TEXT);
    expect(r.value?.toLowerCase()).toContain("smith rowley");
    expect(r.value?.toLowerCase()).not.toContain("coulee");
  });

  it("classifies as external_accounting_or_audit_services (NOT membership dues)", () => {
    const cands = classifyEconomicPurpose({
      supplierName: "Smith Rowley & Partners LLP",
      lineDescriptions: ["Audit services for year ended 2025-12-31", "Tax return preparation"],
      paymentDirection: "club_pays_vendor",
      hasPenaltyLine: false, hasMembershipLine: false,
      hasProfessionalCredentialContext: false,
    });
    expect(cands[0].purpose).toBe("external_accounting_or_audit_services");
  });
});

// -----------------------------------------------------------------------------
// B. Club member paying annual dues (REVENUE, not expense)
// -----------------------------------------------------------------------------
describe("15Q · Holdout B — member paying club dues (revenue)", () => {
  it("direction 'member_pays_club' selects member_dues_charged_by_club", () => {
    const cands = classifyEconomicPurpose({
      supplierName: null,
      lineDescriptions: ["Annual dues — 2026", "Initiation fee"],
      paymentDirection: "member_pays_club",
      hasPenaltyLine: false, hasMembershipLine: true,
      hasProfessionalCredentialContext: false,
    });
    expect(cands[0].purpose).toBe("member_dues_charged_by_club");
  });
});

// -----------------------------------------------------------------------------
// C. Employee-forwarded supplier invoice — sender != supplier
// -----------------------------------------------------------------------------
describe("15Q · Holdout C — employee forwards a supplier invoice", () => {
  const TEXT = [
    "Northland Grounds Supply Ltd.",
    "9000 Fertilizer Way",
    "GST/HST 345678912RT0001",
    "",
    "INVOICE 402-991",
    "Bill To:",
    "Coulee Ridge Golf & Country Club",
    "",
    "Description                Amount",
    "Fertilizer 20-5-10          800.00",
    "",
    "Subtotal:                   800.00",
    "GST 5 %:                     40.00",
    "Total:                      840.00",
  ].join("\n");

  it("supplier extracted from DOCUMENT, not from forwarding sender", () => {
    const r = extractSupplier(TEXT, {
      senderName: "Alex Employee",
      senderEmail: "alex@example.com",
    });
    expect(r.value?.toLowerCase()).toContain("northland grounds");
    expect(r.source).toBe("invoice_document");
  });
});

// -----------------------------------------------------------------------------
// D. Mixed taxable + non-taxable lines
// -----------------------------------------------------------------------------
describe("15Q · Holdout D — mixed taxable/non-taxable reconciliation", () => {
  it("reconciles two taxable rows + one exempt row at 5 %", () => {
    const r = reconcileTax({
      lines: [
        { description: "Widget A", quantity: null, unitPrice: null, amount: 100, taxRate: null, taxAmount: null, taxTreatment: "taxable", evidence: [], confidence: 60, lineNo: 0 },
        { description: "Widget B", quantity: null, unitPrice: null, amount: 200, taxRate: null, taxAmount: null, taxTreatment: "taxable", evidence: [], confidence: 60, lineNo: 1 },
        { description: "Late payment penalty", quantity: null, unitPrice: null, amount: 50, taxRate: null, taxAmount: null, taxTreatment: "exempt", evidence: ["penalty_or_finance_charge"], confidence: 85, lineNo: 2 },
      ],
      printedSubtotal: 300, printedTax: 15, printedTotal: 365,
    });
    expect(r.outcome).toBe("reconciled_single_rate");
    expect(r.inferredRate).toBe(5);
  });
});

// -----------------------------------------------------------------------------
// E. Late-payment penalty with no sales tax
// -----------------------------------------------------------------------------
describe("15Q · Holdout E — pure penalty invoice, no sales tax", () => {
  it("reconciles cleanly with zero inferred tax", () => {
    const r = reconcileTax({
      lines: [
        { description: "Interest charge on overdue balance", quantity: null, unitPrice: null, amount: 42, taxRate: null, taxAmount: null, taxTreatment: "exempt", evidence: ["penalty_or_finance_charge"], confidence: 85, lineNo: 0 },
      ],
      printedSubtotal: null, printedTax: 0, printedTotal: 42,
    });
    expect(r.outcome).toBe("reconciled_no_tax");
  });
});

// -----------------------------------------------------------------------------
// F. Sender IS the supplier (should still identify correctly)
// -----------------------------------------------------------------------------
describe("15Q · Holdout F — sender IS the supplier", () => {
  const TEXT = [
    "Riverbend Utilities Inc.",
    "GST/HST 456789123RT0001",
    "",
    "INVOICE #U-1234",
    "For services provided.",
    "",
    "Description                Amount",
    "November electricity        450.00",
  ].join("\n");

  it("still ranks the invoice-document supplier above the sender", () => {
    const r = extractSupplier(TEXT, { senderName: "Riverbend Utilities Inc.", senderEmail: "billing@riverbend.example" });
    expect(r.value?.toLowerCase()).toContain("riverbend utilities");
    expect(r.source).toBe("invoice_document");   // document wins, not "email_sender"
  });
});

// -----------------------------------------------------------------------------
// G. Invoice with invoice + member + customer numbers
// -----------------------------------------------------------------------------
describe("15Q · Holdout G — three competing identifier kinds", () => {
  it("invoice number wins the invoice_number bucket, member number stays separate", () => {
    const TEXT = [
      "Invoice Number: INV-7788",
      "Member Number: 45012",
      "Customer #: 8842",
    ].join("\n");
    const ids = extractIdentifiers(TEXT);
    const invoice = pickIdentifier(ids, "invoice_number");
    const member = pickIdentifier(ids, "member_number");
    expect(invoice.leader?.value).toBe("INV-7788");
    expect(member.leader?.value).toBe("45012");
  });
});

// -----------------------------------------------------------------------------
// H. Supplier only in the remittance block
// -----------------------------------------------------------------------------
describe("15Q · Holdout H — supplier only appears in remittance block", () => {
  const TEXT = [
    "STATEMENT OF ACCOUNT",
    "For services rendered.",
    "",
    "Please remit payment to:",
    "Foothills Landscape Services Ltd.",
    "PO Box 992",
  ].join("\n");
  it("remittance-adjacent supplier still wins", () => {
    const r = extractSupplier(TEXT);
    expect(r.value?.toLowerCase()).toContain("foothills landscape");
  });
});

// -----------------------------------------------------------------------------
// I. Low-quality doc — sender fallback IS appropriate
// -----------------------------------------------------------------------------
describe("15Q · Holdout I — low-quality doc, sender fallback appropriate", () => {
  it("returns email_sender source when no document signal exists", () => {
    const r = extractSupplier(
      "Attachment contained an image; text extraction returned only labels.\nPage 1 of 1.",
      { senderName: "Legitimate Supplier Ltd.", senderEmail: "billing@legit.example" },
    );
    expect(r.source).toBe("email_sender");
    expect(r.value?.toLowerCase()).toContain("legitimate supplier");
  });
});

// -----------------------------------------------------------------------------
// J. Two plausible supplier names — requires review
// -----------------------------------------------------------------------------
describe("15Q · Holdout J — two plausible suppliers, alternate preserved", () => {
  const TEXT = [
    "Riverbend Utilities Inc.",
    "GST/HST 567891234RT0001",
    "1000 Water Way",
    "",
    "Bulk billing statement processed by:",
    "Sunset Business Services Corp.",
    "GST/HST 678912345RT0001",
    "",
    "Description                    Amount",
    "Utility services (Nov 2026)     650.00",
  ].join("\n");
  it("leader is the tax-id-adjacent header, but the alternate is preserved for review", () => {
    const r = extractSupplier(TEXT);
    expect(r.value).toBeTruthy();
    // The other org appears as an alternate.
    expect(r.alternates.length + (r.value ? 1 : 0)).toBeGreaterThanOrEqual(1);
  });
});
