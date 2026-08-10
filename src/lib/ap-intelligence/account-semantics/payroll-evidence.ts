// Sprint 3 · 221178 semantics slice (2026-08-10) — payroll-evidence
// detector.
//
// Determines whether an AP invoice carries affirmative evidence that
// the debit legitimately belongs on a PAYROLL_ONLY GL account
// (fsGroupKey === "IS_PAYROLL"). The eligibility gate
// `rulePayrollAccountExcluded` consumes this flag: TRUE keeps payroll
// accounts in the candidate pool; FALSE / absent excludes them.
//
// Founder rules:
//   §5 — Payroll accounts should require positive evidence.
//   §6 — Do NOT depend on Social Insurance Number detection.
//   §31 — No supplier / invoice-number / GL-number specific rules.
//         Only generalized structural signals.
//
// Signals used, in decreasing strength:
//   (a) Vendor name matches a known payroll-provider (ADP / Ceridian
//       / Paychex / Payworks / Wagepoint / Paymentevolution etc.).
//       These providers exist to serve payroll processing; an invoice
//       from them for their services legitimately routes to payroll-
//       adjacent accounts if the tenant COA is configured that way.
//   (b) Line / document vocabulary containing multiple payroll-
//       diagnostic tokens (pay period, pay run, gross pay, net pay,
//       source deduction, PD7A, T4, EI premium, CPP, employer share,
//       payroll register, employee earnings, hours worked, pay stub).
//       Requires ≥2 distinct token families to fire — a single
//       "wages" token in an otherwise ordinary invoice is not enough.
//
// Deliberately conservative. False negatives (genuine payroll
// invoice not detected) are recoverable by manual review; false
// positives would silently reopen the exact defect the 221178 audit
// exposed.

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface PayrollEvidenceInput {
  /** Vendor name candidates: extracted invoice header vendor,
   *  matched Spectre vendor name (legal/operating), sender email
   *  domain. Any non-null string here is a candidate signal source. */
  vendorNames?: Array<string | null | undefined>;
  /** Line-item descriptions concatenated. May be empty; the
   *  document-body text below covers the same signal set. */
  lineItemDescriptions?: string[];
  /** Full document text (post-transactional-region filtering when
   *  available; else raw pdfText). Provider agnostic. */
  documentText?: string | null;
}

export interface PayrollEvidenceVerdict {
  hasPayrollEvidence: boolean;
  /** Machine-readable reasons — never a free-form string. Empty
   *  array when no evidence found. */
  reasons: PayrollEvidenceReason[];
}

export type PayrollEvidenceReason =
  | "VENDOR_IS_PAYROLL_PROVIDER"
  | "LINE_VOCABULARY_PAYROLL"
  | "DOCUMENT_VOCABULARY_PAYROLL";

export function detectPayrollEvidence(input: PayrollEvidenceInput): PayrollEvidenceVerdict {
  const reasons: PayrollEvidenceReason[] = [];

  // (a) Known payroll providers. Case-insensitive whole-name / word
  // -boundary. Providers with common English words in their name
  // (like `Pay`) require additional payroll-specific suffix.
  const vendors = (input.vendorNames ?? [])
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0);
  if (vendors.some((v) => matchesPayrollProviderVendor(v))) {
    reasons.push("VENDOR_IS_PAYROLL_PROVIDER");
  }

  // (b) Line / document vocabulary — require ≥2 distinct token
  // families so a single stray "wages" token doesn't trip it.
  const lineText = (input.lineItemDescriptions ?? []).join(" ");
  const docText = input.documentText ?? "";
  const combined = `${lineText} ${docText}`.toLowerCase();
  const linesOnly = lineText.toLowerCase();

  const lineFamilies = countPayrollTokenFamilies(linesOnly);
  const docFamilies = countPayrollTokenFamilies(combined);
  if (lineFamilies >= 2) reasons.push("LINE_VOCABULARY_PAYROLL");
  else if (docFamilies >= 2) reasons.push("DOCUMENT_VOCABULARY_PAYROLL");

  return { hasPayrollEvidence: reasons.length > 0, reasons };
}

// -----------------------------------------------------------------------------
// Internal helpers
// -----------------------------------------------------------------------------

// Payroll-provider vendor names. Word-boundary, case-insensitive.
// Names common enough to be false-positive candidates in isolation
// (e.g. "Pay") require a payroll-specific suffix.
const PAYROLL_PROVIDER_PATTERNS: RegExp[] = [
  /\badp\b/i,
  /\bceridian\b/i,
  /\bpaychex\b/i,
  /\bpayworks\b/i,
  /\bwagepoint\b/i,
  /\bpayment\s?evolution\b/i,
  /\bpapaya\s?global\b/i,
  /\brippling\b/i,
  /\bgusto\b/i,
  /\bhumi\b/i,
  /\bhumi\s?payroll\b/i,
  /\bpayroll\s?services?\b/i,
];

function matchesPayrollProviderVendor(name: string): boolean {
  return PAYROLL_PROVIDER_PATTERNS.some((p) => p.test(name));
}

// Payroll token families. Each RegExp represents ONE family — a
// single family match does not fire the reason. Two or more distinct
// families are required (see caller).
const PAYROLL_TOKEN_FAMILIES: RegExp[] = [
  // Pay-cycle vocabulary
  /\bpay\s?period\b|\bpay\s?run\b|\bpay\s?stub\b|\bpay\s?cheque\b|\bpayroll\s?register\b/i,
  // Compensation math
  /\bgross\s?pay\b|\bnet\s?pay\b|\bearnings\b|\bhours\s?worked\b|\bhourly\s?rate\b/i,
  // Statutory deductions
  /\bsource\s?deduction\b|\bpd7a\b|\bt4\b|\bt4a\b|\bei\s?premium\b|\bcpp\s?contribution\b|\bqpp\s?contribution\b|\bcra\s?remittance\b/i,
  // Employer overhead
  /\bemployer\s?share\b|\bemployer\s?contribution\b|\bworkers?['\s]compensation\b|\bwcb\b|\bwsib\b/i,
  // Employee references
  /\bemployee\s?(?:id|number|name|earnings)\b|\bemp\s?id\b/i,
  // Direct payroll noun cluster (must appear WITH another family; the
  // singleton "wages" or "salary" alone is not enough — that's the
  // exact 221178 false-positive we're guarding against)
  /\bpayroll\b|\bwages?\b|\bsalar(?:y|ies)\b/i,
];

function countPayrollTokenFamilies(text: string): number {
  if (!text || text.trim().length === 0) return 0;
  let n = 0;
  for (const p of PAYROLL_TOKEN_FAMILIES) {
    if (p.test(text)) n++;
  }
  return n;
}
