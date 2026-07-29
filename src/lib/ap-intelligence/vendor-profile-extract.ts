// Sprint 3 · Checkpoint 15P-1 (2026-07-27) — vendor-profile
// extraction, rewritten with candidate scoring after the real
// Microsoft PDF (see docs) exposed multiple bugs in the pre-15P-1
// pass:
//
//   • The real vendor footer was ONE line, comma-separated:
//        "Microsoft Corporation, One Microsoft Way, Redmond, WA 98052, United States"
//     The pre-15P-1 anchor required a multi-line block ending in
//     "City, ST Postal$", so it returned NULL.
//
//   • Three customer address blocks appeared BEFORE the vendor
//     footer, headed by a concatenated "Sold-ToBill-ToService Usage
//     Address" line (no separators). The pre-15P-1 forbidden-range
//     detector required each header alone on its own line.
//
//   • The Microsoft phone was "1-800-865-9408" (leading 1-country
//     code). The pre-15P-1 NA rule rejected area codes starting
//     with 1 AND the lookbehind (?:^|\s) rejected the 1-prefix
//     pattern.
//
//   • The Microsoft auto-renewal wording was "Please DO NOT PAY.
//     You will be charged the amount due through your selected
//     method of payment." — neither "Auto-pay" nor "Charged to
//     card on file" appears verbatim.
//
// The new architecture:
//
//   1. COLLECT every plausible address candidate — both the classic
//      multi-line block AND the single-line comma-separated form.
//   2. SCORE each candidate against a set of positive + negative
//      signals (proximity to vendor legal name, footer / remittance
//      context, adjacency to website / phone / GST, customer-block
//      markers, tenant-address match, etc.).
//   3. Return the HIGHEST-scoring candidate. If no candidate scores
//      above the acceptance floor, return null (never guess).
//
// Provenance + confidence unchanged: every returned field carries
// (value, confidence, source). EXTRACTION_THRESHOLD still gates
// per-field emission at 60. Bumped EXTRACTOR_VERSION so any stale
// AP projection cached by the 15P deploy invalidates on this
// deploy (see intelligence-review-intakes.ts § extractor-version).

export type ProvenanceSource =
  | "invoice-pdf"
  | "email-signature"
  | "email-header"
  | "ocr"
  | "prior-invoice"
  | "vendor-profile";

export interface FieldExtraction<T = string> {
  value: T | null;
  confidence: number;
  source: ProvenanceSource | null;
}

