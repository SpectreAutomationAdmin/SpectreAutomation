// Sprint 3 · Checkpoint 15Y — generalized field-quality validation
// and post-processing.
//
// Runs AFTER parseInvoiceText + optional canonical-projection merge.
// Detects three classes of extraction defect and either corrects
// them (via a text-scan rescue) or nulls the field with an audit
// reason:
//
//   1. Supplier candidate is dominated by form labels / column
//      headings / metadata — reject; scan text for a real
//      organization line.
//
//   2. Payable reference is a concatenation of multiple identifiers
//      (dates glued to numbers glued to IDs) — reject; try to
//      isolate the trailing coherent segment; null if nothing
//      survives.
//
//   3. When (1) OR (2) fires, downstream GL selection must
//      abstain per §9. See applyFieldQualityGate().
//
// NOT document-specific — all detection is by shape and lexicon.
// No supplier names, filenames, invoice numbers, tenant identifiers,
// or industry vocabulary appear as constants.

import type { ExtractedInvoice } from "../types";

// -----------------------------------------------------------------------------
// Lexicons — closed word-lists for structural detection
// -----------------------------------------------------------------------------

// Words that commonly appear as form-labels / column-headings on
// invoices. When a candidate string is dominated by these, it's
// almost certainly a header row rather than an organization name.
const FIELD_LABEL_WORDS = new Set<string>([
  "po", "date", "dates", "salesperson", "salespeople", "phone", "fax",
  "terms", "due", "ship", "shipping", "shipped", "freight", "shipvia",
  "bill", "billed", "billing", "sold", "customer", "invoice", "invoices",
  "order", "orders", "payment", "payments", "account", "acct", "number",
  "no", "num", "id", "reference", "ref", "amount", "amt", "total",
  "totals", "subtotal", "sub", "tax", "gst", "hst", "pst", "qst", "vat",
  "credit", "debit", "balance", "quantity", "qty", "unit", "price",
  "description", "desc", "sku", "item", "code", "part", "product",
  "period", "from", "to", "via", "attn", "attention", "remit", "remittance",
]);

// Words that legitimately appear inside supplier / organization names
// and should NOT be counted against them (e.g. "The Home Depot",
// "Bank of America", "Delta Air Lines").
const ORG_STOPWORDS = new Set<string>([
  "the", "of", "and", "for", "at", "in", "on", "a", "an",
]);

// Common organization-legal suffixes in EN/CA/US/UK.
const ORG_SUFFIX_TOKEN = /\b(?:LP|LLP|LLC|L\.L\.C\.|L\.P\.|Inc\.?|Incorporated|Corp\.?|Corporation|Co\.?|Company|Ltd\.?|Limited|GmbH|Group|Holdings|Enterprises|Services|Systems|Solutions|Partners|Association|Society|Foundation|Trust|Bank|Insurance)\b/;

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type SupplierRejectionReason =
  | "LABEL_HEAVY"           // candidate is mostly form-labels
  | "NO_LETTERS"            // no letters at all
  | "TOO_SHORT"             // too short to be an organization name
  | "ALL_UPPERCASE_ABBREV"  // looks like a code, not a name
  | "PUNCTUATION_HEAVY";    // mostly punctuation

export type ReferenceRejectionReason =
  | "CONCATENATED_DATES"        // multiple date-like segments glued
  | "MULTIPLE_IDENTIFIERS_GLUED" // multiple identifiers in one string
  | "PURE_DATE"                  // is just a date
  | "EMPTY_AFTER_TRIM";

export interface SupplierValidationResult {
  action: "keep" | "rescued" | "rejected";
  value: string | null;
  rejectionReason?: SupplierRejectionReason;
  rescueSource?: "text_scan_org_suffix";
  labelDensity: number; // 0..1 — for diagnostics
}

export interface ReferenceValidationResult {
  action: "keep" | "trimmed" | "rejected";
  value: string | null;
  rejectionReason?: ReferenceRejectionReason;
  originalValue?: string | null;
}

// -----------------------------------------------------------------------------
// Supplier candidate validation
// -----------------------------------------------------------------------------

