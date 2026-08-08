// Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — normalize Textract
// canonical line items into the Slice-5 CanonicalLineItem authority.
//
// Founder §12 rule: no new parallel line-item extractor. Provider-
// specific structure terminates at this normalization boundary. All
// downstream consumers see the Slice-5 CanonicalLineItem shape.
//
// Textract emits `CanonicalDocumentExtraction.lineItems` which uses
// its own CanonicalLineItem shape (from
// document-extractors/canonical-model.ts). This module converts
// each into the Slice-5 CanonicalLineItem shape (from
// evidence/canonical-line-item.ts) preserving provider confidence,
// region, and evidence provenance.

import type { CanonicalDocumentExtraction, CanonicalLineItem as TextractLineItem } from "../document-extractors/canonical-model";
import type { CanonicalLineItem, CanonicalLineItemStrategy } from "../evidence/canonical-line-item";
import { classifyLineItemRole, validateRowArithmetic } from "../evidence/canonical-line-item";

export interface TextractLineItemNormalizationOptions {
  /** Page number of the source page relative to the SOURCE document
   *  (not the single-page extracted PDF). Passed by the caller so
   *  fusion by (page, extension, description) can match against
   *  native items. Defaults to `1` — the extracted single-page PDF's
   *  only page. */
  sourcePageNumber?: number;
}

export function normalizeTextractLineItemsToSlice5(
  extraction: CanonicalDocumentExtraction,
  opts: TextractLineItemNormalizationOptions = {},
): CanonicalLineItem[] {
  const sourcePage = opts.sourcePageNumber ?? 1;
  const out: CanonicalLineItem[] = [];
  for (const li of extraction.lineItems) {
    const description = li.description.value?.trim() ?? "";
    const extension = Number(li.amount.value ?? 0);
    if (!description && !isFinite(extension)) continue;
    if (!isFinite(extension) || extension === 0) continue;

    const providerConf = Math.max(
      li.description.providerConfidence ?? 0,
      li.amount.providerConfidence ?? 0,
    );
    // Slice-5 role classifier; Textract "category" field is a
    // corroborative hint but never overrides the description-based
    // classifier.
    const roleOut = classifyLineItemRole(description, extension);
    const sourceStrategy: CanonicalLineItemStrategy = "TEXTRACT_LINE_ITEM";
    const region = li.description.region ?? li.amount.region;
    const item: CanonicalLineItem = {
      description: description.slice(0, 200) || `Item ${li.productCode?.value ?? ""}`.trim(),
      sku: li.productCode?.value ?? null,
      quantity: li.quantity != null ? Number(li.quantity.value) : null,
      unit: null,
      unitPrice: li.unitPrice != null ? Number(li.unitPrice.value) : null,
      extension,
      role: roleOut.role,
      page: sourcePage,
      region: region
        ? { page: sourcePage, x: region.x, y: region.y, width: region.width, height: region.height }
        : { page: sourcePage, x: 0, y: 0 },
      sourceStrategy,
      providerConfidence: providerConf,
      // Slice-5 validation confidence bounded by provider confidence
      // and Textract's own accuracy on expense line items.
      validationConfidence: Math.min(85, Math.max(45, Math.round(providerConf * 0.85))),
      arithmetic: "UNVALIDATED",
      evidence: [
        { kind: "textract_expense_line", detail: `provConf=${Math.round(providerConf)}` },
        ...(roleOut.cite ? [roleOut.cite] : []),
      ],
    };
    // Arithmetic validation is corroboration, NOT an admission gate
    // (amendment #3). We record the outcome; the fusion layer uses
    // ARITHMETIC_OK as a confidence boost, not a filter.
    const arith = validateRowArithmetic(item);
    item.arithmetic = arith.arithmetic;
    if (arith.cite) item.evidence.push(arith.cite);

    out.push(item);
  }
  return out;
}
