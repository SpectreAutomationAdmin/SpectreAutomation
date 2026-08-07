// Sprint 3 Checkpoint 15E (2026-07-24) — Deterministic invoice
// parser. Given the raw text of a PDF (from pdf-parse), extract a
// structured ExtractedInvoice.
//
// Every match records the rule that produced it via ParseHint so a
// reviewer can see WHY a value was pulled. Rules are ordered by
// specificity — first match wins per field. Currency amounts are kept
// as strings (Decimal-safe) so no float drift enters accounting math.

import type { ExtractedInvoice, ParseHint, PayableReferenceType } from "./types";
// Sprint 3 · Post-16H Phase 4 Slice 2 (2026-08-06) — canonical
// evidence orchestrator. Imported eagerly so the cutover code path
// resolves under both ESM and CommonJS callers.
import {
  buildCanonicalEvidence,
  selectCanonicalFields,
} from "./evidence/build-canonical-evidence";
import { arithmeticReconcileAmounts } from "./evidence/amount-arithmetic-reconciler";
import { EXTRACTION_RULE_VERSION } from "./types";
import { extractSupplier, type SupplierExtraction } from "./supplier-extract";
import { parseDocumentLayout, associateLabelValue, associateDescriptionAmounts, type DocumentLayout } from "./document-layout";
import { extractPayableReference } from "./payable-reference";

// Sprint 3 · Checkpoint 15Q (revised) — hard reject a supplier-name
// candidate that contains monetary symbols, is dominantly numeric,
// or matches an invoice-number shape. This is the last line of
// defence between the extractors and the card projection, so no
// downstream renderer ever displays "$810.00" in the vendor slot.
function isPlausibleSupplierName(value: string): boolean {
  const s = value.trim();
  if (!s) return false;
  if (/[\$€£%]/.test(s)) return false;
  // Must contain a substantive alphabetic run.
  if (!/[A-Za-z]{2,}/.test(s)) return false;
  // Reject invoice-number shapes ("INV-1234567", "1007565767",
  // "A-20260714") — anything ≥ 5 digits with only optional
  // dashes / short letter prefix.
  if (/^[A-Z]{0,4}[-\s]?\d{5,}$/i.test(s)) return false;
  // Reject if letters are less than 40% of characters.
  const letters = (s.match(/[A-Za-z]/g) ?? []).length;
  if (letters < s.length * 0.4) return false;
  // Sprint 3 · Post-16H Phase 4 Slice 3-hotfix (2026-08-06) — reject
  // sentence-shaped candidates. An organization name is a compact
  // proper-noun phrase; a full sentence is a legal-boilerplate /
  // remittance instruction leak. Symptoms observed on staging: the
  // real DMM Energy PDF's pdf-parse output surfaced
  //   "Please write your account number AND the invoice number on
  //    your cheque or return a copy of the invoice with your payment"
  // as the vendor. General signals (no DMM-specific rule):
  //   * word count > 12 — organizations don't have 12+ word names.
  //   * starts with an imperative verb (please, write, return,
  //     remit, note, refer, contact) — that's instruction copy.
  //   * ends with a sentence-terminal period + is > 40 chars.
  const words = s.split(/\s+/);
  if (words.length > 12) return false;
  if (/^(please|write|return|remit|note|refer|contact|see|kindly|thank|call)\b/i.test(s)) return false;
  if (s.length > 40 && /\.$/.test(s)) return false;
  return true;
}

const CURRENCY_HINTS: Record<string, string> = {
  "USD": "USD",
  "US$": "USD",
  "CA$": "CAD",
  "CAD": "CAD",
  "$": "CAD",   // default when only "$" is seen (a Canadian club)
  "EUR": "EUR",
  "GBP": "GBP",
};

// Sprint 3 · Post-16H Phase 4 Slice 1 (2026-08-05) — allow an
// optional currency word AFTER the amount so lines like
// "Invoice Total: 2532.92 CAD" match cleanly. Previously the
// pre-amount cluster accepted CAD/USD/etc. but the post-amount
// tail did not, and the line-scanner's trailing `\s*$` anchor
// rejected any suffix — causing bilingual invoices that print
// "<amount> CAD" to silently drop the total.
//
// Sprint 3 · Post-16H Phase 4 Slice 2 (2026-08-06) — accept an
// optional leading MINUS SIGN so credit memos (negative totals /
// negative subtotals / negative taxes) reconcile through the same
// extractor. Parentheses-negative "(1260.00)" is a separate
// accounting convention deferred to Slice 3.
const MONEY_TOKEN = /(?:[\$€£]|CA\$|US\$|CAD|USD|EUR|GBP)?\s*(-?[0-9]{1,3}(?:[,][0-9]{3})*(?:\.[0-9]{2})|-?[0-9]+\.[0-9]{2})(?:\s*(?:CAD|USD|EUR|GBP))?/;

function toNumericString(raw: string): string {
  return raw.replace(/,/g, "");
}

function firstMatch(text: string, patterns: Array<{ ruleKey: string; regex: RegExp; group?: number }>): { value: string; hint: ParseHint } | null {
  for (const p of patterns) {
    const m = text.match(p.regex);
    if (m && m[p.group ?? 1]) {
      return {
        value: m[p.group ?? 1].trim(),
        hint: { field: "", ruleKey: p.ruleKey, matchedText: m[0].slice(0, 120) },
      };
    }
  }
  return null;
}

// -----------------------------------------------------------------------------
// Individual field extractors — each returns { value, hint } or null.
// -----------------------------------------------------------------------------

