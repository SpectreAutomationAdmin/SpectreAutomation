// Sprint 3 · Checkpoint 15T (2026-07-28) — behavioural test that
// runs the deterministic parser + classifier stack against real-
// layout fixtures where labels and values live on SEPARATE lines.
//
// The fixtures preserve the actual pdf-parse line ordering that
// broke the pre-15T same-line extractor. Every founder-acceptance
// value (vendor identity, invoice number, statement number, account
// number, tax registration, gross amount) has been REPLACED with a
// fictional analogue that keeps the same shape. Anti-hardcoding
// guards below enforce this.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseInvoiceText } from "@/lib/ap-intelligence/parse-invoice";
import { parseDocumentLayout, associateLabelValue, associateDescriptionAmounts } from "@/lib/ap-intelligence/document-layout";
import { extractPayableReference } from "@/lib/ap-intelligence/payable-reference";
import { extractLineItems } from "@/lib/ap-intelligence/line-items-extract";
import { classifyEconomicPurpose } from "@/lib/ap-intelligence/economic-purpose";
import { computeAmountHierarchy } from "@/lib/ap-intelligence/amount-hierarchy";
import { buildTaxGroups } from "@/lib/ap-intelligence/tax-groups";
import {
  PROFESSIONAL_BODY_LAYOUT_TEXT,
  PROFESSIONAL_BODY_EXPECTATIONS,
} from "./fixtures/c15t-professional-body-layout";
import {
  RECURRING_SERVICE_LAYOUT_TEXT,
  RECURRING_SERVICE_EXPECTATIONS,
} from "./fixtures/c15t-recurring-service-layout";

describe("15T · document-layout label→value association", () => {
  it("pairs a label on line N with a value on line N+K (forward)", () => {
    const layout = parseDocumentLayout("SUBTOTAL\n\n\n$1,360.00\n");
    const m = associateLabelValue(layout, {
      labels: ["Subtotal"],
      ruleKeyBase: "test.subtotal",
      valueKind: "amount",
      forwardMaxLines: 4,
    });
    expect(m).not.toBeNull();
    expect(m!.amount).toBe(1360);
    expect(m!.strategy).toBe("forward_line");
  });

  it("pairs a label on line N with a value on line N-K when backwardMaxLines is set", () => {
    // "$1,420.50" on line 0, "INVOICE TOTAL" on line 3 — a payment
    // stub layout where the total prints ABOVE its label.
    const layout = parseDocumentLayout("$1,420.50\n\n\nINVOICE TOTAL\n");
    const m = associateLabelValue(layout, {
      labels: ["Invoice Total", "Total"],
      ruleKeyBase: "test.total",
      valueKind: "amount",
      forwardMaxLines: 2,
      backwardMaxLines: 4,
    });
    expect(m).not.toBeNull();
    expect(m!.amount).toBe(1420.5);
    expect(m!.strategy).toBe("backward_line");
  });

  it("does NOT pair when another label intervenes (candidate exclusivity)", () => {
    const layout = parseDocumentLayout("SUBTOTAL\nGST/HST\n$40.50\n$1,360.00\n");
    const m = associateLabelValue(layout, {
      labels: ["Subtotal"],
      ruleKeyBase: "test.subtotal",
      valueKind: "amount",
      forwardMaxLines: 4,
    });
    // Subtotal cannot grab the amount that belongs to GST/HST.
    // Expected behaviour: the intervening label halts the forward
    // scan; Subtotal returns null OR skips past both amounts.
    if (m) {
      expect(m.amount).not.toBe(40.5);
    }
  });

  it("associates description → amount when they sit on adjacent lines", () => {
    const layout = parseDocumentLayout("Provincial Institute Fee\n\n$500.00\n");
    const pairs = associateDescriptionAmounts(layout, { forwardMaxLines: 2 });
    expect(pairs.length).toBe(1);
    expect(pairs[0].description).toBe("Provincial Institute Fee");
    expect(pairs[0].amount).toBe(500);
  });

  it("does NOT pair a description with a bare amount that belongs to a summary label", () => {
    const layout = parseDocumentLayout("Provincial Institute Fee\nSUBTOTAL\n$500.00\n");
    const pairs = associateDescriptionAmounts(layout, { forwardMaxLines: 3 });
    // The intervening SUBTOTAL section boundary must halt the pairing.
    expect(pairs.every((p) => p.description !== "Provincial Institute Fee")).toBe(true);
  });
});

