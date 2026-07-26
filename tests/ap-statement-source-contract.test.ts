// Sprint 3 Checkpoint 15G (2026-07-24) — Source-contract locks for
// the statement reconciliation layer.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const TYPES = readFileSync(join(process.cwd(), "src/lib/ap-statement-intelligence/types.ts"), "utf8");
const PARSE = readFileSync(join(process.cwd(), "src/lib/ap-statement-intelligence/parse-statement.ts"), "utf8");
const CLASSIFY = readFileSync(join(process.cwd(), "src/lib/ap-statement-intelligence/classify-line.ts"), "utf8");
const VENDOR = readFileSync(join(process.cwd(), "src/lib/ap-statement-intelligence/vendor-resolve.ts"), "utf8");
const MATCH_INV = readFileSync(join(process.cwd(), "src/lib/ap-statement-intelligence/match-invoice.ts"), "utf8");
const MATCH_PMT = readFileSync(join(process.cwd(), "src/lib/ap-statement-intelligence/match-payment.ts"), "utf8");
const MATCH_CR = readFileSync(join(process.cwd(), "src/lib/ap-statement-intelligence/match-credit.ts"), "utf8");
const BALANCE = readFileSync(join(process.cwd(), "src/lib/ap-statement-intelligence/balance-validate.ts"), "utf8");
const ANALYSE = readFileSync(join(process.cwd(), "src/lib/ap-statement-intelligence/analyse.ts"), "utf8");
const MATERIALISE = readFileSync(join(process.cwd(), "src/lib/ap-statement-intelligence/materialise.ts"), "utf8");
const ACTIONS = readFileSync(join(process.cwd(), "src/lib/ap-statement-intelligence/actions.ts"), "utf8");
const CROSSLINK = readFileSync(join(process.cwd(), "src/lib/ap-statement-intelligence/cross-link.ts"), "utf8");
const EV_ROUTE = readFileSync(join(process.cwd(), "src/app/api/mission-control/work-intake/[id]/statement-evidence/route.ts"), "utf8");
const ACT_ROUTE = readFileSync(join(process.cwd(), "src/app/api/mission-control/work-intake/[id]/statement-actions/route.ts"), "utf8");
const CLI = readFileSync(join(process.cwd(), "bin/ap-statement-materialise.ts"), "utf8");
const DOCTYPES = readFileSync(join(process.cwd(), "src/lib/documents/types.ts"), "utf8");

