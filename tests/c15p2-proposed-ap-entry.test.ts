// Sprint 3 · Checkpoint 15P-2 (2026-07-27) — buildProposedApEntry
// unit tests. The founder rule from §Phase 10:
//
//   "Do not independently calculate one entry in the React
//   component and another entry in the server action."
//
// This test suite locks the SHAPE and the ARITHMETIC of the
// canonical builder — every caller (client preview, server post,
// future adapters) MUST produce identical output for identical
// inputs.

import { describe, expect, it } from "vitest";
import { buildProposedApEntry } from "@/lib/ap-intelligence/proposed-ap-entry";

const EXPENSE = {
  id: "acct_expense_6054",
  accountNumber: "6054",
  name: "Computer & IT Services",
  type: "EXPENSE" as const,
};
const AP_CONTROL = {
  id: "acct_2010",
  accountNumber: "2010",
  name: "Accounts Payable",
};
const GST_ITC = {
  id: "acct_1310",
  accountNumber: "1310",
  name: "GST Recoverable (ITC)",
};

describe("15P-2 · Microsoft invoice — the founder's worked example", () => {
  // Subtotal: $29.80 · GST: $1.49 · Gross: $31.29 CAD · 6054 Computer & IT
  const entry = buildProposedApEntry({
    currency: "CAD",
    subtotal: "29.80",
    tax: "1.49",
    gross: "31.29",
    expenseAccount: EXPENSE,
    apControlAccount: AP_CONTROL,
    taxTreatment: { kind: "RECOVERABLE", recoverableAccount: GST_ITC },
    vendorLegalName: "Microsoft Corporation",
    invoiceRef: "E0701097E3",
  });

  it("produces exactly 3 lines (expense DR, ITC DR, AP CR)", () => {
    expect(entry.lines).toHaveLength(3);
  });

  it("line 1 — DR 6054 Computer & IT Services $29.80", () => {
    const l = entry.lines[0];
    expect(l.accountNumber).toBe("6054");
    expect(l.accountName).toBe("Computer & IT Services");
    expect(l.debit).toBe("29.80");
    expect(l.credit).toBe("0.00");
    expect(l.role).toBe("EXPENSE");
  });

  it("line 2 — DR 1310 GST Recoverable (ITC) $1.49", () => {
    const l = entry.lines[1];
    expect(l.accountNumber).toBe("1310");
    expect(l.debit).toBe("1.49");
    expect(l.credit).toBe("0.00");
    expect(l.role).toBe("TAX_RECOVERABLE");
    expect(l.description).toBe("Recoverable tax (ITC)");
  });

  it("line 3 — CR 2010 Accounts Payable $31.29", () => {
    const l = entry.lines[2];
    expect(l.accountNumber).toBe("2010");
    expect(l.debit).toBe("0.00");
    expect(l.credit).toBe("31.29");
    expect(l.role).toBe("AP_CONTROL");
  });

  it("totals: debits 31.29 / credits 31.29 / difference 0.00 / balanced", () => {
    expect(entry.totalDebits).toBe("31.29");
    expect(entry.totalCredits).toBe("31.29");
    expect(entry.difference).toBe("0.00");
    expect(entry.isBalanced).toBe(true);
  });

  it("emits no warnings on a clean invoice", () => {
    expect(entry.warnings).toHaveLength(0);
  });

  it("carries currency + subtotal + tax + gross on the return shape", () => {
    expect(entry.currency).toBe("CAD");
    expect(entry.subtotal).toBe("29.80");
    expect(entry.tax).toBe("1.49");
    expect(entry.gross).toBe("31.29");
  });
});

describe("15P-2 · non-recoverable tax rolls into expense", () => {
  const entry = buildProposedApEntry({
    currency: "CAD",
    subtotal: "100.00",
    tax: "5.00",
    gross: "105.00",
    expenseAccount: EXPENSE,
    apControlAccount: AP_CONTROL,
    taxTreatment: { kind: "NON_RECOVERABLE" },
    vendorLegalName: "X",
    invoiceRef: "N-1",
  });
  it("produces 2 lines (expense DR incl tax, AP CR)", () => {
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines[0].debit).toBe("105.00");
    expect(entry.lines[1].credit).toBe("105.00");
  });
  it("still balances", () => {
    expect(entry.isBalanced).toBe(true);
    expect(entry.totalDebits).toBe(entry.totalCredits);
  });
  it("emits a note explaining the roll-in", () => {
    expect(entry.warnings.some((w) => /Non-recoverable tax.*rolled into/.test(w))).toBe(true);
  });
});