/**
 * Compute the fraction of tokens in a string that are known form
 * labels. High density → the string is a header row, not a name.
 * Applies splitCrammedLabels BEFORE tokenising so a string like
 * "PODateSalesperson" is scored the same as "PO Date Salesperson".
 */
export function labelDensity(candidate: string): number {
  // Two token views — the max density across them is the score.
  // The crammed-split view catches strings where the PDF text
  // extractor concatenated adjacent header cells with no space.
  const rawTokens = candidate
    .replace(/[#&:/,\-]+/g, " ")
    .split(/\s+/)
    .map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length > 0);
  const crammedTokens = splitCrammedLabels(candidate)
    .map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length > 0);
  const score = (tokens: string[]) => {
    if (tokens.length === 0) return 0;
    const contentTokens = tokens.filter((t) => !ORG_STOPWORDS.has(t));
    if (contentTokens.length === 0) return 0;
    const labels = contentTokens.filter((t) => FIELD_LABEL_WORDS.has(t));
    return labels.length / contentTokens.length;
  };
  return Math.max(score(rawTokens), score(crammedTokens));
}

/**
 * Split a crammed-header-row style crammed string back into
 * tokens by detecting label-boundary transitions. Used only for
 * detection; never used to rebuild the "correct" value.
 */
export function splitCrammedLabels(candidate: string): string[] {
  // Insert space before an uppercase letter that follows a
  // lowercase or a digit — restores "POSalesperson" → "PO Salesperson".
  // Also splits on punctuation.
  const spaced = candidate
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[#/&,]+/g, " ");
  return spaced.split(/\s+/).map((t) => t.replace(/[^A-Za-z0-9]/g, "")).filter((t) => t.length > 0);
}

/**
 * Score a supplier candidate. Returns keep / rescued / rejected.
 *
 * Rescue path: when the candidate is rejected as label-heavy, scan
 * fullText for the first line matching an organization-suffix
 * pattern (LP / Inc / Ltd / Corp / LLC / Co. / Limited / Corporation).
 * If found, use that as the corrected supplier.
 */
export function validateSupplierCandidate(
  candidate: string | null,
  fullText: string,
  opts?: {
    labelDensityThreshold?: number; // default 0.5
    minLetters?: number;            // default 3
  },
): SupplierValidationResult {
  const threshold = opts?.labelDensityThreshold ?? 0.5;
  const minLetters = opts?.minLetters ?? 3;

  if (!candidate || candidate.trim().length === 0) {
    return { action: "rejected", value: null, rejectionReason: "TOO_SHORT", labelDensity: 0 };
  }

  const trimmed = candidate.trim();
  const letters = trimmed.replace(/[^A-Za-z]/g, "").length;
  if (letters === 0) {
    return { action: "rejected", value: null, rejectionReason: "NO_LETTERS", labelDensity: 0 };
  }
  if (letters < minLetters) {
    return { action: "rejected", value: null, rejectionReason: "TOO_SHORT", labelDensity: 0 };
  }

  // Detect labels using BOTH the token split AND the split-crammed
  // form (so crammed-header-row noise gets caught).
  const density = Math.max(
    labelDensity(trimmed),
    labelDensity(splitCrammedLabels(trimmed).join(" ")),
  );

  // Rescue path: label-heavy → scan fullText for a real org line.
  if (density >= threshold) {
    const rescued = rescueOrganizationFromText(fullText, trimmed);
    if (rescued) {
      return {
        action: "rescued",
        value: rescued,
        rejectionReason: "LABEL_HEAVY",
        rescueSource: "text_scan_org_suffix",
        labelDensity: density,
      };
    }
    return { action: "rejected", value: null, rejectionReason: "LABEL_HEAVY", labelDensity: density };
  }

  return { action: "keep", value: trimmed, labelDensity: density };
}

/**
 * Scan fullText for the first line matching an organization-suffix
 * pattern. Skips lines that themselves fail the label-density test.
 * Falls back to 2-line adjacent windows because flat-text PDF
 * extractors frequently split "Northlake Turf Products LP" across
 * two lines ("Northlake Turf Products\nLP …").
 * Returns null if no defensible candidate.
 */
export function rescueOrganizationFromText(fullText: string, avoid?: string): string | null {
  const lines = fullText.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const avoidNorm = avoid ? avoid.toLowerCase().replace(/\s+/g, "") : "";
  const isDefensibleOrgPhrase = (candidate: string): string | null => {
    if (!candidate || candidate.length < 6 || candidate.length > 120) return null;
    if (labelDensity(candidate) > 0.4) return null;
    if (!/[A-Za-z]{3,}/.test(candidate)) return null;
    // Require substantive content BEFORE the suffix — otherwise a
    // stray line like "LP Phone: 555-1212" would masquerade as an
    // org phrase.
    const suffixMatch = candidate.match(ORG_SUFFIX_TOKEN);
    if (!suffixMatch) return null;
    const beforeSuffix = candidate.slice(0, suffixMatch.index ?? 0).trim();
    const beforeLetters = beforeSuffix.replace(/[^A-Za-z]/g, "").length;
    if (beforeLetters < 3) return null;
    // Extract the org phrase — from start-of-line up to and INCLUDING
    // the suffix (stop at a natural break just after it).
    const m = candidate.match(new RegExp(`^([^|]*?${ORG_SUFFIX_TOKEN.source})(?:[\\s|,;].*)?$`, "i"));
    const name = (m ? m[1] : candidate).trim().replace(/[|,;].*$/, "").trim();
    if (name.length < 6 || name.length > 100) return null;
    if (labelDensity(name) > 0.4) return null;
    if (avoidNorm && name.toLowerCase().replace(/\s+/g, "").includes(avoidNorm)) return null;
    return name;
  };

  // Pass 1 — single-line scan.
  for (const line of lines) {
    if (!ORG_SUFFIX_TOKEN.test(line)) continue;
    const rescued = isDefensibleOrgPhrase(line);
    if (rescued) return rescued;
  }
  // Pass 2 — two-line adjacent windows. Catches PDF extractors that
  // split "<company>\n<suffix>" across a line break.
  for (let i = 0; i < lines.length - 1; i++) {
    const combined = `${lines[i]} ${lines[i + 1]}`.trim();
    if (!ORG_SUFFIX_TOKEN.test(combined)) continue;
    // If pass 1 already matched, we won't reach here for that line.
    // Require the suffix to appear in the SECOND half (so we don't
    // just re-detect a suffix in line i alone).
    if (!ORG_SUFFIX_TOKEN.test(lines[i + 1])) continue;
    const rescued = isDefensibleOrgPhrase(combined);
    if (rescued) return rescued;
  }
  return null;
}

// -----------------------------------------------------------------------------
// Payable-reference validation
// -----------------------------------------------------------------------------

// Date-shaped fragment patterns. The permissive form allows the
// trailing year segment to blend with a following separator/digit,
// which is what happens when a PDF text extractor concatenates
// adjacent header cells.
const DATE_FRAGMENT_LOOSE = /\d{1,2}\/\d{1,2}\/?\d{0,4}/g;
const DATE_FRAGMENT_STRICT = /\d{1,2}\/\d{1,2}\/\d{2,4}/g;

/**
 * Detect if a reference string looks like multiple identifiers glued
 * together (e.g. two dates + a number + an ID glued into one value
 * because the text extractor flattened a header row). Rescue
 * attempt: strip the date-shaped fragments and keep the trailing
 * coherent identifier; null if nothing coherent survives.
 */
export function validatePayableReferenceCandidate(
  candidate: string | null,
): ReferenceValidationResult {
  if (!candidate || candidate.trim().length === 0) {
    return { action: "rejected", value: null, rejectionReason: "EMPTY_AFTER_TRIM" };
  }
  const original = candidate.trim();

  // Pure date → reject as invoice number.
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(original)) {
    return { action: "rejected", value: null, rejectionReason: "PURE_DATE", originalValue: original };
  }

  // Multiple slashes are the strongest signal of concatenated header
  // values.  Two dates share at least 4 slashes (2 per date). Also
  // catch the strict-match count for a second opinion.
  const slashCount = (original.match(/\//g) ?? []).length;
  const strictDateCount = (original.match(DATE_FRAGMENT_STRICT) ?? []).length;
  const looseDateCount = (original.match(DATE_FRAGMENT_LOOSE) ?? []).length;
  const concatenatedByShape = slashCount >= 3 || strictDateCount >= 2 || looseDateCount >= 2;

  if (concatenatedByShape) {
    // Try to rescue the trailing non-date portion.
    let stripped = original
      .replace(DATE_FRAGMENT_LOOSE, " ")
      .replace(/\s+/g, " ")
      .trim();
    // Trim separator debris left behind.
    stripped = stripped.replace(/^[\s\-\/]+/, "").replace(/[\s\-\/]+$/, "");
    if (
      stripped.length >= 3 &&
      /\d/.test(stripped) &&
      stripped.length < original.length * 0.7
    ) {
      return {
        action: "trimmed",
        value: stripped,
        rejectionReason: "CONCATENATED_DATES",
        originalValue: original,
      };
    }
    return {
      action: "rejected",
      value: null,
      rejectionReason: "CONCATENATED_DATES",
      originalValue: original,
    };
  }

  // Detect crammed multiple identifiers: three or more long numeric
  // runs of ≥5 digits back-to-back separated only by separators.
  const longRuns = original.match(/\d{5,}/g) ?? [];
  if (longRuns.length >= 3) {
    return {
      action: "rejected",
      value: null,
      rejectionReason: "MULTIPLE_IDENTIFIERS_GLUED",
      originalValue: original,
    };
  }

  return { action: "keep", value: original };
}

// -----------------------------------------------------------------------------
// Quality gate composed over an ExtractedInvoice
// -----------------------------------------------------------------------------

export interface QualityGateResult {
  supplier: SupplierValidationResult;
  reference: ReferenceValidationResult;
  // TRUE when field quality is high enough for a confident GL
  // recommendation. FALSE forces the analyser + ranker to abstain.
  glEligible: boolean;
  // Diagnostic-only: which field(s) triggered the abstention.
  abstentionReasons: string[];
}

/**
 * Full field-quality pass over an ExtractedInvoice. Mutates a copy;
 * returns the corrected invoice plus the gate result.
 */
export function applyFieldQualityGate(args: {
  extraction: ExtractedInvoice;
  fullText: string;
}): { extraction: ExtractedInvoice; gate: QualityGateResult } {
  const supplier = validateSupplierCandidate(args.extraction.vendor.guessedName, args.fullText);
  const reference = validatePayableReferenceCandidate(args.extraction.invoiceNumber);

  const glEligible =
    (supplier.action === "keep" || supplier.action === "rescued") &&
    (reference.action === "keep" || reference.action === "trimmed");

  const abstentionReasons: string[] = [];
  if (supplier.action === "rejected") {
    abstentionReasons.push(`supplier_${supplier.rejectionReason ?? "unknown"}`);
  }
  if (reference.action === "rejected") {
    abstentionReasons.push(`reference_${reference.rejectionReason ?? "unknown"}`);
  }

  const corrected: ExtractedInvoice = {
    ...args.extraction,
    vendor: {
      ...args.extraction.vendor,
      guessedName: supplier.value,
    },
    invoiceNumber: reference.value,
    // If reference was rejected as concatenated, the type is no
    // longer trustable as INVOICE_NUMBER — clear it.
    payableReferenceType: reference.action === "rejected" ? null : args.extraction.payableReferenceType,
    warnings: [
      ...args.extraction.warnings,
      ...(supplier.action !== "keep" ? [`supplier_${supplier.action}:${supplier.rejectionReason ?? ""}`] : []),
      ...(reference.action !== "keep" ? [`reference_${reference.action}:${reference.rejectionReason ?? ""}`] : []),
    ],
  };

  return {
    extraction: corrected,
    gate: {
      supplier,
      reference,
      glEligible,
      abstentionReasons,
    },
  };
}
