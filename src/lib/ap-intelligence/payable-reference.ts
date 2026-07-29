// Sprint 3 · Checkpoint 15T (2026-07-28) — payable-reference taxonomy.
//
// Founder rule (15T §7): the payable-reference field must accept
// invoice numbers, statement numbers, bill numbers, reference
// numbers, plus a bucket for other identifier types. Both same-line
// and separated-label/value layouts are supported via the shared
// document-layout layer.
//
// Guardrails: account numbers, member numbers, dates, phone
// numbers, and tax-registration numbers must NOT be mistaken for
// the payable reference.

import type { DocumentLayout } from "./document-layout";
import { associateLabelValue } from "./document-layout";

export type PayableReferenceType =
  | "INVOICE_NUMBER"
  | "STATEMENT_NUMBER"
  | "BILL_NUMBER"
  | "REFERENCE_NUMBER"
  | "OTHER";

export interface PayableReferenceResult {
  value: string;
  type: PayableReferenceType;
  ruleKey: string;
  confidence: number;
  strategy: "same_line" | "forward_line" | "backward_line" | "inline_prefix";
  labelLineIndex: number;
  valueLineIndex: number;
}

// Search order — most specific label wins first. Within each type
// we accept multiple label variants because different vendors use
// different terminology.
// Sprint 3 · Checkpoint 15T — the labels are strict. Bare "Invoice"
// / "Statement" / "Bill" alone are HEADER words on many documents
// (page banners, section titles) — using them as label alternates
// would pick up unrelated text as the payable reference.
const SEARCH_ORDER: Array<{
  type: PayableReferenceType;
  labels: string[];
  ruleKeyBase: string;
}> = [
  {
    type: "INVOICE_NUMBER",
    labels: ["Invoice Number", "Invoice No", "Invoice No.", "Invoice #", "Invoice ID"],
    ruleKeyBase: "payable_ref.invoice_number",
  },
  {
    type: "STATEMENT_NUMBER",
    labels: ["Statement Number", "Statement No", "Statement No.", "Statement #", "Statement ID"],
    ruleKeyBase: "payable_ref.statement_number",
  },
  {
    type: "BILL_NUMBER",
    labels: ["Bill Number", "Bill No", "Bill No.", "Bill #", "Bill ID"],
    ruleKeyBase: "payable_ref.bill_number",
  },
  {
    type: "REFERENCE_NUMBER",
    labels: ["Reference Number", "Reference No", "Reference No.", "Reference #", "Payment Reference", "Ref No", "Ref #"],
    ruleKeyBase: "payable_ref.reference_number",
  },
];

// Values that are legitimate identifier candidates. A raw phone
// number, a date, an ACCOUNT identifier prefixed with "Your account
// number", a tax registration — all EXCLUDED regardless of what label
// they appear under.
// Sprint 3 · Checkpoint 15T — phone-like detection requires at least
// one phone-format character (space, dash, dot, paren) OR a leading
// `+`. A pure-digit string right after "Invoice #:" is an invoice
// number, not a phone number, and must NOT be rejected here.
const REJECT_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /^\+\d[\d\s\-().]{6,}$/, reason: "phone-like-plus-prefix" },
  { pattern: /^\d[\d\s\-().]*[\s\-().][\d\s\-().]*$/, reason: "phone-like-grouping" },
  { pattern: /^\d{4}[-\/]\d{1,2}[-\/]\d{1,2}$/, reason: "date-iso" },
  { pattern: /^\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}$/, reason: "date-numeric" },
  { pattern: /^\d{9}(?:RT\d{4})?$/i, reason: "tax-registration-canada" },
  { pattern: /^\d{2}-\d{7}$/, reason: "tax-registration-us-ein" },
  { pattern: /^(?:number|no\.?|#|id|ref)$/i, reason: "empty-label-value" },
];

function isAcceptableIdentifier(value: string): boolean {
  const v = value.trim();
  if (!v) return false;
  if (v.length < 3 || v.length > 40) return false;
  // Must contain at least one alphanumeric character AFTER stripping
  // whitespace / dashes / hashes.
  const alnum = v.replace(/[^A-Za-z0-9]/g, "");
  if (alnum.length < 3) return false;
  for (const rej of REJECT_PATTERNS) {
    if (rej.pattern.test(v)) return false;
  }
  return true;
}

export function extractPayableReference(
  layout: DocumentLayout,
): PayableReferenceResult | null {
  for (const spec of SEARCH_ORDER) {
    const match = associateLabelValue(layout, {
      labels: spec.labels,
      ruleKeyBase: spec.ruleKeyBase,
      valueKind: "text",
      forwardMaxLines: 3,
    });
    if (!match) continue;
    const value = match.value.trim();
    if (!isAcceptableIdentifier(value)) continue;

    // Extra guard — the value line MUST NOT be classified as an
    // account/tax-registration kind. This defends against a
    // structurally close but semantically wrong pair.
    const valueLine = layout.lines[match.valueLineIndex];
    if (valueLine && (valueLine.kind === "TAX_REGISTRATION" || valueLine.kind === "ACCOUNT_NUMBER")) {
      continue;
    }

    // Additionally reject when the value line's TEXT clearly indicates
    // an account/member context ("Your account number: 00108064").
    if (valueLine && /^(?:Your\s+)?(?:account|member|customer|client)\s+(?:number|no\.?|#|id)/i.test(valueLine.text)) {
      continue;
    }

    return {
      value,
      type: spec.type,
      ruleKey: match.ruleKey,
      confidence: match.confidence,
      strategy: match.strategy as PayableReferenceResult["strategy"],
      labelLineIndex: match.labelLineIndex,
      valueLineIndex: match.valueLineIndex,
    };
  }

  // Fallback — inline prefix such as "INV-1234567" or an identifier-
  // shaped standalone line that immediately follows an invoice-like
  // label. Deliberately conservative.
  for (const line of layout.lines) {
    if (line.kind === "IDENTIFIER") {
      // Only accept if a previous non-blank line contains an invoice
      // / statement / bill / reference cue.
      let priorIdx = line.index - 1;
      while (priorIdx >= 0 && layout.lines[priorIdx].kind === "BLANK") priorIdx--;
      if (priorIdx < 0) continue;
      const prior = layout.lines[priorIdx];
      const priorText = prior.text.toLowerCase();
      let type: PayableReferenceType | null = null;
      if (/statement\s+(?:number|no|#)/.test(priorText)) type = "STATEMENT_NUMBER";
      else if (/bill\s+(?:number|no|#)/.test(priorText)) type = "BILL_NUMBER";
      else if (/reference\s+(?:number|no|#)/.test(priorText)) type = "REFERENCE_NUMBER";
      else if (/invoice\s+(?:number|no|#)/.test(priorText)) type = "INVOICE_NUMBER";
      if (!type) continue;
      if (!isAcceptableIdentifier(line.text)) continue;
      return {
        value: line.text,
        type,
        ruleKey: `payable_ref.${type.toLowerCase()}.identifier_after_label`,
        confidence: 72,
        strategy: "forward_line",
        labelLineIndex: prior.index,
        valueLineIndex: line.index,
      };
    }
  }

  return null;
}