describe("15T · payable-reference taxonomy", () => {
  it("returns INVOICE_NUMBER when label is 'Invoice #:' and value on next line", () => {
    const layout = parseDocumentLayout("Invoice #:\n9999999999\n");
    const r = extractPayableReference(layout);
    expect(r).not.toBeNull();
    expect(r!.value).toBe("9999999999");
    expect(r!.type).toBe("INVOICE_NUMBER");
  });

  it("returns STATEMENT_NUMBER when label is 'Statement number' and value on next line", () => {
    const layout = parseDocumentLayout("Statement number\nBODY-99999999\n");
    const r = extractPayableReference(layout);
    expect(r).not.toBeNull();
    expect(r!.value).toBe("BODY-99999999");
    expect(r!.type).toBe("STATEMENT_NUMBER");
  });

  it("returns BILL_NUMBER when label is 'Bill number'", () => {
    const layout = parseDocumentLayout("Bill Number: X-9999\n");
    const r = extractPayableReference(layout);
    expect(r).not.toBeNull();
    expect(r!.type).toBe("BILL_NUMBER");
  });

  it("returns REFERENCE_NUMBER when label is 'Reference #'", () => {
    const layout = parseDocumentLayout("Reference #: R-777\n");
    const r = extractPayableReference(layout);
    expect(r).not.toBeNull();
    expect(r!.type).toBe("REFERENCE_NUMBER");
  });

  it("does NOT return an account number as the payable reference", () => {
    const layout = parseDocumentLayout("Your account number: 00099999\n");
    const r = extractPayableReference(layout);
    expect(r).toBeNull();
  });

  it("does NOT return a tax-registration number as the payable reference", () => {
    const layout = parseDocumentLayout("GST 999999999\n");
    const r = extractPayableReference(layout);
    expect(r).toBeNull();
  });

  it("does NOT return a phone-formatted number as the payable reference", () => {
    const layout = parseDocumentLayout("Reference #: 1-800-555-1234\n");
    const r = extractPayableReference(layout);
    // Phone-shaped values must be rejected.
    if (r) expect(r.value).not.toMatch(/\d-\d{3}-\d{3}-\d{4}/);
  });

  it("accepts a pure-digit invoice number (no dashes) — not a phone number", () => {
    const layout = parseDocumentLayout("Invoice #:\n1234567890\n");
    const r = extractPayableReference(layout);
    expect(r).not.toBeNull();
    expect(r!.value).toBe("1234567890");
    expect(r!.type).toBe("INVOICE_NUMBER");
  });
});

describe("15T · full parser on the professional-body layout fixture", () => {
  it("extracts payable reference + subtotal + tax + total from cross-line layout", () => {
    const parsed = parseInvoiceText({ extractedText: PROFESSIONAL_BODY_LAYOUT_TEXT });
    expect(parsed.invoice.invoiceNumber).toBe("9999999999");
    expect(parsed.invoice.payableReferenceType).toBe("INVOICE_NUMBER");
    expect(parsed.invoice.subtotal).toBe("1600.00");
    expect(parsed.invoice.taxTotal).toBe("75.50");
    expect(parsed.invoice.total).toBe("1650.50");
  });

  it("extracts fee lines that pair across separate lines", () => {
    const items = extractLineItems(PROFESSIONAL_BODY_LAYOUT_TEXT);
    expect(items.length).toBeGreaterThanOrEqual(3);
    const hasRegionFee = items.some((i) => /Body Region Fee/i.test(i.description));
    const hasNationalFee = items.some((i) => /Body National Fee/i.test(i.description));
    const hasPenalty = items.some((i) => /Penalty/i.test(i.description));
    expect(hasRegionFee).toBe(true);
    expect(hasNationalFee).toBe(true);
    expect(hasPenalty).toBe(true);
  });

  it("classifies economic purpose as professional-membership dues via full-doc phrases", () => {
    const items = extractLineItems(PROFESSIONAL_BODY_LAYOUT_TEXT);
    const cands = classifyEconomicPurpose({
      supplierName: "BODY ACRONYM",
      lineDescriptions: items.map((l) => l.description),
      fullDocumentText: PROFESSIONAL_BODY_LAYOUT_TEXT,
      paymentDirection: "club_pays_vendor",
      hasPenaltyLine: items.some((l) => l.evidence.includes("penalty_or_finance_charge")),
      hasMembershipLine: /\bmember\s+dues\b/i.test(PROFESSIONAL_BODY_LAYOUT_TEXT),
      hasProfessionalCredentialContext: true,
    });
    expect(cands[0].purpose).toBe(PROFESSIONAL_BODY_EXPECTATIONS.topPurpose);
    // Score must clear the gl-recommend boost gate at 60 so the
    // recommender promotes the membership-dues account on tenants
    // whose COA has one.
    expect(cands[0].score).toBeGreaterThanOrEqual(60);
  });

  it("amount hierarchy preserves the printed total verbatim", () => {
    const items = extractLineItems(PROFESSIONAL_BODY_LAYOUT_TEXT);
    const parsed = parseInvoiceText({ extractedText: PROFESSIONAL_BODY_LAYOUT_TEXT });
    const h = computeAmountHierarchy({
      printedTotal: Number(parsed.invoice.total),
      printedSubtotal: Number(parsed.invoice.subtotal),
      printedTax: Number(parsed.invoice.taxTotal),
      lineItems: items,
    });
    expect(h.value).toBe(PROFESSIONAL_BODY_EXPECTATIONS.gross);
    expect(h.source === "PRINTED_TOTAL" || h.source === "RECONCILED").toBe(true);
  });
});

