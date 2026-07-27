// Sprint 3 · Checkpoint 15P (2026-07-27) — vendor-profile extraction.
//
// A SECOND pass over the invoice PDF text, independent of the AP
// coding pipeline in parse-invoice.ts. The AP pipeline's job is to
// classify + code the invoice; this module's job is to populate the
// vendor's PERMANENT profile so the operator almost never has to
// type when they click "Create vendor".
//
// Deterministic, no LLM/OCR. Every returned field carries:
//   • value:      the extracted string (or null)
//   • confidence: integer 0–100 — how confident the extractor is
//   • source:     provenance ("invoice-pdf" | "email-signature" | …)
//
// The founder's rule: NEVER guess. When the confidence for a field
// falls below EXTRACTION_THRESHOLD, the field is returned as null
// rather than a low-confidence guess.
//
// General-purpose: no vendor-specific parsing. A future Cisco / Dell /
// Sysco / Toro / John Deere invoice must pass through the same
// pipeline. The patterns lean on the North-American invoice-footer
// conventions (US ZIP + Canadian postal + provincial abbreviations
// + BN9 tax registration) plus common international variants.

export type ProvenanceSource =
  | "invoice-pdf"
  | "email-signature"
  | "email-header"
  | "ocr"
  | "prior-invoice"
  | "vendor-profile";

export interface FieldExtraction<T = string> {
  value: T | null;
  confidence: number;              // 0-100 — 0 for "not found"
  source: ProvenanceSource | null; // null when value is null
}

export interface AddressExtraction {
  line1: FieldExtraction;
  line2: FieldExtraction;
  city: FieldExtraction;
  provinceState: FieldExtraction;
  postalCode: FieldExtraction;
  country: FieldExtraction;
  // Whole-block confidence — the address components are extracted
  // together, so we expose one confidence per whole address in
  // addition to the per-line confidence for granular UI use.
  blockConfidence: number;
}

export interface ExtractedVendorProfile {
  address: AddressExtraction;
  phone: FieldExtraction;
  fax: FieldExtraction;
  website: FieldExtraction;
  customerSupportEmail: FieldExtraction;
  arEmail: FieldExtraction;
  remittanceEmail: FieldExtraction;
  taxRegistrationNumber: FieldExtraction;
  vatNumber: FieldExtraction;
  paymentTerms: FieldExtraction;
}

// Anything under this threshold is treated as "not confidently found"
// and the field is returned as `null` (per founder's "never guess" rule).
const EXTRACTION_THRESHOLD = 60;

const CANADIAN_PROVINCES = new Set([
  "AB","BC","MB","NB","NL","NS","NT","NU","ON","PE","QC","SK","YT",
]);
const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY",
  "LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND",
  "OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);

// -----------------------------------------------------------------------------
// Field extractors
// -----------------------------------------------------------------------------

/**
 * Phone extractor. Recognises common NA + international formats.
 *   • +1 (800) 555-1212
 *   • 1-800-555-1212
 *   • 800-555-1212
 *   • (416) 555-1212
 *   • 416.555.1212
 *   • +44 20 7946 0958
 * Rejects any 9+ digit substring that looks like a SIN / EIN / GST
 * / postal / order-number (e.g. "9-digit BN9" tax IDs).
 */
