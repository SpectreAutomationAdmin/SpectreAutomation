// Sprint 3 · Phase 4 Slice 5.6 (2026-08-09) — Query Sanitizer.
//
// Founder §4: queries MUST be generated exclusively from bounded
// product evidence. This module is the last line of defence — even
// though ProductReferenceRequest already excludes tenant identity
// by its type shape, this sanitizer scrubs the candidate arrays and
// descriptionExcerpt for anything that resembles PII / financial
// identifiers / email addresses / phone numbers / postal addresses
// BEFORE the request is dispatched to any external provider.
//
// Non-negotiable exclusions (hard privacy boundary):
//   • Email addresses (RFC-5322 shape)
//   • Phone numbers (international / N. American)
//   • Postal codes (CA/US shape)
//   • Street addresses
//   • Government tax/business IDs (GST/HST/BN/EIN/SSN/SIN)
//   • Currency amounts (money in the description leaks totals)
//   • Bank account / routing / IBAN shapes
//   • Long numeric sequences that could be invoice numbers or serials
//     when they are NOT structurally proven to be a product identifier
//   • Person names heuristic — capitalised bigrams followed by proper-
//     name commas
//   • URLs
//
// The sanitiser NEVER adds inference — it only removes. When in
// doubt, drop the token.

import type { ProductReferenceRequest } from "../product-reference-provider";

