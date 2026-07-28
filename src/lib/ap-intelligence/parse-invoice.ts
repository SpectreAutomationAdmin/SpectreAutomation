// Sprint 3 Checkpoint 15E (2026-07-24) — Deterministic invoice
// parser. Given the raw text of a PDF (from pdf-parse), extract a
// structured ExtractedInvoice.
//
// Every match records the rule that produced it via ParseHint so a
// reviewer can see WHY a value was pulled. Rules are ordered by
// specificity — first match wins per field. Currency amounts are kept
// as strings (Decimal-safe) so no float drift enters accounting math.

import type { ExtractedInvoice, ParseHint } from "./types";
import { EXTRACTION_RULE_VERSION } from "./types";
import { extractSupplier, type SupplierExtraction } from "./supplier-extract";

const CURRENCY_HINTS: Record<string, string> = {
  "USD": "USD",
  "US$": "USD",
  "CA$": "CAD",
  "CAD": "CAD",
  "$": "CAD",   // default when only "$" is seen (a Canadian club)
  "EUR": "EUR",
  "GBP": "GBP",
};

const MONEY_TOKEN = /(?:[\$€£]|CA\$|US\$|CAD|USD|EUR|GBP)?\s*([0-9]{1,3}(?:[,][0-9]{3})*(?:\.[0-9]{2})|[0-9]+\.[0-9]{2})/;

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
  return firstMatch(text, [
    { ruleKey: "inv_no.labeled", regex: /(?:^|\n)\s*Invoice\s*(?:Number|No\.?|#)\s*[:#-]?\s*([A-Za-z0-9][A-Za-z0-9\-\/]{1,30})\b/i },
    { ruleKey: "inv_no.compact", regex: /\bInvoice\s*[#:]\s*([A-Za-z0-9][A-Za-z0-9\-\/]{1,30})\b/i },
    { ruleKey: "inv_no.hash", regex: /\b(?:INV|INVN)\s*[-# ]?\s*([A-Za-z0-9\-]{3,30})\b/i },
  ]);
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

  const invoiceNumber = record("invoiceNumber", extractInvoiceNumber(text));
  const invoiceDate = record("invoiceDate", extractDate(text, "invoice"));
  const dueDate = record("dueDate", extractDate(text, "due"));
  const purchaseOrder = record("purchaseOrder", extractPurchaseOrder(text));
  const currency = record("currency", extractCurrency(text));
  const subtotalHit = extractMoney(text, ["Subtotal", "Sub Total", "Net", "Charges", "Net Amount", "Sub-Total"], "subtotal");
  // Sprint 3 · Checkpoint 15Q — accept compound "GST/HST" labels used
  // by Microsoft-format invoices. Order matters: longest / most-specific
  // patterns first (GST/HST, HST, GST) so extractMoney picks the correct
  // one rather than falling through to bare "GST" or "HST".
  const taxHit = extractMoney(text, ["Sales Tax", "GST/HST", "GST/ HST", "HST/GST", "GST", "HST", "Tax Total", "Tax"], "tax");
  const totalHit = extractMoney(text, ["Invoice Total", "Total Due", "Total", "Amount Due", "Balance Due"], "total");
  if (subtotalHit) { hints.push({ ...subtotalHit.hint, field: "subtotal" }); }
  if (taxHit)      { hints.push({ ...taxHit.hint, field: "taxTotal" }); }
  if (totalHit)    { hints.push({ ...totalHit.hint, field: "total" }); }

  const vendorEmail = record("vendor.email", extractVendorEmail(text));
  const vendorTax = record("vendor.taxNumber", extractVendorTaxNumber(text));
  // Sprint 3 · Checkpoint 15Q — the pre-15Q `extractVendorName` was a
  // regex-only picker that could return a Bill-To recipient or a
  // form-header string. The new `extractSupplier` builds a scored
  // candidate list with positive/negative evidence per candidate,
  // so the leader is chosen by weight of signals — not "first
  // corp-suffix line wins". The legacy regex is used only as a
  // last-ditch tie-breaker when the scored extractor returns null.
  const supplier = extractSupplier(text, {
    senderName: null,   // sender is not passed here — analyse.ts is where sender fallback happens
    senderEmail: args.emailSenderAddress ?? null,
  });
  let vendorNameFromText: string | null = supplier.value;
  if (vendorNameFromText) {
    hints.push({
      field: "vendor.name",
      ruleKey: `supplier.${supplier.reasoningCode}`,
      matchedText: (vendorNameFromText ?? "").slice(0, 120),
    });
  } else {
    // No document-supported supplier — fall back to the legacy
    // regex hit for backwards compatibility. A `null` return simply
    // leaves guessedName null for downstream to handle.
    vendorNameFromText = record("vendor.name", extractVendorName(text));
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

  if (!invoiceNumber) warnings.push("Invoice number not extracted.");
  if (!totalHit) warnings.push("Invoice total not extracted.");
  if (!invoiceDate) warnings.push("Invoice date not extracted.");
  if (!vendorNameFromText && !vendorTax) warnings.push("Vendor identity not extracted from the invoice.");

  const criticalMissing = !invoiceNumber || !totalHit || !invoiceDate;
  const state = criticalMissing ? "PARTIAL" : "STRUCTURED";

  return {
    invoice: {
      state,
      ruleVersion: EXTRACTION_RULE_VERSION,
      extractedTextChars: text.length,
      vendor: {
        guessedName: vendorNameFromText,
        guessedEmail: emailAddress,
        guessedTaxNumber: vendorTax,
        guessedDomain: domain,
      },
      invoiceNumber,
      invoiceDate,
      dueDate,
      paymentTerms: null,
      purchaseOrder,
      description,
      currency,
      subtotal: subtotalHit ? toNumericString(subtotalHit.value) : null,
      taxTotal: taxHit ? toNumericString(taxHit.value) : null,
      total: totalHit ? toNumericString(totalHit.value) : null,
      lineItems,
      remittance: { address: null, email: providenceEmail },
      warnings,
    },
    hints,
    supplier,
  };
}
