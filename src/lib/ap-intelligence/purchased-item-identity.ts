// Sprint 3 · Phase 4 Slice 5.3 (2026-08-08) — evidence-backed
// purchased-item identity.
//
// Founder amendment #3:
//   Do NOT promote arbitrary uppercase/model-looking tokens into
//   authoritative manufacturer/model fields. Evidence hierarchy:
//     explicit labelled Serial/Model value
//   > structured product-code/SKU column
//   > provider-declared item fields
//   > strongly-supported description-derived manufacturer/model candidate
//
//   Keep SKU/product code separate from model. Generic tokens
//   (EA, GST, TOTAL, headers, units) must not become models.
//
// Founder amendment #4:
//   Bare MODEL# / SERIAL# column headings contribute zero. Values
//   count only when structurally associated with a specific
//   purchased item.

import type { CanonicalLineItem } from "./evidence/canonical-line-item";
import { isItemizedSummaryDescription } from "./line-item-region-strategies";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type PurchasedItemEvidenceKind =
  | "line_item_description"
  | "sku_column"
  | "explicit_labelled_serial"
  | "explicit_labelled_model"
  | "extension_present"
  | "quantity_present"
  | "unit_price_present"
  | "manufacturer_from_description"
  | "model_from_description"
  | "attached_serial_line"
  | "attached_model_line";

export interface PurchasedItemEvidence {
  kind: PurchasedItemEvidenceKind;
  detail: string;
}

export type PurchasedItemEvidenceQuality = "HIGH" | "MEDIUM" | "LOW";

export interface PurchasedItemIdentity {
  /** Free-text description as extracted (never invented). */
  description: string;
  /** Manufacturer NAME when strongly supported. Null when
   *  description alone is insufficient. */
  manufacturer: string | null;
  /** Model identifier when explicitly labelled or strongly
   *  supported. Null otherwise. Separate from SKU. */
  model: string | null;
  /** Structured product code / stock-keeping unit (numeric or
   *  alphanumeric code from the SKU column). Separate from model. */
  sku: string | null;
  /** Serial number when explicitly labelled AND structurally
   *  associated with THIS item. Null when only a bare column
   *  heading was seen. */
  serialNumber: string | null;

  quantity: number | null;
  unitPrice: number | null;
  extension: number | null;

  /** Per-item evidence quality — separate from taxonomy confidence
   *  (per §20). LOW when only a summary-shape description exists;
   *  HIGH when substantive description + at least one structured
   *  field present. */
  evidenceQuality: PurchasedItemEvidenceQuality;

  /** Evidence citations for downstream diagnostics. */
  provenance: PurchasedItemEvidence[];

  /** Original CanonicalLineItem index (for provenance to canonical
   *  evidence). */
  sourceLineItemIndex: number;
}

// -----------------------------------------------------------------------------
// Rejection vocabularies — deliberately conservative
// -----------------------------------------------------------------------------

/** Generic tokens that must NOT be promoted to model / manufacturer
 *  even if uppercase or model-shaped. */
const NON_MODEL_TOKENS = new Set([
  "EA", "PCS", "PC", "KG", "LB", "LBS", "OZ", "GAL", "GAL.", "L", "ML", "M", "CM", "MM", "FT", "IN",
  "HR", "HRS", "HOUR", "HOURS", "MIN", "DAY", "DAYS", "MONTH", "MONTHS", "YR", "YEAR", "YEARS",
  "GST", "HST", "PST", "QST", "VAT", "TVQ", "TPS",
  "TOTAL", "SUBTOTAL", "SUB", "TAX", "AMOUNT", "AMT", "PRICE", "COST", "NET", "GROSS",
  "LINE", "LINES", "ITEM", "ITEMS", "PRODUCT", "PRODUCTS", "PART", "PARTS", "EACH",
  "INC", "INC.", "LTD", "LTD.", "CO", "CO.", "CORP", "CORP.", "LLC", "LLP", "LP", "ULC", "PLC",
  "USD", "CAD", "EUR", "GBP",
  "QTY", "SKU", "REF", "REFERENCE", "MODEL", "SERIAL", "MFG", "MFR",
  "NEW", "USED", "REBUILT", "OEM",
  "PREMIUM", "STANDARD", "BASIC", "DELUXE",  // adjectives, not manufacturers
]);

