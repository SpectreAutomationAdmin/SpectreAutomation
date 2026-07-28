// Sprint 3 · Checkpoint 15Q (2026-07-28) — invoice-intelligence
// unit tests. Every fixture is fictional. NO CPA / Turcato /
// 1007565767 strings appear in any fixture; the acceptance
// invoice is separate (see c15q-invoice-intelligence-holdout.test.ts).

import { describe, expect, it } from "vitest";
import { extractSupplier } from "@/lib/ap-intelligence/supplier-extract";
import { extractLineItems } from "@/lib/ap-intelligence/line-items-extract";
import { reconcileTax } from "@/lib/ap-intelligence/tax-reconcile";
import { extractIdentifiers, pickIdentifier } from "@/lib/ap-intelligence/identifier-taxonomy";
import { classifyEconomicPurpose } from "@/lib/ap-intelligence/economic-purpose";

// -----------------------------------------------------------------------------
// Supplier extraction
// -----------------------------------------------------------------------------

describe("15Q · supplier extractor — the document is primary evidence", () => {
  it("selects the issuer even when a Bill-To recipient contains an org-like name", () => {
    const text = [
      "Acme Golf & Country Club",   // header — could be misread as issuer
      "1234 Fairway Drive",
      "",
      "INVOICE",
      "",
      "Bill To:",
      "Riverside Athletics Association Inc.",   // recipient — should NOT win
      "999 Recipient Way",
      "",
      "Meadowbrook Turf Supplies Ltd.",         // supplier
      "555 Vendor Blvd",
      "GST/HST 123456789RT0001",
    ].join("\n");
    const r = extractSupplier(text);
    expect(r.value).toBe("Meadowbrook Turf Supplies Ltd.");
    expect(r.source).toBe("invoice_document");
    // The recipient candidate is either dropped or ranked lower.
    const winnerNormalized = r.normalized;
    for (const alt of r.alternates) {
      expect(alt.normalized).not.toBe(winnerNormalized);
    }
  });

  it("promotes a name preceded by 'Remit to' language even without a corp suffix", () => {
    const text = [
      "Statement of Account",
      "",
      "Remit payment to:",
      "Grand Prairie Utilities",
      "PO Box 400",
    ].join("\n");
    const r = extractSupplier(text);
    expect(r.value).toBe("Grand Prairie Utilities");
    expect(r.source).toBe("invoice_document");
  });

  it("ranks a tax-id-adjacent candidate above an unrelated header line", () => {
    const text = [
      "Some Random Header",
      "",
      "Ridge Consulting Services Ltd.",
      "GST/HST 987654321RT0001",
    ].join("\n");
    const r = extractSupplier(text);
    expect(r.value).toBe("Ridge Consulting Services Ltd.");
  });

  it("does NOT pick a person's name over an unrelated organization", () => {
    const text = [
      "Jane Smith",                    // person
      "",
      "Blue Ridge Turf Ltd.",          // supplier
      "GST/HST 111222333RT0001",
    ].join("\n");
    const r = extractSupplier(text);
    expect(r.value).toBe("Blue Ridge Turf Ltd.");
    // Alternates may contain Jane Smith, but it must not be the leader.
    expect(r.value).not.toBe("Jane Smith");
  });

  it("falls back to sender ONLY when the document has NO supported supplier", () => {
    const text = ["Some blob of text", "with no plausible supplier", "line at all"].join("\n");
    const r = extractSupplier(text, { senderName: "Big Utility Corporation" });
    expect(r.source).toBe("email_sender");
    expect(r.reasoningCode).toBe("sender_org_suffix_fallback");
    expect(r.value).toBe("Big Utility Corporation");
  });

  it("does NOT fall back to a person's sender name", () => {
    const text = ["No supplier signal in this doc"].join("\n");
    const r = extractSupplier(text, { senderName: "John Person", senderEmail: "john@example.com" });
    expect(r.source).toBe("system_default");
    expect(r.value).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// Line-item extraction — per-line taxable flag
// -----------------------------------------------------------------------------

describe("15Q · line-item extractor with per-line tax classification", () => {
  it("marks a penalty line as exempt from tax", () => {
    const text = [
      "Description                                       Amount",
      "Annual maintenance fee                            500.00",
      "Late payment penalty                               25.00",
    ].join("\n");
    const items = extractLineItems(text);
    const penalty = items.find((l) => /penalty/i.test(l.description));
    expect(penalty).toBeDefined();
    expect(penalty!.taxTreatment).toBe("exempt");
    expect(penalty!.evidence).toContain("penalty_or_finance_charge");
  });

  it("promotes a 'Membership dues' line to taxable via language cue", () => {
    const text = "Annual membership dues        400.00";
    const items = extractLineItems(text);
    const dues = items.find((l) => /membership/i.test(l.description));
    expect(dues).toBeDefined();
    expect(dues!.taxTreatment).toBe("taxable");
  });

  it("respects an explicit 'Non-taxable' group header for subsequent rows", () => {
    const text = [
      "Non-taxable items",
      "Interest charge                     30.00",
    ].join("\n");
    const items = extractLineItems(text);
    const interest = items.find((l) => /interest/i.test(l.description));
    expect(interest!.taxTreatment).toBe("exempt");
    expect(interest!.evidence).toContain("adjacent_tax_group_header");
  });

  it("captures explicit tax-amount column when a header advertises it", () => {
    const text = [
      "Description               Amount    Tax Amount",
      "Widget                     100.00       5.00",
    ].join("\n");
    const items = extractLineItems(text);
    const widget = items[0];
    expect(widget.taxTreatment).toBe("taxable");
    expect(widget.taxAmount).toBe(5);
  });
});

// -----------------------------------------------------------------------------
// Tax reconciliation
// -----------------------------------------------------------------------------

describe("15Q · tax reconciliation across mixed taxable + non-taxable lines", () => {
  it("reconciles two taxable lines + one non-taxable penalty at 5 %", () => {
    const r = reconcileTax({
      lines: [
        { description: "Membership fee A", quantity: null, unitPrice: null, amount: 500, taxRate: null, taxAmount: null, taxTreatment: "taxable", evidence: ["member_dues_language"], confidence: 80, lineNo: 0 },
        { description: "Membership fee B", quantity: null, unitPrice: null, amount: 300, taxRate: null, taxAmount: null, taxTreatment: "taxable", evidence: ["member_dues_language"], confidence: 80, lineNo: 1 },
        { description: "Late payment penalty", quantity: null, unitPrice: null, amount: 50, taxRate: null, taxAmount: null, taxTreatment: "exempt", evidence: ["penalty_or_finance_charge"], confidence: 85, lineNo: 2 },
      ],
      printedSubtotal: null,
      printedTax: 40,
      printedTotal: 890,
    });
    expect(r.outcome).toBe("reconciled_single_rate");
    expect(r.inferredRate).toBe(5);
    expect(r.taxableSubtotal).toBe(800);
    expect(r.nonTaxableSubtotal).toBe(50);
    expect(r.inferredTax).toBe(40);
  });

  it("recognises the founder-priority case: dues + penalty, 5 % on dues only", () => {
    // Behavioural test of the founder-brief pattern (still no CPA
    // acceptance strings — synthetic).
    const r = reconcileTax({
      lines: [
        { description: "Professional membership fee (senior)", quantity: null, unitPrice: null, amount: 600, taxRate: null, taxAmount: null, taxTreatment: "taxable", evidence: ["member_dues_language"], confidence: 70, lineNo: 0 },
        { description: "Regional levy", quantity: null, unitPrice: null, amount: 200, taxRate: null, taxAmount: null, taxTreatment: "taxable", evidence: ["member_dues_language"], confidence: 60, lineNo: 1 },
        { description: "Late-payment penalty (annual)", quantity: null, unitPrice: null, amount: 75, taxRate: null, taxAmount: null, taxTreatment: "exempt", evidence: ["penalty_or_finance_charge"], confidence: 85, lineNo: 2 },
      ],
      printedSubtotal: 800,
      printedTax: 40,
      printedTotal: 915,
    });
    expect(r.outcome).toBe("reconciled_single_rate");
    expect(r.inferredRate).toBe(5);
    expect(r.taxableSubtotal).toBe(800);
    expect(r.nonTaxableSubtotal).toBe(75);
  });

  it("reports 'reconciled_no_tax' cleanly when no taxable lines and no printed tax", () => {
    const r = reconcileTax({
      lines: [
        { description: "Interest charge", quantity: null, unitPrice: null, amount: 30, taxRate: null, taxAmount: null, taxTreatment: "exempt", evidence: ["penalty_or_finance_charge"], confidence: 85, lineNo: 0 },
      ],
      printedSubtotal: null, printedTax: 0, printedTotal: 30,
    });
    expect(r.outcome).toBe("reconciled_no_tax");
    expect(r.inferredTax).toBe(0);
  });

  it("returns an actionable message when subtotal + tax != total", () => {
    const r = reconcileTax({
      lines: [
        { description: "A", quantity: null, unitPrice: null, amount: 100, taxRate: null, taxAmount: null, taxTreatment: "taxable", evidence: [], confidence: 60, lineNo: 0 },
      ],
      printedSubtotal: 100, printedTax: 5, printedTotal: 200,   // wrong total
    });
    expect(r.outcome).not.toBe("reconciled_single_rate");
    expect(r.actionable).toBeTruthy();
  });
});

// -----------------------------------------------------------------------------
// Identifier taxonomy
// -----------------------------------------------------------------------------

describe("15Q · identifier taxonomy — labelled numbers, alternates preserved", () => {
  const text = [
    "Invoice Number: 92348",
    "Member Number: 55321",
    "Customer #: C-88",
    "PO: PO-9999",
    "GST/HST 123456789RT0001",
  ].join("\n");
  const ids = extractIdentifiers(text);

  it("classifies each number by its label", () => {
    const kinds = new Set(ids.map((c) => c.kind));
    expect(kinds.has("invoice_number")).toBe(true);
    expect(kinds.has("member_number")).toBe(true);
    expect(kinds.has("customer_number")).toBe(true);
    expect(kinds.has("purchase_order")).toBe(true);
    expect(kinds.has("tax_registration")).toBe(true);
  });

  it("pickIdentifier(invoice_number) returns the labelled invoice number, not the member number", () => {
    const p = pickIdentifier(ids, "invoice_number");
    expect(p.leader?.value).toBe("92348");
    // The member number is NOT in the invoice_number alternates.
    for (const alt of p.alternates) expect(alt.value).not.toBe("55321");
  });

  it("pickIdentifier(member_number) is independently available", () => {
    const p = pickIdentifier(ids, "member_number");
    expect(p.leader?.value).toBe("55321");
  });
});

// -----------------------------------------------------------------------------
// Economic-purpose classifier
// -----------------------------------------------------------------------------

describe("15Q · economic-purpose classifier — concept > keyword", () => {
  it("classifies a professional-body invoice with dues lines as employee_professional_membership_dues", () => {
    const cands = classifyEconomicPurpose({
      supplierName: "The Provincial Institute of Something",
      lineDescriptions: ["Annual professional dues", "Regional membership fee", "Late payment penalty"],
      paymentDirection: "club_pays_vendor",
      hasPenaltyLine: true,
      hasMembershipLine: true,
      hasProfessionalCredentialContext: true,
    });
    expect(cands[0].purpose).toBe("employee_professional_membership_dues");
    expect(cands[0].supporting.length).toBeGreaterThanOrEqual(3);
    // NOT classified as external accounting services.
    const external = cands.find((c) => c.purpose === "external_accounting_or_audit_services");
    expect(external?.score ?? 0).toBeLessThan(cands[0].score);
  });

  it("classifies an external accounting FIRM invoice as external_accounting_or_audit_services", () => {
    const cands = classifyEconomicPurpose({
      supplierName: "Smith & Partners LLP",
      lineDescriptions: ["Audit services for year ended December 31", "Tax return preparation"],
      paymentDirection: "club_pays_vendor",
      hasPenaltyLine: false,
      hasMembershipLine: false,
      hasProfessionalCredentialContext: false,
    });
    expect(cands[0].purpose).toBe("external_accounting_or_audit_services");
  });

  it("classifies a member paying the club as member_dues_charged_by_club (REVENUE, not expense)", () => {
    const cands = classifyEconomicPurpose({
      supplierName: null,
      lineDescriptions: ["Annual dues — 2026", "Initiation fee"],
      paymentDirection: "member_pays_club",
      hasPenaltyLine: false,
      hasMembershipLine: true,
      hasProfessionalCredentialContext: false,
    });
    expect(cands[0].purpose).toBe("member_dues_charged_by_club");
    // The employee-membership expense concept is contradicted by
    // the reversed direction.
    const employeeDues = cands.find((c) => c.purpose === "employee_professional_membership_dues");
    expect(employeeDues?.score ?? 0).toBeLessThan(cands[0].score);
  });

  it("classifies a standalone penalty invoice as penalties_and_late_fees", () => {
    const cands = classifyEconomicPurpose({
      supplierName: "Utility Company",
      lineDescriptions: ["Late-payment penalty"],
      paymentDirection: "club_pays_vendor",
      hasPenaltyLine: true,
      hasMembershipLine: false,
      hasProfessionalCredentialContext: false,
    });
    expect(cands[0].purpose).toBe("penalties_and_late_fees");
  });

  it("returns multiple candidates with supporting evidence for each", () => {
    const cands = classifyEconomicPurpose({
      supplierName: "The Provincial Institute of Something",
      lineDescriptions: ["Annual professional dues"],
      paymentDirection: "club_pays_vendor",
      hasPenaltyLine: false,
      hasMembershipLine: true,
      hasProfessionalCredentialContext: true,
    });
    expect(cands.length).toBeGreaterThanOrEqual(1);
    for (const c of cands) {
      expect(c.classificationConcept).toBeTruthy();
      expect(c.suggestedAccountRoles.length).toBeGreaterThan(0);
    }
  });
});
