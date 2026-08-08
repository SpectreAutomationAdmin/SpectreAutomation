// Sprint 3 · Phase 4 Slice 5.2 (2026-08-08) — document-role-aware
// transactional-text builder.
//
// Founder amendment #4: do NOT fix "Capital Circle" or "finance
// charge" primarily through literal regex exceptions. Use DOCUMENT-
// ROLE PROVENANCE. Address/contact regions, recipient/supplier
// addresses, legal boilerplate, remittance instructions, payment
// terms and policy/footer regions must NOT contribute transactional
// accounting-nature evidence. Capital/interest/etc. inference should
// consume canonical purchased-item evidence AND transaction-relevant
// regions.
//
// This module reduces the raw flattened text to only the regions
// that carry TRANSACTIONAL fact — line items, summary totals, and
// invoice-level metadata. Supplier / recipient blocks (contact and
// address text), footer boilerplate, and any policy paragraphs
// (return terms, admin fees, "invoice due upon receipt...") are
// stripped so a nature classifier that scans this text cannot pick
// up "Capital Circle" (Saskatoon supplier street), "finance charge"
// (DMM footer policy), or similar boilerplate.

import type { LayoutRegion, RegionKind } from "./layout-regions";

/** Region kinds whose text represents an ACTUAL transactional fact.
 *  Anything not on this list is provenance/context/boilerplate. */
const TRANSACTIONAL_KINDS: ReadonlySet<RegionKind> = new Set([
  "LINE_ITEMS",
  "SUMMARY",
]);

/** Region kinds whose text is provenance / context / boilerplate.
 *  Explicitly listed for auditability. */
const NON_TRANSACTIONAL_KINDS: ReadonlySet<RegionKind> = new Set([
  "SUPPLIER_BLOCK",
  "RECIPIENT_BLOCK",
  "HEADER",
  "FOOTER",
  "UNKNOWN",  // conservative: unless classified as transactional, exclude
]);

/** Policy-paragraph / terms-and-conditions phrases that identify a
 *  visual line as boilerplate REGARDLESS of the enclosing region.
 *  A line beginning with any of these is stripped even from a
 *  transactional region (some PDFs emit policy text inside the line-
 *  items band). These match SUMMARY_ROW_LEADING policy prefixes from
 *  line-item-region-strategies.ts. */
const POLICY_LINE_LEADING =
  /^(?:invoice\s*due|administration\s*fee|on\s*all\s*overdue|account'?s?\s*terms|terms\s*and\s*conditions|all\s+merchandise|the\s+property\s+of|until\s*full\s*payment|please\s*write|please\s*remit|thank\s*you|please\s*note|\d+%\s*per\s*month|finance\s*charge\s*of|(?:overdue|late)\s*balances?)/i;

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface TransactionalTextResult {
  /** Concatenated transactional text, newline-separated. Callers pass
   *  this to text-scanning classifiers instead of the raw flattened
   *  PDF text. */
  text: string;
  /** Per-region breakdown for diagnostics. */
  includedRegions: Array<{ kind: RegionKind; page: number; lineCount: number; charCount: number }>;
  excludedRegions: Array<{ kind: RegionKind; page: number; lineCount: number; reason: string }>;
  strippedPolicyLineCount: number;
}

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

/** Build the transactional-only text view of the document. When no
 *  regions are available (image-only PDF, OCR-pending), returns
 *  empty text with an explanatory diagnostic. */
export function buildTransactionalText(regions: LayoutRegion[]): TransactionalTextResult {
  const included: TransactionalTextResult["includedRegions"] = [];
  const excluded: TransactionalTextResult["excludedRegions"] = [];
  let strippedPolicyLineCount = 0;
  const chunks: string[] = [];

  for (const r of regions) {
    if (!TRANSACTIONAL_KINDS.has(r.kind)) {
      excluded.push({
        kind: r.kind, page: r.page, lineCount: r.lines.length,
        reason: NON_TRANSACTIONAL_KINDS.has(r.kind)
          ? "non-transactional region kind"
          : `unrecognised region kind: ${r.kind}`,
      });
      continue;
    }
    // Strip policy-line leading prefixes inside otherwise-transactional regions.
    let regionText = "";
    let charCount = 0;
    for (const line of r.lines) {
      const trimmed = line.text.trim();
      if (!trimmed) continue;
      if (POLICY_LINE_LEADING.test(trimmed)) {
        strippedPolicyLineCount++;
        continue;
      }
      regionText += trimmed + "\n";
      charCount += trimmed.length;
    }
    if (regionText.length > 0) {
      chunks.push(regionText);
      included.push({ kind: r.kind, page: r.page, lineCount: r.lines.length, charCount });
    }
  }

  return {
    text: chunks.join("\n").trim(),
    includedRegions: included,
    excludedRegions: excluded,
    strippedPolicyLineCount,
  };
}

/** Build a diagnostic string for logging / observability. */
export function transactionalTextDiagnostic(result: TransactionalTextResult): string {
  const inc = result.includedRegions.map((r) => `${r.kind}(p${r.page}:${r.lineCount}L,${r.charCount}c)`).join(",");
  const exc = result.excludedRegions.map((r) => `${r.kind}(p${r.page}:${r.lineCount}L)`).join(",");
  return `chars=${result.text.length} included=[${inc}] excluded=[${exc}] policyStripped=${result.strippedPolicyLineCount}`;
}
