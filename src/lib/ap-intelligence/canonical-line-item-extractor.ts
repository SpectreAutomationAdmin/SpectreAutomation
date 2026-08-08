// Sprint 3 · Phase 4 Slice 5 (2026-08-07) — the ONE canonical
// line-item authority.
//
// Founder rule (hard requirement): after Slice 5 there must be one
// production line-item authority. Canonical evidence,
// economic-purpose classification, GL ranking, Work Intake projection
// and AP Coding must not derive line items independently.
//
// This module is that authority. Every consumer calls
// extractCanonicalLineItems({ bytes, flattenedText?, pageCount? }).
//
// Routing (amendment #1 — page-class based, not char-count):
//
//   For each page:
//     PageClass DIGITAL_TEXT   → positioned reconstruction (composable
//                                CLASSIC_COLUMN_TABLE + CATEGORY_BLOCK_STATEMENT
//                                region strategies).
//     PageClass PARTIAL_TEXT   → positioned reconstruction (best effort)
//                              + flattened fallback for uncovered spans.
//     PageClass IMAGE_ONLY     → route to Textract OCR path. If Textract
//                                is unavailable (staging or worker not
//                                configured), record OCR_PENDING and
//                                abstain rather than fabricate.
//
//   If ALL pages produced 0 rows and any usable flattened text
//   exists → run the flattened-text fallback extractor and tag rows
//   FLATTENED_TEXT_FALLBACK.

import { extractPdfLayout } from "./pdf-layout-extract";
import type { PdfLayout } from "./pdf-layout-extract";
import {
  detectClassicColumnTableRegions,
  detectCategoryBlockRegions,
  reconstructClassicColumnTable,
  reconstructCategoryBlock,
  resolveRegions,
  type LineItemRegion,
} from "./line-item-region-strategies";
import type {
  CanonicalLineItem,
  CanonicalLineItemStrategy,
} from "./evidence/canonical-line-item";
import {
  classifyLineItemRole,
  reconcileCanonicalLineItems,
  validateRowArithmetic,
} from "./evidence/canonical-line-item";
import { extractLineItems as flattenedFallbackExtract } from "./line-items-extract";

// -----------------------------------------------------------------------------
// Public API
// -----------------------------------------------------------------------------

export interface CanonicalLineItemExtractionInput {
  /** Pre-computed PdfLayout — preferred when the caller already ran
   *  extractPdfLayout (e.g. the strategy router). Avoids re-parsing. */
  layout?: PdfLayout | null;
  /** PDF bytes. Used only when `layout` is absent. */
  bytes?: Buffer | null;
  /** Pre-extracted flattened text. Optional — used for flattened
   *  fallback when positional path yields nothing OR bytes not
   *  provided. */
  flattenedText?: string | null;
  /** Known page count (from analyseIngestedInvoice). Used for the
   *  flattened fallback. */
  pageCount?: number | null;
}

export interface CanonicalLineItemExtractionResult {
  /** Reconstructed line items. Empty when abstaining. */
  lineItems: CanonicalLineItem[];
  /** Detected regions (for diagnostics). */
  regions: LineItemRegion[];
  /** Which strategy actually produced items (a document may mix). */
  strategiesUsed: CanonicalLineItemStrategy[];
  /** Human-readable diagnostic for observability. */
  diagnostic: string;
  /** Per-page classification. */
  pages: Array<{
    page: number;
    pageClass: string;
    itemsProduced: number;
    routedTo: "POSITIONED" | "TEXTRACT_PENDING" | "FLATTENED_FALLBACK" | "SKIPPED";
  }>;
  /** Set to true when at least one page requires OCR but Textract
   *  results are not yet available. Downstream should not attempt to
   *  produce a line-item recommendation; the OCR path re-enqueues
   *  analysis when results arrive. */
  ocrPending: boolean;
  /** Reconciliation vs claimed totals (populated when caller passes
   *  the claimed values in a follow-up call to reconcileCanonicalLineItems). */
  reconciliationHint?: null;
}