describe("closed enumerations", () => {
  it("STATEMENT_EXTRACTION_STATES cover the 5 approved values", () => {
    for (const s of ["STRUCTURED", "PARTIALLY_STRUCTURED", "DOCUMENT_UNREADABLE", "UNSUPPORTED_LAYOUT", "INSUFFICIENT_EVIDENCE"]) {
      expect(TYPES).toMatch(new RegExp(`"${s}"`));
    }
  });
  it("STATEMENT_TRANSACTION_KINDS cover the 9 approved kinds", () => {
    for (const s of ["INVOICE", "CREDIT_NOTE", "PAYMENT", "FINANCE_CHARGE", "OPENING_BALANCE", "BALANCE_FORWARD", "ADJUSTMENT", "OTHER", "UNKNOWN"]) {
      expect(TYPES).toMatch(new RegExp(`"${s}"`));
    }
  });
  it("STATEMENT_MATCH_STATES cover invoice + payment + credit outcomes", () => {
    for (const s of ["EXACT_MATCH", "PROBABLE_MATCH", "AMBIGUOUS_MATCH", "AMOUNT_MISMATCH", "DATE_MISMATCH", "NOT_FOUND", "DUPLICATE_LEDGER_ENTRY", "DUPLICATE_STATEMENT_LINE", "UNAPPLIED_PAYMENT", "PAYMENT_NOT_FOUND", "PAYMENT_AMOUNT_MISMATCH", "PAYMENT_DATE_MISMATCH", "VOIDED_PAYMENT_CONFLICT", "UNAPPLIED_CREDIT", "CREDIT_NOT_FOUND", "CREDIT_AMOUNT_MISMATCH"]) {
      expect(TYPES).toMatch(new RegExp(`"${s}"`));
    }
  });
  it("STATEMENT_MATCH_TARGET_KINDS cover the 4 approved targets", () => {
    for (const s of ["AP_INVOICE", "VENDOR_PAYMENT", "AP_CREDIT", "NONE"]) {
      expect(TYPES).toMatch(new RegExp(`"${s}"`));
    }
  });
  it("RECONCILIATION_STATES cover the 7 approved values", () => {
    for (const s of ["RECONCILED", "RECONCILED_WITH_TIMING_DIFFERENCES", "EXCEPTIONS_FOUND", "VENDOR_UNRESOLVED", "DOCUMENT_UNREADABLE", "INSUFFICIENT_EVIDENCE", "REVIEW_REQUIRED"]) {
      expect(TYPES).toMatch(new RegExp(`"${s}"`));
    }
  });
  it("STATEMENT_REVIEWER_ACTIONS cover the 11 approved actions", () => {
    for (const s of ["CONFIRM_VENDOR", "CORRECT_VENDOR", "CONFIRM_LINE_MATCH", "REJECT_LINE_MATCH", "LINK_EXISTING_INVOICE", "LINK_EXISTING_PAYMENT", "MARK_TIMING_DIFFERENCE", "MARK_VENDOR_ERROR", "MARK_SPECTRE_ERROR", "DEFER_REVIEW", "RESOLVE_RECONCILIATION"]) {
      expect(TYPES).toMatch(new RegExp(`"${s}"`));
    }
  });
  it("STATEMENT_FINDING_KEYS cover all 21 checkpoint-listed keys", () => {
    for (const s of ["ap.statement.reconciled", "ap.statement.vendor_not_found", "ap.statement.vendor_ambiguous", "ap.statement.unreadable", "ap.statement.unsupported_layout", "ap.statement.opening_balance_mismatch", "ap.statement.closing_balance_mismatch", "ap.statement.ledger_balance_mismatch", "ap.statement.invoice_not_found", "ap.statement.invoice_amount_mismatch", "ap.statement.invoice_date_mismatch", "ap.statement.duplicate_invoice_in_ledger", "ap.statement.duplicate_statement_line", "ap.statement.payment_not_found", "ap.statement.payment_amount_mismatch", "ap.statement.unapplied_payment", "ap.statement.voided_payment_conflict", "ap.statement.credit_not_found", "ap.statement.unapplied_credit", "ap.statement.finance_charge_unrecorded", "ap.statement.unknown_transaction"]) {
      expect(TYPES).toMatch(new RegExp(`"${s.replace(/\./g, "\\.")}"`));
    }
  });
  it("IngestedDocument evidence widening includes VENDOR_STATEMENT_RECONCILIATION", () => {
    expect(DOCTYPES).toMatch(/VENDOR_STATEMENT_RECONCILIATION/);
  });
});

describe("parse-statement — no LLM / OCR imports", () => {
  it("imports only deterministic helpers", () => {
    const lines = PARSE.split("\n").filter((l) => /^\s*import\s/.test(l));
    for (const line of lines) {
      expect(line).not.toMatch(/openai|anthropic|@aws-sdk\/client-textract|@azure\/ai-form-recognizer|tesseract|ocr/i);
    }
  });
});

describe("classify-line — deterministic rules, no probabilistic scoring", () => {
  it("no random or ML dependencies", () => {
    expect(CLASSIFY).not.toMatch(/Math\.random/);
    const lines = CLASSIFY.split("\n").filter((l) => /^\s*import\s/.test(l));
    for (const line of lines) {
      expect(line).not.toMatch(/openai|anthropic|tensorflow|onnx/i);
    }
  });
});

