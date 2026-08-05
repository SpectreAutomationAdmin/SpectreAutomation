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

// Sprint 3 · Checkpoint 16H rejection #4 (2026-08-06) — bumped to
// version 2 for the mime-default INVOICE fallback. Rule audit trail
// now clearly separates keyword-derived INVOICE classifications
// from mime-default INVOICE classifications.
const CLASSIFY_RULES_VERSION = 2;
export { CLASSIFY_RULES_VERSION };

function isInvoiceCandidateMime(mimeType: string): boolean {
  // A PDF from an email attachment is an invoice candidate unless a
  // more-specific keyword rule (STATEMENT / CREDIT_NOTE / REMITTANCE
  // / PURCHASE_ORDER) already claimed it above. Image types (JPEG,
  // PNG) are also candidates — many small vendors send phone-camera
  // snapshots of paper invoices.
  const m = mimeType.toLowerCase();
  return m === "application/pdf"
    || m === "image/jpeg" || m === "image/jpg"
    || m === "image/png"
    || m === "image/tiff" || m === "image/tif"
    || m === "image/heic" || m === "image/heif";
}

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
  // Sprint 3 · Checkpoint 16H rejection #4 (2026-08-06) — mime-based
  // invoice-candidate fallback. Every unclassified PDF or image
  // attachment defaults to INVOICE so the AP pipeline (OCR →
  // extraction → materialise) runs against the CONTENT, not the
  // filename. Founder §10: filename is weak supporting evidence only.
  //
  // This rule runs LAST so a filename like "purchase-order-42.pdf"
  // still resolves to PURCHASE_ORDER (the earlier keyword rule
  // matches first). Only untagged PDFs like "B0037FC.PDF" and
  // camera-snapshot invoices ("IMG_1234.jpg") take this branch.
  //
  // The OCR/extraction stage is the authority that upgrades to
  // real AP intake OR abstains truthfully (see analyseIngestedInvoice
  // + strategy-router). A vague email body cannot defeat this.
  {
    key: "mime.pdf_or_image_default_invoice",
    classification: "INVOICE",
    matches: (s) => isInvoiceCandidateMime(s.mimeType),
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
