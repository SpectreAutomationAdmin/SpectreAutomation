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
import { isItemizedSummaryDescription, isTotalsBlockRowRejected } from "../line-item-region-strategies";

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
    const providerAmount = Number(li.amount.value ?? 0);
    const rawQty = li.quantity != null ? Number(li.quantity.value) : null;
    const rawUnitPrice = li.unitPrice != null ? Number(li.unitPrice.value) : null;
    const productCode = li.productCode?.value ?? null;

    // Sprint 3 · Phase 4 Slice 5.8 (2026-08-09) — §1 first-cause
    // correction. Textract on image-only invoices commonly reports
    // description + qty + unitPrice with 100% confidence but returns
    // amount=0 when the totals column is offset. Previous behavior:
    // silently drop these rows. New behavior:
    //   (a) if qty × unitPrice is computable → adopt as extension
    //       with COMPUTED_FROM_QTY_TIMES_UNIT provenance;
    //   (b) if description substantive + no numeric fields → keep
    //       with extension=null so PurchasedItemIdentity can still
    //       form an identity (§8: PURCHASE_EVIDENCE_PRESENT_BUT_
    //       AMOUNT_UNRECOVERABLE ≠ extraction failure);
    //   (c) only skip rows that have NEITHER a substantive
    //       description NOR any numeric evidence.
    let extension: number | null;
    let extensionSource: "provider" | "computed" | "none";
    if (isFinite(providerAmount) && providerAmount !== 0) {
      extension = providerAmount;
      extensionSource = "provider";
    } else if (rawQty != null && isFinite(rawQty) && rawQty > 0
               && rawUnitPrice != null && isFinite(rawUnitPrice) && rawUnitPrice > 0) {
      extension = Math.round(rawQty * rawUnitPrice * 100) / 100;
      extensionSource = "computed";
    } else {
      extension = null;
      extensionSource = "none";
    }

    const hasSubstantiveDescription = description.length >= 3;
    const hasAnyNumericSignal = extension != null || rawQty != null || rawUnitPrice != null || (productCode != null && productCode.length > 0);
    if (!hasSubstantiveDescription && !hasAnyNumericSignal) continue;

    const providerConf = Math.max(
      li.description.providerConfidence ?? 0,
      li.amount.providerConfidence ?? 0,
      li.unitPrice?.providerConfidence ?? 0,
      li.quantity?.providerConfidence ?? 0,
    );
    // Sprint 3 · 221178 follow-on (Correction A) — apply the same
    // generalized summary-row rejection as the native/pdf.js path.
    // Textract on some invoices returns a SUBTOTAL / TAX / TOTAL row
    // as an "expense line" — those must not become PRIMARY_PURCHASE.
    const isItemizedSummary = isItemizedSummaryDescription(description);
    const totalsBlock = isTotalsBlockRowRejected({ description, quantity: rawQty, unitPrice: rawUnitPrice });
    // Role classification — needs a numeric extension to pick the
    // correct role. When extension is null (amount unrecoverable) we
    // default to PRIMARY_PURCHASE and rely on downstream classifiers
    // (item-completeness, capital-evidence) to disambiguate from the
    // description.
    const roleOut = (isItemizedSummary || totalsBlock.reject)
      ? { role: "SUMMARY_ROW_REJECTED" as const, cite: null }
      : extension != null
        ? classifyLineItemRole(description, extension)
        : { role: "PRIMARY_PURCHASE" as const, cite: null };
    const sourceStrategy: CanonicalLineItemStrategy = "TEXTRACT_LINE_ITEM";
    const region = li.description.region ?? li.amount.region;

    const evidence: CanonicalLineItem["evidence"] = [
      { kind: "textract_expense_line", detail: `provConf=${Math.round(providerConf)}` },
    ];
    if (extensionSource === "computed") {
      evidence.push({
        kind: "arithmetic_qty_times_unit_equals_extension",
        detail: `amount=0 from provider; computed extension=${extension} from qty=${rawQty} × unitPrice=${rawUnitPrice}`,
      });
    } else if (extensionSource === "none") {
      evidence.push({
        kind: "flattened_text_row",
        detail: "amount unrecoverable from provider AND qty/unitPrice absent — description-only row",
      });
    }
    if (roleOut.cite) evidence.push(roleOut.cite);

    const item: CanonicalLineItem = {
      description: description.slice(0, 200) || `Item ${productCode ?? ""}`.trim(),
      sku: productCode,
      quantity: rawQty,
      unit: null,
      unitPrice: rawUnitPrice,
      // extension is number | null per the completed CanonicalLineItem
      // typing; downstream authorities already tolerate null.
      extension: (extension ?? 0),
      role: roleOut.role,
      page: sourcePage,
      region: region
        ? { page: sourcePage, x: region.x, y: region.y, width: region.width, height: region.height }
        : { page: sourcePage, x: 0, y: 0 },
      sourceStrategy,
      providerConfidence: providerConf,
      validationConfidence: Math.min(85, Math.max(45, Math.round(providerConf * 0.85))),
      arithmetic: extensionSource === "computed" ? "ARITHMETIC_OK" : "UNVALIDATED",
      evidence,
    };
    // Arithmetic validation is corroboration, NOT an admission gate.
    // Skip re-validation when we already computed the extension
    // ourselves (would double-log).
    if (extensionSource !== "computed" && extension != null) {
      const arith = validateRowArithmetic(item);
      item.arithmetic = arith.arithmetic;
      if (arith.cite) item.evidence.push(arith.cite);
    }

    out.push(item);
  }
  return out;
}
