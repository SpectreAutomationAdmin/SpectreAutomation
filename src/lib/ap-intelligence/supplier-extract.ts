// Sprint 3 · Checkpoint 15Q (2026-07-28) — supplier-identity
// extractor.
//
// Founder rule: the SUPPLIER is the party issuing the invoice and
// expecting payment. The document is the primary evidence; the
// email sender is a tie-breaker at most.
//
// Pre-15Q defect: `extractVendorName` (parse-invoice.ts) was a
// regex-only picker that grabbed the first line matching a
// corporate-suffix pattern. It could pick a "Bill-To" recipient's
// name (comment claimed a guard, code had none) or fall through to
// a random top-of-page line. When it fell through to null, the
// projection couldn't label the vendor and the card showed the
// generic "AP invoice" label alongside the sender's line — the
// founder read this as "sender labelled as vendor".
//
// This module returns a scored list of supplier candidates with
// provenance + positive/negative evidence per candidate. The
// caller may promote the leader as the extracted supplier, or fall
// back to the sender only when NO supported candidate exists.
//
// GENERALIZED — nothing here is invoice-specific. No CPA rule, no
// Turcato rule, no acceptance-invoice number, no attachment
// filename. The scoring model applies uniformly to every invoice
// text.

import { emailDomain, normalizeName } from "@/lib/vendor-matching/normalize";

// -----------------------------------------------------------------------------
// Shape
// -----------------------------------------------------------------------------

export type SupplierEvidenceKind =
  | "corp_suffix"          // "…, Inc." "…, Corporation" "…, Ltd" on the line
  | "issuer_header"        // top-of-document, page 1
  | "repeat_across_pages"  // same name appears on page 1 AND a later page
  | "adjacent_tax_id"      // GST/HST/BN registration close to the name
  | "adjacent_address"     // street address / postal-code block adjacent
  | "adjacent_remittance"  // "remit to" / "make cheque payable to" nearby
  | "issuer_language"      // "invoice from", "supplier", "sold by" cue
  | "sender_domain_match"  // email domain aligns with name / website
  | "recipient_context"    // negative: "bill to", "sold to", "attention"
  | "member_context"       // negative: "member", "account holder", "customer"
  | "person_name_shape"    // negative: two-word person name pattern
  | "email_line"           // negative: line is an email address
  | "date_or_id_line";     // negative: line looks like an ID / date

export interface SupplierEvidence {
  kind: SupplierEvidenceKind;
  detail?: string;
}

export interface SupplierCandidate {
  value: string;                    // as it appears in the doc, trimmed
  normalized: string;               // normalizeName output
  lineNo: number;
  score: number;
  positive: SupplierEvidence[];
  negative: SupplierEvidence[];
}

export type SupplierSource =
  | "invoice_document"
  | "email_sender"
  | "attachment_metadata"
  | "system_default";

export interface SupplierExtraction {
  value: string | null;
  normalized: string | null;
  source: SupplierSource;
  confidence: number;               // 0..100
  reasoningCode: string;
  candidates: SupplierCandidate[];
  alternates: SupplierCandidate[];
}

// -----------------------------------------------------------------------------
// Signal patterns (generic, no invoice-specific strings)
// -----------------------------------------------------------------------------

