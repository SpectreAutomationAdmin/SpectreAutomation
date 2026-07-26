// Sprint 3 Checkpoint 15F (2026-07-24) — Vendor Master Intelligence
// shared contracts.
//
// Every enumeration below is CLOSED. Widening requires an explicit
// checkpoint change; the source-contract test locks each set.

// ---------------------------------------------------------------------------
// Duplicate-detection outcome.
// ---------------------------------------------------------------------------
export const VENDOR_DUPLICATE_STATES = [
  "CONFIRMED_DUPLICATE",     // multiple deterministic signals agree
  "LIKELY_DUPLICATE",        // one strong + one supporting signal
  "POSSIBLE_DUPLICATE",      // one supporting signal only
  "DISTINCT_VENDOR",         // no matching signals
  "CONFLICT_REQUIRES_REVIEW",// signals contradict (tax mismatch, etc.)
] as const;
export type VendorDuplicateState = (typeof VENDOR_DUPLICATE_STATES)[number];

// Rule keys — every match/conflict carries one so the reviewer sees WHY.
export const DUPLICATE_RULE_KEYS = [
  "match.tax_number_exact",
  "match.email_exact",
  "match.contact_email_exact",
  "match.website_domain_exact",
  "match.telephone_normalised",
  "match.legal_name_normalised",
  "match.trade_name_normalised",
  "match.remittance_address_normalised",
  "match.default_expense_account",
  "match.historical_invoice_number_overlap",
  "conflict.tax_number_differs",
  "conflict.banking_differs",
  "conflict.legal_entity_differs",
  "conflict.address_materially_differs",
  "conflict.invoice_history_overlap_inconsistent",
  "conflict.payment_history_conflict",
] as const;
export type DuplicateRuleKey = (typeof DUPLICATE_RULE_KEYS)[number];

// ---------------------------------------------------------------------------
// Canonical-vendor recommendation states.
// ---------------------------------------------------------------------------
export const CANONICAL_STATES = [
  "RECOMMENDED",            // one vendor clearly wins on completeness
  "AMBIGUOUS",              // reviewer must choose
  "INSUFFICIENT_EVIDENCE",  // not enough data to recommend
] as const;
export type CanonicalState = (typeof CANONICAL_STATES)[number];

// ---------------------------------------------------------------------------
// Alias kinds — historical vendor codes / references that resolve to a
// canonical vendor on future imports.
// ---------------------------------------------------------------------------
export const VENDOR_ALIAS_KINDS = [
  "JONAS_VENDOR_CODE",
  "LEGACY_INVOICE_NUMBER",
  "LEGAL_NAME",
  "OPERATING_NAME",
  "TAX_NUMBER",
  "OTHER",
] as const;
export type VendorAliasKind = (typeof VENDOR_ALIAS_KINDS)[number];

// ---------------------------------------------------------------------------
// Merge-record status.
// ---------------------------------------------------------------------------
export const MERGE_STATUSES = ["COMMITTED", "REVERSED"] as const;
export type MergeStatus = (typeof MERGE_STATUSES)[number];

// ---------------------------------------------------------------------------
// Reviewer actions on a vendor-consolidation situation.
// ---------------------------------------------------------------------------
export const VENDOR_CONSOLIDATION_ACTIONS = [
  "APPROVE_CONSOLIDATION",
  "REJECT_CONSOLIDATION",
  "CHOOSE_DIFFERENT_CANONICAL",
  "MARK_VENDORS_DISTINCT",
  "DEFER_REVIEW",
  "EXECUTE_CONSOLIDATION",
] as const;
export type VendorConsolidationAction = (typeof VENDOR_CONSOLIDATION_ACTIONS)[number];

// ---------------------------------------------------------------------------
// Signal weights — DETERMINISTIC values, not probabilities. Reserved
// for the state classifier only. `STRONG` signals alone qualify as
// CONFIRMED_DUPLICATE (with corroborating context); `SUPPORTING`
// signals cannot promote past LIKELY_DUPLICATE without a strong.
// ---------------------------------------------------------------------------
export type SignalStrength = "STRONG" | "SUPPORTING";

export const SIGNAL_STRENGTHS: Record<DuplicateRuleKey, SignalStrength | null> = {
  "match.tax_number_exact":                "STRONG",
  "match.website_domain_exact":            "STRONG",
  "match.remittance_address_normalised":   "STRONG",
  "match.email_exact":                     "SUPPORTING",
  "match.contact_email_exact":             "SUPPORTING",
  "match.telephone_normalised":            "SUPPORTING",
  "match.legal_name_normalised":           "SUPPORTING",
  "match.trade_name_normalised":           "SUPPORTING",
  "match.default_expense_account":         "SUPPORTING",
  "match.historical_invoice_number_overlap": "SUPPORTING",
  // Conflicts contribute negatively to the state classifier, not to strength.
  "conflict.tax_number_differs":                     null,
  "conflict.banking_differs":                        null,
  "conflict.legal_entity_differs":                   null,
  "conflict.address_materially_differs":             null,
  "conflict.invoice_history_overlap_inconsistent":   null,
  "conflict.payment_history_conflict":               null,
};

// ---------------------------------------------------------------------------
// Errors — every operational failure maps to exactly one category.
// ---------------------------------------------------------------------------
export type VendorIntelligenceErrorCategory =
  | "TENANT_MISMATCH"
  | "VENDOR_MISSING"
  | "APPROVAL_PENDING"
  | "CONFLICT_BLOCKING"
  | "COLLISION"
  | "MISSING_INPUT"
  | "PERMISSION_DENIED"
  | "UNEXPECTED";

export class VendorIntelligenceError extends Error {
  category: VendorIntelligenceErrorCategory;
  constructor(category: VendorIntelligenceErrorCategory, message: string) {
    super(message);
    this.name = "VendorIntelligenceError";
    this.category = category;
  }
}