/** The single line-item authority. */
export async function extractCanonicalLineItems(
  input: CanonicalLineItemExtractionInput,
): Promise<CanonicalLineItemExtractionResult> {
  const strategiesUsed = new Set<CanonicalLineItemStrategy>();
  const perPage: CanonicalLineItemExtractionResult["pages"] = [];
  let layout: PdfLayout | null = input.layout ?? null;
  if (!layout && input.bytes) {
    try {
      layout = await extractPdfLayout(input.bytes);
    } catch {
      layout = null;
    }
  }

  const items: CanonicalLineItem[] = [];
  const regions: LineItemRegion[] = [];
  let ocrPending = false;

  if (layout && layout.items.length > 0) {
    // Positioned path. Detect regions from all strategies; resolve
    // overlaps; reconstruct each region independently; merge.
    const classicRegions = detectClassicColumnTableRegions(layout);
    const categoryRegions = detectCategoryBlockRegions(layout);
    const merged = resolveRegions([...classicRegions, ...categoryRegions]);

    // Cross-page consolidation: when the same header signature exists
    // on multiple pages of a classic table, treat page 2+ as a
    // continuation. In practice this is handled naturally because
    // each region reconstructs its own rows and we merge below;
    // repeated-header rows on page 2 are simply the region seed and
    // not emitted as line items.
    for (const r of merged) regions.push(r);

    // Reconstruct per region.
    for (const region of merged) {
      const rowsForRegion = region.kind === "CLASSIC_COLUMN_TABLE"
        ? reconstructClassicColumnTable(region, layout)
        : reconstructCategoryBlock(region, layout);
      for (const li of rowsForRegion) {
        strategiesUsed.add(li.sourceStrategy);
        items.push(li);
      }
    }

    // Per-page reporting.
    for (const pd of (layout.pages ?? [])) {
      const producedOnPage = items.filter((i) => i.page === pd.page).length;
      let routedTo: CanonicalLineItemExtractionResult["pages"][number]["routedTo"] = "POSITIONED";
      if (pd.pageClass === "IMAGE_ONLY") {
        routedTo = "TEXTRACT_PENDING";
        ocrPending = true;
      } else if (producedOnPage === 0 && pd.pageClass === "PARTIAL_TEXT") {
        routedTo = "FLATTENED_FALLBACK";
      }
      perPage.push({
        page: pd.page,
        pageClass: pd.pageClass,
        itemsProduced: producedOnPage,
        routedTo,
      });
    }
  } else {
    // No layout OR zero positioned items → IMAGE_ONLY / no-text-layer
    // document. Amendment #1: route by document class, not char count.
    // A single-page zero-item extract classifies IMAGE_ONLY.
    const pageCount = input.pageCount ?? layout?.pageCount ?? 1;
    for (let p = 1; p <= pageCount; p++) {
      perPage.push({
        page: p,
        pageClass: "IMAGE_ONLY",
        itemsProduced: 0,
        routedTo: "TEXTRACT_PENDING",
      });
    }
    ocrPending = true;
  }

  // Flattened-text fallback (last resort). Runs only when the
  // positional path produced zero items AND we have flattened text.
  // Rows tagged FLATTENED_TEXT_FALLBACK. This preserves Path B's
  // usefulness on documents where layout is unavailable but there's
  // enough flat text to recover items (deferred to §5 acceptance:
  // OCR is preferred for IMAGE_ONLY pages, but if OCR is not yet
  // wired for a given deployment, flat text is better than nothing).
  const flat = (input.flattenedText ?? layout?.flattenedText ?? "").trim();
  if (items.length === 0 && flat.length > 0) {
    const flatItems = flattenedFallbackExtract(flat);
    for (const fli of flatItems) {
      const { role } = classifyLineItemRole(fli.description, fli.amount);
      const li: CanonicalLineItem = {
        description: fli.description.slice(0, 200),
        sku: null,
        quantity: fli.quantity,
        unit: null,
        unitPrice: fli.unitPrice,
        extension: fli.amount,
        taxTreatment: fli.taxRate != null
          ? { rate: fli.taxRate, taxable: fli.taxTreatment === "taxable" }
          : { taxable: fli.taxTreatment === "taxable" },
        role,
        page: 1,
        sourceStrategy: "FLATTENED_TEXT_FALLBACK",
        validationConfidence: Math.max(40, Math.min(70, Math.round(fli.confidence * 0.75))),
        arithmetic: "UNVALIDATED",
        evidence: [{ kind: "flattened_text_row" }],
      };
      const arith = validateRowArithmetic(li);
      li.arithmetic = arith.arithmetic;
      if (arith.cite) li.evidence.push(arith.cite);
      strategiesUsed.add("FLATTENED_TEXT_FALLBACK");
      items.push(li);
    }
    // Mark all pages as flattened-fallback in the per-page report.
    for (const p of perPage) {
      if (p.itemsProduced === 0 && p.routedTo !== "TEXTRACT_PENDING") {
        p.routedTo = "FLATTENED_FALLBACK";
      }
    }
    // Once flattened fallback ran we clear OCR-pending unless there
    // truly are zero items produced (in which case the caller should
    // still know an OCR path is pending).
    if (items.length > 0) ocrPending = false;
  }

  // Cross-strategy dedupe: when a positioned classic-table row and a
  // category-block row cover the same (page, extension, similar
  // description), keep the higher-confidence one. Guards against
  // OXIO-shape documents where a summary panel might overlap with a
  // detail block.
  const deduped = dedupeCrossStrategy(items);

  const diagnostic = `strategies=[${[...strategiesUsed].join(",")}] regions=${regions.length} items=${deduped.length} pages=${perPage.map((p) => `${p.page}:${p.pageClass}→${p.routedTo}(${p.itemsProduced})`).join(", ")}${ocrPending ? " OCR_PENDING" : ""}`;

  return {
    lineItems: deduped,
    regions,
    strategiesUsed: [...strategiesUsed],
    diagnostic,
    pages: perPage,
    ocrPending,
  };
}