describe("15P-2 · zero-tax invoice (exempt)", () => {
  const entry = buildProposedApEntry({
    currency: "CAD",
    subtotal: "50.00",
    tax: "0.00",
    gross: "50.00",
    expenseAccount: EXPENSE,
    apControlAccount: AP_CONTROL,
    taxTreatment: { kind: "NONE" },
    vendorLegalName: "X",
    invoiceRef: "N-2",
  });
  it("produces 2 lines (no ITC line, no expense-tax roll)", () => {
    expect(entry.lines).toHaveLength(2);
    expect(entry.lines[0].debit).toBe("50.00");
    expect(entry.lines[1].credit).toBe("50.00");
  });
  it("balances at $50 both sides", () => {
    expect(entry.totalDebits).toBe("50.00");
    expect(entry.totalCredits).toBe("50.00");
    expect(entry.isBalanced).toBe(true);
  });
});

describe("15P-2 · arithmetic-mismatch WARNS but still balances the DR side vs CR side", () => {
  // subtotal 100 + tax 5 = 105 but gross = 106 → mismatch warning +
  // the CR uses gross ($106) so the entry is intentionally unbalanced
  // (DR 105, CR 106). The preview surfaces this and posting is blocked.
  const entry = buildProposedApEntry({
    currency: "CAD",
    subtotal: "100.00",
    tax: "5.00",
    gross: "106.00",   // wrong on purpose
    expenseAccount: EXPENSE,
    apControlAccount: AP_CONTROL,
    taxTreatment: { kind: "RECOVERABLE", recoverableAccount: GST_ITC },
    vendorLegalName: "X",
    invoiceRef: "M-1",
  });
  it("emits an arithmetic-mismatch warning", () => {
    expect(entry.warnings.some((w) => /Arithmetic mismatch/.test(w))).toBe(true);
  });
  it("is NOT balanced — preview surfaces this, posting is blocked", () => {
    expect(entry.isBalanced).toBe(false);
    expect(entry.difference).not.toBe("0.00");
  });
});

describe("15P-2 · ASSET-type debit rolls to ASSET role (capital)", () => {
  const asset = { id: "acct_1540", accountNumber: "1540", name: "Equipment & Fixtures", type: "ASSET" as const };
  const entry = buildProposedApEntry({
    currency: "CAD",
    subtotal: "10000.00",
    tax: "500.00",
    gross: "10500.00",
    expenseAccount: asset,
    apControlAccount: AP_CONTROL,
    taxTreatment: { kind: "RECOVERABLE", recoverableAccount: GST_ITC },
    vendorLegalName: "Y",
    invoiceRef: "A-1",
  });
  it("first line role = ASSET (not EXPENSE)", () => {
    expect(entry.lines[0].role).toBe("ASSET");
    expect(entry.lines[0].accountNumber).toBe("1540");
  });
  it("still balances at 10500", () => {
    expect(entry.totalDebits).toBe("10500.00");
    expect(entry.totalCredits).toBe("10500.00");
  });
});

describe("15P-2 · description carries the vendor + invoice ref", () => {
  const entry = buildProposedApEntry({
    currency: "CAD",
    subtotal: "29.80",
    tax: "1.49",
    gross: "31.29",
    expenseAccount: EXPENSE,
    apControlAccount: AP_CONTROL,
    taxTreatment: { kind: "RECOVERABLE", recoverableAccount: GST_ITC },
    vendorLegalName: "Microsoft Corporation",
    invoiceRef: "E0701097E3",
  });
  it("expense line description is 'Microsoft Corporation · E0701097E3'", () => {
    expect(entry.lines[0].description).toBe("Microsoft Corporation · E0701097E3");
  });
  it("AP control line description matches the expense line pattern", () => {
    expect(entry.lines[2].description).toBe("Microsoft Corporation · E0701097E3");
  });
});