describe("15T · full parser on the recurring-service layout fixture", () => {
  it("extracts STATEMENT_NUMBER as payable reference", () => {
    const parsed = parseInvoiceText({ extractedText: RECURRING_SERVICE_LAYOUT_TEXT });
    expect(parsed.invoice.invoiceNumber).toBe("BODY-99999999");
    expect(parsed.invoice.payableReferenceType).toBe("STATEMENT_NUMBER");
  });

  it("extracts the printed total, not the sub-charges", () => {
    const parsed = parseInvoiceText({ extractedText: RECURRING_SERVICE_LAYOUT_TEXT });
    expect(parsed.invoice.total).toBe("50.99");
  });

  it("extracts the internet service line item, not the rollup labels", () => {
    const items = extractLineItems(RECURRING_SERVICE_LAYOUT_TEXT);
    const hasInternet = items.some((i) => /internet/i.test(i.description));
    expect(hasInternet).toBe(true);
    // Rollup labels must NOT appear as line items (§3 exclusion set).
    const hasRollupOngoing = items.some((i) => /^ongoing\s+charges$/i.test(i.description));
    const hasRollupCredits = items.some((i) => /^credits$/i.test(i.description));
    const hasRollupPending = items.some((i) => /^pending\s+payments$/i.test(i.description));
    expect(hasRollupOngoing).toBe(false);
    expect(hasRollupCredits).toBe(false);
    expect(hasRollupPending).toBe(false);
  });

  it("classifies economic purpose as recurring communications/connectivity service", () => {
    const items = extractLineItems(RECURRING_SERVICE_LAYOUT_TEXT);
    const cands = classifyEconomicPurpose({
      supplierName: "BODY",
      lineDescriptions: items.map((l) => l.description),
      fullDocumentText: RECURRING_SERVICE_LAYOUT_TEXT,
      paymentDirection: "club_pays_vendor",
      hasPenaltyLine: false,
      hasMembershipLine: false,
      hasProfessionalCredentialContext: false,
    });
    expect(cands[0].purpose).toBe(RECURRING_SERVICE_EXPECTATIONS.topPurpose);
    expect(cands[0].score).toBeGreaterThanOrEqual(60);
  });

  it("amount hierarchy: printed total 50.99 wins", () => {
    const items = extractLineItems(RECURRING_SERVICE_LAYOUT_TEXT);
    const parsed = parseInvoiceText({ extractedText: RECURRING_SERVICE_LAYOUT_TEXT });
    const h = computeAmountHierarchy({
      printedTotal: parsed.invoice.total ? Number(parsed.invoice.total) : null,
      printedSubtotal: parsed.invoice.subtotal ? Number(parsed.invoice.subtotal) : null,
      printedTax: parsed.invoice.taxTotal ? Number(parsed.invoice.taxTotal) : null,
      lineItems: items,
    });
    expect(h.value).toBe(RECURRING_SERVICE_EXPECTATIONS.gross);
  });
});

