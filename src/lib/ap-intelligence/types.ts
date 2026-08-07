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
// Sprint 3 · Checkpoint 15T (2026-07-28) — bumped from 2 to 3. The
// parser now consumes the shared document-layout association layer
// for label→value pairing across separate lines (subtotal / tax /
// total / payable-reference). This is a wholesale parsing behaviour
// change; every projection cache must invalidate on deploy.
// Sprint 3 · Checkpoint 15Y (2026-08-03) — bumped to 4 for the
// field-quality gate: contaminated supplier candidates and
// concatenated payable references are now rejected and can force
// GL abstention. Every warm projection cache invalidates on deploy.
//
// Sprint 3 · Post-16H Phase 4 Slice 3-hotfix (2026-08-06) — bumped
// to 7 to cover the accumulated Slice 1 + 2 + 3 analyser changes
// (never bumped during those slices — that oversight kept warm
// mission-control-projection caches on the pre-Slice-1 shape and
// was the root cause of the founder-observed DMM card divergence).
//
// Included in this bump:
//   * Slice 1: OICE bug fix, MONEY_TOKEN trailing currency,
//     Canadian-tax currency inference, multi-tax GST+PST sum.
//   * Slice 2: canonical evidence cutover for payref / dates /
//     currency / amounts, CREDIT_MEMO_NUMBER type, Credit Total
//     labels, MONEY_TOKEN negative-amount support.
//   * Slice 3: supplier ranker v2 (scored composition + VETO
//     negatives), canonical line-items / credits / surcharges,
//     line-item arithmetic reconciliation, structured tax
//     components with TPS↔GST bilingual normalisation and
//     SUMMARY/REMITTANCE level detection, economic-purpose from
//     canonical line items, supplier scalar cutover so
//     invoice.vendor.guessedName reflects canonical selection.
//
// Bumping this version invalidates every warm apSummaryCache
// entry — the next projection sees the current analyser output.
export const EXTRACTION_RULE_VERSION = 8;

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
// Payable-reference taxonomy — Sprint 3 · Checkpoint 15T.
//
// Different vendor documents identify themselves under different
// labels. A statement-based service (telecom, utilities, membership
// billing) prints "Statement number …" instead of "Invoice #". A
// bill-first vendor prints "Bill number …". The taxonomy preserves
// WHICH label produced the identifier so downstream consumers can
// present it accurately.
// ---------------------------------------------------------------------------
export const PAYABLE_REFERENCE_TYPES = [
  "INVOICE_NUMBER",
  "STATEMENT_NUMBER",
  "BILL_NUMBER",
  "REFERENCE_NUMBER",
  // Sprint 3 · Post-16H Phase 4 Slice 2 (2026-08-06) — credit-memo
  // taxonomy addition. Ranked FIRST inside the extractor so a
  // credit memo's own reference wins over any referenced original.
  "CREDIT_MEMO_NUMBER",
  "OTHER",
] as const;
export type PayableReferenceType = (typeof PAYABLE_REFERENCE_TYPES)[number];

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
  // Sprint 3 · Checkpoint 15T — taxonomy of the payable reference in
  // invoiceNumber. Preserves whether the identifier came from an
  // invoice, statement, bill, generic reference, or other label. Null
  // when no payable reference was extracted. Optional so pre-15T test
  // fixtures continue to compile — production callers always populate.
  payableReferenceType?: PayableReferenceType | null;
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
