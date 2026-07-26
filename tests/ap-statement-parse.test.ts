// Sprint 3 Checkpoint 15G (2026-07-24) — Pure-function tests for
// statement extraction, line classification, and arithmetic
// validation.

import { describe, expect, it } from "vitest";
import { parseStatementText } from "@/lib/ap-statement-intelligence/parse-statement";
import { classifyStatementLine } from "@/lib/ap-statement-intelligence/classify-line";
import { validateStatementArithmetic } from "@/lib/ap-statement-intelligence/balance-validate";
import { STATEMENT_RULE_VERSION } from "@/lib/ap-statement-intelligence/types";

const FAKE_STATEMENT_TEXT = `
NORTHSIDE COURSE MAINTENANCE INC.
1234 Fairway Drive · Calgary, AB · T2N 1N4

STATEMENT OF ACCOUNT
Account Number: NS-12345
Statement Date: 2026-06-30
Period Start: 2026-06-01
Period End:   2026-06-30

Opening Balance:  1000.00
Closing Balance:  1725.00
Amount Due:       1725.00

Date         Ref          Description                Debit       Credit      Balance
2026-06-01   OB           Opening Balance                                    1000.00
2026-06-05   INV-1001     Monthly grounds contract   525.00                  1525.00
2026-06-10   PMT-2001     Payment received                       500.00      1025.00
2026-06-15   INV-1002     Fairway aeration           700.00                  1725.00
`;

describe("classifyStatementLine — deterministic", () => {
  it("classifies INVOICE from description", () => {
    expect(classifyStatementLine({ description: "Monthly service invoice", referenceNumber: null, debitAmount: "100.00", creditAmount: null })).toBe("INVOICE");
  });
  it("classifies PAYMENT from description", () => {
    expect(classifyStatementLine({ description: "Payment received", referenceNumber: null, debitAmount: null, creditAmount: "100.00" })).toBe("PAYMENT");
  });
  it("classifies OPENING_BALANCE", () => {
    expect(classifyStatementLine({ description: "Opening balance", referenceNumber: null, debitAmount: null, creditAmount: null })).toBe("OPENING_BALANCE");
  });
  it("classifies CREDIT_NOTE from description", () => {
    expect(classifyStatementLine({ description: "Return / credit note", referenceNumber: null, debitAmount: null, creditAmount: "50.00" })).toBe("CREDIT_NOTE");
  });
  it("classifies FINANCE_CHARGE", () => {
    expect(classifyStatementLine({ description: "Finance charge on overdue balance", referenceNumber: null, debitAmount: "25.00", creditAmount: null })).toBe("FINANCE_CHARGE");
  });
  it("falls back to INVOICE on debit-only line with no description hint", () => {
    expect(classifyStatementLine({ description: "Service delivery", referenceNumber: null, debitAmount: "300.00", creditAmount: null })).toBe("INVOICE");
  });
  it("falls back to PAYMENT on credit-only line", () => {
    expect(classifyStatementLine({ description: "Amount received", referenceNumber: null, debitAmount: null, creditAmount: "100.00" })).toBe("PAYMENT");
  });
  it("classifies INVOICE from INV reference", () => {
    expect(classifyStatementLine({ description: "", referenceNumber: "INV-2001", debitAmount: null, creditAmount: null })).toBe("INVOICE");
  });
  it("classifies PAYMENT from CHQ reference", () => {
    expect(classifyStatementLine({ description: "", referenceNumber: "CHQ-1234", debitAmount: null, creditAmount: "500.00" })).toBe("PAYMENT");
  });
  it("returns UNKNOWN when nothing matches", () => {
    expect(classifyStatementLine({ description: "misc", referenceNumber: "MISC", debitAmount: null, creditAmount: null })).toBe("UNKNOWN");
  });
});

describe("parseStatementText — happy path", () => {
  it("extracts header (statement date, period, balances, currency)", () => {
    const p = parseStatementText({ extractedText: FAKE_STATEMENT_TEXT });
    expect(p.state).toBe("STRUCTURED");
    expect(p.ruleVersion).toBe(STATEMENT_RULE_VERSION);
    expect(p.header.statementDate).toBe("2026-06-30");
    expect(p.header.periodStart).toBe("2026-06-01");
    expect(p.header.periodEnd).toBe("2026-06-30");
    expect(p.header.openingBalance).toBe("1000.00");
    expect(p.header.closingBalance).toBe("1725.00");
    expect(p.header.amountDue).toBe("1725.00");
    expect(p.header.vendorAccountNumber).toBe("NS-12345");
    expect(p.header.currency).toBe("CAD");
    expect(p.header.vendorNameGuess).toContain("NORTHSIDE");
  });
  it("extracts >= 3 transaction lines with correct classification", () => {
    const p = parseStatementText({ extractedText: FAKE_STATEMENT_TEXT });
    expect(p.lines.length).toBeGreaterThanOrEqual(3);
    // First line is opening balance
    const opening = p.lines.find((l) => l.transactionKind === "OPENING_BALANCE");
    expect(opening).toBeDefined();
    // At least one INVOICE + one PAYMENT
    expect(p.lines.some((l) => l.transactionKind === "INVOICE")).toBe(true);
    expect(p.lines.some((l) => l.transactionKind === "PAYMENT")).toBe(true);
  });
});

describe("parseStatementText — refusal states", () => {
  it("returns DOCUMENT_UNREADABLE for empty text", () => {
    const p = parseStatementText({ extractedText: "" });
    expect(p.state).toBe("DOCUMENT_UNREADABLE");
  });
  it("returns UNSUPPORTED_LAYOUT when nothing recognisable", () => {
    const p = parseStatementText({ extractedText: "This is prose, not a statement." });
    expect(["UNSUPPORTED_LAYOUT", "INSUFFICIENT_EVIDENCE"]).toContain(p.state);
  });
});

describe("validateStatementArithmetic — opening + activity = closing", () => {
  it("no findings when arithmetic holds", () => {
    const p = parseStatementText({ extractedText: FAKE_STATEMENT_TEXT });
    const findings = validateStatementArithmetic(p);
    expect(findings).toEqual([]);
  });
  it("flags closing_balance_mismatch when totals disagree", () => {
    const p = parseStatementText({ extractedText: FAKE_STATEMENT_TEXT.replace("Closing Balance:  1725.00", "Closing Balance:  2000.00") });
    const findings = validateStatementArithmetic(p);
    expect(findings.map((f) => f.key)).toContain("ap.statement.closing_balance_mismatch");
  });
  it("preserves decimal precision (no float drift)", () => {
    const custom = `
Opening Balance: 100.10
Closing Balance: 100.30

Date         Ref     Description   Debit   Credit   Balance
2026-01-05   INV-A   Charge        0.20             100.30
`;
    const p = parseStatementText({ extractedText: custom });
    // 100.10 + 0.20 = 100.30 exactly, no float drift.
    const findings = validateStatementArithmetic(p);
    expect(findings.some((f) => f.key.includes("mismatch"))).toBe(false);
  });
});