describe("balance-validate — decimal-safe, no floats", () => {
  it("never uses parseFloat / Number for amounts", () => {
    // (Diff calc uses .mul(100).toNumber() for cent-integer purposes; that's fine.)
    // But no `parseFloat(closingBalance)` or `Number(subtotal)` on money.
    expect(BALANCE).not.toMatch(/parseFloat\s*\(\s*(?:closing|opening|amount|subtotal|total)/i);
  });
  it("uses toMoney + sumMoney from the accounting Decimal helpers", () => {
    expect(BALANCE).toMatch(/toMoney/);
    expect(BALANCE).toMatch(/sumMoney/);
  });
});

describe("vendor-resolve — tenant-scoped + status filter", () => {
  it("always filters clubId and excludes MERGED vendors", () => {
    expect(VENDOR).toMatch(/where:\s*\{\s*clubId/);
    expect(VENDOR).toMatch(/status:\s*\{\s*not:\s*"MERGED"/);
  });
});

describe("match modules — tenant-scoped", () => {
  it("match-invoice scopes clubId + vendorId", () => {
    expect(MATCH_INV).toMatch(/where:\s*\{\s*clubId:\s*args\.clubId,\s*vendorId:\s*args\.canonicalVendorId/);
  });
  it("match-payment scopes clubId + vendorId", () => {
    expect(MATCH_PMT).toMatch(/where:\s*\{\s*clubId:\s*args\.clubId,\s*vendorId:\s*args\.canonicalVendorId/);
  });
  it("match-credit scopes clubId + vendorId on both negative-invoice and payment queries", () => {
    const clubMatches = MATCH_CR.match(/where:\s*\{\s*clubId:\s*args\.clubId,\s*vendorId:\s*args\.canonicalVendorId/g) ?? [];
    expect(clubMatches.length).toBeGreaterThanOrEqual(2);
  });
});

describe("analyse — never posts, never pays, never creates AP records", () => {
  it("no aPInvoice.create / vendorPayment.create anywhere in the analyser", () => {
    expect(ANALYSE).not.toMatch(/aPInvoice\.create\(/);
    expect(ANALYSE).not.toMatch(/vendorPayment\.create\(/);
    expect(ANALYSE).not.toMatch(/postInvoice/);
  });
});

describe("materialise — reuses C15B persistence + is idempotent", () => {
  it("uses upsertAnalysisFindings (semantic identity)", () => {
    expect(MATERIALISE).toMatch(/upsertAnalysisFindings/);
  });
  it("intake identity keyed on ap-statement:<club>:<doc>", () => {
    expect(MATERIALISE).toMatch(/ap-statement:\$\{args\.clubId\}:\$\{args\.ingestedDocumentId\}/);
  });
  it("no aPInvoice.create anywhere", () => {
    expect(MATERIALISE).not.toMatch(/aPInvoice\.create\(/);
  });
  it("only enumerates STATEMENT-classified PDFs", () => {
    expect(MATERIALISE).toMatch(/classification:\s*"STATEMENT"/);
  });
});

describe("actions — never creates AP records, only links to existing ones", () => {
  it("does not create AP invoices or payments (only links)", () => {
    expect(ACTIONS).not.toMatch(/aPInvoice\.create\(/);
    expect(ACTIONS).not.toMatch(/vendorPayment\.create\(/);
    expect(ACTIONS).not.toMatch(/postInvoice/);
  });
  it("tenant guard fires before any switch branch", () => {
    const guardIdx = ACTIONS.indexOf("prisma.workIntakeItem.findFirst");
    const switchIdx = ACTIONS.indexOf("switch (args.kind)");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(switchIdx).toBeGreaterThan(guardIdx);
  });
  it("LINK_EXISTING_INVOICE re-verifies the invoice is in the same club", () => {
    expect(ACTIONS).toMatch(/aPInvoice\.count\(\{\s*where:\s*\{\s*id:\s*args\.payload\.linkToApInvoiceId,\s*clubId:\s*args\.clubId/);
  });
});

describe("cross-link — read-only", () => {
  it("no writes anywhere in cross-link.ts", () => {
    expect(CROSSLINK).not.toMatch(/\.create\(/);
    expect(CROSSLINK).not.toMatch(/\.update\(/);
    expect(CROSSLINK).not.toMatch(/\.delete\(/);
  });
});

describe("HTTP routes — 404-on-mismatch, closed-enum validation", () => {
  it("statement-evidence is GET-only", () => {
    expect(EV_ROUTE).toMatch(/export async function GET/);
    expect(EV_ROUTE).not.toMatch(/export async function POST/);
    expect(EV_ROUTE).not.toMatch(/export async function PATCH/);
    expect(EV_ROUTE).not.toMatch(/export async function DELETE/);
  });
  it("statement-evidence never exposes storageKey / storageBucket", () => {
    expect(EV_ROUTE).not.toMatch(/storageKey/);
    expect(EV_ROUTE).not.toMatch(/storageBucket/);
  });
  it("statement-evidence explicitly declares autoActionAvailable: false", () => {
    expect(EV_ROUTE).toMatch(/autoActionAvailable:\s*false/);
  });
  it("statement-actions validates kind against STATEMENT_REVIEWER_ACTIONS", () => {
    expect(ACT_ROUTE).toMatch(/STATEMENT_REVIEWER_ACTIONS/);
    expect(ACT_ROUTE).toMatch(/invalid_kind/);
  });
  it("both routes return 404 (never 403) on tenant mismatch", () => {
    expect(EV_ROUTE).toMatch(/status: 404/);
    expect(EV_ROUTE).not.toMatch(/status: 403/);
    expect(ACT_ROUTE).toMatch(/status: 404/);
    expect(ACT_ROUTE).not.toMatch(/status: 403/);
  });
});

describe("CLI — staging + Silver Springs guards", () => {
  it("refuses non-staging URLs", () => {
    expect(CLI).toMatch(/APP_URL is not staging\/localhost/);
  });
  it("refuses Silver Springs by slug or name", () => {
    expect(CLI).toMatch(/silver-springs/i);
  });
  it("default is dry-run", () => {
    expect(CLI).toMatch(/let apply = false/);
  });
});
