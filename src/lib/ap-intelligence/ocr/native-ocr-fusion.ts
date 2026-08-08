// Sprint 3 · Phase 4 Slice 5.1 (2026-08-08) — native + OCR
// canonical-line-item fusion.
//
// Founder amendment #3 + amendment #8:
//   - Match on page + geometry + amount + description similarity +
//     table role where available.
//   - Arithmetic reconciliation is STRONG corroboration but MUST NOT
//     be a universal admission requirement for unmatched OCR rows.
//   - Strong provider/table-role evidence may enter canonical
//     evidence at LOWER confidence even before complete reconciliation.
//   - OCR must not simply overwrite native extraction.
//   - Canonical reconciliation determines the selected value; all
//     supporting/conflicting evidence retained on `evidence[]`.
//
// The result: one deduplicated CanonicalLineItem[] with provenance
// for every merge decision.

import type {
  CanonicalLineItem,
  CanonicalLineItemEvidenceCite,
} from "../evidence/canonical-line-item";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface FusionMatch {
  nativeItem: CanonicalLineItem | null;
  ocrItem: CanonicalLineItem | null;
  merged: CanonicalLineItem;
  matchStrategy:
    | "MERGED_NATIVE_AND_OCR"
    | "NATIVE_ONLY"
    | "OCR_ONLY_ADMITTED"
    | "OCR_ONLY_REJECTED";
  matchReason: string;
}

export interface FusionResult {
  items: CanonicalLineItem[];
  matches: FusionMatch[];
  diagnostic: {
    nativeCount: number;
    ocrCount: number;
    mergedCount: number;
    nativeOnlyCount: number;
    ocrOnlyAdmittedCount: number;
    ocrOnlyRejectedCount: number;
  };
}

// -----------------------------------------------------------------------------
// Fusion
// -----------------------------------------------------------------------------

const AMOUNT_TOL = 0.02;

export function fuseNativeAndOcrLineItems(
  native: CanonicalLineItem[],
  ocr: CanonicalLineItem[],
): FusionResult {
  const matches: FusionMatch[] = [];
  const ocrUsed = new Set<number>();

  // 1. For each native item, look for a best-matching OCR row.
  for (const n of native) {
    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < ocr.length; i++) {
      if (ocrUsed.has(i)) continue;
      const o = ocr[i];
      const score = scoreMatch(n, o);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0 && bestScore >= MATCH_ACCEPT_THRESHOLD) {
      const o = ocr[bestIdx];
      ocrUsed.add(bestIdx);
      const merged = mergeMatched(n, o, bestScore);
      matches.push({
        nativeItem: n,
        ocrItem: o,
        merged,
        matchStrategy: "MERGED_NATIVE_AND_OCR",
        matchReason: `score=${bestScore.toFixed(2)} amt=${o.extension.toFixed(2)} pageMatch=${n.page === o.page}`,
      });
    } else {
      matches.push({
        nativeItem: n,
        ocrItem: null,
        merged: n,
        matchStrategy: "NATIVE_ONLY",
        matchReason: bestIdx >= 0 ? `best OCR score=${bestScore.toFixed(2)} below threshold` : "no OCR row available",
      });
    }
  }

  // 2. Unmatched OCR rows. Admit UNCONDITIONALLY when the OCR row
  //    has strong provider evidence (TEXTRACT_LINE_ITEM strategy AND
  //    provider confidence ≥ ADMIT_MIN_PROVIDER_CONF). Amendment #3:
  //    arithmetic corroboration boosts, does not gate.
  for (let i = 0; i < ocr.length; i++) {
    if (ocrUsed.has(i)) continue;
    const o = ocr[i];
    const strong =
      o.sourceStrategy === "TEXTRACT_LINE_ITEM"
      && (o.providerConfidence ?? 0) >= ADMIT_MIN_PROVIDER_CONF;
    if (strong) {
      const admitted: CanonicalLineItem = {
        ...o,
        // Lower confidence when arithmetic hasn't validated — but
        // still admitted per amendment #3.
        validationConfidence: o.arithmetic === "ARITHMETIC_OK"
          ? o.validationConfidence
          : Math.max(35, Math.round(o.validationConfidence * 0.75)),
        evidence: [
          ...o.evidence,
          { kind: "textract_expense_line", detail: "unmatched OCR row admitted on provider strength" },
        ],
      };
      matches.push({
        nativeItem: null,
        ocrItem: o,
        merged: admitted,
        matchStrategy: "OCR_ONLY_ADMITTED",
        matchReason: `provConf=${Math.round(o.providerConfidence ?? 0)} arithmetic=${o.arithmetic}`,
      });
    } else {
      matches.push({
        nativeItem: null,
        ocrItem: o,
        merged: o,
        matchStrategy: "OCR_ONLY_REJECTED",
        matchReason: `insufficient provider evidence (strategy=${o.sourceStrategy}, providerConfidence=${Math.round(o.providerConfidence ?? 0)})`,
      });
    }
  }

  const items = matches
    .filter((m) => m.matchStrategy !== "OCR_ONLY_REJECTED")
    .map((m) => m.merged);

  return {
    items,
    matches,
    diagnostic: {
      nativeCount: native.length,
      ocrCount: ocr.length,
      mergedCount: matches.filter((m) => m.matchStrategy === "MERGED_NATIVE_AND_OCR").length,
      nativeOnlyCount: matches.filter((m) => m.matchStrategy === "NATIVE_ONLY").length,
      ocrOnlyAdmittedCount: matches.filter((m) => m.matchStrategy === "OCR_ONLY_ADMITTED").length,
      ocrOnlyRejectedCount: matches.filter((m) => m.matchStrategy === "OCR_ONLY_REJECTED").length,
    },
  };
}

