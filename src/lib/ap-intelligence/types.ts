// Sprint 3 Checkpoint 15E (2026-07-24) — AP-Invoice Operational
// Intelligence contracts.
//
// Closed enumerations. Every value the analyser produces is
// deterministic. No LLM, no OCR (parsing operates on text extracted
// deterministically by pdf-parse).

// ---------------------------------------------------------------------------
// Extraction outcomes — how the analyser summarises PDF parsing.
// ---------------------------------------------------------------------------
export const EXTRACTION_STATES = [
  "STRUCTURED",         // enough fields extracted to reconcile
  "PARTIAL",            // some fields missing; downstream may still run
  "DOCUMENT_UNREADABLE",// pdf-parse returned no useful text
] as const;
export type ExtractionState = (typeof EXTRACTION_STATES)[number];

// The extraction rule version — bump when the parser regex set changes.
export const EXTRACTION_RULE_VERSION = 1;

// ---------------------------------------------------------------------------
// Vendor resolution outcomes.
// ---------------------------------------------------------------------------
export const VENDOR_MATCH_STATES = [
  "MATCHED",
  "AMBIGUOUS",
  "NOT_FOUND",
  "INSUFFICIENT_SIGNAL",
] as const;
export type VendorMatchState = (typeof VENDOR_MATCH_STATES)[number];

// ---------------------------------------------------------------------------
// AP reconciliation outcomes.
// ---------------------------------------------------------------------------
export const AP_RECONCILE_STATES = [
  "MATCH",              // vendor + invoice-ref + total all agree
  "DUPLICATE",          // an APInvoice already exists on this vendorRef
  "NOT_FOUND",          // no matching APInvoice
  "AMOUNT_MISMATCH",    // vendorRef matches but total differs
  "DATE_MISMATCH",      // vendorRef matches but invoice date differs
  "VENDOR_MISMATCH",    // vendorRef used in AP but attached to another vendor
  "HASH_DUPLICATE",     // an existing APInvoice already has this exact PDF attached
  "INSUFFICIENT_SIGNAL",
] as const;
export type ApReconcileState = (typeof AP_RECONCILE_STATES)[number];

// ---------------------------------------------------------------------------
// Capital / operating classification.
// ---------------------------------------------------------------------------
export const CAPITAL_VS_OPERATING_STATES = [
  "OPERATING",
  "CAPITAL",
  "AMBIGUOUS",
  "INSUFFICIENT_EVIDENCE",
] as const;
export type CapitalVsOperatingState = (typeof CAPITAL_VS_OPERATING_STATES)[number];

// Recommended capital classes when CAPITAL is selected. Closed set for
// this checkpoint; each maps to a Spectre chart-of-accounts row (see
// gl-recommend.ts).
export const CAPITAL_CLASSES = [
  "COURSE_EQUIPMENT",
  "KITCHEN_EQUIPMENT",
  "GOLF_EQUIPMENT",
  "BUILDING_IMPROVEMENTS",
  "FURNITURE",
  "COMPUTER_EQUIPMENT",
  "VEHICLES",
  "IRRIGATION",
  "OTHER_CAPITAL",
] as const;
export type CapitalClass = (typeof CAPITAL_CLASSES)[number];

// Deterministic AP correction kinds (Phase K — user learning).
export const AP_CORRECTION_KINDS = [
  "APPROVE_EXTRACTION",
  "REJECT_EXTRACTION",
  "CORRECT_VENDOR",
  "CORRECT_GL_ACCOUNT",
  "MARK_OPERATING",
  "MARK_CAPITAL",
  "ATTACH_TO_EXISTING_INVOICE",
  "CREATE_DRAFT_INVOICE",
] as const;
export type ApCorrectionKind = (typeof AP_CORRECTION_KINDS)[number];

// ---------------------------------------------------------------------------
// Extracted invoice shape — everything the parser can populate.
// Every field is nullable — a missing field means "not confidently
// extracted", NEVER "guessed".
// ---------------------------------------------------------------------------
export interface ExtractedInvoice {
  state: ExtractionState;
  ruleVersion: number;
  // Text length that the parser had to work with. 0 → DOCUMENT_UNREADABLE.
  extractedTextChars: number;
  vendor: {
    guessedName: string | null;
    guessedEmail: string | null;
    guessedTaxNumber: string | null;
    guessedDomain: string | null;
  };
  invoiceNumber: string | null;
  invoiceDate: string | null;      // ISO date
  dueDate: string | null;          // ISO date
  paymentTerms: string | null;
  purchaseOrder: string | null;
  description: string | null;
  currency: string | null;
  subtotal: string | null;         // Decimal-safe string ("1234.56")
  taxTotal: string | null;
  total: string | null;
  lineItems: Array<{
    description: string;
    quantity: string | null;
    unitCost: string | null;
    amount: string;
  }>;
  remittance: {
    address: string | null;
    email: string | null;
  };
  warnings: string[];
}

// Deterministic parse-hint reasons — WHY a field was extracted.
export interface ParseHint {
  field: string;
  ruleKey: string;
  matchedText: string;
}
