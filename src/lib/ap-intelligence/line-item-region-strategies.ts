// Sprint 3 · Phase 4 Slice 5 (2026-08-07) — composable line-item
// reconstruction strategies operating on document regions.
//
// Founder amendment #3: reconstruct by region, not by one global
// document mode. CLASSIC_COLUMN_TABLE and CATEGORY_BLOCK_STATEMENT
// are composable structural-region strategies. A document may
// contain both. Neither is a fallback to the other.
//
// Each strategy exposes:
//   detectRegions(layout) → RegionCandidate[]
//   reconstruct(region, layout) → CanonicalLineItem[]
//
// The line-item extractor calls detectRegions on every strategy,
// merges regions, resolves overlaps (larger region wins; same-size
// prefers CLASSIC), and then reconstructs each region with its
// strategy.

import type { PdfLayout, LayoutVisualLine, LayoutTextItem } from "./pdf-layout-extract";
import type {
  CanonicalLineItem,
  CanonicalLineItemEvidenceCite,
  CanonicalLineItemRole,
} from "./evidence/canonical-line-item";
import { classifyLineItemRole, validateRowArithmetic } from "./evidence/canonical-line-item";

// -----------------------------------------------------------------------------
// Region model
// -----------------------------------------------------------------------------

export type LineItemRegionKind = "CLASSIC_COLUMN_TABLE" | "CATEGORY_BLOCK_STATEMENT";

export interface LineItemRegion {
  kind: LineItemRegionKind;
  page: number;
  /** Top y of the region (top-left convention). */
  yTop: number;
  /** Bottom y of the region (top-left convention). Downward. */
  yBottom: number;
  /** Confidence in the region detection (0..100). */
  confidence: number;
  /** Diagnostic string for logs / traces. */
  diagnostic: string;
  /** Strategy-private payload. */
  payload: unknown;
}

// -----------------------------------------------------------------------------
// Shared regex catalogues — GENERAL only.
// -----------------------------------------------------------------------------

/** Summary / footer labels — every strategy stops at these. */
const SUMMARY_ROW_LEADING =
  /^(?:sub\s*[-]?\s*total|total|balance(?:\s*due)?|amount\s*due|invoice\s*total|payment|discount|credit(?:s)?|gst|hst|pst|qst|vat|tax(?:es)?(?:\/fees)?|shipping|freight|surcharge|convenience\s*fee|charges?|thank\s*you|please\s*remit|amount\s*enclosed|previous\s*balance|new\s*charges|adjustment|ongoing\s*charges|pending\s*payments|total\s*due|due)\b/i;

/** Category-block labels (Ongoing charges / Taxes and Fees / Credits /
 *  Pending payments / etc.) — used by CATEGORY_BLOCK strategy to
 *  identify anchor rows. GENERIC statement-style labels only. */
const CATEGORY_LABELS: Array<{ pattern: RegExp; role: CanonicalLineItemRole }> = [
  { pattern: /^(ongoing\s+charges?|recurring\s+charges?|monthly\s+charges?|service\s+charges?|charges?\b)/i, role: "PRIMARY_PURCHASE" },
  { pattern: /^(taxes?\s*(?:and|&|\/)?\s*fees?|sales\s*tax|tax)\s*$/i, role: "TAX" },
  { pattern: /^(credits?|adjustments?)\s*$/i, role: "CREDIT" },
  { pattern: /^(discounts?|promotions?)\s*$/i, role: "DISCOUNT" },
  { pattern: /^(surcharges?|environmental\s*fees?|delivery\s*charges?)\s*$/i, role: "SURCHARGE" },
  { pattern: /^(interest|finance\s*charges?)\s*$/i, role: "INTEREST" },
  { pattern: /^(penalties?|late\s*fees?)\s*$/i, role: "PENALTY" },
  { pattern: /^(freight|shipping|delivery)\s*$/i, role: "FREIGHT" },
];