// -----------------------------------------------------------------------------
// Match scoring — amendment #3 axes: page + geometry + amount +
// description similarity + table role.
// -----------------------------------------------------------------------------

const MATCH_ACCEPT_THRESHOLD = 0.55;
const ADMIT_MIN_PROVIDER_CONF = 60;

function scoreMatch(n: CanonicalLineItem, o: CanonicalLineItem): number {
  let score = 0;
  // Amount agreement is the strongest single signal.
  const amtDelta = Math.abs(Math.abs(n.extension) - Math.abs(o.extension));
  if (amtDelta <= AMOUNT_TOL) score += 0.55;
  else if (amtDelta <= 0.10) score += 0.35;
  else if (amtDelta <= 1.00) score += 0.15;
  // Page agreement.
  if (n.page === o.page) score += 0.1;
  // Role agreement.
  if (n.role === o.role) score += 0.1;
  else if ((n.role === "PRIMARY_PURCHASE" && o.role === "PRIMARY_PURCHASE")) score += 0.1;
  // Description similarity (Jaccard on lowercase word sets).
  const sim = descriptionSimilarity(n.description, o.description);
  score += sim * 0.25;
  // Geometry (page + y-band roughly aligned) when both regions
  // present.
  if (n.region && o.region && n.region.page === o.region.page) {
    const dy = Math.abs((n.region.y ?? 0) - (o.region.y ?? 0));
    if (dy < 15) score += 0.08;
    else if (dy < 40) score += 0.04;
  }
  return score;
}

function mergeMatched(n: CanonicalLineItem, o: CanonicalLineItem, matchScore: number): CanonicalLineItem {
  // Amendment #8: preserve all supporting/conflicting evidence.
  // Native usually wins on layout; OCR usually wins on description.
  // Confidence = max of both + arithmetic bonus when either side
  // reconciled.
  const arithmeticOk = n.arithmetic === "ARITHMETIC_OK" || o.arithmetic === "ARITHMETIC_OK";
  const conflicts: CanonicalLineItemEvidenceCite[] = [];
  if (Math.abs(Math.abs(n.extension) - Math.abs(o.extension)) > AMOUNT_TOL) {
    conflicts.push({
      kind: "arithmetic_qty_times_unit_equals_extension",
      detail: `amount disagreement native=${n.extension} vs OCR=${o.extension}`,
    });
  }

  // Prefer OCR description when it's more specific (longer OR
  // contains alphabetic content native missed); otherwise keep native.
  const nativeDesc = (n.description ?? "").trim();
  const ocrDesc = (o.description ?? "").trim();
  const preferOcrDesc =
    (ocrDesc.length > nativeDesc.length + 5)
    || (nativeDesc.length < 6 && ocrDesc.length >= 6);

  return {
    description: preferOcrDesc ? ocrDesc : nativeDesc,
    sku: o.sku ?? n.sku ?? null,
    quantity: n.quantity ?? o.quantity ?? null,
    unit: n.unit ?? o.unit ?? null,
    unitPrice: n.unitPrice ?? o.unitPrice ?? null,
    extension: n.extension,
    taxTreatment: n.taxTreatment ?? o.taxTreatment,
    role: n.role,
    page: n.page,
    region: n.region ?? o.region,
    sourceStrategy: n.sourceStrategy,
    providerConfidence: Math.max(n.providerConfidence ?? 0, o.providerConfidence ?? 0),
    validationConfidence: Math.min(
      98,
      Math.max(n.validationConfidence, o.validationConfidence)
      + (arithmeticOk ? 6 : 0)
      + Math.round(matchScore * 4),
    ),
    arithmetic: arithmeticOk ? "ARITHMETIC_OK" : n.arithmetic,
    evidence: [
      ...n.evidence,
      { kind: "textract_expense_line", detail: `fused with OCR row (matchScore=${matchScore.toFixed(2)})` },
      ...o.evidence,
      ...conflicts,
    ],
    warnings: [
      ...(n.warnings ?? []),
      ...(conflicts.length > 0 ? ["Amount disagreement between native and OCR"] : []),
    ],
  };
}

function descriptionSimilarity(a: string, b: string): number {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter((w) => w.length >= 2);
  const na = new Set(norm(a));
  const nb = new Set(norm(b));
  if (na.size === 0 || nb.size === 0) return 0;
  let hits = 0;
  for (const w of nb) if (na.has(w)) hits++;
  return hits / Math.max(na.size, nb.size);
}
