// Sprint 3 Checkpoint 15G (2026-07-24) — Vendor statement
// reconciliation shared contracts. Closed enumerations only.

// ---------------------------------------------------------------------------
// Extraction outcome
// ---------------------------------------------------------------------------
export const STATEMENT_EXTRACTION_STATES = [
  "STRUCTURED",
  "PARTIALLY_STRUCTURED",
  "DOCUMENT_UNREADABLE",
  "UNSUPPORTED_LAYOUT",
  "INSUFFICIENT_EVIDENCE",
] as const;
export type StatementExtractionState = (typeof STATEMENT_EXTRACTION_STATES)[number];

export const STATEMENT_RULE_VERSION = 1;

// ---------------------------------------------------------------------------
// Statement line kinds — deterministic classification per line
// ---------------------------------------------------------------------------
export const STATEMENT_TRANSACTION_KINDS = [
  "INVOICE",
  "CREDIT_NOTE",
  "PAYMENT",
  "FINANCE_CHARGE",
  "OPENING_BALANCE",
  "BALANCE_FORWARD",
  "ADJUSTMENT",
  "OTHER",
  "UNKNOWN",
] as const;
export type StatementTransactionKind = (typeof STATEMENT_TRANSACTION_KINDS)[number];

// ---------------------------------------------------------------------------
// Match target + state — one row per statement line per candidate match
// ---------------------------------------------------------------------------
export const STATEMENT_MATCH_TARGET_KINDS = [
  "AP_INVOICE",
  "VENDOR_PAYMENT",
  "AP_CREDIT",
  "NONE",
] as const;
export type StatementMatchTargetKind = (typeof STATEMENT_MATCH_TARGET_KINDS)[number];

export const STATEMENT_MATCH_STATES = [
  // shared
  "EXACT_MATCH",
  "PROBABLE_MATCH",
  "AMBIGUOUS_MATCH",
  "AMOUNT_MISMATCH",
  "DATE_MISMATCH",
  "NOT_FOUND",
  "DUPLICATE_LEDGER_ENTRY",
  "DUPLICATE_STATEMENT_LINE",
  // payments
  "UNAPPLIED_PAYMENT",
  "PAYMENT_NOT_FOUND",
  "PAYMENT_AMOUNT_MISMATCH",
  "PAYMENT_DATE_MISMATCH",
  "VOIDED_PAYMENT_CONFLICT",
  // credits
  "UNAPPLIED_CREDIT",
  "CREDIT_NOT_FOUND",
  "CREDIT_AMOUNT_MISMATCH",
] as const;
export type StatementMatchState = (typeof STATEMENT_MATCH_STATES)[number];

// ---------------------------------------------------------------------------
// Vendor resolution states — reuse 15F semantics
// ---------------------------------------------------------------------------
export const STATEMENT_VENDOR_RESOLUTION_STATES = [
  "MATCHED",
  "AMBIGUOUS",
  "NOT_FOUND",
  "CONFLICT_REQUIRES_REVIEW",
] as const;
export type StatementVendorResolutionState = (typeof STATEMENT_VENDOR_RESOLUTION_STATES)[number];

// ---------------------------------------------------------------------------
// Reconciliation state — the terminal outcome per statement
// ---------------------------------------------------------------------------
export const RECONCILIATION_STATES = [
  "RECONCILED",
  "RECONCILED_WITH_TIMING_DIFFERENCES",
  "EXCEPTIONS_FOUND",
  "VENDOR_UNRESOLVED",
  "DOCUMENT_UNREADABLE",
  "INSUFFICIENT_EVIDENCE",
  "REVIEW_REQUIRED",
] as const;
export type ReconciliationState = (typeof RECONCILIATION_STATES)[number];

// ---------------------------------------------------------------------------
// Reviewer actions
// ---------------------------------------------------------------------------
export const STATEMENT_REVIEWER_ACTIONS = [
  "CONFIRM_VENDOR",
  "CORRECT_VENDOR",
  "CONFIRM_LINE_MATCH",
  "REJECT_LINE_MATCH",
  "LINK_EXISTING_INVOICE",
  "LINK_EXISTING_PAYMENT",
  "MARK_TIMING_DIFFERENCE",
  "MARK_VENDOR_ERROR",
  "MARK_SPECTRE_ERROR",
  "DEFER_REVIEW",
  "RESOLVE_RECONCILIATION",
] as const;
export type StatementReviewerAction = (typeof STATEMENT_REVIEWER_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Finding keys — one per exception category
// ---------------------------------------------------------------------------
export const STATEMENT_FINDING_KEYS = [
  "ap.statement.reconciled",
  "ap.statement.vendor_not_found",
  "ap.statement.vendor_ambiguous",
  "ap.statement.unreadable",
  "ap.statement.unsupported_layout",
  "ap.statement.opening_balance_mismatch",
  "ap.statement.closing_balance_mismatch",
  "ap.statement.ledger_balance_mismatch",
  "ap.statement.invoice_not_found",
  "ap.statement.invoice_amount_mismatch",
  "ap.statement.invoice_date_mismatch",
  "ap.statement.duplicate_invoice_in_ledger",
  "ap.statement.duplicate_statement_line",
  "ap.statement.payment_not_found",
  "ap.statement.payment_amount_mismatch",
  "ap.statement.unapplied_payment",
  "ap.statement.voided_payment_conflict",
  "ap.statement.credit_not_found",
  "ap.statement.unapplied_credit",
  "ap.statement.finance_charge_unrecorded",
  "ap.statement.unknown_transaction",
] as const;
export type StatementFindingKey = (typeof STATEMENT_FINDING_KEYS)[number];

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------
export type StatementErrorCategory =
  | "TENANT_MISMATCH"
  | "DOCUMENT_MISSING"
  | "VENDOR_MISSING"
  | "MISSING_INPUT"
  | "PERMISSION_DENIED"
  | "UNEXPECTED";

export class StatementIntelligenceError extends Error {
  category: StatementErrorCategory;
  constructor(category: StatementErrorCategory, message: string) {
    super(message);
    this.name = "StatementIntelligenceError";
    this.category = category;
  }
}

// ---------------------------------------------------------------------------
// Parsed statement shape
// ---------------------------------------------------------------------------
export interface ExtractedStatementLine {
  sequence: number;
  transactionDate: string | null; // ISO
  referenceNumber: string | null;
  description: string | null;
  transactionKind: StatementTransactionKind;
  debitAmount: string | null;   // Decimal-safe strings
  creditAmount: string | null;
  runningBalance: string | null;
  evidence: {
    ruleKey: string;
    matchedTextSnippet: string;
  };
}

export interface ExtractedStatement {
  state: StatementExtractionState;
  ruleVersion: number;
  extractedTextChars: number;
  header: {
    vendorNameGuess: string | null;
    vendorAccountNumber: string | null;
    statementDate: string | null;
    periodStart: string | null;
    periodEnd: string | null;
    openingBalance: string | null;
    closingBalance: string | null;
    amountDue: string | null;
    currency: string | null;
  };
  lines: ExtractedStatementLine[];
  warnings: string[];
}