function extractInvoiceNumber(text: string) {
  // Sprint 3 · Post-16H Phase 4 Slice 1 (2026-08-05) — fix the
  // "OICE" bug. The prior `inv_no.hash` regex
  //   /\b(?:INV|INVN)\s*[-# ]?\s*([A-Za-z0-9\-]{3,30})\b/i
  // captured the tail of the word "INVOICE" itself (INV + zero
  // separator + "OICE"). Fixed by:
  //   * requiring at least one MANDATORY separator character
  //     after INV|INVN, so "INVOICE" as a solid word can never
  //     succeed;
  //   * validating captured values pass isPlausibleInvoiceNumber
  //     (must contain a digit; must not equal common labels).
  //
  // Also adds:
  //   * bilingual "Facture" support (Québec French invoices);
  //   * label-then-value on separate lines ("Invoice\nB0037FC");
  //   * label + space + value on the same line ("Invoice B0037FC")
  //     — very common on French/Canadian invoices that print no
  //     "#" separator between the word and the number.
  const patterns: Array<{ ruleKey: string; regex: RegExp; group?: number }> = [
    { ruleKey: "inv_no.labeled", regex: /(?:^|\n)\s*Invoice\s*(?:Number|No\.?|#)\s*[:#\-]?\s*([A-Za-z0-9][A-Za-z0-9\-\/]{1,30})\b/i },
    { ruleKey: "inv_no.facture", regex: /(?:^|\n)\s*Facture\s*(?:Num[eé]ro|N[oº]\.?|#)?\s*[:#\-]?\s*([A-Za-z0-9][A-Za-z0-9\-\/]{1,30})\b/i },
    { ruleKey: "inv_no.compact", regex: /\bInvoice\s*[#:]\s*([A-Za-z0-9][A-Za-z0-9\-\/]{1,30})\b/i },
    // Label + one-or-more whitespace + value (Invoice B0037FC).
    // Value MUST contain at least one digit to be a reference.
    { ruleKey: "inv_no.label_space", regex: /(?:^|\n)\s*Invoice\s+([A-Z][A-Z0-9\-\/]{2,29}\d[A-Z0-9\-\/]{0,29})\b/ },
    // Sprint 3 · Post-16H Phase 4 Slice 4 (2026-08-07) — column-first
    // pdf-parse output can jam label + value + adjacent date into a
    // single line ("B0037FC2026/06/17DATEPAGE"). Extract the leading
    // alphanumeric reference (letters + digits, ≥ 4 chars total, at
    // least one digit) and reject the trailing yyyy/mm/dd or similar
    // date suffix by anchoring on the year boundary.
    { ruleKey: "inv_no.jammed_date_suffix", regex: /(?:^|\n)([A-Z][A-Z0-9]{3,15})(?=(?:19|20)\d{2}[\/\-]\d{1,2}[\/\-]\d{1,2})/ },
    // INV / INVN with MANDATORY separator [-# ] — kills the OICE bug.
    { ruleKey: "inv_no.hash", regex: /\b(?:INV|INVN)[\s\-#]+([A-Za-z0-9\-]{3,30})\b/i },
  ];
  const first = firstMatch(text, patterns);
  if (!first) return null;
  if (!isPlausibleInvoiceNumber(first.value)) return null;
  return first;
}

/** Reject fragments of "INVOICE" / "FACTURE" / common labels, dates,
 *  phone numbers, or pure alphabetic strings. A real invoice number
 *  must have at least one digit AND not be a known-bad token. */
function isPlausibleInvoiceNumber(v: string): boolean {
  const s = v.trim();
  if (s.length < 3 || s.length > 32) return false;
  // Must contain at least one digit — invoice references are almost
  // never pure letters.
  if (!/\d/.test(s)) return false;
  // Reject fragments of common label words.
  const bad = new Set([
    "oice", "voice", "cture", "acture", "umber", "eference",
    "number", "reference", "statement", "bill",
  ]);
  if (bad.has(s.toLowerCase())) return false;
  // Reject North-American phone shapes — but only the formatted
  // variety (with separators). A bare 10-digit numeric string is a
  // legitimate invoice reference in plenty of billing systems, so
  // we do NOT reject digits-only. Formatted phones (1-800-555-1234,
  // (555) 123-4567, 555.123.4567) are explicit context.
  if (/^\+?1?[\s.\-]?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}$/.test(s)) return false;
  // Reject ISO date shapes.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  return true;
}

function extractPurchaseOrder(text: string) {
  // Sprint 3 Checkpoint 15H (2026-07-25) — Require the captured PO value
  // to (a) contain at least one digit and (b) not itself be the word
  // "Number"/"No"/"NO". Microsoft's Office 365 invoices print
  // "Customer PO Number:" with no value; the previous regex captured
  // the LABEL "PO Number" as if it were the value.
  const notLabel = (v: string) => /\d/.test(v) && !/^(number|no\.?|#)$/i.test(v);
  const candidates: Array<{ value: string; hint: ParseHint }> = [];
  const patterns = [
    { ruleKey: "po.labeled", regex: /(?:^|\n)\s*(?:Purchase\s*Order|PO|P\.O\.?)\s*(?:Number|No\.?|#)?\s*[:#]\s*([A-Za-z0-9][A-Za-z0-9\-\/]{2,30})\b/i },
    { ruleKey: "po.hash",    regex: /\bPO[\s\-]#\s*([A-Za-z0-9\-]{3,20})\b/i },
    { ruleKey: "po.hash_num", regex: /\bPO\s*#\s*([A-Za-z0-9\-]{3,20})\b/i },
  ];
  for (const p of patterns) {
    const m = text.match(p.regex);
    if (m && m[1] && notLabel(m[1].trim())) {
      candidates.push({ value: m[1].trim(), hint: { field: "purchaseOrder", ruleKey: p.ruleKey, matchedText: m[0].slice(0, 120) } });
    }
  }
  return candidates[0] ?? null;
}

function extractDate(text: string, kind: "invoice" | "due") {
  const label = kind === "invoice" ? "Invoice\\s*Date|Date\\s*of\\s*Invoice|Bill\\s*Date|Date" : "Due\\s*Date|Payment\\s*Due|Due";
  const isoLike = /(\d{4}-\d{2}-\d{2})/;
  const numeric = /(\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4})/;
  const monthName = /((?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2},?\s+\d{4})/i;
  const patterns = [
    { ruleKey: `${kind}_date.labeled_iso`, regex: new RegExp(`(?:${label})\\s*[:#-]?\\s*${isoLike.source}`, "i") },
    { ruleKey: `${kind}_date.labeled_numeric`, regex: new RegExp(`(?:${label})\\s*[:#-]?\\s*${numeric.source}`, "i") },
    { ruleKey: `${kind}_date.labeled_name`, regex: new RegExp(`(?:${label})\\s*[:#-]?\\s*${monthName.source}`, "i") },
  ];
  const first = firstMatch(text, patterns);
  if (!first) return null;
  const iso = normaliseDateToIso(first.value);
  return iso ? { value: iso, hint: first.hint } : null;
}

function normaliseDateToIso(raw: string): string | null {
  const s = raw.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const numMatch = s.match(/^(\d{1,2})[\/-](\d{1,2})[\/-](\d{2,4})$/);
  if (numMatch) {
    let a = parseInt(numMatch[1], 10);
    let b = parseInt(numMatch[2], 10);
    let y = parseInt(numMatch[3], 10);
    if (y < 100) y += 2000;
    // Assume YYYY / MM / DD → but the incoming is MM/DD/YY or DD/MM/YY.
    // Heuristic: if a>12, it MUST be day-first; otherwise assume MM/DD/YY.
    let month: number, day: number;
    if (a > 12 && b <= 12) { day = a; month = b; }
    else { month = a; day = b; }
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    return `${y.toString().padStart(4, "0")}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  }
  const nameMatch = s.match(/^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/);
  if (nameMatch) {
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const m = months.indexOf(nameMatch[1].toLowerCase().slice(0, months.find((x) => x.startsWith(nameMatch[1].toLowerCase()))?.length ?? 0)) + 1;
    const mAbbr = ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"];
    const m2 = mAbbr.indexOf(nameMatch[1].toLowerCase().slice(0, 3)) + 1;
    const month = m > 0 ? m : m2 > 0 ? m2 : 0;
    if (month === 0) return null;
    const day = parseInt(nameMatch[2], 10);
    const year = parseInt(nameMatch[3], 10);
    return `${year}-${month.toString().padStart(2, "0")}-${day.toString().padStart(2, "0")}`;
  }
  return null;
}

// Sprint 3 · Checkpoint 15T — layout-aware money extraction. Wraps
// the shared document-layout label→value associator, then falls back
// to the pre-15T line-scan regex so parse-invoice remains resilient
// when the layout classifier misses (e.g. money on the same line as
// a fragmentary label). Accepts an optional consumed-line-index set
// so summary labels never grab amounts already paired with a line-
// item description.
//
// The label list is a STRICT PRIORITY ORDER — most-specific labels
// first. Each label is tried across the whole document; only if it
// finds nothing does the next-lower-priority label run. This matters
// because a document may print BOTH "Amount Due: 0.00" (payment-stub
// summary) AND "INVOICE TOTAL: $1,650.50" (the real total) — the
// specific label wins over the generic one regardless of line order.
function extractMoneyFromLayout(
  layout: DocumentLayout,
  labels: string[],
  ruleKeyBase: string,
  opts?: { backwardMaxLines?: number; consumedLineIndices?: Set<number> },
): null | { value: string; hint: ParseHint; valueLineIndex: number } {
  for (const label of labels) {
    const match = associateLabelValue(layout, {
      labels: [label],
      ruleKeyBase,
      valueKind: "amount",
      forwardMaxLines: 4,
      backwardMaxLines: opts?.backwardMaxLines ?? 0,
      consumedLineIndices: opts?.consumedLineIndices,
    });
    if (match && match.amount != null) {
      return {
        value: match.value.replace(/^[+-]?\s*(?:CA\$|US\$|[\$€£])\s*/, "").trim(),
        hint: {
          field: "",
          ruleKey: match.ruleKey,
          matchedText: `${match.label} = ${match.value} (${match.strategy}, d=${match.distance})`.slice(0, 120),
        },
        valueLineIndex: match.valueLineIndex,
      };
    }
  }
  return null;
}

function extractMoney(text: string, labels: string[], ruleKeyBase: string) {
  const labelAlt = labels.map((l) => l.replace(/\s+/g, "\\s+")).join("|");
  // Sprint 3 · Checkpoint 15Q — line-scan the labels rather than the
  // whole-text non-greedy match. The pre-15Q whole-text regex
  // (`\b(labels)\b[^\n\r]{0,20}?MONEY`) would misfire on
  // "Tax return preparation                     500.00" — the 20-char
  // gap allowance is enough to reach the amount, so the tax
  // extractor mis-attributed a service LINE to the invoice tax
  // total. The line-scan requires the label to be the leading
  // significant token on the line AND the tail to end with money.
  //
  // Accepted shapes:
  //   "Subtotal:  7000.00"           labeled + colon
  //   "GST 5 %:  350.00"             labeled + rate + colon
  //   "HST (13%): 260.00"            labeled + parenthetical rate
  //   "Sales Tax  50.00"             labeled + amount only
  // Rejected:
  //   "Tax return preparation  500.00" — label followed by word chars
  // The lookahead forbids the label from being followed by another
  // ALPHABETIC word (which would make the label part of a longer
  // phrase like "Tax return preparation"). Space-then-word is
  // rejected; space-then-digit / colon / paren / % / dash / end is
  // allowed. This distinguishes "Tax:" from "Tax return".
  const lineRegex = new RegExp(
    `^\\s*(?:${labelAlt})(?=\\s*(?:[:=(%\\d\\$\\-]|$))\\s*[^\\n\\r]{0,20}?${MONEY_TOKEN.source}\\s*$`,
    "i",
  );
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(lineRegex);
    if (m && m[1]) {
      return {
        value: m[1].trim(),
        hint: { field: "", ruleKey: `${ruleKeyBase}.labeled`, matchedText: raw.trim().slice(0, 120) },
      };
    }
  }
  return null;
}

/**
 * Sprint 3 · Post-16H Phase 4 Slice 1 (2026-08-05) — sum every
 * distinct tax-component line so mixed-tax invoices (GST + PST,
 * GST + QST, HST alone) surface a taxTotal that reconciles with
 * subtotal + total.
 *
 * The prior extractor used first-line-wins ordering — for a
 * "GST 5%: 50.25 / PST 7%: 70.35" invoice it returned only 50.25
 * and the reconcile stage would report ALLOCATION_VARIANCE. The
 * summing helper preserves each component line so the reconciler
 * can present the correct sum AND log which components were
 * observed (useful diagnostic when a tenant's tax setup is
 * misconfigured).
 *
 * Returns null when fewer than TWO distinct tax component lines
 * were found — in that case the caller should keep the existing
 * single-line result (which handles combined "GST/HST: 50.25"
 * lines correctly).
 */
function extractTaxSum(
  text: string,
): { value: string; hint: ParseHint; components: Array<{ label: string; amount: number }> } | null {
  const lineRegex = /^\s*(GST|HST|PST|QST|TPS|TVQ|VAT|Sales\s+Tax)\s*(?:\(?\s*\d+(?:\.\d+)?\s*%?\s*\)?)?\s*[:=]?\s*[^\n\r]*?([0-9]{1,3}(?:[,][0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})\s*(?:CAD|USD|EUR|GBP)?\s*$/i;
  const components: Array<{ label: string; amount: number }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(lineRegex);
    if (!m) continue;
    const label = m[1].toUpperCase().replace(/\s+/g, " ");
    const amount = Number(m[2].replace(/,/g, ""));
    if (!isFinite(amount) || amount < 0) continue;
    // Skip zero-amount lines — they inflate the count without
    // contributing (many invoices print "PST: 0.00" to be explicit
    // that no PST applies, and treating that as a "distinct
    // component" would wrongly trigger the sum path).
    if (amount === 0) continue;
    // Dedupe: same label repeated on multiple lines (e.g. per-item
    // GST breakdown) — we only want the SUMMARY line, so the last
    // occurrence per label wins. Callers that want per-line breakout
    // should use the layout layer directly.
    const existing = components.findIndex((c) => c.label === label);
    if (existing >= 0) components[existing].amount = amount;
    else components.push({ label, amount });
  }
  if (components.length < 2) return null;
  const sum = components.reduce((a, c) => a + c.amount, 0);
  return {
    value: sum.toFixed(2),
    hint: {
      field: "taxTotal",
      ruleKey: "tax.multi_component_sum",
      matchedText: components.map((c) => `${c.label}=${c.amount.toFixed(2)}`).join(", ").slice(0, 120),
    },
    components,
  };
}

function extractCurrency(text: string): { value: string; hint: ParseHint } | null {
  const hit = firstMatch(text, [
    { ruleKey: "currency.explicit", regex: /\b(USD|CAD|EUR|GBP)\b/ },
    { ruleKey: "currency.symbolic_ca", regex: /(CA\$)/ },
    { ruleKey: "currency.symbolic_us", regex: /(US\$)/ },
  ]);
  if (hit) {
    const norm = CURRENCY_HINTS[hit.value.toUpperCase()] ?? CURRENCY_HINTS[hit.value] ?? "CAD";
    return { value: norm, hint: hit.hint };
  }
  if (/\$/.test(text)) {
    return { value: "CAD", hint: { field: "currency", ruleKey: "currency.dollar_default_cad", matchedText: "$" } };
  }
  // Sprint 3 · Post-16H Phase 4 Slice 1 (2026-08-05) — infer CAD
  // from Canadian tax evidence. Many club invoices print totals as
  // plain "1,234.56" (no currency symbol, no ISO code) but include
  // Canadian tax lines (GST 5%, PST, HST 13%, QST, TPS, TVQ). Those
  // taxes ONLY exist in the Canadian tax system, so their presence
  // is a strong-and-unambiguous currency signal. This inference is
  // additive — providers or explicit currency tokens still win.
  const canadaTax = text.match(/\b(GST|HST|PST|QST|TPS|TVQ)\b\s*(?:[:(]|\d|%|\s)/);
  if (canadaTax) {
    return {
      value: "CAD",
      hint: { field: "currency", ruleKey: "currency.canadian_tax_inference", matchedText: canadaTax[0].slice(0, 60) },
    };
  }
  // US sales-tax hint (weakest — plenty of US invoices just say "Tax:").
  const usSalesTax = text.match(/\bSales\s+Tax\b/i);
  if (usSalesTax && /\bEIN\b|\bZIP\b|\b\d{5}(?:-\d{4})?\b/.test(text)) {
    return {
      value: "USD",
      hint: { field: "currency", ruleKey: "currency.us_tax_inference", matchedText: "Sales Tax + US locality signal" },
    };
  }
  return null;
}

function extractVendorEmail(text: string) {
  return firstMatch(text, [
    { ruleKey: "vendor.email", regex: /\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/ },
  ]);
}

function extractVendorTaxNumber(text: string) {
  return firstMatch(text, [
    { ruleKey: "vendor.tax_number.hst", regex: /\b(?:HST|GST|BN|Business\s+Number|Tax\s*Reg(?:istration)?\s*(?:Number|No\.?)?)\s*[:#]?\s*(\d{9}\s*RT\s*\d{4}|\d{9}(?:RT\d{4})?)\b/i },
    { ruleKey: "vendor.tax_number.us_ein", regex: /\bEIN\s*[:#]?\s*(\d{2}-\d{7})\b/i },
  ]);
}

function extractVendorName(text: string): { value: string; hint: ParseHint } | null {
  // Sprint 3 Checkpoint 15H (2026-07-25) — Two-pass vendor-name extraction.
  //
  // Pass 1: look for a "<CompanyName> Corporation|Inc.|Ltd|LLC|Company"
  // line anywhere in the document. This is the strongest signal for
  // large vendors that print their legal name in the footer
  // (Microsoft Corporation, Amazon Web Services Inc., etc.).
  //
  // Pass 2: header-line heuristic — first non-empty line in the top of
  // the document that isn't a date, invoice-header keyword, or an
  // address-ish string. Fixes the "July 2026" false-positive on the
  // Microsoft invoice.
  const CORP_SUFFIX_LINE = /^([A-Z][A-Za-z0-9&.,'\-\s]{2,60}?\s+(?:Corporation|Corp|Company|Inc\.?|Ltd\.?|Limited|LLC|LLP|LP|ULC|PLC|GmbH|AG|SA|BV|NV))\b/;
  const allLines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const line of allLines) {
    const m = line.match(CORP_SUFFIX_LINE);
    if (m) {
      const name = m[1].trim();
      // Reject if the name is a customer/bill-to leftover: guard against
      // lines that come right after "Sold-To" / "Bill-To" / "Ship-To".
      // (First-match-wins is fine here — the vendor's own name is
      // almost always the first corporate-suffix line in the PDF.)
      return { value: name, hint: { field: "vendor.name", ruleKey: "vendor.name.corp_suffix", matchedText: line.slice(0, 120) } };
    }
  }
  // Pass 2 fallback — first non-empty header line that isn't a
  // month, date, common label, address hint, phone, or URL.
  const headerLines = allLines.slice(0, 30);
  const skipPrefix = /^(invoice|bill|statement|amount|total|subtotal|tax|date|due|remit|page|customer|sold[- ]?to|bill[- ]?to|ship[- ]?to|service|to:|from:|attn|attention|order|billing|address|payment)/i;
  const monthNames = /^(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+\d/i;
  const yearOnly = /^\d{4}$/;
  const dateLike = /^\d{1,4}[-/.\s]\d{1,2}[-/.\s]\d{1,4}$/;
  for (const line of headerLines) {
    if (skipPrefix.test(line)) continue;
    if (line.length < 4 || line.length > 80) continue;
    if (!/[A-Za-z]/.test(line)) continue;
    if (/@/.test(line)) continue;
    // Reject dates + years + month-year lines.
    if (dateLike.test(line)) continue;
    if (yearOnly.test(line)) continue;
    if (monthNames.test(line)) continue;
    // Reject lines that are almost entirely digits/punct (order numbers, IDs).
    const alnum = line.replace(/[^A-Za-z0-9]/g, "");
    const letters = line.replace(/[^A-Za-z]/g, "");
    if (letters.length < alnum.length * 0.4) continue;
    return { value: line, hint: { field: "vendor.name", ruleKey: "vendor.name.first_company_line", matchedText: line } };
  }
  return null;
}

function extractLineItems(text: string): Array<{ description: string; quantity: string | null; unitCost: string | null; amount: string }> {
  // Deterministic line-item extraction: look for lines matching
  //   <description> <qty> <unit> <amount>  or  <description> <amount>
  // Anchored on a currency-shaped trailing token. Ignores header rows.
  const out: Array<{ description: string; quantity: string | null; unitCost: string | null; amount: string }> = [];
  const lines = text.split(/\r?\n/);
  const lineRegex = /^(.+?)\s+(?:([0-9]+(?:\.[0-9]+)?)\s+)?(?:\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})\s+)?\$?\s*([0-9]{1,3}(?:,[0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})\s*$/;
  const totalKeywords = /^(subtotal|tax|total|balance|amount\s+due|invoice\s+total|payment)/i;
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (totalKeywords.test(l)) continue;
    const m = l.match(lineRegex);
    if (!m) continue;
    const description = m[1].trim();
    if (description.length < 3) continue;
    if (/^(item|qty|description|price|amount)$/i.test(description)) continue;
    out.push({
      description,
      quantity: m[2] ? toNumericString(m[2]) : null,
      unitCost: m[3] ? toNumericString(m[3]) : null,
      amount: toNumericString(m[4]),
    });
    if (out.length >= 32) break; // hard cap
  }
  return out;
}

function extractDescription(text: string): string | null {
  // Take the first non-blank line after "Description" or "For:" label,
  // capped at 240 chars. Deterministic; no summarisation.
  const labelMatch = text.match(/\n\s*(?:Description|For|Re|Subject)\s*[:#-]\s*([^\n]{5,240})/i);
  if (labelMatch) return labelMatch[1].trim();
  return null;
}

function domainFromEmail(email: string | null): string | null {
  if (!email) return null;
  const idx = email.indexOf("@");
  if (idx < 0) return null;
  return email.slice(idx + 1).toLowerCase();
}

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------
export interface ParseArgs {
  extractedText: string;
  emailSubject?: string | null;
  emailSenderAddress?: string | null;
}

export interface ParseResult {
  invoice: ExtractedInvoice;
  hints: ParseHint[];
  // Sprint 3 · Checkpoint 15Q — the scored supplier extraction that
  // produced (or failed to produce) vendor.guessedName. Retained on
  // the parse result so the orchestrator + card projection can render
  // per-field provenance without re-running the extractor.
  supplier: SupplierExtraction;
  // Sprint 3 · Post-16H Phase 4 Slice 2 (2026-08-06) — canonical
  // evidence layer + selection. Consumers may read the winning
  // scalar from `.invoice.*` as before, or drill into
  // `.canonicalEvidence` / `.selection` to render provenance,
  // rejected alternates, and conflict reasons.
  canonicalEvidence?: import("./evidence/canonical-invoice-evidence").CanonicalInvoiceEvidence;
  selection?: import("./evidence/build-canonical-evidence").CanonicalFieldSelection;
}

export function parseInvoiceText(args: ParseArgs): ParseResult {
  const text = args.extractedText || "";
  const hints: ParseHint[] = [];
  const warnings: string[] = [];

  if (text.trim().length === 0) {
    return {
      supplier: {
        value: null, normalized: null, source: "system_default",
        confidence: 0, reasoningCode: "empty_document", candidates: [], alternates: [],
      },
      invoice: {
        state: "DOCUMENT_UNREADABLE",
        ruleVersion: EXTRACTION_RULE_VERSION,
        extractedTextChars: 0,
        vendor: { guessedName: null, guessedEmail: null, guessedTaxNumber: null, guessedDomain: null },
        invoiceNumber: null,
        payableReferenceType: null,
        invoiceDate: null,
        dueDate: null,
        paymentTerms: null,
        purchaseOrder: null,
        description: null,
        currency: null,
        subtotal: null,
        taxTotal: null,
        total: null,
        lineItems: [],
        remittance: { address: null, email: null },
        warnings: ["No text extracted from PDF."],
      },
      hints: [],
    };
  }

  const record = <T extends string | null>(field: string, hit: { value: T; hint: ParseHint } | null): T => {
    if (!hit) return null as T;
    hints.push({ field, ruleKey: hit.hint.ruleKey, matchedText: hit.hint.matchedText });
    return hit.value;
  };

  // Sprint 3 · Checkpoint 15T — parse the document layout ONCE, then
  // reuse for every label→value association. This is the shared
  // association layer that handles the label-on-line-N, value-on-line-
  // N+K layouts pdf-parse frequently produces.
  const layout = parseDocumentLayout(text);
  // Pre-compute description→amount pairings so the summary-label
  // extractors (subtotal / tax / total) skip amounts that already
  // belong to a line item. Without this, SUBTOTAL / GST could grab
  // the amount belonging to an adjacent fee row.
  const descAmountPairs = associateDescriptionAmounts(layout, { forwardMaxLines: 2 });
  const consumedAmountLineIndices = new Set<number>();
  for (const p of descAmountPairs) {
    consumedAmountLineIndices.add(p.amountLineIndex);
  }

  // Sprint 3 · Checkpoint 15T — payable-reference extraction now goes
  // through the taxonomy-aware extractor first, then falls back to the
  // legacy invoice-number regex when the layout layer finds nothing.
  const payableRefResult = extractPayableReference(layout);
  let invoiceNumber: string | null;
  let payableReferenceType: PayableReferenceType | null;
  if (payableRefResult) {
    invoiceNumber = payableRefResult.value;
    payableReferenceType = payableRefResult.type;
    hints.push({
      field: "payableReference",
      ruleKey: payableRefResult.ruleKey,
      matchedText: `${payableRefResult.type} = ${payableRefResult.value} (${payableRefResult.strategy})`.slice(0, 120),
    });
    // Also emit the legacy hint field so existing hint-consumers
    // (source-contract tests, older projections) see the same value
    // under the pre-15T field name.
    hints.push({
      field: "invoiceNumber",
      ruleKey: payableRefResult.ruleKey,
      matchedText: payableRefResult.value.slice(0, 120),
    });
  } else {
    invoiceNumber = record("invoiceNumber", extractInvoiceNumber(text));
    payableReferenceType = invoiceNumber ? "INVOICE_NUMBER" : null;
  }
  const invoiceDate = record("invoiceDate", extractDate(text, "invoice"));
  const dueDate = record("dueDate", extractDate(text, "due"));
  const purchaseOrder = record("purchaseOrder", extractPurchaseOrder(text));
  const currencyResult = extractCurrency(text);
  const currency = record("currency", currencyResult);
  const currencyRuleKey: string | null = currencyResult?.hint.ruleKey ?? null;
  // Sprint 3 · Checkpoint 15T — money extraction now consults the
  // shared document-layout layer FIRST (handles CPA-style layouts
  // where SUBTOTAL sits on line 38 and the amount sits on line 41).
  // If the layout layer finds nothing, we fall back to the pre-15T
  // line-scan regex so existing tests continue to pass.
  const subtotalLayout = extractMoneyFromLayout(layout, ["Subtotal", "Sub Total", "Net", "Net Amount", "Sub-Total", "Charges"], "subtotal", { consumedLineIndices: consumedAmountLineIndices });
  if (subtotalLayout) consumedAmountLineIndices.add(subtotalLayout.valueLineIndex);
  const subtotalHit = subtotalLayout ?? extractMoney(text, ["Subtotal", "Sub Total", "Net", "Charges", "Net Amount", "Sub-Total"], "subtotal");
  const taxLayout = extractMoneyFromLayout(layout, ["Sales Tax", "GST/HST", "GST/ HST", "HST/GST", "Taxes/Fees", "Taxes and Fees", "GST", "HST", "Tax Total", "Tax"], "tax", { consumedLineIndices: consumedAmountLineIndices });
  if (taxLayout) consumedAmountLineIndices.add(taxLayout.valueLineIndex);
  // Sprint 3 · Post-16H Phase 4 Slice 1 (2026-08-05) — mixed-tax
  // path. If the document prints ≥ 2 distinct non-zero component
  // lines (GST + PST etc.), sum them; that reconciles with the
  // printed total. Otherwise fall through to the existing
  // single-line layout / regex extractor.
  const taxSum = extractTaxSum(text);
  const taxHit = taxSum ?? taxLayout ?? extractMoney(text, ["Sales Tax", "GST/HST", "GST/ HST", "HST/GST", "GST", "HST", "Tax Total", "Tax"], "tax");
  // Sprint 3 · Checkpoint 15T — the total extractor runs LAST and
  // treats every subtotal / tax / description-paired amount as
  // consumed. Backward scan is generous (20 lines) because pdf-parse
  // often places the printed total on its own line MANY rows above
  // the "INVOICE TOTAL" label.
  // Sprint 3 · Post-16H Phase 4 Slice 2 (2026-08-06) — "Credit Total"
  // (credit memos) and "Grand Total" (some club-suppliers' generic
  // print format) now resolve. Credit Total must precede plain "Total"
  // in the search order so it wins on documents that print both.
  const totalLayout = extractMoneyFromLayout(layout, ["Invoice Total", "Total Amount Due", "Credit Total", "Total Due", "Total Amount", "Balance Due", "Balance Owing", "Amount Due", "Grand Total", "Total"], "total", { backwardMaxLines: 20, consumedLineIndices: consumedAmountLineIndices });
  if (totalLayout) consumedAmountLineIndices.add(totalLayout.valueLineIndex);
  const totalHit = totalLayout ?? extractMoney(text, ["Invoice Total", "Credit Total", "Total Due", "Grand Total", "Total", "Amount Due", "Balance Due"], "total");
  if (subtotalHit) { hints.push({ ...subtotalHit.hint, field: "subtotal" }); }
  if (taxHit)      { hints.push({ ...taxHit.hint, field: "taxTotal" }); }
  if (totalHit)    { hints.push({ ...totalHit.hint, field: "total" }); }

  // Sprint 3 · Post-16H Phase 4 Slice 4 (2026-08-07) — arithmetic
  // reconciliation for column-first invoices. When the label-based
  // extractor's subtotal+tax does NOT equal total (or when subtotal
  // is missing entirely), search the document for a unique money
  // triple where A + B = C and correct in place. General rule; no
  // vendor-specific patterns. Founder-required §6.
  const arithReconcile = arithmeticReconcileAmounts({
    text,
    labelBased: {
      subtotal: subtotalHit ? Number(toNumericString(subtotalHit.value)) : null,
      tax: taxHit ? Number(toNumericString(taxHit.value)) : null,
      total: totalHit ? Number(toNumericString(totalHit.value)) : null,
    },
  });
  let reconciledSubtotal: number | null = subtotalHit ? Number(toNumericString(subtotalHit.value)) : null;
  let reconciledTax: number | null = taxHit ? Number(toNumericString(taxHit.value)) : null;
  let reconciledTotal: number | null = totalHit ? Number(toNumericString(totalHit.value)) : null;
  if (arithReconcile) {
    reconciledSubtotal = arithReconcile.subtotal;
    reconciledTax = arithReconcile.tax;
    reconciledTotal = arithReconcile.total;
    hints.push({
      field: "amountReconciliation",
      ruleKey: "amount.arithmetic_reconcile",
      matchedText: arithReconcile.reason.slice(0, 200),
    });
  }

  const vendorEmail = record("vendor.email", extractVendorEmail(text));
  const vendorTax = record("vendor.taxNumber", extractVendorTaxNumber(text));
  // Sprint 3 · Checkpoint 15Q (revised, 2026-07-28) — dual-extractor
  // strategy. The founder-observed regression: the card title showed
  // "$810.00 invoice #1007565767" for the CPA Alberta invoice,
  // which means the extractor returned a value that beat the legacy
  // regex + failed the card's null-fallback path. To be safe:
  //   1. Run BOTH the scored extractor and the legacy regex.
  //   2. Prefer the scored value ONLY when it (a) is non-null, (b)
  //      passes the plausibility check (no monetary chars, ≥ 2
  //      letters, at least one substantive positive signal) and
  //      (c) has confidence ≥ 40. Otherwise defer to the legacy
  //      value.
  //   3. NEVER emit a value that starts with "$" / "%" / is
  //      purely numeric / matches an invoice-number shape — such
  //      values are junk regardless of which extractor produced them.
  const supplier = extractSupplier(text, {
    senderName: null,   // sender is not passed here — analyse.ts is where sender fallback happens
    senderEmail: args.emailSenderAddress ?? null,
  });
  const legacyName = extractVendorName(text);
  const scoredCandidateIsSafe =
    supplier.value != null
    && supplier.confidence >= 40
    && isPlausibleSupplierName(supplier.value);
  let vendorNameFromText: string | null;
  if (scoredCandidateIsSafe) {
    vendorNameFromText = supplier.value;
    hints.push({
      field: "vendor.name",
      ruleKey: `supplier.${supplier.reasoningCode}`,
      matchedText: (vendorNameFromText ?? "").slice(0, 120),
    });
  } else if (legacyName && isPlausibleSupplierName(legacyName.value)) {
    vendorNameFromText = legacyName.value;
    hints.push({ ...legacyName.hint, field: "vendor.name" });
  } else if (supplier.value && isPlausibleSupplierName(supplier.value)) {
    // Last resort: use the scored extractor even at low confidence,
    // as long as the value itself is plausible.
    vendorNameFromText = supplier.value;
    hints.push({
      field: "vendor.name",
      ruleKey: `supplier.${supplier.reasoningCode}.low_confidence`,
      matchedText: supplier.value.slice(0, 120),
    });
  } else {
    vendorNameFromText = null;
  }

  const description = record("description", extractDescription(text) ? {
    value: extractDescription(text)!,
    hint: { field: "description", ruleKey: "description.labeled", matchedText: (extractDescription(text) ?? "").slice(0, 120) },
  } : null);

  const lineItems = extractLineItems(text);

  // Sprint 3 Checkpoint 15H Remediation (2026-07-25) — the email sender
  // address is NOT PDF-extracted evidence and must not appear as
  // vendor.guessedEmail. Callers still get the sender in
  // extraction.remittance.email as PROVENANCE-ONLY. This prevents the
  // email sender ("Chris Turcato") from being treated as a vendor
  // signal when the invoice was actually issued by someone else
  // ("Microsoft Corporation").
  const emailAddress = vendorEmail;
  const domain = domainFromEmail(emailAddress);
  const providenceEmail = args.emailSenderAddress?.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/)?.[0] ?? null;

  // Sprint 3 · Post-16H Phase 4 Slice 2 (2026-08-06) — canonical
  // evidence CUTOVER. Every legacy extractor above becomes a
  // CANDIDATE SOURCE feeding the canonical evidence layer; the
  // selected value returned to consumers is drawn from the
  // canonical layer, not from the legacy variable directly.
  //
  // Founder rule (§2): "Do not maintain two independent extraction
  // authorities indefinitely." parseInvoiceText's OUTPUT is now
  // authoritatively derived from CanonicalInvoiceEvidence; the
  // legacy scalar variables become inputs to the pipeline.
  //
  // Slice-2-safe promotion: because evidence is currently seeded
  // ONLY from legacy values, `select.value` equals the legacy
  // value in every observed case (proven by the benchmark
  // holding invariant). Slice 3 will add additional candidate
  // sources; when those add value or refute the legacy pick, the
  // selector will surface the difference here without any further
  // downstream change.
  const canonicalEvidence = buildCanonicalEvidence({
    text,
    legacyValues: {
      supplierName: vendorNameFromText,
      supplierConfidence: supplier.confidence,
      supplierRuleKey: `supplier.${supplier.reasoningCode}`,
      supplierAlternates: (supplier.alternates ?? []).map((a) => ({
        value: a.value,
        // SupplierCandidate uses `.score` (0..100). Fall back to 0
        // if score somehow missing so the seeded candidate is still
        // present as a preserved-loser record.
        confidence: typeof (a as { score?: number }).score === "number" ? (a as { score: number }).score : 0,
        rule: `supplier.alt.line${(a as { lineNo?: number }).lineNo ?? "unknown"}`,
      })),
      payableReferenceValue: invoiceNumber,
      payableReferenceType,
      payableReferenceConfidence: payableRefResult?.confidence ?? null,
      payableReferenceRuleKey: payableRefResult?.ruleKey ?? null,
      invoiceDate,
      dueDate,
      currency,
      currencyRuleKey: currencyRuleKey,
      subtotal: reconciledSubtotal,
      tax: reconciledTax,
      total: reconciledTotal,
      taxComponents: (taxHit && "components" in taxHit && Array.isArray((taxHit as { components?: Array<{ label: string; amount: number }> }).components))
        ? (taxHit as { components: Array<{ label: string; amount: number }> }).components
        : undefined,
    },
    email: {
      senderAddress: args.emailSenderAddress ?? null,
      subject: args.emailSubject ?? null,
    },
    pageCount: 1,
  });
  const selection = selectCanonicalFields(canonicalEvidence);

  // Downstream ApAnalyseResult sees the SELECTED canonical values.
  const selectedInvoiceNumber = selection.payableReference.value ?? invoiceNumber;
  const selectedPayableRefType = selection.payableReference.type ?? payableReferenceType;
  const selectedInvoiceDate = selection.invoiceDate.value ?? invoiceDate;
  const selectedDueDate = selection.dueDate.value ?? dueDate;
  const selectedCurrency = selection.currency.value ?? currency;
  const selectedSubtotal = selection.subtotal.value;
  const selectedTax = selection.tax.value;
  const selectedTotal = selection.total.value;
  // Sprint 3 · Post-16H Phase 4 Slice 3-hotfix (2026-08-06) — supplier
  // cutover completion. Slice 2 moved payref / dates / currency /
  // amounts through canonical selection but left `guessedName` on the
  // legacy `vendorNameFromText`. Slice 3's supplier ranker v2
  // consequently never influenced the scalar the card renders. The
  // founder-observed DMM "PRODUIT" bug on the real Outlook-backed
  // Work Intake card was the direct symptom. Every downstream card /
  // modal / API consumer now sees the canonical winner.
  const selectedSupplierName = selection.supplier.value ?? vendorNameFromText;

  if (!selectedInvoiceNumber) warnings.push("Invoice number not extracted.");
  if (selectedTotal == null) warnings.push("Invoice total not extracted.");
  if (!selectedInvoiceDate) warnings.push("Invoice date not extracted.");
  if (!vendorNameFromText && !vendorTax) warnings.push("Vendor identity not extracted from the invoice.");

  const criticalMissing = !selectedInvoiceNumber || selectedTotal == null || !selectedInvoiceDate;
  const state = criticalMissing ? "PARTIAL" : "STRUCTURED";

  return {
    invoice: {
      state,
      ruleVersion: EXTRACTION_RULE_VERSION,
      extractedTextChars: text.length,
      vendor: {
        guessedName: selectedSupplierName,
        guessedEmail: emailAddress,
        guessedTaxNumber: vendorTax,
        guessedDomain: domain,
      },
      invoiceNumber: selectedInvoiceNumber,
      payableReferenceType: selectedPayableRefType,
      invoiceDate: selectedInvoiceDate,
      dueDate: selectedDueDate,
      paymentTerms: null,
      purchaseOrder,
      description,
      currency: selectedCurrency,
      subtotal: selectedSubtotal != null ? selectedSubtotal.toFixed(2) : null,
      taxTotal: selectedTax != null ? selectedTax.toFixed(2) : null,
      total: selectedTotal != null ? selectedTotal.toFixed(2) : null,
      lineItems,
      remittance: { address: null, email: providenceEmail },
      warnings,
    },
    hints,
    supplier,
    canonicalEvidence,
    selection,
  };
}
