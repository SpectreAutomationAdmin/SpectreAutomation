// Sprint 3 Checkpoint 15D (2026-07-24) — Deterministic
// document-classification for the ingested-document layer.
//
// Rules only. No OCR. No LLM. No probabilistic guessing.
//
// The classifier takes lightweight signals (filename, email subject,
// sender domain, MIME) and returns one of the closed classes. Each
// signal has a ruleKey so downstream audit rows can explain WHY the
// class landed. Ties are resolved by the order of the RULES array —
// first match wins.
//
// A signal that fails to match ANY rule returns UNKNOWN with
// ruleKey "unclassified". UNKNOWN is a first-class outcome, not an
// error — the founder can still preview / download the document; only
// downstream extraction logic changes behaviour on it.

import type { IngestedDocumentClassification } from "./types";

export interface ClassifySignals {
  filename: string;              // sanitised filename
  originalFilename: string;      // raw
  mimeType: string;
  emailSubject?: string | null;
  senderAddress?: string | null; // full "name@domain.tld"
  emailBodyExcerpt?: string | null; // first 500 chars, may be null
}

export interface ClassifyOutcome {
  classification: IngestedDocumentClassification;
  ruleKey: string;
}

interface Rule {
  key: string;
  classification: IngestedDocumentClassification;
  matches: (s: ClassifySignals) => boolean;
}

const CLASSIFY_RULES_VERSION = 1;
export { CLASSIFY_RULES_VERSION };

function containsAny(haystack: string | undefined | null, needles: string[]): boolean {
  if (!haystack) return false;
  const hay = haystack.toLowerCase();
  return needles.some((n) => hay.includes(n));
}

function filenameSignal(s: ClassifySignals): string {
  return `${s.filename} ${s.originalFilename}`.toLowerCase();
}

// Rule order matters — first match wins. Statement first so a filename
// like "credit-note-statement.pdf" resolves to STATEMENT (rare but
// deterministic); credit note before invoice for the same reason.
const RULES: Rule[] = [
  {
    key: "filename.statement",
    classification: "STATEMENT",
    matches: (s) =>
      containsAny(filenameSignal(s), ["statement", "aged-statement", "aging-statement", "stmt"]),
  },
  {
    key: "subject.statement",
    classification: "STATEMENT",
    matches: (s) =>
      containsAny(s.emailSubject, ["statement", "aged statement", "statement of account", "aging statement"]),
  },
  {
    key: "filename.credit_note",
    classification: "CREDIT_NOTE",
    matches: (s) =>
      containsAny(filenameSignal(s), ["credit-note", "credit_note", "creditmemo", "credit-memo"]),
  },
  {
    key: "subject.credit_note",
    classification: "CREDIT_NOTE",
    matches: (s) =>
      containsAny(s.emailSubject, ["credit note", "credit memo", "credit adjustment"]),
  },
  {
    key: "filename.remittance",
    classification: "REMITTANCE",
    matches: (s) =>
      containsAny(filenameSignal(s), ["remittance", "payment-advice", "remit"]),
  },
  {
    key: "subject.remittance",
    classification: "REMITTANCE",
    matches: (s) =>
      containsAny(s.emailSubject, ["remittance", "payment advice", "remit advice"]),
  },
  {
    key: "filename.purchase_order",
    classification: "PURCHASE_ORDER",
    matches: (s) =>
      containsAny(filenameSignal(s), ["purchase-order", "purchase_order", "po-", "po_"]),
  },
  {
    key: "subject.purchase_order",
    classification: "PURCHASE_ORDER",
    matches: (s) =>
      containsAny(s.emailSubject, ["purchase order", "po number", "po#"]),
  },
  {
    key: "filename.invoice",
    classification: "INVOICE",
    matches: (s) =>
      containsAny(filenameSignal(s), ["invoice", "inv-", "inv_", "bill-", "bill_"]),
  },
  {
    key: "subject.invoice",
    classification: "INVOICE",
    matches: (s) =>
      containsAny(s.emailSubject, ["invoice", "your bill", "amount due"]),
  },
  {
    key: "body.invoice",
    classification: "INVOICE",
    matches: (s) =>
      containsAny(s.emailBodyExcerpt, ["invoice number", "amount due", "total due"]),
  },
];

export function classifyDocument(signals: ClassifySignals): ClassifyOutcome {
  for (const rule of RULES) {
    if (rule.matches(signals)) {
      return { classification: rule.classification, ruleKey: rule.key };
    }
  }
  return { classification: "UNKNOWN", ruleKey: "unclassified" };
}