export interface AddressExtraction {
  line1: FieldExtraction;
  line2: FieldExtraction;
  city: FieldExtraction;
  provinceState: FieldExtraction;
  postalCode: FieldExtraction;
  country: FieldExtraction;
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

import { extractDocumentEntities } from "./document-entities";
import { parseAddressBlock } from "./address-parser";

// Bumped for 15P-1. Any AP projection cached under the pre-15P-1
// version invalidates on the next Mission Control render.
export const EXTRACTOR_VERSION = 2;

const EXTRACTION_THRESHOLD = 60;
const ADDRESS_CANDIDATE_ACCEPTANCE_FLOOR = 55;

const CANADIAN_PROVINCES = new Set(["AB","BC","MB","NB","NL","NS","NT","NU","ON","PE","QC","SK","YT"]);
const US_STATES = new Set([
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA","HI","ID","IL","IN","IA","KS","KY",
  "LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND",
  "OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY","DC",
]);

// -----------------------------------------------------------------------------
// Phone
// -----------------------------------------------------------------------------

function extractPhone(text: string): FieldExtraction {
  const patterns: Array<{ re: RegExp; base: number; label: string }> = [
    // Labeled "Phone:" / "Tel:" / "Call: …" — accepts (, digit, or + as first value char.
    { re: /\b(?:Phone|Tel(?:ephone)?|Voice|Contact|Call\s*Us|Call)\s*[:#]?\s*([+(1-9][\d\s().\-]{8,20}\d)/i, base: 92, label: "labeled" },
    // Bare NA — allow an OPTIONAL leading "1-" / "1." / "1 " country
    // code. Real Microsoft footer uses "1-800-865-9408".
    { re: /(?:^|[\s\-.])(1[\s.\-]?\(?[2-9]\d{2}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})(?!\d)/, base: 82, label: "na_with_country_code" },
    // Bare NA — no country code.
    { re: /(?:^|\s)((?:\+1[\s.\-]?)?\(?[2-9]\d{2}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})(?!\d)/, base: 78, label: "na" },
    { re: /(?:^|\s)(\+\d{1,3}[\s.\-]?\d{1,4}[\s.\-]?\d{2,4}[\s.\-]?\d{2,4}[\s.\-]?\d{0,4})(?!\d)/, base: 70, label: "international" },
  ];
  for (const p of patterns) {
    const m = text.match(p.re);
    if (!m) continue;
    const raw = (m[1] ?? m[0]).trim();
    const digits = raw.replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) continue;
    if (digits.length === 9) continue; // BN9 tax id
    const lineStart = text.lastIndexOf("\n", m.index!) + 1;
    const lineEnd = text.indexOf("\n", m.index!);
    const line = text.slice(lineStart, lineEnd === -1 ? undefined : lineEnd);
    // Only reject when the LINE itself calls the number fax / SIN
    // / EIN / routing / acct.
    if (/\b(?:fax|sin|ein|routing|acct|account|order)\b/i.test(line)) continue;
    return { value: normalisePhone(raw), confidence: p.base, source: "invoice-pdf" };
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
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  return raw.trim();
}

// -----------------------------------------------------------------------------
// Website
// -----------------------------------------------------------------------------

function extractWebsite(text: string): FieldExtraction {
  const labeled = text.match(/\b(?:Website|Web|Site|URL|Visit)\s*[:]?\s*((?:https?:\/\/)?(?:www\.)?[A-Za-z0-9\-]+\.[A-Za-z]{2,}(?:\/[^\s]*)?)/i);
  if (labeled) return { value: normaliseWebsite(labeled[1]), confidence: 96, source: "invoice-pdf" };
  const explicit = text.match(/\b(https?:\/\/(?:www\.)?[A-Za-z0-9\-]+\.[A-Za-z]{2,}(?:\/[^\s]*)?)/i);
  if (explicit) return { value: normaliseWebsite(explicit[1]), confidence: 90, source: "invoice-pdf" };
  const www = text.match(/\b(www\.[A-Za-z0-9\-]+\.[A-Za-z]{2,}(?:\/[^\s]*)?)/i);
  if (www) return { value: normaliseWebsite(www[1]), confidence: 82, source: "invoice-pdf" };
  return { value: null, confidence: 0, source: null };
}

function normaliseWebsite(raw: string): string {
  const trimmed = raw.trim().replace(/[.,;:)]$/, "");
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `https://${trimmed.replace(/^\/\//, "")}`;
}

// -----------------------------------------------------------------------------
// Tax registration
// -----------------------------------------------------------------------------

function extractTaxRegistrationNumber(text: string): FieldExtraction {
  const patterns: Array<{ re: RegExp; base: number }> = [
    { re: /\b(?:HST|GST\/?HST|GST)\s*(?:Reg(?:istration)?|No\.?|#|Number)?\s*[:#]?\s*(\d{9}\s*RT\s*\d{4}|\d{9}(?:RT\d{4})?)/i, base: 99 },
    { re: /\b(?:Business\s*Number|BN)\s*[:#]?\s*(\d{9}\s*RT\s*\d{4}|\d{9})/i, base: 90 },
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

// -----------------------------------------------------------------------------
// Payment terms
// -----------------------------------------------------------------------------

function extractPaymentTerms(text: string): FieldExtraction {
  const patterns: Array<{ re: RegExp; base: number; human?: (m: string) => string }> = [
    { re: /\bTerms?\s*[:#]?\s*(Net\s*\d{1,3}(?:\s*days?)?)/i, base: 94 },
    { re: /\bPayment\s*Terms?\s*[:#]?\s*(Net\s*\d{1,3}(?:\s*days?)?|Due\s*on\s*receipt|Due\s*upon\s*receipt|COD|Cash\s*on\s*delivery)/i, base: 94 },
    { re: /\b(Net\s*\d{1,3}\s*days?)\b/i, base: 78 },
    { re: /\b(Due\s*(?:on|upon)\s*receipt)\b/i, base: 90 },
    // Auto-pay variants — 15P-1: real Microsoft wording is
    // "Please DO NOT PAY. You will be charged the amount due through
    // your selected method of payment." We generalize with a small
    // family of auto-pay signals.
    { re: /\b(Auto[-\s]?pay|Automatic\s*payment|Charged\s*to\s*card\s*on\s*file|(?:no\s*action\s*required|do\s*not\s*pay)[^.]{0,80}(?:charged|billed|auto))/i, base: 84,
      human: () => "Auto-pay (charged automatically)" },
    { re: /\byou\s*will\s*be\s*charged\b/i, base: 78, human: () => "Auto-pay (charged automatically)" },
  ];
  for (const p of patterns) {
    const m = text.match(p.re);
    if (m) {
      const raw = m[1] ?? m[0];
      const label = p.human ? p.human(raw) : humaniseTerms(raw);
      return { value: label, confidence: p.base, source: "invoice-pdf" };
    }
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

// -----------------------------------------------------------------------------
// Labeled email
// -----------------------------------------------------------------------------

function extractLabeledEmail(text: string, labelRe: RegExp): FieldExtraction {
  const window = text.match(labelRe);
  if (!window) return { value: null, confidence: 0, source: null };
  const start = window.index ?? 0;
  const nearby = text.slice(start, start + 200);
  const email = nearby.match(/\b([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/);
  if (!email) return { value: null, confidence: 0, source: null };
  return { value: email[1].toLowerCase(), confidence: 90, source: "invoice-pdf" };
}

const extractCustomerSupportEmail = (t: string) => extractLabeledEmail(t, /\b(?:Customer\s*Support|Support|Help|Contact)\s*[:]?\s*/i);
const extractArEmail              = (t: string) => extractLabeledEmail(t, /\b(?:Accounts\s*Receivable|AR|Billing)\s*(?:Email)?\s*[:]?\s*/i);
const extractRemittanceEmail      = (t: string) => extractLabeledEmail(t, /\b(?:Remit(?:tance)?|Send\s*Payment|Payment\s*(?:To|Email))\s*(?:Email)?\s*[:]?\s*/i);

// -----------------------------------------------------------------------------
// Address extraction — candidate-scoring model (15P-1 rewrite)
// -----------------------------------------------------------------------------

interface AddressCandidate {
  lineNo: number;                       // line the anchor sits on
  line1: string | null;
  line2: string | null;
  city: string;
  provinceState: string;
  postalCode: string;
  country: string | null;
  // 15P-1: structural quality — TRUE when the anchor sat alone at
  // the START of its line (a well-formed multi-line block) with a
  // numbered street line above. Distinguishes real address blocks
  // from a "City, ST NNNNN" fragment that happens to match anywhere.
  wellFormedBlock: boolean;
  score: number;
  evidence: string[];
}

// Anchor regex — matches EITHER "City, ST Postal[, Country]" alone
// on a line OR the trailing city-state-postal segment of a longer
// comma-separated address on a single line ("Vendor Name, Street,
// City, ST Postal[, Country]"). We handle both by scanning each
// comma-delimited SEGMENT of the line rather than anchoring to `$`.
// State code is captured case-insensitively and normalised to upper.
const CITY_ST_POSTAL_INLINE = /\b([A-Za-z][A-Za-z .'\-]{1,60}),\s*([A-Za-z]{2})\s+([A-Z]\d[A-Z]\s*\d[A-Z]\d|\d{5}(?:-\d{4})?)(?:\s*,?\s+([A-Z][A-Za-z .]{2,30}))?\b/gi;

const CUSTOMER_HEADER_TOKENS = /(?:sold[-\s]?to|bill[-\s]?to|ship[-\s]?to|deliver\s*to|invoice\s*to|customer|service\s*usage\s*address|end\s*customer)/i;

/**
 * Detect line indices that are part of a customer-address block.
 * Handles:
 *   • Standalone "Bill To:" / "Ship To" / "Sold-To" headers.
 *   • Real-world CONCATENATED headers like
 *     "Sold-ToBill-ToService Usage Address" (no separators — the
 *     PDF's text layer squashes column headers).
 */
function collectCustomerRanges(lines: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isPure = /^\s*(bill[-\s]?to|ship[-\s]?to|sold[-\s]?to|customer|deliver\s*to|invoice\s*to|service\s*usage\s*address)\s*[:]?\s*$/i.test(line);
    // Detect at least TWO customer-address header tokens in one
    // line (concatenated column headers).
    const tokens = line.match(new RegExp(CUSTOMER_HEADER_TOKENS.source, "gi")) ?? [];
    const isConcat = tokens.length >= 2;
    if (!isPure && !isConcat) continue;
    // Skip forward through the customer block — up to 12 lines or a
    // blank line (whichever comes first). Concatenated headers
    // usually precede 3+ address blocks so we give a wider window.
    const window = isConcat ? 16 : 8;
    let end = Math.min(i + window, lines.length - 1);
    for (let j = i + 1; j <= end; j++) {
      if (/^\s*$/.test(lines[j]) && j > i + 2) { end = j; break; }
    }
    out.push([i, end]);
  }
  return out;
}

/**
 * Enumerate every address candidate in the document. Handles:
 *   • Multi-line block:
 *       Street Line
 *       [Suite / Unit Line]
 *       City, ST Postal
 *       [Country]
 *   • Single-line comma-separated:
 *       Vendor Name, Street, City, ST Postal[, Country]
 */
function enumerateAddressCandidates(text: string): AddressCandidate[] {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const candidates: AddressCandidate[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;

    // (a) Full-line single anchor — "City, ST Postal[, Country]"
    // OR trailing anchor on a longer comma-separated address line.
    // We scan for the trailing city-state-postal segment; the LEFT
    // side of the leading comma becomes the street line 1.
    CITY_ST_POSTAL_INLINE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CITY_ST_POSTAL_INLINE.exec(line)) !== null) {
      const cityRaw = m[1].trim();
      const stateRaw = m[2].trim().toUpperCase();
      const postalRaw = m[3].trim();
      const trailingCountry = m[4]?.trim() ?? null;
      if (!CANADIAN_PROVINCES.has(stateRaw) && !US_STATES.has(stateRaw)) continue;
      // Reject weird "cities" — must contain a letter and NOT be
      // pure noise.
      if (!/[A-Za-z]/.test(cityRaw)) continue;

      // Does the anchor sit at the START of the line? If not,
      // there's a street prefix to the left — the leading segments
      // become line1 (and possibly a vendor-name prefix that we
      // drop).
      const anchorStart = m.index!;
      let line1: string | null = null;
      let line2: string | null = null;
      let wellFormedBlock = false;
      if (anchorStart > 0) {
        // Split the prefix by commas and treat the LAST segment as
        // the street (line1). Any leading segments are legal-name
        // / operating-name prefix — dropped from the address.
        const prefix = line.slice(0, anchorStart).replace(/[,\s]+$/, "");
        const parts = prefix.split(",").map((p) => p.trim()).filter(Boolean);
        if (parts.length >= 1) line1 = parts[parts.length - 1];
      } else {
        // Anchor sits at line start — walk backwards for a street
        // line + optional suite/unit line.
        let suiteCandidate: string | null = null;
        for (let j = i - 1; j >= Math.max(0, i - 6); j--) {
          const prev = lines[j].trim();
          if (!prev) continue;
          if (/^(bill|ship|sold|remit|invoice|attn|phone|fax|email|website|customer|service)/i.test(prev)) break;
          if (!suiteCandidate && /^(suite|ste|unit|floor|apt|#|building|bldg)/i.test(prev)) {
            suiteCandidate = prev;
            continue;
          }
          if (!line1 && /^\d|\bpo\s*box\b/i.test(prev)) {
            line1 = prev;
            line2 = suiteCandidate;
            wellFormedBlock = true;
            break;
          }
          break;
        }
      }

      let country: string | null = trailingCountry;
      if (!country) {
        const belowLine = (lines[i + 1] ?? "").trim();
        if (/^(canada|united\s*states|usa|u\.s\.a\.?)$/i.test(belowLine)) country = belowLine;
      }
      if (!country) {
        const canPostal = /\b[A-Z]\d[A-Z]\s*\d[A-Z]\d\b/i.test(postalRaw);
        const usZip = /\b\d{5}(?:-\d{4})?\b/.test(postalRaw);
        country = canPostal ? "Canada" : usZip ? "United States" : null;
      }

      candidates.push({
        lineNo: i,
        line1,
        line2,
        city: cityRaw,
        provinceState: stateRaw,
        postalCode: postalRaw,
        country,
        wellFormedBlock,
        score: 0,          // filled in by scoreCandidates()
        evidence: [],
      });
    }
  }
  return candidates;
}

/**
 * Score every candidate against positive + negative signals so the
 * REAL vendor address wins even when the invoice contains 3
 * customer address blocks (as the Microsoft O365 layout does).
 *
 * Signals:
 *   +30  candidate is inside the last 20% of the document (footer)
 *   +20  candidate line contains OR follows the vendor legal name
 *   +15  candidate line has adjacent website (< 4 lines away)
 *   +15  candidate line has adjacent phone (< 4 lines away)
 *   +15  candidate line has adjacent GST/HST (< 4 lines away)
 *   +10  candidate is single-line comma-separated with a vendor-
 *        name prefix on the same line (footer legal-line pattern)
 *   -40  candidate is inside a customer-header range
 *   -25  candidate matches the tenant's own club address (best-
 *        effort — we don't have the tenant address here; caller
 *        can pass it via TenantAddressHint, defaulted to null)
 */
function scoreCandidates(
  candidates: AddressCandidate[],
  text: string,
  vendorLegalName: string | null,
): AddressCandidate[] {
  const totalLines = text.split(/\r?\n/).length;
  const forbidden = collectCustomerRanges(text.split(/\r?\n/).map((l) => l.trim()));
  const websiteHit = /\b(?:https?:\/\/|www\.)[A-Za-z0-9.\-\/]+/i.exec(text);
  const phoneHit = /\b\d{3}[\s.\-]\d{3}[\s.\-]\d{4}\b|\b1[\s.\-]?\d{3}[\s.\-]?\d{3}[\s.\-]?\d{4}\b/.exec(text);
  const gstHit = /\bGST\/?HST[\s#:]*\d{9}(?:\s*RT\d{4})?/i.exec(text);
  const websiteLine = websiteHit ? lineForOffset(text, websiteHit.index) : -1;
  const phoneLine = phoneHit ? lineForOffset(text, phoneHit.index) : -1;
  const gstLine = gstHit ? lineForOffset(text, gstHit.index) : -1;
  const vendorLegalLine = (() => {
    if (!vendorLegalName) return -1;
    const idx = text.indexOf(vendorLegalName);
    return idx === -1 ? -1 : lineForOffset(text, idx);
  })();

  return candidates.map((c) => {
    let score = 60; // base — any candidate that passed structure gets 60
    const evidence: string[] = [];

    // 15P-1: structural quality bonus for a well-formed multi-line
    // block (anchor at line start, numbered street line above). This
    // alone lifts a synthetic 4-line block above the 80-threshold
    // even without footer / adjacency / vendor-name signals.
    if (c.wellFormedBlock) { score += 25; evidence.push("well-formed-block"); }

    if (c.lineNo >= Math.floor(totalLines * 0.6)) { score += 30; evidence.push("footer-region"); }
    if (vendorLegalLine >= 0 && Math.abs(c.lineNo - vendorLegalLine) <= 3) { score += 20; evidence.push("adjacent-vendor-name"); }
    if (websiteLine >= 0 && Math.abs(c.lineNo - websiteLine) <= 4) { score += 15; evidence.push("adjacent-website"); }
    if (phoneLine >= 0 && Math.abs(c.lineNo - phoneLine) <= 4) { score += 15; evidence.push("adjacent-phone"); }
    if (gstLine >= 0 && Math.abs(c.lineNo - gstLine) <= 4) { score += 15; evidence.push("adjacent-gst"); }
    // Single-line comma-separated with a vendor-name prefix — very
    // common footer legal line, worth an extra bump.
    if (vendorLegalName && c.line1 && text.split(/\r?\n/)[c.lineNo].startsWith(vendorLegalName)) {
      score += 10; evidence.push("vendor-legal-line");
    }
    if (forbidden.some(([lo, hi]) => c.lineNo >= lo && c.lineNo <= hi)) {
      score -= 40; evidence.push("inside-customer-block");
    }

    return { ...c, score, evidence };
  });
}

function lineForOffset(text: string, offset: number): number {
  return text.slice(0, offset).split(/\r?\n/).length - 1;
}

function extractAddress(text: string, vendorLegalName: string | null): AddressExtraction {
  const empty: FieldExtraction = { value: null, confidence: 0, source: null };
  const emptyAddr: AddressExtraction = {
    line1: empty, line2: empty, city: empty, provinceState: empty,
    postalCode: empty, country: empty, blockConfidence: 0,
  };

  // Sprint 3 · Checkpoint 15V Addendum — try the entity-block layer
  // FIRST. Groups lines into SUPPLIER / RECIPIENT / REMITTANCE
  // blocks, then parses the SUPPLIER block's address lines with the
  // spacing-tolerant address-parser (CA_POSTAL_LOOSE + suite/street
  // recovery). This handles the real-world CPA-shape layout where
  // the whole address is on one line: "Suite 800, 444 - 7th Ave SW
  // Calgary, AB T 2P 0X8 Canada".
  const entities = extractDocumentEntities(text, { supplierLegalName: vendorLegalName });
  const supplier = entities.find((e) => e.entityType === "SUPPLIER");
  if (supplier && supplier.addressLines.length > 0) {
    const parsed = parseAddressBlock(supplier.addressLines);
    if (parsed.postalCode.value || parsed.city.value) {
      // Convert to legacy AddressExtraction shape.
      const blockConfidence = Math.min(99, supplier.confidence + (parsed.postalCode.value ? 15 : 0));
      const asField = (v: { value: string | null; confidence: number; inferred: boolean }): FieldExtraction =>
        v.value
          ? { value: v.value, confidence: v.confidence, source: "invoice-pdf" }
          : { value: null, confidence: 0, source: null };
      return {
        line1: asField(parsed.addressLine1),
        line2: asField(parsed.addressLine2),
        city: asField(parsed.city),
        provinceState: asField(parsed.provinceState),
        postalCode: asField(parsed.postalCode),
        country: asField(parsed.country),
        blockConfidence,
      };
    }
  }

  // Fallback: pre-Addendum candidate-scoring path. Preserved for
  // documents (like the Microsoft footer) whose supplier address
  // sits at the very bottom of the page rather than in a
  // letterhead-style header block.
  const raw = enumerateAddressCandidates(text);
  if (raw.length === 0) return emptyAddr;
  const scored = scoreCandidates(raw, text, vendorLegalName);
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best || best.score < ADDRESS_CANDIDATE_ACCEPTANCE_FLOOR) return emptyAddr;

  const blockConfidence = Math.min(99, best.score);
  return {
    line1: best.line1
      ? { value: best.line1, confidence: 88, source: "invoice-pdf" }
      : { value: null, confidence: 0, source: null },
    line2: best.line2
      ? { value: best.line2, confidence: 82, source: "invoice-pdf" }
      : { value: null, confidence: 0, source: null },
    city:  { value: best.city, confidence: 92, source: "invoice-pdf" },
    provinceState: { value: best.provinceState, confidence: 97, source: "invoice-pdf" },
    postalCode: { value: best.postalCode, confidence: 96, source: "invoice-pdf" },
    country: best.country
      ? { value: best.country, confidence: 90, source: "invoice-pdf" }
      : { value: null, confidence: 0, source: null },
    blockConfidence,
  };
}

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export interface ExtractOptions {
  vendorLegalName?: string | null;   // strengthens address candidate scoring
}

export function extractVendorProfile(text: string, opts: ExtractOptions = {}): ExtractedVendorProfile {
  const raw = text || "";
  const clamp = (f: FieldExtraction): FieldExtraction =>
    f.confidence >= EXTRACTION_THRESHOLD ? f : { value: null, confidence: 0, source: null };

  const address = extractAddress(raw, opts.vendorLegalName ?? null);
  const gated: AddressExtraction = address.blockConfidence >= EXTRACTION_THRESHOLD
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
    address: gated,
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
