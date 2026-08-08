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

/** Summary / footer / policy labels — every strategy stops at these
 *  OR skips the row. Slice 5: extended with policy-footer prefixes
 *  that carry a currency-looking token nearby ("Invoice due upon
 *  receipt...", "Administration fee: 2.00% per month...", "on all
 *  overdue amounts..."). These are prose paragraphs, not line items,
 *  even when their tail happens to end with a decimal amount. */
const SUMMARY_ROW_LEADING =
  /^(?:sub\s*[-]?\s*total|total|balance(?:\s*due)?|amount\s*due|invoice\s*total|payment|discount|credit(?:s)?|gst|hst|pst|qst|vat|tax(?:es)?(?:\/fees)?|shipping|freight|surcharge|convenience\s*fee|charges?|thank\s*you|please\s*remit|please\s*write|amount\s*enclosed|previous\s*balance|new\s*charges|adjustment|ongoing\s*charges|pending\s*payments|total\s*due|due|invoice\s*due|administration\s*fee|on\s*all\s*overdue|account'?s?\s*terms|terms\s*and\s*conditions|all\s+merchandise|the\s+property\s+of|until\s*full\s*payment)\b/i;

/** Sprint 3 · Phase 4 Slice 5.3 (2026-08-08, amendment #1) —
 *  generalized ITEMIZED-TOTAL summary shapes. A row matching this
 *  pattern reports the SUM of underlying product rows and MUST NOT
 *  become a PRIMARY_PURCHASE. The parser retains the row as
 *  reconciliation/summary evidence and marks the description as a
 *  summary shape so the canonical extractor + evidence-quality gate
 *  can act on it downstream.
 *
 *  Covers: "2 Lines Total", "N Line Total", "Items Total",
 *  "Product Total", "Parts Total", "Net Total" — all with optional
 *  leading digit count. Case-insensitive. */
const ITEMIZED_SUMMARY_RE =
  /^\s*(?:\d+\s*)?(?:lines?|items?|products?|parts?|net)\s*total\s*$/i;

/** True when the row's description text is a summary/itemized-total
 *  shape rather than a real product row. */
export function isItemizedSummaryDescription(description: string): boolean {
  return ITEMIZED_SUMMARY_RE.test(description.trim());
}

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

// Sprint 3 · Phase 4 Slice 5.3 completion (2026-08-08, §1+§2+§3) —
// unit-of-measure vocabulary used to (a) filter measurement tags out
// of numeric-cell resolution and (b) associate a unit label with the
// shipped quantity. Closed list of standard measurement tokens; NOT
// supplier / product / SKU literals.
const UNIT_TAG_TOKEN = /^(?:EA|EACH|PC|PCS|HR|HRS|HOUR|HOURS|MIN|DAY|DAYS|WK|WEEK|MO|MONTH|YR|YEAR|KG|LB|LBS|OZ|GAL|GALLON|GALLONS|L|LITER|LITRE|ML|M|CM|MM|FT|IN|SF|LF|CF|BX|BOX|CS|CASE|PK|PKG|SET|ROLL|ROLLS|BAG|BAGS|BUNDLE|BUNDLES|DRUM|PALLET)$/i;
const NUMERIC_ONLY_TOKEN = /^-?\d+(?:\.\d+)?$/;

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

  // Sprint 3 · Phase 4 Slice 5.3 (2026-08-08, amendments #1 + #2) —
  // three-phase reconstruction:
  //   Phase 1: collect a `RowCandidate` for every body line, keeping
  //            description-only rows and amount-only rows separately
  //            (previously description-only rows were dropped).
  //   Phase 2: split-row merge — pair a description-only row with an
  //            adjacent amount-only row when structural evidence
  //            supports it (same region, close y-band, compatible
  //            column occupancy, no intervening product row).
  //   Phase 3: emit CanonicalLineItem[], rejecting itemized-summary
  //            shapes (§1) as reconciliation-only evidence rather
  //            than PRIMARY_PURCHASE.
  interface CellToken { text: string; x: number; }
  interface CellResolution {
    value: number | null;
    picked: string | null;
    candidates: string[];
    unit: string | null;
  }
  interface RowCandidate {
    y: number;
    page: number;
    workingItems: ReturnType<typeof splitFusedItemsAcrossColumns>;
    /** Physical tokens per semantic cell, position-preserved so
     *  future consumers can address multiple physical subcolumns
     *  even when the header detector only resolved a coarse role
     *  (§3 completion pass). */
    physicalCells: Map<string, CellToken[]>;
    skuRaw: string;
    descRaw: string;
    qtyResolved: CellResolution;
    unitResolved: CellResolution;
    amtResolved: CellResolution;
    hasAmount: boolean;
    hasSkuOrDesc: boolean;
    isSummaryShape: boolean;
    /** Leading token like "<line#> <product-code>" that a split-row
     *  merge may use as strong (but not required) corroborating
     *  evidence. */
    leadingToken: string | null;
  }

  const candidates: RowCandidate[] = [];
  const items: CanonicalLineItem[] = [];

  for (const line of bodyLines) {
    if (candidates.length >= MAX_ROWS) break;
    const text = line.text.trim();
    if (text.length === 0) continue;
    if (SUMMARY_ROW_LEADING.test(text)) break;
    if (POLICY_HINTS.test(text) && !endsWithAmount(text)) continue;
    const workingItems = splitFusedItemsAcrossColumns(line.items, columns);
    // §3 completion pass: preserve tokens with position so multiple
    // physical subcolumns can survive coarse header detection.
    const physicalCells = new Map<string, CellToken[]>();
    for (const it of workingItems.items) {
      const col = nearestColumn(it, columns);
      if (col == null) continue;
      const arr = physicalCells.get(col.role) ?? [];
      arr.push({ text: it.text.trim(), x: it.x });
      physicalCells.set(col.role, arr);
    }
    if (physicalCells.size === 0) continue;
    const skuTokens = physicalCells.get("sku") ?? [];
    const descTokens = physicalCells.get("description") ?? [];
    const qtyTokens = physicalCells.get("quantity") ?? [];
    const unitTokens = physicalCells.get("unitPrice") ?? [];
    const amtTokens = physicalCells.get("amount") ?? [];
    const skuRaw = skuTokens.map((t) => t.text).join(" ").trim();
    const descRaw = descTokens.map((t) => t.text).join(" ").trim();
    // §1 completion pass: token-aware monetary resolution. Filter
    // measurement-unit tags, take the rightmost AMOUNT_TOKEN-shaped
    // token as the semantic value (invoice numeric columns are almost
    // universally right-aligned). Preserve all candidates as evidence.
    const qtyResolved = resolveQuantityCell(qtyTokens);
    const unitResolved = resolveMonetaryCell(unitTokens);
    const amtResolved = resolveMonetaryCell(amtTokens);
    const hasAmount = amtResolved.value != null;
    const hasSkuOrDesc = skuRaw.length > 0 || descRaw.length > 2;
    if (!hasAmount && !hasSkuOrDesc) continue;
    // Extract a leading-token like "<line#> <product-code>" for
    // optional merge corroboration.
    const leadingTokenMatch = (descRaw || text).match(/^\s*(\d{1,3})\s+(\S{2,})\b/);
    const leadingToken = leadingTokenMatch ? `${leadingTokenMatch[1]} ${leadingTokenMatch[2]}` : null;
    candidates.push({
      y: line.y, page: line.page,
      workingItems, physicalCells,
      skuRaw, descRaw,
      qtyResolved, unitResolved, amtResolved,
      hasAmount, hasSkuOrDesc,
      isSummaryShape: descRaw ? isItemizedSummaryDescription(descRaw) : false,
      leadingToken,
    });
  }

  // Phase 2 — split-row merge.
  //   • Row A: substantive description present (descRaw.length ≥ 3)
  //     but NO amount and NO qty/unit.
  //   • Row B: amount present but description absent OR
  //     numeric-only OR very short.
  //   • Same page + close y-band (< ~20) + compatible x/column
  //     occupancy (no intervening candidate with description).
  //   Merge: adopt A's description; take B's qty/unitPrice/extension.
  //   Corroboration: matching leadingToken doubles confidence.
  const merged = new Set<number>();
  for (let i = 0; i < candidates.length; i++) {
    if (merged.has(i)) continue;
    const a = candidates[i];
    const aIsDescOnly = a.descRaw.length >= 3
      && !a.hasAmount
      && a.qtyResolved.value == null
      && a.unitResolved.value == null;
    if (!aIsDescOnly) continue;
    // Look for an amount-only counterpart within a small y-band.
    for (let j = 0; j < candidates.length; j++) {
      if (j === i || merged.has(j)) continue;
      const b = candidates[j];
      if (b.page !== a.page) continue;
      if (Math.abs(b.y - a.y) > 25) continue;
      // §1 completion-pass amendment: only merge when B is genuinely
      // amount-only. A "<line#> <product-code>" prefix in B's desc
      // is NOT amount-only even though it matches the previous
      // digit-only check — it's the leading prefix of a fresh product
      // row. Reject unless (a) B's descRaw is empty, (b) it's a single
      // ≤3-char numeric like a bare "1", or (c) leadingTokens match
      // A's.
      const bLeadingTokenMatchesA = a.leadingToken != null && b.leadingToken != null && a.leadingToken === b.leadingToken;
      const bLooksLikeContinuation = b.descRaw === ""
        || /^\d{1,3}$/.test(b.descRaw.trim())
        || bLeadingTokenMatchesA;
      if (!b.hasAmount || !bLooksLikeContinuation) continue;
      // Reject the merge if any OTHER candidate with a substantive
      // description sits between A and B on the y axis.
      const [loY, hiY] = a.y < b.y ? [a.y, b.y] : [b.y, a.y];
      const intervening = candidates.some((c, idx) =>
        idx !== i && idx !== j
        && c.page === a.page
        && c.y > loY && c.y < hiY
        && c.descRaw.length >= 3
        && !c.isSummaryShape,
      );
      if (intervening) continue;
      // Corroboration signal.
      const tokensMatch = a.leadingToken != null && b.leadingToken != null && a.leadingToken === b.leadingToken;
      // Merge: adopt A's desc, take B's resolved numeric cells.
      a.qtyResolved = b.qtyResolved;
      a.unitResolved = b.unitResolved;
      a.amtResolved = b.amtResolved;
      a.hasAmount = true;
      a.workingItems = { items: [...a.workingItems.items, ...b.workingItems.items], usedProportionalSplit: a.workingItems.usedProportionalSplit || b.workingItems.usedProportionalSplit };
      // Cite this merge on the candidate so the emitted row keeps
      // provenance.
      (a as RowCandidate & { mergeProvenance?: { fromY: number; toY: number; tokensMatch: boolean } })
        .mergeProvenance = { fromY: a.y, toY: b.y, tokensMatch };
      merged.add(j);
      break;
    }
  }

  // Phase 3 — emit CanonicalLineItem[] from the surviving candidates.
  for (let i = 0; i < candidates.length; i++) {
    if (items.length >= MAX_ROWS) break;
    if (merged.has(i)) continue; // consumed by an earlier merge
    const c = candidates[i];

    // Wrapped description merge into the previous emitted item.
    // §1 completion-pass amendment: y-band widened from 20 → 32 so
    // multi-line description blocks (multiple continuation lines +
    // Serial#/Model# labels) attach to the primary purchase row
    // rather than each becoming a spurious PRIMARY_PURCHASE. Guard
    // rows: only wrap when the candidate has no numeric evidence AND
    // its distance to the previous ITEM'S ANCHOR y is within the
    // continuation window. The row is otherwise emitted normally.
    if (!c.hasAmount
        && c.descRaw.length > 0
        && !c.skuRaw
        && c.qtyResolved.value == null
        && items.length > 0) {
      const prev = items[items.length - 1];
      if (c.y - (prev.region?.y ?? 0) < 32 && prev.description.length < 200) {
        prev.description = `${prev.description} ${c.descRaw}`.trim().slice(0, 200);
        prev.evidence.push({ kind: "wrapped_description_merge", detail: c.descRaw.slice(0, 60) });
        continue;
      }
    }

    const quantity = c.qtyResolved.value;
    const unitPrice = c.unitResolved.value;
    const extension = c.amtResolved.value;

    let description = c.descRaw;
    if (!description || description.length < 3) {
      const nonAmountItems = c.workingItems.items
        .filter((it) => !AMOUNT_TOKEN.test(it.text.trim()) && !AMOUNT_TOKEN.test(it.text.replace("$", "").trim()))
        .map((it) => it.text.trim())
        .filter(Boolean);
      description = nonAmountItems.join(" ").trim().slice(0, 200);
    }
    if (!description && !c.skuRaw && extension == null) continue;
    if (extension == null) continue;

    // Amendment #1: itemized-summary shapes NEVER become
    // PRIMARY_PURCHASE. Preserve as SUMMARY_ROW_REJECTED role for
    // downstream reconciliation evidence.
    const cites: CanonicalLineItemEvidenceCite[] = [
      { kind: "column_header", detail: `[${columns.map((c) => c.role).join(",")}]` },
      { kind: "column_alignment" },
    ];
    if (c.workingItems.usedProportionalSplit) {
      cites.push({ kind: "proportional_character_split", detail: "pdf.js emitted a fused row across ≥2 column centres" });
    }
    // §1 completion pass: when a semantic cell resolved from multiple
    // physical candidates, cite them so the founder-facing diagnostic
    // shows how the value was selected.
    if (c.amtResolved.candidates.length > 1) {
      cites.push({
        kind: "column_alignment",
        detail: `amount_candidates=[${c.amtResolved.candidates.join(",")}] picked=${c.amtResolved.picked}(rightmost-x)`,
      });
    }
    if (c.unitResolved.candidates.length > 1) {
      cites.push({
        kind: "column_alignment",
        detail: `unitPrice_candidates=[${c.unitResolved.candidates.join(",")}] picked=${c.unitResolved.picked}(rightmost-x)`,
      });
    }
    const mergeProvenance = (c as RowCandidate & { mergeProvenance?: { fromY: number; toY: number; tokensMatch: boolean } }).mergeProvenance;
    if (mergeProvenance) {
      cites.push({
        kind: "wrapped_description_merge",
        detail: `POSITIONED_SPLIT_ROW_MERGE: description@y=${mergeProvenance.fromY} + amount@y=${mergeProvenance.toY}${mergeProvenance.tokensMatch ? " · leadingTokenMatch" : ""}`,
      });
    }

    const isSummary = isItemizedSummaryDescription(description);
    const { role, cite: roleCite } = isSummary
      ? { role: "SUMMARY_ROW_REJECTED" as const, cite: null }
      : classifyLineItemRole(description, extension);
    if (roleCite) cites.push(roleCite);
    if (isSummary) {
      cites.push({
        kind: "flattened_text_row",
        detail: `itemized_summary_rejected: "${description.slice(0, 60)}"`,
      });
    }

    const li: CanonicalLineItem = {
      description: description || (c.skuRaw ? `Item ${c.skuRaw}` : "line item"),
      sku: c.skuRaw || null,
      quantity,
      // §2 completion pass: measurement unit surfaced from the
      // quantity cell (EA / PCS / HR / GAL / …) when present.
      unit: c.qtyResolved.unit,
      unitPrice,
      extension,
      role,
      page: c.page,
      region: { page: c.page, x: 0, y: c.y, lineIndex: undefined },
      sourceStrategy: c.workingItems.usedProportionalSplit
        ? "POSITIONED_PROPORTIONAL_SPLIT"
        : "POSITIONED_CLASSIC_TABLE",
      validationConfidence: c.workingItems.usedProportionalSplit
        ? 55
        : (mergeProvenance ? (mergeProvenance.tokensMatch ? 82 : 74) : 78),
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

// Sprint 3 · Phase 4 Slice 5.3 completion (2026-08-08, §1) —
// Token-aware monetary cell resolver. When a semantic column contains
// multiple physical tokens (e.g. unit-price + amount fall into the
// same coarse "amount" cell), pick the rightmost AMOUNT_TOKEN-shaped
// value as the semantic value. Invoice numeric columns are almost
// universally right-aligned; the rightmost valid amount in the cell
// is the column's value. Non-amount / measurement-tag tokens are
// filtered out first. Returns candidates so the founder-facing
// diagnostic can show how the value was selected.
function resolveMonetaryCell(tokens: Array<{ text: string; x: number }>): {
  value: number | null;
  picked: string | null;
  candidates: string[];
  unit: string | null;
} {
  const unit = tokens.find((t) => UNIT_TAG_TOKEN.test(t.text))?.text ?? null;
  const monetary = tokens
    .filter((t) => !UNIT_TAG_TOKEN.test(t.text))
    .filter((t) => AMOUNT_TOKEN.test(t.text.trim()));
  if (monetary.length === 0) return { value: null, picked: null, candidates: [], unit };
  // Rightmost x wins (right-aligned column value).
  const sorted = [...monetary].sort((a, b) => b.x - a.x);
  const picked = sorted[0];
  return {
    value: parseAmount(picked.text),
    picked: picked.text,
    candidates: monetary.map((c) => c.text),
    unit,
  };
}

// §2 completion pass — quantity resolver: strip measurement tags,
// take the rightmost purely-numeric token (typically the shipped
// / invoiced quantity in an Order/Backorder/Shipped triple). Also
// records the associated unit tag (EA / PCS / …) when present so
// downstream consumers can preserve it on the CanonicalLineItem.
function resolveQuantityCell(tokens: Array<{ text: string; x: number }>): {
  value: number | null;
  picked: string | null;
  candidates: string[];
  unit: string | null;
} {
  const unit = tokens.find((t) => UNIT_TAG_TOKEN.test(t.text))?.text ?? null;
  const numeric = tokens
    .filter((t) => !UNIT_TAG_TOKEN.test(t.text))
    .filter((t) => NUMERIC_ONLY_TOKEN.test(t.text.replace(/,/g, "")));
  if (numeric.length === 0) return { value: null, picked: null, candidates: [], unit };
  const sorted = [...numeric].sort((a, b) => b.x - a.x);
  const picked = sorted[0];
  return {
    value: parseNumber(picked.text),
    picked: picked.text,
    candidates: numeric.map((c) => c.text),
    unit,
  };
}