// -----------------------------------------------------------------------------
// Dedupe helper
// -----------------------------------------------------------------------------

function dedupeCrossStrategy(items: CanonicalLineItem[]): CanonicalLineItem[] {
  if (items.length < 2) return items;
  const kept: CanonicalLineItem[] = [];
  const round2 = (n: number) => Math.round(n * 100) / 100;
  for (const li of items) {
    const dup = kept.find((k) =>
      k.page === li.page
      && Math.abs(round2(k.extension) - round2(li.extension)) < 0.01
      && descriptionSimilarity(k.description, li.description) >= 0.7,
    );
    if (!dup) { kept.push(li); continue; }
    // Keep the higher validation confidence; on tie prefer
    // CLASSIC_COLUMN_TABLE (richer evidence) over CATEGORY_BLOCK.
    const preferNew =
      li.validationConfidence > dup.validationConfidence
      || (li.validationConfidence === dup.validationConfidence
          && li.sourceStrategy === "POSITIONED_CLASSIC_TABLE"
          && dup.sourceStrategy !== "POSITIONED_CLASSIC_TABLE");
    if (preferNew) {
      const idx = kept.indexOf(dup);
      kept[idx] = li;
    }
  }
  return kept;
}

function descriptionSimilarity(a: string, b: string): number {
  const na = a.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  const nb = b.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(Boolean);
  if (na.length === 0 || nb.length === 0) return 0;
  const setA = new Set(na);
  let hits = 0;
  for (const w of nb) if (setA.has(w)) hits++;
  return hits / Math.max(na.length, nb.length);
}

// Re-export for consumers that only need reconciliation.
export { reconcileCanonicalLineItems };