// Corporate-suffix rule — the org name up to and including a
// canonical suffix. The base can be up to 60 chars. Deliberately
// permissive on the tail: many real invoices print
// "Microsoft Corporation, One Microsoft Way, Redmond, WA 98052"
// on a single line — the suffix appears mid-line, followed by an
// address. We anchor at start-of-line + capture through the
// suffix, then TOLERATE any trailing address / punctuation.
const CORP_SUFFIX_RE =
  /^\s*([A-Z][A-Za-z0-9&.,'\-\s/]{2,60}?(?:\s+(?:Corporation|Corp|Company|Co|Inc|Incorporated|Ltd|Limited|LLC|LLP|LP|ULC|PLC|GmbH|AG|SA|BV|NV|Pty|Association|Society|Foundation|Institute|Group|Holdings)\.?))(?:\b|,|\s|$)/;

// Line-shape rejects — labels ("Customer PO Number:"), pure header
// strings ("Order Details", "Billing Summary"), inline summary
// key/value lines ("Charges:29.80"). A candidate line must not
// end with a bare colon and must not be one of a small set of
// known invoice-form header phrases.
const LABEL_TAIL_RE = /:\s*$/;
const FORM_HEADER_RE =
  /^\s*(?:order\s+details|billing\s+summary|payment\s+summary|invoice\s+summary|remittance\s+advice|statement\s+of\s+account|tax\s+summary|line\s+items?|charges?|discounts?|credits?|balance\s+due|amount\s+due|invoice\s+total|subtotal|total)\s*[:]?\s*$/i;

// Negative-context markers. Any candidate whose ANCHOR line is
// inside a range starting with one of these headers is a recipient
// / customer, not a supplier.
const RECIPIENT_HEADER_RE =
  /^\s*(?:bill[-\s]?to|sold[-\s]?to|ship[-\s]?to|deliver[-\s]?to|invoice[-\s]?to|customer|member|account\s+holder|attention|attn|for\s+the\s+attention\s+of)\s*[:]?\s*$/i;

// Person-name shape — two capitalized words, no digits, no
// organizational suffix, no punctuation. Signals a recipient name.
const PERSON_NAME_RE = /^\s*[A-Z][a-z]+(?:\s+[A-Z]\.)?\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)?\s*$/;

// "Invoice from", "sold by", explicit "Supplier:" label positive
// language cues on the line preceding the candidate. Bare "supplier"
// in a sentence would false-match ("no plausible supplier"), so the
// term must appear as a label ("Supplier:" / "Vendor:") or in a
// specific "sold by" / "billed by" / "issued by" / "invoice from"
// / "issued from" construction.
const ISSUER_LANGUAGE_RE = /\b(?:invoice\s+from|sold\s+by|billed\s+by|issued\s+by|issued\s+from)\b|^\s*(?:supplier|vendor)\s*:/i;

// "Remit to" / "make cheque payable to" near the candidate.
const REMITTANCE_RE = /\b(?:remit\s+to|make\s+cheque(?:s)?\s+payable\s+to|payments?\s+to|payable\s+to)\b/i;

// Adjacent tax-registration signature. GST/HST BN9(+RT0001) OR
// generic "Tax Registration" / "GST/HST" / "BN" prefix.
const TAX_ID_RE = /\b(?:GST\/?HST|HST|GST|BN|Business\s*Number|Tax\s*Registration)\b/i;

// Address block — a numbered street or postal code near the candidate.
const ADDRESS_LINE_RE = /^\s*(?:\d+\s+\w|PO\s+Box\b|P\.\s*O\.\s*Box\b|\d{5}(?:-\d{4})?|[A-Z]\d[A-Z]\s*\d[A-Z]\d)\b/i;

// Common non-issuer line shapes to exclude.
const DATE_ISH_RE = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4})\b/;
const ID_ISH_RE = /^\s*[#A-Z]{0,4}[-\s]?\d{4,}\s*$/;
const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const MONTH_RE = /\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\b/i;

// -----------------------------------------------------------------------------
// Candidate collection + scoring
// -----------------------------------------------------------------------------

const RECIPIENT_WINDOW_LINES = 8;

/**
 * Extract supplier candidates from the PDF text. Returns the leader
 * (highest positive score) as `.value` + the runner-ups on `.alternates`.
 * When no candidate has any positive support, returns `{ value: null }`
 * with `source: "system_default"` — the caller may then decide to
 * consult the email sender as a tie-breaker.
 */
export function extractSupplier(
  text: string,
  opts: { senderName?: string | null; senderEmail?: string | null } = {},
): SupplierExtraction {
  const lines = text.split(/\r?\n/);
  const recipientRanges = collectRecipientRanges(lines);
  const totalLines = lines.length;

  const candidates: SupplierCandidate[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const positive: SupplierEvidence[] = [];
    const negative: SupplierEvidence[] = [];

    // Positive: corp suffix.
    const suffixHit = line.match(CORP_SUFFIX_RE);
    if (suffixHit) positive.push({ kind: "corp_suffix" });

    // Only continue if the line is a plausible name shape.
    // A candidate MUST have either a corp suffix OR be flagged by
    // adjacent issuer language / remittance / tax id (below).
    let plausibleName: boolean = suffixHit != null;

    // Negative shape filters (drop line entirely).
    if (EMAIL_RE.test(line)) { negative.push({ kind: "email_line" }); continue; }
    if (ID_ISH_RE.test(line)) { negative.push({ kind: "date_or_id_line" }); continue; }
    if (DATE_ISH_RE.test(line) || MONTH_RE.test(line) && line.length < 40) continue;
    // Address-shaped lines ("PO Box 400", "1234 Fairway Drive",
    // postal codes) are physical-address fragments, not org names.
    // They may still be USEFUL as an adjacent_address signal for
    // another candidate — never as a supplier candidate themselves.
    if (ADDRESS_LINE_RE.test(line)) continue;
    // Label lines ("Customer PO Number:") are form-fields, not names.
    // Pure-form header phrases ("Order Details", "Billing Summary")
    // are section chrome, not suppliers. Reject both categorically.
    if (LABEL_TAIL_RE.test(line)) continue;
    if (FORM_HEADER_RE.test(line)) continue;

    // Positive: issuer language on the previous line ("Invoice from")
    if (i > 0 && ISSUER_LANGUAGE_RE.test(lines[i - 1])) {
      positive.push({ kind: "issuer_language", detail: lines[i - 1].trim() });
      plausibleName = true;
    }
    // Positive: remittance language PRECEDES the candidate. The cue
    // "Remit to:" / "Please remit payment to:" introduces the party
    // that follows. Looking forward too would let the cue's own
    // header line ("Statement of Account", etc.) sail through as
    // "adjacent to remittance".
    for (let j = Math.max(0, i - 3); j < i; j++) {
      if (REMITTANCE_RE.test(lines[j])) { positive.push({ kind: "adjacent_remittance" }); plausibleName = true; break; }
    }
    // Positive: tax-registration near the line.
    for (let j = Math.max(0, i - 4); j <= Math.min(lines.length - 1, i + 6); j++) {
      if (TAX_ID_RE.test(lines[j])) { positive.push({ kind: "adjacent_tax_id" }); break; }
    }
    // Positive: address / postal-code block adjacent.
    for (let j = Math.max(0, i - 1); j <= Math.min(lines.length - 1, i + 3); j++) {
      if (j === i) continue;
      if (ADDRESS_LINE_RE.test(lines[j])) { positive.push({ kind: "adjacent_address" }); break; }
    }
    // Positive: issuer header (page 1, top 20 %).
    if (i <= Math.max(20, Math.floor(totalLines * 0.15))) positive.push({ kind: "issuer_header" });

    // Negative: line is inside a recipient range.
    if (recipientRanges.some(([lo, hi]) => i >= lo && i <= hi)) {
      negative.push({ kind: "recipient_context" });
    }
    // Negative: member / account-holder / customer language in the
    // 3 lines above.
    for (let j = Math.max(0, i - 3); j < i; j++) {
      if (/\b(?:member|account\s+holder|customer|attention|attn)\b/i.test(lines[j])) {
        negative.push({ kind: "member_context", detail: lines[j].trim() });
        break;
      }
    }
    // Negative: person-name shape. Skip when a strong org signal
    // is present — "adjacent_remittance" / "adjacent_tax_id" / corp
    // suffix — because a three-word org name ("Grand Prairie Utilities")
    // otherwise trips the negative and loses to weaker candidates.
    const hasStrongOrgSignal =
      positive.some((p) => p.kind === "corp_suffix" || p.kind === "adjacent_remittance" || p.kind === "adjacent_tax_id");
    if (PERSON_NAME_RE.test(line) && !hasStrongOrgSignal) {
      negative.push({ kind: "person_name_shape" });
    }

    // A line must have MORE than just the "issuer_header" positional
    // signal to become a candidate. A generic top-of-page string
    // ("Statement of Account", "INVOICE", form headers) would
    // otherwise sail through and win by default. Require at least
    // one substantive signal: corp suffix OR issuer-language OR
    // remittance-adjacent OR tax-id-adjacent OR address-adjacent OR
    // repeat-across-pages.
    const substantivePositives = positive.filter((p) => p.kind !== "issuer_header").length;
    if (!plausibleName && substantivePositives === 0) continue;

    // Repeat-across-pages positive: if the SAME normalized name appears
    // later in the doc (below line i + 25), that's issuer repetition.
    const norm = normalizeName(suffixHit ? suffixHit[1] : line);
    if (norm) {
      for (let j = i + 25; j < lines.length; j++) {
        const otherNorm = normalizeName(lines[j].trim());
        if (otherNorm && otherNorm === norm) {
          positive.push({ kind: "repeat_across_pages" });
          break;
        }
      }
    }

    candidates.push({
      value: (suffixHit ? suffixHit[1] : line).trim(),
      normalized: norm ?? line.toLowerCase(),
      lineNo: i,
      score: 0,          // filled below
      positive,
      negative,
    });
  }

  // Score.
  for (const c of candidates) c.score = scoreCandidate(c);

  // Filter: require at least SOME positive support OR no negatives.
  const scored = candidates
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    // No document-supported supplier. Sender fallback ONLY when the
    // caller provided one AND it isn't obviously a person forwarding
    // (heuristic: has organizational suffix or is an email domain).
    const senderNameHasSuffix = opts.senderName && CORP_SUFFIX_RE.test(opts.senderName);
    const domain = emailDomain(opts.senderEmail ?? undefined);
    if (senderNameHasSuffix) {
      return {
        value: opts.senderName!,
        normalized: normalizeName(opts.senderName!),
        source: "email_sender",
        confidence: 40,
        reasoningCode: "sender_org_suffix_fallback",
        candidates,
        alternates: [],
      };
    }
    if (domain) {
      return {
        value: null,
        normalized: null,
        source: "system_default",
        confidence: 0,
        reasoningCode: "no_document_supplier_sender_is_person",
        candidates,
        alternates: [],
      };
    }
    return {
      value: null,
      normalized: null,
      source: "system_default",
      confidence: 0,
      reasoningCode: "no_supplier_signal",
      candidates,
      alternates: [],
    };
  }

  const leader = scored[0];
  // Deduplicate alternates by normalized name.
  const seen = new Set<string>([leader.normalized]);
  const alternates: SupplierCandidate[] = [];
  for (const c of scored.slice(1)) {
    if (seen.has(c.normalized)) continue;
    seen.add(c.normalized);
    alternates.push(c);
    if (alternates.length >= 3) break;
  }

  // Confidence based on leader's positive weight + gap to runner-up.
  const runnerUpScore = scored[1]?.score ?? 0;
  const gap = leader.score - runnerUpScore;
  let confidence = Math.min(95, Math.max(30, leader.score));
  if (gap >= 20) confidence = Math.min(95, confidence + 5);
  if (leader.negative.length > 0) confidence = Math.max(30, confidence - 15);

  return {
    value: leader.value,
    normalized: leader.normalized,
    source: "invoice_document",
    confidence,
    reasoningCode: leader.positive.length >= 3 ? "multi_signal_supplier" : "single_signal_supplier",
    candidates: scored,
    alternates,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/**
 * Weight positive + negative evidence into a total score.
 *
 *   +20 corp_suffix
 *   +15 issuer_language ("invoice from", "sold by", ...)
 *   +15 adjacent_remittance
 *   +15 adjacent_tax_id
 *   +10 adjacent_address
 *   +10 issuer_header (top of doc)
 *   +10 repeat_across_pages
 *
 *   -30 recipient_context ("bill to" / "sold to" / etc.)
 *   -20 member_context ("member", "account holder")
 *   -15 person_name_shape
 *   -50 email_line   (dropped upstream — never reaches scoring)
 */
function scoreCandidate(c: SupplierCandidate): number {
  const WEIGHTS: Record<SupplierEvidenceKind, number> = {
    corp_suffix: 20,
    issuer_language: 15,
    adjacent_remittance: 15,
    adjacent_tax_id: 15,
    adjacent_address: 10,
    issuer_header: 10,
    repeat_across_pages: 10,
    recipient_context: -30,
    member_context: -20,
    person_name_shape: -15,
    email_line: -50,
    date_or_id_line: -50,
    sender_domain_match: 0,
  };
  const positive = c.positive.reduce((a, ev) => a + (WEIGHTS[ev.kind] ?? 0), 0);
  const negative = c.negative.reduce((a, ev) => a + (WEIGHTS[ev.kind] ?? 0), 0);
  return positive + negative;
}

/**
 * Collect line ranges that belong to a recipient block. A header
 * like "Bill To" / "Sold To" starts the range; the range ends at
 * the next blank line or after RECIPIENT_WINDOW_LINES lines,
 * whichever comes first.
 */
function collectRecipientRanges(lines: string[]): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < lines.length; i++) {
    if (!RECIPIENT_HEADER_RE.test(lines[i])) continue;
    let end = Math.min(i + RECIPIENT_WINDOW_LINES, lines.length - 1);
    for (let j = i + 1; j <= end; j++) {
      if (/^\s*$/.test(lines[j]) && j > i + 1) { end = j; break; }
    }
    out.push([i, end]);
  }
  return out;
}