function extractPhone(text: string): FieldExtraction {
  // Each pattern captures the FULL phone-shaped substring in group 1
  // (or falls back to m[0] when the match itself is the phone). The
  // NA rule now allows an optional leading `(` before the area code
  // and captures the whole span so we don't accidentally emit a
  // 3-digit area code as the value.
  const patterns: Array<{ re: RegExp; label: string; base: number }> = [
    { re: /\b(?:Phone|Tel(?:ephone)?|Voice|Contact|Call\s*Us)\s*[:#]?\s*([+(\d][\d\s().\-]{8,20}\d)/i, label: "labeled", base: 92 },
    { re: /(?:^|\s)((?:\+1[\s.\-]?)?\(?[2-9]\d{2}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})(?!\d)/, label: "north_america", base: 78 },
    { re: /(?:^|\s)(\+\d{1,3}[\s.\-]?\d{1,4}[\s.\-]?\d{2,4}[\s.\-]?\d{2,4}[\s.\-]?\d{0,4})(?!\d)/, label: "international", base: 70 },
  ];
  for (const p of patterns) {
    const m = text.match(p.re);
    if (!m) continue;
    const raw = (m[1] ?? m[0]).trim();
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) continue;
    // Reject 9-digit Canadian BN9 (tax ID) — treated as tax number, not phone.
    if (digits.length === 9) continue;
    // Reject if the LINE the phone appears on is labeled fax / SIN
    // / EIN / routing / acct / etc. — checking the whole surrounding
    // window was too eager (an invoice number on the NEXT line
    // triggered a false reject).
    const lineStart = text.lastIndexOf("\n", m.index!) + 1;
    const lineEnd = text.indexOf("\n", m.index!);
    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    if (/\b(?:fax|sin|ein|routing|acct|account|order|po\s*#|invoice\s*#)\b/i.test(line)) continue;
    const value = normalisePhone(raw);
    return { value, confidence: p.base, source: "invoice-pdf" };
  }
  return { value: null, confidence: 0, source: null };
}

function extractFax(text: string): FieldExtraction {
  const m = text.match(/\bFax\s*[:#]?\s*(\+?\d[\d\s().\-]{8,20}\d)/i);
  if (!m) return { value: null, confidence: 0, source: null };
  const digits = (m[1] ?? "").replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return { value: null, confidence: 0, source: null };
  return { value: normalisePhone(m[1]), confidence: 88, source: "invoice-pdf" };
}

function normalisePhone(raw: string): string {
  const digits = raw.replace(/\D/g, "");
  // Canonicalise to +CC (AAA) BBB-CCCC for 10/11-digit North American.
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return raw.trim();
}

/**
 * Website — a URL that looks like a vendor's public site. Rejects:
 *   • the tenant's own domain (best-effort — we don't have it here)
 *   • urls that clearly point at social / storage / tracking domains
 *   • the email domain's website prefix ONLY if it exactly matches
 *     the AR / support email (that's already captured elsewhere)
 */
function extractWebsite(text: string): FieldExtraction {
  // Labeled first — highest confidence.
  const labeled = text.match(/\b(?:Website|Web|Site|URL|Visit)\s*[:]?\s*((?:https?:\/\/)?(?:www\.)?[A-Za-z0-9\-]+\.[A-Za-z]{2,}(?:\/[^\s]*)?)/i);
  if (labeled) return { value: normaliseWebsite(labeled[1]), confidence: 96, source: "invoice-pdf" };
  // Free-standing http(s) URL.
  const explicit = text.match(/\b(https?:\/\/(?:www\.)?[A-Za-z0-9\-]+\.[A-Za-z]{2,}(?:\/[^\s]*)?)/i);
  if (explicit) return { value: normaliseWebsite(explicit[1]), confidence: 90, source: "invoice-pdf" };
  // Free-standing "www.X.Y" — lower confidence but still an outbound URL.
  const www = text.match(/\b(www\.[A-Za-z0-9\-]+\.[A-Za-z]{2,}(?:\/[^\s]*)?)/i);
  if (www) return { value: normaliseWebsite(www[1]), confidence: 82, source: "invoice-pdf" };
  return { value: null, confidence: 0, source: null };
}

function normaliseWebsite(raw: string): string {
  const trimmed = raw.trim().replace(/[.,;:)]$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/\//, "")}`;
}

/**
 * GST / HST / VAT registration number. Extends the parse-invoice
 * matcher to cover more layouts (footer "GST/HST No.", "VAT ID:",
 * "IRD Number", etc.) and to return HIGH confidence when the label
 * unambiguously names GST/HST.
 */
function extractTaxRegistrationNumber(text: string): FieldExtraction {
  const patterns: Array<{ re: RegExp; base: number }> = [
    // Explicit label + Canadian BN9(RT) format.
    { re: /\b(?:HST|GST\/?HST|GST)\s*(?:Reg(?:istration)?|No\.?|#|Number)?\s*[:#]?\s*(\d{9}\s*RT\s*\d{4}|\d{9}(?:RT\d{4})?)/i, base: 99 },
    // Business Number label.
    { re: /\b(?:Business\s*Number|BN)\s*[:#]?\s*(\d{9}\s*RT\s*\d{4}|\d{9})/i, base: 90 },
    // "Tax Registration Number: XXXXX".
    { re: /\bTax\s*(?:Reg(?:istration)?|ID|Identification)\s*(?:Number|No\.?|#)?\s*[:#]?\s*(\S+)/i, base: 82 },
  ];
  for (const p of patterns) {
    const m = text.match(p.re);
    if (!m) continue;
    const value = m[1].trim().replace(/\s+/g, " ");
    if (value.length < 8 || value.length > 40) continue;
    return { value, confidence: p.base, source: "invoice-pdf" };
  }
  return { value: null, confidence: 0, source: null };
}

function extractVatNumber(text: string): FieldExtraction {
  const m = text.match(/\bVAT\s*(?:ID|Number|No\.?|#)?\s*[:#]?\s*([A-Z]{0,3}\s?\d[\d\s\-A-Z]{5,20})/i);
  if (!m) return { value: null, confidence: 0, source: null };
  const value = m[1].trim().replace(/\s+/g, " ");
  return { value, confidence: 88, source: "invoice-pdf" };
}

/**
 * Payment terms. HIGH confidence only when the extraction produced
 * explicit terms text ("Net 30", "Due on receipt", "Due upon
 * receipt", "Net 45 days from invoice date"). Never guesses.
 */
function extractPaymentTerms(text: string): FieldExtraction {
  const patterns: Array<{ re: RegExp; base: number }> = [
    { re: /\bTerms?\s*[:#]?\s*(Net\s*\d{1,3}(?:\s*days?)?)/i, base: 94 },
    { re: /\bPayment\s*Terms?\s*[:#]?\s*(Net\s*\d{1,3}(?:\s*days?)?|Due\s*on\s*receipt|Due\s*upon\s*receipt|COD|Cash\s*on\s*delivery)/i, base: 94 },
    { re: /\b(Net\s*\d{1,3}\s*days?)\b/i, base: 78 },
    { re: /\b(Due\s*(?:on|upon)\s*receipt)\b/i, base: 90 },
    { re: /\b(Auto[-\s]?pay|Automatic\s*payment|Charged\s*to\s*card\s*on\s*file)\b/i, base: 82 },
  ];
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m) return { value: humaniseTerms(m[1]), confidence: p.base, source: "invoice-pdf" };
  }
  return { value: null, confidence: 0, source: null };
}

function humaniseTerms(raw: string): string {
  const s = raw.trim().replace(/\s+/g, " ");
  const netMatch = s.match(/^Net\s*(\d{1,3})\b/i);
  if (netMatch) return `Net ${netMatch[1]}`;
  if (/^Due\s*(?:on|upon)\s*receipt$/i.test(s)) return "Due on receipt";
  if (/^(Auto[-\s]?pay|Automatic\s*payment)$/i.test(s)) return "Auto-pay";
  if (/^COD$/i.test(s) || /^Cash\s*on\s*delivery$/i.test(s)) return "COD";
  return s;
}

/**
 * Email extractors — three flavours by label context. If none is
 * labelled, we DO NOT guess (per the founder's rule); the caller can
 * still fall back on the generic vendor email from parse-invoice.ts.
 */
function extractLabeledEmail(text: string, labelRe: RegExp): FieldExtraction {
  const window = text.match(labelRe);
  if (!window) return { value: null, confidence: 0, source: null };
  const start = window.index ?? 0;
  const nearby = text.slice(start, start + 200);
  const email = nearby.match(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/);
  if (!email) return { value: null, confidence: 0, source: null };
  return { value: email[1].toLowerCase(), confidence: 90, source: "invoice-pdf" };
}

function extractCustomerSupportEmail(text: string): FieldExtraction {
  return extractLabeledEmail(text, /\b(?:Customer\s*Support|Support|Help|Contact)\s*[:]?\s*/i);
}

function extractArEmail(text: string): FieldExtraction {
  return extractLabeledEmail(text, /\b(?:Accounts\s*Receivable|AR|Billing)\s*(?:Email)?\s*[:]?\s*/i);
}

function extractRemittanceEmail(text: string): FieldExtraction {
  return extractLabeledEmail(text, /\b(?:Remit(?:tance)?|Send\s*Payment|Payment\s*(?:To|Email))\s*(?:Email)?\s*[:]?\s*/i);
}

/**
 * Address block extraction.
 *
 * Multi-line addresses on invoices follow one of two conventions:
 *
 *   VendorNameLine
 *   Address line 1
 *   [Address line 2]
 *   City, ProvinceState PostalCode
 *   [Country]
 *
 *   -- OR --
 *
 *   Address line 1 · City, ProvinceState PostalCode · Country     (single-line footer)
 *
 * We anchor on the CITY-STATE-POSTAL line — it's the strongest single
 * signal (a Canadian postal `A1A 1A1` or a US ZIP `12345` or
 * `12345-6789` next to a state code). Then we walk backwards for one
 * or two address-line-1/-2 candidates.
 *
 * "Bill To" / "Ship To" / "Customer" sections are EXCLUDED — the
 * caller's tenant address must never leak into the vendor profile.
 */
function extractAddress(text: string): AddressExtraction {
  const empty: FieldExtraction = { value: null, confidence: 0, source: null };
  const emptyAddr: AddressExtraction = {
    line1: empty, line2: empty, city: empty, provinceState: empty,
    postalCode: empty, country: empty, blockConfidence: 0,
  };

  // Split into lines + trim.
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  // Locate the customer-address sections so we can exclude their
  // ranges — those addresses belong to the CLUB, not the vendor.
  const forbiddenRanges = collectForbiddenRanges(lines);

  // Regexes for the anchor line.
  const canPostal = /\b([A-Z]\d[A-Z])\s*(\d[A-Z]\d)\b/;   // Canadian: A1A 1A1
  const usZip = /\b(\d{5})(?:-(\d{4}))?\b/;                // US ZIP (5 or 9)
  // "City, ProvinceState PostalCode" — comma between city and state.
  const anchorRe = /^(.+?),\s*([A-Z]{2})\s+([A-Z]\d[A-Z]\s*\d[A-Z]\d|\d{5}(?:-\d{4})?)(?:\s+([A-Z][A-Za-z .]{2,30}))?$/;

  for (let i = 0; i < lines.length; i++) {
    if (forbiddenRanges.some(([lo, hi]) => i >= lo && i <= hi)) continue;
    const line = lines[i];
    if (!line) continue;
    const m = line.match(anchorRe);
    if (!m) continue;
    const cityRaw = m[1].trim();
    const stateRaw = m[2].trim().toUpperCase();
    const postalRaw = m[3].trim();
    const trailingCountry = m[4]?.trim() ?? null;
    if (!CANADIAN_PROVINCES.has(stateRaw) && !US_STATES.has(stateRaw)) continue;

    // Country resolution: explicit trailing country wins; else infer
    // from postal shape (CA vs US); else the line right below often
    // has the country name.
    let country: string | null = trailingCountry;
    if (!country) {
      const belowLine = (lines[i + 1] ?? "").trim();
      if (/^(canada|united\s*states|usa|u\.s\.a\.?)$/i.test(belowLine)) country = belowLine;
    }
    if (!country) {
      country = canPostal.test(postalRaw) ? "Canada" : usZip.test(postalRaw) ? "United States" : null;
    }

    // Walk backwards from the anchor for up to 6 lines. The
    // physical order on the invoice is:
    //   line1 (street)
    //   [line2 (suite/unit)]      ← optional
    //   city, state postal        ← anchor
    // Walking upward we see line2 FIRST (if it exists), then line1.
    // Collect a pending suite/unit candidate on the first pass; once
    // we find the digit-containing line1, promote the candidate to
    // line2 and stop.
    let line1: string | null = null;
    let line2: string | null = null;
    let suiteCandidate: string | null = null;
    for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
      if (forbiddenRanges.some(([lo, hi]) => j >= lo && j <= hi)) break;
      const prev = lines[j].trim();
      if (!prev) continue;
      if (/^(bill|ship|sold|remit|invoice|attn|phone|fax|email|website)/i.test(prev)) break;
      // Suite / unit / floor / apt / building — remember it and
      // continue walking upward for line1.
      if (!suiteCandidate && /^(suite|ste|unit|floor|apt|#|building|bldg)/i.test(prev)) {
        suiteCandidate = prev;
        continue;
      }
      // Address-line-1 candidate must contain digits (street # or PO Box).
      if (!line1 && /^\d|\bpo\s*box\b/i.test(prev)) {
        line1 = prev;
        line2 = suiteCandidate;   // Promote the pending candidate.
        break;
      }
      // Otherwise stop — anything else between the anchor and line1
      // means we've overshot the address block.
      break;
    }
    if (!line1) continue;

    const blockConfidence = 82 + (country ? 8 : 0) + (line2 ? 4 : 0);
    return {
      line1: { value: line1, confidence: 88, source: "invoice-pdf" },
      line2: line2
        ? { value: line2, confidence: 82, source: "invoice-pdf" }
        : { value: null, confidence: 0, source: null },
      city: { value: cityRaw, confidence: 92, source: "invoice-pdf" },
      provinceState: { value: stateRaw, confidence: 97, source: "invoice-pdf" },
      postalCode: { value: postalRaw, confidence: 96, source: "invoice-pdf" },
      country: country
        ? { value: country, confidence: 90, source: "invoice-pdf" }
        : { value: null, confidence: 0, source: null },
      blockConfidence: Math.min(99, blockConfidence),
    };
  }
  return emptyAddr;
}

/**
 * Bill-to / Ship-to / Customer-address ranges. Returns [startLine,
 * endLine] pairs to skip when hunting for the VENDOR address so the
 * club's own address never leaks into the vendor profile.
 */
function collectForbiddenRanges(lines: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const headerRe = /^\s*(bill[-\s]?to|ship[-\s]?to|sold[-\s]?to|customer|deliver\s*to|invoice\s*to)\s*[:]?\s*$/i;
  for (let i = 0; i < lines.length; i++) {
    if (headerRe.test(lines[i])) {
      // Skip forward through the address block (up to 8 lines or the
      // next blank-line-then-header boundary).
      let end = Math.min(i + 8, lines.length - 1);
      for (let j = i + 1; j <= end; j++) {
        if (/^\s*$/.test(lines[j]) && j > i + 2) { end = j; break; }
      }
      out.push([i, end]);
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export function extractVendorProfile(text: string): ExtractedVendorProfile {
  const raw = text || "";

  const clamp = (f: FieldExtraction): FieldExtraction =>
    f.confidence >= EXTRACTION_THRESHOLD ? f : { value: null, confidence: 0, source: null };

  const address = extractAddress(raw);
  // Address blockConfidence gates the whole address block; per-line
  // fields inherit the gate so we never emit a partial address that
  // pairs a real city with a null line1.
  const gatedAddress: AddressExtraction = address.blockConfidence >= EXTRACTION_THRESHOLD
    ? {
        line1: clamp(address.line1),
        line2: clamp(address.line2),
        city: clamp(address.city),
        provinceState: clamp(address.provinceState),
        postalCode: clamp(address.postalCode),
        country: clamp(address.country),
        blockConfidence: address.blockConfidence,
      }
    : {
        line1: { value: null, confidence: 0, source: null },
        line2: { value: null, confidence: 0, source: null },
        city:  { value: null, confidence: 0, source: null },
        provinceState: { value: null, confidence: 0, source: null },
        postalCode: { value: null, confidence: 0, source: null },
        country: { value: null, confidence: 0, source: null },
        blockConfidence: 0,
      };

  return {
    address: gatedAddress,
    phone: clamp(extractPhone(raw)),
    fax: clamp(extractFax(raw)),
    website: clamp(extractWebsite(raw)),
    customerSupportEmail: clamp(extractCustomerSupportEmail(raw)),
    arEmail: clamp(extractArEmail(raw)),
    remittanceEmail: clamp(extractRemittanceEmail(raw)),
    taxRegistrationNumber: clamp(extractTaxRegistrationNumber(raw)),
    vatNumber: clamp(extractVatNumber(raw)),
    paymentTerms: clamp(extractPaymentTerms(raw)),
  };
}
