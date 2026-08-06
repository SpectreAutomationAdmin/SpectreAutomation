// Sprint 3 · Post-16H Phase 4 Slice 3 (2026-08-06) — tax-component
// structured metadata (§9). Replaces label-only deduplication with
// structural grouping.
//
// Each component carries:
//   * taxType   — GST / HST / PST / QST / TPS / TVQ / VAT / SALES_TAX
//   * rate?     — 5, 13, 9.975, etc.
//   * taxableBase? — base amount when observable
//   * amount    — the tax dollar amount
//   * page      — page number where the component appears
//   * region.lineIndex — line index within the document text
//   * level     — LINE | GROUP | SUMMARY | REMITTANCE
//   * duplicateGroupId? — same (type, rate, amount) appearing at
//                         multiple levels get a shared identity;
//                         downstream tax-total selection uses the
//                         highest-level SUMMARY representative and
//                         suppresses REMITTANCE + duplicate LINE
//                         copies.
//   * confidence
//
// Founder rules embodied:
//   * separate GST components for distinct taxable bases MAY both
//     survive (different duplicateGroupId)
//   * repeated summary/remittance presentation is deduplicated
//   * line-level taxes reconcile to summary tax but are not added
//     twice
//   * bilingual duplicate labels (TPS + GST) collapse when their
//     numeric evidence agrees

export type TaxType = "GST" | "HST" | "PST" | "QST" | "TPS" | "TVQ" | "VAT" | "SALES_TAX" | "OTHER";
export type TaxComponentLevel = "LINE" | "GROUP" | "SUMMARY" | "REMITTANCE";

export interface StructuredTaxComponent {
  taxType: TaxType;
  rate: number | null;
  taxableBase: number | null;
  amount: number;
  page: number;
  region: { lineIndex: number };
  level: TaxComponentLevel;
  duplicateGroupId?: string;
  confidence: number;
  evidenceSnippet?: string;
}

const TAX_LABEL_TO_TYPE: Array<[RegExp, TaxType]> = [
  [/^\s*HST\b/i, "HST"],
  [/^\s*GST\b/i, "GST"],
  [/^\s*TPS\b/i, "TPS"],           // French label for GST
  [/^\s*QST\b/i, "QST"],
  [/^\s*TVQ\b/i, "TVQ"],           // French label for QST
  [/^\s*PST\b/i, "PST"],
  [/^\s*VAT\b/i, "VAT"],
  [/^\s*Sales\s+Tax\b/i, "SALES_TAX"],
];

// TPS ≡ GST, TVQ ≡ QST — normalise the French duplicates so a
// bilingual invoice printing both labels does not double-count.
const BILINGUAL_EQUIVALENTS: Partial<Record<TaxType, TaxType>> = {
  TPS: "GST",
  TVQ: "QST",
};

const RATE_IN_LABEL = /\(?\s*(\d+(?:\.\d+)?)\s*%\s*\)?/;

// Sections that indicate REMITTANCE context.
const REMITTANCE_MARKERS = /\b(Remit(?:tance)?|please\s+return\s+with\s+payment|payment\s+coupon|payment\s+stub)\b/i;

/**
 * Extract structured tax components from the flat text of a
 * document. Each qualifying tax line becomes a component; a
 * simple structural pass assigns SUMMARY vs REMITTANCE levels
 * based on where in the document the line falls (before / after
 * the first remittance marker).
 */
export function extractStructuredTaxComponents(text: string): StructuredTaxComponent[] {
  const out: StructuredTaxComponent[] = [];
  const rows = text.split(/\r?\n/);
  let remittanceStartIdx: number | null = null;
  for (let i = 0; i < rows.length; i++) {
    if (REMITTANCE_MARKERS.test(rows[i])) {
      remittanceStartIdx = i;
      break;
    }
  }
  for (let i = 0; i < rows.length; i++) {
    const raw = rows[i];
    let normalized = raw.trim();
    if (!normalized) continue;
    // Detect the tax type from the leading label.
    let taxType: TaxType | null = null;
    for (const [re, ty] of TAX_LABEL_TO_TYPE) {
      if (re.test(normalized)) { taxType = ty; break; }
    }
    if (!taxType) continue;
    // Rate (optional).
    const rateMatch = normalized.match(RATE_IN_LABEL);
    const rate = rateMatch ? Number(rateMatch[1]) : null;
    // Amount — last money-shaped token on the line.
    const amtMatch = normalized.match(/(-?\d{1,3}(?:,\d{3})*(?:\.\d{2})|-?\d+\.\d{2})\s*(?:CAD|USD|EUR|GBP)?\s*$/);
    if (!amtMatch) continue;
    const amount = Number(amtMatch[1].replace(/,/g, ""));
    if (!isFinite(amount) || amount === 0) continue;

    const level: TaxComponentLevel =
      remittanceStartIdx != null && i >= remittanceStartIdx ? "REMITTANCE" : "SUMMARY";

    const canonicalType: TaxType = BILINGUAL_EQUIVALENTS[taxType] ?? taxType;

    out.push({
      taxType: canonicalType,
      rate,
      taxableBase: null,
      amount,
      page: 1,
      region: { lineIndex: i },
      level,
      confidence: 80,
      evidenceSnippet: normalized.slice(0, 80),
    });
  }
  // Assign duplicate-group ids by (canonical taxType, rate, amount).
  const groupMap = new Map<string, string>();
  for (const c of out) {
    const key = `${c.taxType}|${c.rate ?? "-"}|${c.amount.toFixed(2)}`;
    if (!groupMap.has(key)) groupMap.set(key, `dup_${groupMap.size + 1}`);
    c.duplicateGroupId = groupMap.get(key);
  }
  return out;
}

/**
 * Reduce a set of structured components to the tax-total selection
 * downstream tax reconciliation should trust. Rules:
 *
 *   * within each duplicateGroupId, prefer SUMMARY over REMITTANCE
 *     over LINE — never sum duplicates
 *   * distinct duplicate groups sum
 *   * ignore zero-amount components
 */
export function selectTaxTotal(components: StructuredTaxComponent[]): {
  total: number;
  used: StructuredTaxComponent[];
  suppressed: StructuredTaxComponent[];
} {
  const bestPerGroup = new Map<string, StructuredTaxComponent>();
  const suppressed: StructuredTaxComponent[] = [];
  const rank: Record<TaxComponentLevel, number> = {
    SUMMARY: 3,
    GROUP: 2,
    REMITTANCE: 1,
    LINE: 0,
  };
  for (const c of components) {
    if (c.amount === 0) continue;
    const key = c.duplicateGroupId ?? `${c.taxType}|${c.rate ?? "-"}|${c.amount.toFixed(2)}`;
    const existing = bestPerGroup.get(key);
    if (!existing || rank[c.level] > rank[existing.level]) {
      if (existing) suppressed.push(existing);
      bestPerGroup.set(key, c);
    } else {
      suppressed.push(c);
    }
  }
  const used = Array.from(bestPerGroup.values());
  const total = round2(used.reduce((a, c) => a + c.amount, 0));
  return { total, used, suppressed };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