/** Classic table column-header lexicon. */
const HEADER_TOKENS: Array<{ role: "sku" | "description" | "quantity" | "unitPrice" | "amount"; patterns: RegExp[] }> = [
  { role: "sku",         patterns: [/\b(?:sku|item(?:\s*(?:#|no\.?|number))|part(?:\s*(?:#|no\.?|number))|product(?:\s*(?:#|no\.?|number))|code|ref)\b/i] },
  { role: "description", patterns: [/\b(?:description|item|product|service)\b/i] },
  { role: "quantity",    patterns: [/\b(?:qty|quantity|units?|shipped|hours?)\b/i] },
  { role: "unitPrice",   patterns: [/\b(?:unit\s*(?:price|cost)|price(?:\/unit)?|rate|per\s*unit)\b/i] },
  { role: "amount",      patterns: [/\b(?:amount|total|extended|extension|line\s*total|net)\b/i] },
];

const AMOUNT_TOKEN = /^\$?\s*-?\d{1,3}(?:,\d{3})*(?:\.\d{2})?$|^-?\d+\.\d{2}$/;
const CURRENCY_AMOUNT_INLINE = /(?:CA\$|US\$|\$)\s*(-?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)|(-?\d{1,3}(?:,\d{3})*\.\d{2})/;

const POLICY_HINTS =
  /(?:policy|return|terms|conditions|liability|not\s*paid|f\.?o\.?b\.|please\s*note|copy|original|do\s+not\s+pay|questions?\s+contact|contact\s+us|refer\s+a\s+friend|learn\s+more)/i;

const MAX_ROWS = 128;

// -----------------------------------------------------------------------------
// CLASSIC_COLUMN_TABLE strategy
// -----------------------------------------------------------------------------

interface ClassicPayload {
  headerLine: LayoutVisualLine;
  columns: Array<{ role: string; xCenter: number }>;
}

export function detectClassicColumnTableRegions(layout: PdfLayout): LineItemRegion[] {
  const regions: LineItemRegion[] = [];
  const headerCandidates = layout.visualLines
    .map((line) => scoreHeader(line))
    .filter((c) => c.matchedRoles.size >= 2);
  // On multi-page invoices, the same table header may repeat on every
  // page — the second and subsequent occurrences aren't independent
  // tables, they extend the first. Group by identical (page, header
  // signature). We accept the first occurrence per page as the region
  // seed; cross-page merging happens in the extractor.
  const seenSignatures = new Set<string>();
  for (const hc of headerCandidates) {
    const sig = `${hc.line.page}|${[...hc.matchedRoles].sort().join(",")}|${Math.round(hc.line.y / 10)}`;
    if (seenSignatures.has(sig)) continue;
    seenSignatures.add(sig);
    const columns = [...hc.columnsByRole.entries()]
      .map(([role, x]) => ({ role, xCenter: x }))
      .sort((a, b) => a.xCenter - b.xCenter);
    if (columns.length < 2) continue;
    // Region extends from the header row downward on this page until
    // the first row whose text begins with a SUMMARY_ROW_LEADING label
    // OR page end.
    const pageLines = layout.visualLines
      .filter((l) => l.page === hc.line.page && l.y > hc.line.y)
      .sort((a, b) => a.y - b.y);
    let regionBottomY = pageLines.length > 0
      ? pageLines[pageLines.length - 1].y + 5
      : hc.line.y + 400;
    for (const l of pageLines) {
      if (SUMMARY_ROW_LEADING.test(l.text.trim())) {
        regionBottomY = l.y - 1;
        break;
      }
    }
    regions.push({
      kind: "CLASSIC_COLUMN_TABLE",
      page: hc.line.page,
      yTop: hc.line.y,
      yBottom: regionBottomY,
      confidence: Math.min(100, 40 + hc.matchedRoles.size * 15),
      diagnostic: `header=${hc.line.text.slice(0, 60)} cols=[${columns.map((c) => c.role).join(",")}]`,
      payload: { headerLine: hc.line, columns } as ClassicPayload,
    });
  }
  return regions;
}

export function reconstructClassicColumnTable(
  region: LineItemRegion,
  layout: PdfLayout,
): CanonicalLineItem[] {
  const payload = region.payload as ClassicPayload;
  const { headerLine, columns } = payload;

  // Body lines: rows on the region's page, strictly BELOW the header
  // (top-left convention: greater y = further down), up to the
  // region's yBottom.
  const bodyLines = layout.visualLines
    .filter((l) => l.page === region.page && l.y > headerLine.y && l.y <= region.yBottom)
    .sort((a, b) => a.y - b.y);

  const items: CanonicalLineItem[] = [];
  for (const line of bodyLines) {
    if (items.length >= MAX_ROWS) break;
    const text = line.text.trim();
    if (text.length === 0) continue;
    if (SUMMARY_ROW_LEADING.test(text)) break;
    if (POLICY_HINTS.test(text) && !endsWithAmount(text)) continue;

    // If the line has a single item that spans multiple detected
    // column x-centres, this is a fused row from pdf.js. Prefer
    // glyph-level items (we already asked for disableCombineTextItems:
    // true); if a fused item still appears, apply proportional
    // character splitting AS LOWER-CONFIDENCE evidence (amendment #2).
    const workingItems = splitFusedItemsAcrossColumns(line.items, columns);

    // Snap items to columns by nearest x-centre.
    const cells = new Map<string, string[]>();
    for (const it of workingItems.items) {
      const col = nearestColumn(it, columns);
      if (col == null) continue;
      const arr = cells.get(col.role) ?? [];
      arr.push(it.text.trim());
      cells.set(col.role, arr);
    }
    if (cells.size === 0) continue;

    const skuRaw = (cells.get("sku") ?? []).join(" ").trim();
    const descRaw = (cells.get("description") ?? []).join(" ").trim();
    const qtyRaw = (cells.get("quantity") ?? []).join(" ").trim();
    const unitRaw = (cells.get("unitPrice") ?? []).join(" ").trim();
    const amtRaw = (cells.get("amount") ?? []).join(" ").trim();

    const hasAmount = AMOUNT_TOKEN.test(amtRaw);
    const hasSkuOrDesc = skuRaw.length > 0 || descRaw.length > 2;
    if (!hasAmount && !hasSkuOrDesc) continue;

    // Wrapped description merge: if this row has ONLY a description
    // (no amount, no sku, no qty) and is near the previous row, append
    // its text to the previous item.
    if (!hasAmount && descRaw.length > 0 && !skuRaw && !qtyRaw && items.length > 0) {
      const prev = items[items.length - 1];
      if (line.y - (prev.region?.y ?? 0) < 20 && prev.description.length < 200) {
        prev.description = `${prev.description} ${descRaw}`.trim().slice(0, 200);
        prev.evidence.push({ kind: "wrapped_description_merge", detail: descRaw.slice(0, 60) });
        continue;
      }
    }

    const quantity = parseNumber(qtyRaw);
    const unitPrice = parseAmount(unitRaw);
    const extension = parseAmount(amtRaw);

    let description = descRaw;
    if (!description || description.length < 3) {
      const nonAmountItems = workingItems.items
        .filter((it) => !AMOUNT_TOKEN.test(it.text.trim()) && !AMOUNT_TOKEN.test(it.text.replace("$", "").trim()))
        .map((it) => it.text.trim())
        .filter(Boolean);
      description = nonAmountItems.join(" ").trim().slice(0, 200);
    }
    if (!description && !skuRaw && extension == null) continue;

    if (extension == null) continue; // No amount → not a line item.

    const cites: CanonicalLineItemEvidenceCite[] = [
      { kind: "column_header", detail: `[${columns.map((c) => c.role).join(",")}]` },
      { kind: "column_alignment" },
    ];
    if (workingItems.usedProportionalSplit) {
      cites.push({ kind: "proportional_character_split", detail: "pdf.js emitted a fused row across ≥2 column centres" });
    }

    const { role, cite: roleCite } = classifyLineItemRole(description, extension);
    if (roleCite) cites.push(roleCite);

    const li: CanonicalLineItem = {
      description: description || (skuRaw ? `Item ${skuRaw}` : "line item"),
      sku: skuRaw || null,
      quantity,
      unit: null,
      unitPrice,
      extension,
      role,
      page: line.page,
      region: { page: line.page, x: 0, y: line.y, lineIndex: undefined },
      sourceStrategy: workingItems.usedProportionalSplit
        ? "POSITIONED_PROPORTIONAL_SPLIT"
        : "POSITIONED_CLASSIC_TABLE",
      validationConfidence: workingItems.usedProportionalSplit ? 55 : 78,
      arithmetic: "UNVALIDATED",
      evidence: cites,
    };
    const arith = validateRowArithmetic(li);
    li.arithmetic = arith.arithmetic;
    if (arith.cite) li.evidence.push(arith.cite);

    // Amendment #2 acceptance gate: proportional-split rows must have
    // arithmetic evidence to commit.
    if (li.sourceStrategy === "POSITIONED_PROPORTIONAL_SPLIT" && arith.arithmetic !== "ARITHMETIC_OK") {
      continue;
    }
    items.push(li);
  }
  return items;
}

// -----------------------------------------------------------------------------
// CATEGORY_BLOCK_STATEMENT strategy
// -----------------------------------------------------------------------------

interface CategoryPayload {
  anchorLine: LayoutVisualLine;
  categoryRole: CanonicalLineItemRole;
  categoryLabel: string;
}

export function detectCategoryBlockRegions(layout: PdfLayout): LineItemRegion[] {
  const regions: LineItemRegion[] = [];
  for (const line of layout.visualLines) {
    const text = line.text.trim();
    if (text.length === 0) continue;
    for (const { pattern, role } of CATEGORY_LABELS) {
      if (pattern.test(text)) {
        // The region extends from this line to the next category
        // label OR summary boundary OR end-of-page.
        const pageLines = layout.visualLines
          .filter((l) => l.page === line.page && l.y > line.y)
          .sort((a, b) => a.y - b.y);
        let yBottom = pageLines.length > 0
          ? pageLines[pageLines.length - 1].y + 5
          : line.y + 200;
        for (const l of pageLines) {
          const t = l.text.trim();
          if (CATEGORY_LABELS.some((c) => c.pattern.test(t))) { yBottom = l.y - 1; break; }
          if (/^(total\s*due|balance\s*due|invoice\s*total|amount\s*due)\b/i.test(t)) { yBottom = l.y - 1; break; }
        }
        regions.push({
          kind: "CATEGORY_BLOCK_STATEMENT",
          page: line.page,
          yTop: line.y,
          yBottom,
          confidence: 60,
          diagnostic: `category=${text.slice(0, 40)} role=${role}`,
          payload: { anchorLine: line, categoryRole: role, categoryLabel: text } as CategoryPayload,
        });
        break;
      }
    }
  }
  return regions;
}

export function reconstructCategoryBlock(
  region: LineItemRegion,
  layout: PdfLayout,
): CanonicalLineItem[] {
  const payload = region.payload as CategoryPayload;
  const { anchorLine, categoryRole } = payload;
  const detailLines = layout.visualLines
    .filter((l) => l.page === region.page && l.y > anchorLine.y && l.y <= region.yBottom)
    .sort((a, b) => a.y - b.y);

  const items: CanonicalLineItem[] = [];
  for (const line of detailLines) {
    if (items.length >= MAX_ROWS) break;
    const text = line.text.trim();
    if (!text) continue;
    if (POLICY_HINTS.test(text)) continue;
    // Look for an amount anywhere on the line.
    const amtMatch = text.match(CURRENCY_AMOUNT_INLINE);
    if (!amtMatch) continue;
    const amountRaw = amtMatch[1] ?? amtMatch[2];
    const amount = parseAmount(amountRaw);
    if (amount == null) continue;
    // Description = the text with the matched amount stripped.
    const description = text.replace(amtMatch[0], "").trim().replace(/\s+/g, " ").slice(0, 200);
    if (!description || description.length < 3) continue;
    // The category role from the anchor label; if the row itself looks
    // like a credit (negative or credit keyword), let role classifier
    // override.
    const roleOut = classifyLineItemRole(description, amount, { categoryHint: categoryRole });
    const li: CanonicalLineItem = {
      description,
      sku: null,
      quantity: null,
      unit: null,
      unitPrice: null,
      extension: categoryRole === "CREDIT" ? -Math.abs(amount) : amount,
      role: roleOut.role,
      page: line.page,
      region: { page: line.page, x: 0, y: line.y },
      sourceStrategy: "POSITIONED_CATEGORY_BLOCK",
      validationConfidence: 70,
      arithmetic: "ARITHMETIC_INSUFFICIENT_DATA",
      evidence: [
        { kind: "category_block_label", detail: `${payload.categoryLabel} → ${roleOut.role}` },
        ...(roleOut.cite ? [roleOut.cite] : []),
      ],
    };
    items.push(li);
  }
  return items;
}

// -----------------------------------------------------------------------------
// Region merge / overlap resolution
// -----------------------------------------------------------------------------

/** Given regions from multiple strategies, resolve overlaps.
 *  Rules:
 *   - Two regions overlap when same page AND their y-ranges intersect.
 *   - When they overlap, prefer the region with higher confidence.
 *   - Ties break to CLASSIC_COLUMN_TABLE (more informative). */
export function resolveRegions(regions: LineItemRegion[]): LineItemRegion[] {
  const sorted = [...regions].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    return a.yTop - b.yTop;
  });
  const kept: LineItemRegion[] = [];
  for (const r of sorted) {
    const overlap = kept.find((k) =>
      k.page === r.page &&
      Math.max(k.yTop, r.yTop) < Math.min(k.yBottom, r.yBottom),
    );
    if (!overlap) { kept.push(r); continue; }
    // Overlap — decide which wins.
    const preferR =
      r.confidence > overlap.confidence
      || (r.confidence === overlap.confidence && r.kind === "CLASSIC_COLUMN_TABLE" && overlap.kind !== "CLASSIC_COLUMN_TABLE");
    if (preferR) {
      const idx = kept.indexOf(overlap);
      kept[idx] = r;
    }
  }
  return kept;
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

interface HeaderScore {
  line: LayoutVisualLine;
  matchedRoles: Set<string>;
  columnsByRole: Map<string, number>;
}

function scoreHeader(line: LayoutVisualLine): HeaderScore {
  const roles = new Set<string>();
  const columnsByRole = new Map<string, number>();
  for (const item of line.items) {
    for (const { role, patterns } of HEADER_TOKENS) {
      if (patterns.some((p) => p.test(item.text))) {
        if (!columnsByRole.has(role)) {
          const xCenter = item.x + item.width / 2;
          columnsByRole.set(role, xCenter);
          roles.add(role);
        }
      }
    }
  }
  return { line, matchedRoles: roles, columnsByRole };
}

function nearestColumn(
  item: LayoutTextItem,
  columns: Array<{ role: string; xCenter: number }>,
): { role: string; xCenter: number } | null {
  const cx = item.x + item.width / 2;
  let best: { role: string; xCenter: number } | null = null;
  let bestDist = Infinity;
  for (const c of columns) {
    const d = Math.abs(cx - c.xCenter);
    if (d < bestDist) { bestDist = d; best = c; }
  }
  return best;
}

/** When pdf.js emits a fused row (a single positioned item whose x
 *  span crosses multiple column centres), apply proportional
 *  character splitting as a LOWER-CONFIDENCE recovery. Guarded
 *  behind: (a) exactly one item on the line, (b) item spans ≥2
 *  column centres, (c) item text length ≥ 6. */
function splitFusedItemsAcrossColumns(
  items: LayoutTextItem[],
  columns: Array<{ role: string; xCenter: number }>,
): { items: LayoutTextItem[]; usedProportionalSplit: boolean } {
  if (items.length !== 1 || items[0].text.length < 6 || items[0].width <= 0) {
    return { items, usedProportionalSplit: false };
  }
  const only = items[0];
  const spans = columns.filter((c) => c.xCenter >= only.x && c.xCenter <= only.x + only.width);
  if (spans.length < 2) return { items, usedProportionalSplit: false };
  // Split the text proportionally at column boundaries.
  const spanX0 = only.x;
  const spanW = only.width;
  const boundaries = spans
    .slice(1)
    .map((c, i) => ((spans[i].xCenter + c.xCenter) / 2 - spanX0) / spanW);
  const chunks: string[] = [];
  let cursor = 0;
  const text = only.text;
  for (const b of boundaries) {
    const cutIdx = Math.max(1, Math.min(text.length - 1, Math.round(text.length * b)));
    chunks.push(text.slice(cursor, cutIdx));
    cursor = cutIdx;
  }
  chunks.push(text.slice(cursor));
  const out: LayoutTextItem[] = spans.map((c, idx) => ({
    text: chunks[idx].trim(),
    page: only.page,
    x: only.x + (spanW / chunks.length) * idx,
    y: only.y,
    width: spanW / chunks.length,
    height: only.height,
    yBaselineRaw: only.yBaselineRaw,
    pageHeight: only.pageHeight,
  }));
  return { items: out, usedProportionalSplit: true };
}

function endsWithAmount(text: string): boolean {
  const last = text.split(/\s+/).pop() ?? "";
  return AMOUNT_TOKEN.test(last);
}

function parseNumber(raw: string): number | null {
  if (!raw) return null;
  const clean = raw.replace(/[^0-9.\-]/g, "");
  if (!clean) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}

function parseAmount(raw: string): number | null {
  if (!raw) return null;
  const clean = raw.replace(/[$,\s]/g, "");
  if (!AMOUNT_TOKEN.test(raw.trim()) && !/^-?\d+(?:\.\d{1,2})?$/.test(clean)) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}