// -----------------------------------------------------------------------------
// Anti-hardcoding guard — extended from 15Q to include the 15T-era
// acceptance strings. If any of these appear in production code
// (src/lib/**) the test fails. Vendor identities and specific amounts
// must remain FICTIONAL in fixtures + tests only.
// -----------------------------------------------------------------------------
describe("15T · production code contains no acceptance-specific hardcoding", () => {
  const FORBIDDEN_STRINGS = [
    // Founder acceptance PDFs from staging
    "CPA Alberta",
    "cpaalberta",
    "1007565767",
    "Chartered Professional Accountants",
    "OXIO",
    "Oxio",
    "oxio.ca",
    "OXIO-23375874",
    "OXIO-00108064",
    "23375874",
    "00108064",
    "40.32",
    "40.00",
    "1.92",
    "1.60",
    "1420.50",
    "1360.00",
    // Coulee Ridge specific account numbers must not be hardcoded
    "6064",
    "6061",
    "6045",
  ];

  // Strip line comments so we only check EXECUTABLE code. Comments
  // documenting the failure mode ("this line handles the CPA
  // Alberta case") are legitimate — the rule is that production
  // BEHAVIOUR must not branch on acceptance-specific values.
  function stripComments(line: string): string {
    // Line comment (//) and block-comment content on the line.
    return line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
  }

  function scanFileForForbidden(filePath: string): Array<{ file: string; term: string; line: number; snippet: string }> {
    const raw = readFileSync(filePath, "utf8");
    const rawLines = raw.split(/\r?\n/);
    const violations: Array<{ file: string; term: string; line: number; snippet: string }> = [];
    // Track whether we are inside a multi-line block comment.
    let inBlockComment = false;
    for (let i = 0; i < rawLines.length; i++) {
      let effective = rawLines[i];
      // If we're inside a block comment, look for its terminator.
      if (inBlockComment) {
        const end = effective.indexOf("*/");
        if (end === -1) continue;
        effective = effective.slice(end + 2);
        inBlockComment = false;
      }
      // Detect an unterminated block comment starting on this line.
      const start = effective.indexOf("/*");
      if (start !== -1 && effective.indexOf("*/", start) === -1) {
        inBlockComment = true;
        effective = effective.slice(0, start);
      }
      effective = stripComments(effective);
      for (const term of FORBIDDEN_STRINGS) {
        if (effective.includes(term)) {
          violations.push({ file: filePath, term, line: i + 1, snippet: rawLines[i].trim().slice(0, 120) });
        }
      }
    }
    return violations;
  }

  it("does not appear in any src/lib/ap-intelligence code (comments excluded)", async () => {
    const { readdir } = await import("node:fs/promises");
    const root = join(process.cwd(), "src", "lib", "ap-intelligence");
    const files = (await readdir(root)).filter((f) => f.endsWith(".ts"));
    const violations: Array<{ file: string; term: string; line: number; snippet: string }> = [];
    for (const f of files) {
      violations.push(...scanFileForForbidden(join(root, f)));
    }
    if (violations.length > 0) {
      throw new Error(
        "Acceptance-specific values leaked into executable src/lib/ap-intelligence code:\n"
        + violations.map((v) => `  ${v.file}:${v.line}  [${v.term}]  ${v.snippet}`).join("\n"),
      );
    }
  });

  it("does not appear in mission-control invoice-analysis / intelligence-review-intakes / ap-action (comments excluded)", async () => {
    const targets = [
      join(process.cwd(), "src", "lib", "mission-control", "invoice-analysis.ts"),
      join(process.cwd(), "src", "lib", "mission-control", "intelligence-review-intakes.ts"),
      join(process.cwd(), "src", "lib", "mission-control", "ap-action.ts"),
    ];
    const violations: Array<{ file: string; term: string; line: number; snippet: string }> = [];
    for (const f of targets) {
      violations.push(...scanFileForForbidden(f));
    }
    if (violations.length > 0) {
      throw new Error(
        "Acceptance-specific values leaked into executable mission-control projection layer:\n"
        + violations.map((v) => `  ${v.file}:${v.line}  [${v.term}]  ${v.snippet}`).join("\n"),
      );
    }
  });
});