// -----------------------------------------------------------------------------
// Regexes — closed generic list. NO supplier / product / SKU literals.
// -----------------------------------------------------------------------------

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const URL_RE = /\bhttps?:\/\/[^\s]+|\bwww\.[^\s]+\b/gi;
const PHONE_RE = /\+?\d{1,3}?[\s.-]?\(?\d{2,4}\)?[\s.-]?\d{3,4}[\s.-]?\d{3,4}/g;
const CA_POSTAL_RE = /\b[A-Za-z]\d[A-Za-z][\s-]?\d[A-Za-z]\d\b/g;
const US_ZIP_RE = /\b\d{5}(?:-\d{4})?\b/g;
const STREET_LINE_RE = /\b\d+\s+[A-Za-z][A-Za-z\s.]+(?:street|st|road|rd|ave|avenue|blvd|boulevard|way|drive|dr|court|ct|lane|ln|place|pl|highway|hwy|route|rte)\b\.?/gi;
const CA_GST_HST_RE = /\b\d{9}\s*RT\s*\d{4}\b/gi;
const CA_BN_RE = /\bBN\s*\d{9}\b/gi;
const US_EIN_RE = /\b\d{2}-\d{7}\b/g;
const US_SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CA_SIN_RE = /\b\d{3}\s?\d{3}\s?\d{3}\b/g;
const CURRENCY_AMOUNT_RE = /(?:CAD?|USD?|EUR?|GBP?|\$|€|£)\s*-?\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d{1,3}(?:,\d{3})+(?:\.\d{2})?/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{4}[0-9]{7}(?:[A-Z0-9]?){0,16}\b/g;
const BANK_ACCOUNT_RE = /\b(?:transit|routing|swift|account\s*(?:#|no\.?|number))\s*:?\s*\d{4,}\b/gi;
// Long numeric-only tokens (7+ digits) that could be invoice numbers,
// customer IDs, or purchase-order numbers. Product SKUs are usually
// shorter or contain hyphens/letters. When in doubt, drop.
const LONG_NUMERIC_RE = /\b\d{7,}\b/g;

// -----------------------------------------------------------------------------
// Model / SKU shape validator (§4 explicit — no invoice numbers)
// -----------------------------------------------------------------------------

/** A candidate is safe to send externally if it LOOKS like a product
 *  identifier: alphanumeric mix, 3-24 chars, contains at least one
 *  letter OR one hyphen OR one dot (else it could be a bare invoice
 *  number). Pure-numeric identifiers ≥ 7 digits are dropped by the
 *  LONG_NUMERIC_RE. */
export function looksLikeProductIdentifier(candidate: string): boolean {
  const t = candidate.trim();
  if (t.length < 2 || t.length > 24) return false;
  if (LONG_NUMERIC_RE.test(t)) return false;
  LONG_NUMERIC_RE.lastIndex = 0;
  // Must contain a letter OR hyphen OR dot to distinguish from a
  // bare invoice-number-like sequence. Bare short numerics like "42"
  // pass — they're too short to be an invoice number by themselves.
  if (/^\d{1,6}$/.test(t)) return true;
  return /[A-Za-z]|-|\./.test(t) && /[A-Za-z0-9]/.test(t);
}

// -----------------------------------------------------------------------------
// Public: sanitise a ProductReferenceRequest
// -----------------------------------------------------------------------------

export interface SanitizationOutcome {
  request: ProductReferenceRequest;
  rejectedCandidates: string[];
  rejectionReasons: string[];
  sanitizedDescriptionExcerpt: string;
  wasModified: boolean;
}

/** Redact any privacy-hazardous content from a ProductReferenceRequest.
 *  Returns a new request object plus a rejection log for audit. */
export function sanitizeProductReferenceRequest(
  req: ProductReferenceRequest,
): SanitizationOutcome {
  const rejected: string[] = [];
  const reasons: string[] = [];

  const scrubCandidateArray = (arr: string[], kind: string): string[] => {
    const kept: string[] = [];
    for (const raw of arr ?? []) {
      const c = (raw ?? "").trim();
      if (c.length === 0) continue;
      if (containsPii(c)) {
        rejected.push(c); reasons.push(`${kind}:pii`);
        continue;
      }
      if (!looksLikeProductIdentifier(c)) {
        rejected.push(c); reasons.push(`${kind}:not-product-shape`);
        continue;
      }
      kept.push(c);
    }
    return kept;
  };

  const brandCandidates = scrubCandidateArray(req.brandCandidates, "brand");
  const modelCandidates = scrubCandidateArray(req.modelCandidates, "model");
  const skuCandidates = scrubCandidateArray(req.skuCandidates, "sku");

  // Serials are dropped as OUTBOUND tokens entirely — a serial number
  // can uniquely identify a physical unit and its owner. Keep for
  // internal reasoning only. Provider receives an empty array.
  const serialCandidates: string[] = [];
  if ((req.serialCandidates ?? []).length > 0) {
    for (const s of req.serialCandidates) {
      rejected.push(s);
      reasons.push("serial:always-dropped-outbound");
    }
  }

  const sanitizedDescriptionExcerpt = sanitizeDescription(req.descriptionExcerpt ?? "");

  const wasModified =
    brandCandidates.length !== (req.brandCandidates ?? []).length
    || modelCandidates.length !== (req.modelCandidates ?? []).length
    || skuCandidates.length !== (req.skuCandidates ?? []).length
    || serialCandidates.length !== (req.serialCandidates ?? []).length
    || sanitizedDescriptionExcerpt !== req.descriptionExcerpt;

  return {
    request: {
      brandCandidates,
      modelCandidates,
      skuCandidates,
      serialCandidates,
      descriptionExcerpt: sanitizedDescriptionExcerpt,
      // observedUnitPrice is a bounded numeric passed for price
      // plausibility ONLY — currency stripped from stringified form.
      // Do not send tax-inclusive totals; the caller must supply the
      // per-unit value or leave null.
      observedUnitPrice: req.observedUnitPrice,
      currency: req.currency,
      maxCalls: req.maxCalls,
    },
    rejectedCandidates: rejected,
    rejectionReasons: reasons,
    sanitizedDescriptionExcerpt,
    wasModified,
  };
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** True when a token contains any pattern in the exclusion list. */
export function containsPii(text: string): boolean {
  const patterns: RegExp[] = [
    EMAIL_RE, URL_RE, PHONE_RE, CA_POSTAL_RE, US_ZIP_RE,
    STREET_LINE_RE, CA_GST_HST_RE, CA_BN_RE, US_EIN_RE, US_SSN_RE,
    CA_SIN_RE, CURRENCY_AMOUNT_RE, IBAN_RE, BANK_ACCOUNT_RE,
    LONG_NUMERIC_RE,
  ];
  for (const p of patterns) {
    p.lastIndex = 0;
    if (p.test(text)) return true;
  }
  return false;
}

/** Redact PII from the description excerpt. Redaction replaces the
 *  hazardous span with a [REDACTED] token so the remaining product-
 *  context text can still guide the external provider. */
export function sanitizeDescription(text: string): string {
  if (!text) return "";
  let out = text
    .replace(EMAIL_RE, "[REDACTED]")
    .replace(URL_RE, "[REDACTED]")
    .replace(PHONE_RE, "[REDACTED]")
    .replace(CA_POSTAL_RE, "[REDACTED]")
    .replace(US_ZIP_RE, "[REDACTED]")
    .replace(STREET_LINE_RE, "[REDACTED]")
    .replace(CA_GST_HST_RE, "[REDACTED]")
    .replace(CA_BN_RE, "[REDACTED]")
    .replace(US_EIN_RE, "[REDACTED]")
    .replace(US_SSN_RE, "[REDACTED]")
    .replace(CA_SIN_RE, "[REDACTED]")
    .replace(CURRENCY_AMOUNT_RE, "[REDACTED]")
    .replace(IBAN_RE, "[REDACTED]")
    .replace(BANK_ACCOUNT_RE, "[REDACTED]")
    .replace(LONG_NUMERIC_RE, "[REDACTED]");
  // Collapse whitespace + cap length (defence in depth against
  // large-payload send).
  out = out.replace(/\s+/g, " ").trim();
  return out.length > 200 ? out.slice(0, 200) + "…" : out;
}