/** A model candidate must satisfy: length ≥ 3, contains at least
 *  one digit OR at least one hyphen/underscore, not in the reject
 *  list, not a pure number. */
function isPlausibleModelToken(tok: string): boolean {
  const t = tok.trim().replace(/[.,;:]$/, "");
  if (t.length < 3) return false;
  if (NON_MODEL_TOKENS.has(t.toUpperCase())) return false;
  if (/^\d+(?:\.\d+)?$/.test(t)) return false;      // pure number
  if (!/[\d\-_]/.test(t)) return false;              // no digit / hyphen / underscore
  return /^[A-Z0-9][A-Z0-9\-_/.]{2,15}$/i.test(t);
}

/** Explicitly-labelled serial value pattern: "Serial #: 12345" or
 *  "Serial No 123". Requires the LABEL to be present. Returns the
 *  value or null. */
function extractLabelledSerial(text: string): string | null {
  const m = text.match(/\bSerial\s*(?:#|no\.?|number)?\s*[:\.]?\s*([A-Z0-9][A-Z0-9\-_]{3,})/i);
  return m ? m[1] : null;
}

function extractLabelledModel(text: string): string | null {
  const m = text.match(/\bModel\s*(?:#|no\.?|number)?\s*[:\.]?\s*([A-Z0-9][A-Z0-9\-_]{2,})/i);
  return m ? m[1] : null;
}

// -----------------------------------------------------------------------------
// Extraction
// -----------------------------------------------------------------------------

/** Build `PurchasedItemIdentity[]` from the canonical line items.
 *  Only PRIMARY_PURCHASE and SURCHARGE rows contribute (§9 amendment
 *  scoping — TAX/SUMMARY_ROW_REJECTED/CREDIT/etc. never); the caller
 *  decides how to segment auxiliary rows.
 *
 *  Each canonical line item becomes one PurchasedItemIdentity. When
 *  a following line item's description is only a serial-value (e.g.
 *  "Serial #: 418124536"), it attaches to the preceding item and
 *  is REMOVED from the output list (per §4 attachment rule). */
export function extractPurchasedItems(canonicalLineItems: CanonicalLineItem[]): PurchasedItemIdentity[] {
  const out: PurchasedItemIdentity[] = [];
  for (let i = 0; i < canonicalLineItems.length; i++) {
    const li = canonicalLineItems[i];
    if (li.role !== "PRIMARY_PURCHASE" && li.role !== "SURCHARGE") continue;

    // Attempt attachment: is THIS row a bare serial/model value line
    // that should attach to the PREVIOUS purchased item instead of
    // starting a new one?
    const serialAttach = extractLabelledSerial(li.description);
    const modelAttach = extractLabelledModel(li.description);
    if ((serialAttach || modelAttach) && li.description.length <= 60 && out.length > 0) {
      const prev = out[out.length - 1];
      if (serialAttach && !prev.serialNumber) {
        prev.serialNumber = serialAttach;
        prev.provenance.push({ kind: "attached_serial_line", detail: `Serial ${serialAttach}` });
      }
      if (modelAttach && !prev.model) {
        prev.model = modelAttach;
        prev.provenance.push({ kind: "attached_model_line", detail: `Model ${modelAttach}` });
      }
      continue;
    }

    // Description-based provenance (never invent — only cite).
    const provenance: PurchasedItemEvidence[] = [
      { kind: "line_item_description", detail: li.description.slice(0, 80) },
    ];
    if (li.extension != null) provenance.push({ kind: "extension_present", detail: String(li.extension) });
    if (li.quantity != null) provenance.push({ kind: "quantity_present", detail: String(li.quantity) });
    if (li.unitPrice != null) provenance.push({ kind: "unit_price_present", detail: String(li.unitPrice) });
    if (li.sku) provenance.push({ kind: "sku_column", detail: li.sku });

    // Structured SKU column — kept SEPARATE from model.
    const sku = li.sku ?? null;

    // Explicit labelled serial / model (in this row's own description).
    const inlineSerial = extractLabelledSerial(li.description);
    const inlineModel = extractLabelledModel(li.description);
    if (inlineSerial) provenance.push({ kind: "explicit_labelled_serial", detail: `Serial ${inlineSerial}` });
    if (inlineModel) provenance.push({ kind: "explicit_labelled_model", detail: `Model ${inlineModel}` });

    // Description-derived model candidate — ONLY when strongly
    // supported: uppercase-ish token with digit/hyphen AND not in
    // reject vocabulary AND not the FIRST word (first word is
    // usually a line# or quantity, e.g. "1 30807 TORO ...").
    let descriptionModel: string | null = null;
    const tokens = li.description.split(/\s+/).filter(Boolean);
    // Skip leading numeric line-number and SKU-code tokens.
    let scanFrom = 0;
    if (tokens[0] && /^\d+$/.test(tokens[0])) scanFrom = 1;                      // line #
    if (tokens[scanFrom] && /^\d{3,}$/.test(tokens[scanFrom])) scanFrom++;       // SKU code
    for (let t = scanFrom; t < tokens.length; t++) {
      const tok = tokens[t].replace(/[.,;:]$/, "");
      if (isPlausibleModelToken(tok)) {
        descriptionModel = tok;
        provenance.push({ kind: "model_from_description", detail: tok });
        break;
      }
    }

    // Description-derived manufacturer candidate: the token BEFORE
    // the model token if it's uppercase-ish, not a reject, and not
    // a leading numeric.
    let descriptionManufacturer: string | null = null;
    if (descriptionModel != null) {
      const modelIdx = tokens.findIndex((t) => t.replace(/[.,;:]$/, "") === descriptionModel);
      if (modelIdx > scanFrom) {
        const cand = tokens[modelIdx - 1].replace(/[.,;:]$/, "");
        if (
          cand.length >= 3
          && !NON_MODEL_TOKENS.has(cand.toUpperCase())
          && /^[A-Z][A-Z0-9]{2,}$/.test(cand)   // ALL CAPS 3+ char (typical brand)
          && !/\d/.test(cand)                    // manufacturers usually alphabetical
        ) {
          descriptionManufacturer = cand;
          provenance.push({ kind: "manufacturer_from_description", detail: cand });
        }
      }
    }

    // Composite outputs — prefer explicit labels over description.
    const serialNumber = inlineSerial ?? null;
    const model = inlineModel ?? descriptionModel;

    // Evidence quality — mirrors purpose-evidence-quality's rules
    // for the per-item lens.
    const isSummary = isItemizedSummaryDescription(li.description);
    const substantiveDescLen = li.description.trim().length;
    let evidenceQuality: PurchasedItemEvidenceQuality;
    if (isSummary) evidenceQuality = "LOW";
    else if (substantiveDescLen < 6 && !sku && !model && !serialNumber) evidenceQuality = "LOW";
    else if ((model || sku) && li.extension != null && substantiveDescLen >= 6) evidenceQuality = "HIGH";
    else if (li.extension != null && substantiveDescLen >= 6) evidenceQuality = "MEDIUM";
    else evidenceQuality = "LOW";

    out.push({
      description: li.description,
      manufacturer: descriptionManufacturer,
      model,
      sku,
      serialNumber,
      quantity: li.quantity ?? null,
      unitPrice: li.unitPrice ?? null,
      extension: li.extension ?? null,
      evidenceQuality,
      provenance,
      sourceLineItemIndex: i,
    });
  }
  return out;
}
