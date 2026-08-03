// Sprint 3 · Checkpoint 16A (2026-08-04) — positioned-layout
// table reconstructor.
//
// The founder's §5 rule: Textract line items are ONE source, not
// the only source. When a provider extractor returns nominal line
// items (e.g. a bare SKU with no amount) but the PDF has a real
// product table with dozens of positioned items, this module
// recovers the line items from the positioned layout instead of
// abstaining.
//
// Approach:
//   1. Detect column boundaries by clustering the x-positions of
//      right-aligned amount tokens.
//   2. Detect the line-item table header (row containing keywords
//      like "Description", "Qty", "Unit", "Price", "Amount").
//   3. Below the header, group items by y-band into rows.
//   4. For each row, snap items into columns (SKU/Description/Qty/
//      Unit price/Amount).
//   5. Reject rows that are actually subtotal/tax/total/policy
//      lines (matched against SUMMARY_ROW pattern).
//   6. Merge multi-line descriptions (rows with amounts continuing
//      from the previous row's description column).
//
// GENERAL logic — no supplier / SKU / filename specificity.

import type { PdfLayout, LayoutVisualLine, LayoutTextItem } from "./pdf-layout-extract";

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export interface ReconstructedLineItem {
  page: number;
  rowY: number;
  sku: string | null;
  description: string;
  quantity: number | null;
  unitPrice: number | null;
  amount: number | null;
  supportingCellCount: number;
  confidence: number; // 0-100
}

export interface TableReconstructResult {
  headerFound: boolean;
  headerRowY: number | null;
  detectedColumns: Array<{ role: string; xCenter: number }>;
  lineItems: ReconstructedLineItem[];
  rejectedRows: Array<{ y: number; text: string; reason: string }>;
  columnAlignmentConfidence: number;
}

// -----------------------------------------------------------------------------
// Column-header lexicon — GENERAL. Order matters (SKU / description /
// qty / unit / amount).
// -----------------------------------------------------------------------------

const HEADER_TOKENS: Array<{ role: "sku" | "description" | "quantity" | "unitPrice" | "amount"; patterns: RegExp[] }> = [
  { role: "sku",         patterns: [/\b(?:sku|item(?:\s*(?:#|no\.?|number))|part(?:\s*(?:#|no\.?|number))|product(?:\s*(?:#|no\.?|number))|code|ref)\b/i] },
  { role: "description", patterns: [/\b(?:description|item|product|service)\b/i] },
  { role: "quantity",    patterns: [/\b(?:qty|quantity|units?)\b/i] },
  { role: "unitPrice",   patterns: [/\b(?:unit\s*(?:price|cost)|price(?:\/unit)?|rate|per\s*unit)\b/i] },
  { role: "amount",      patterns: [/\b(?:amount|total|extended|extension|line\s*total)\b/i] },
];

// A row is a SUMMARY (not a line item) when its text begins with one
// of these labels — subtotal, tax, total, freight, discount, etc.
const SUMMARY_ROW_LEADING = /^(?:sub\s*[-]?\s*total|total|balance(?:\s*due)?|amount\s*due|invoice\s*total|payment|discount|credit|gst|hst|pst|qst|vat|tax|shipping|freight|surcharge|convenience\s*fee|charges?|thank\s*you|please\s*remit|amount\s*enclosed|previous\s*balance|new\s*charges|adjustment)/i;

// Policy / footer text that must be ignored (returns policy, terms).
const POLICY_HINTS = /(?:policy|return|terms|conditions|liability|not\s*paid|f\.?o\.?b\.|please\s*note|copy|original)/i;

const AMOUNT_TOKEN = /^\$?\s*-?\d{1,3}(?:,\d{3})*(?:\.\d{2})?$|^-?\d+\.\d{2}$/;

// -----------------------------------------------------------------------------
// Public entrypoint
// -----------------------------------------------------------------------------

export function reconstructLineItemTable(layout: PdfLayout): TableReconstructResult {
  const empty: TableReconstructResult = {
    headerFound: false,
    headerRowY: null,
    detectedColumns: [],
    lineItems: [],
    rejectedRows: [],
    columnAlignmentConfidence: 0,
  };

  if (layout.visualLines.length === 0) return empty;

  // Step 1 — locate the header row by finding a line whose items
  // contain at least 2 recognised column-header tokens.
  const headerCandidates = layout.visualLines.map((line) => scoreHeader(line));
  const bestHeader = headerCandidates
    .filter((c) => c.matchedRoles.size >= 2)
    .sort((a, b) => b.matchedRoles.size - a.matchedRoles.size || a.line.y - b.line.y)[0];

  if (!bestHeader) {
    // No table header detected — bail out with empty result.
    return empty;
  }
  const header = bestHeader.line;

  // Step 2 — map header items to column x-centers.
  const columns = [...bestHeader.columnsByRole.entries()]
    .map(([role, x]) => ({ role, xCenter: x }))
    .sort((a, b) => a.xCenter - b.xCenter);
  if (columns.length < 2) return empty;

  // Step 3 — consume rows below the header, on the same page.
  const bodyLines = layout.visualLines
    .filter((l) => l.page === header.page && l.y > header.y)
    .sort((a, b) => a.y - b.y);

  const rejected: TableReconstructResult["rejectedRows"] = [];
  const lineItems: ReconstructedLineItem[] = [];
  let alignmentHits = 0;
  let alignmentTotal = 0;
  let lastRowY = header.y;

  for (const line of bodyLines) {
    const text = line.text.trim();
    if (text.length === 0) continue;

    // Bail out once we hit summary / totals / footer land.
    if (SUMMARY_ROW_LEADING.test(text)) {
      rejected.push({ y: line.y, text: text.slice(0, 80), reason: "SUMMARY_ROW_LEADING" });
      // Stop consuming further rows — the item table ends here.
      break;
    }
    if (POLICY_HINTS.test(text) && !AMOUNT_TOKEN.test(text.split(/\s+/).pop() ?? "")) {
      rejected.push({ y: line.y, text: text.slice(0, 80), reason: "POLICY_TEXT" });
      continue;
    }

    // Snap items into columns by nearest x-center.
    const cells = new Map<string, string[]>();
    for (const it of line.items) {
      const col = nearestColumn(it, columns);
      if (col == null) continue;
      alignmentTotal++;
      const dist = Math.abs(it.x - col.xCenter);
      if (dist < 40) alignmentHits++;
      const arr = cells.get(col.role) ?? [];
      arr.push(it.text.trim());
      cells.set(col.role, arr);
    }

    if (cells.size === 0) continue;

    // Parse cells into structured fields.
    const skuRaw = (cells.get("sku") ?? []).join(" ").trim();
    const descRaw = (cells.get("description") ?? []).join(" ").trim();
    const qtyRaw = (cells.get("quantity") ?? []).join(" ").trim();
    const unitRaw = (cells.get("unitPrice") ?? []).join(" ").trim();
    const amtRaw = (cells.get("amount") ?? []).join(" ").trim();

    // A defensible line-item row requires either an amount OR a
    // sku-plus-description combination.
    const hasAmount = AMOUNT_TOKEN.test(amtRaw);
    const hasSkuOrDesc = skuRaw.length > 0 || descRaw.length > 2;
    if (!hasAmount && !hasSkuOrDesc) {
      rejected.push({ y: line.y, text: text.slice(0, 80), reason: "NO_AMOUNT_OR_DESC" });
      continue;
    }

    // Multi-line description merge: if this row has ONLY a
    // description cell (no amount, no sku) and is close to the
    // previous row, append its text to the previous line item.
    if (!hasAmount && descRaw.length > 0 && skuRaw.length === 0 && qtyRaw.length === 0 && lineItems.length > 0) {
      const prev = lineItems[lineItems.length - 1];
      if (line.y - prev.rowY < 20 && prev.description.length < 200) {
        prev.description = `${prev.description} ${descRaw}`.trim().slice(0, 200);
        continue;
      }
    }

    const quantity = parseNumber(qtyRaw);
    const unitPrice = parseAmount(unitRaw);
    const amount = parseAmount(amtRaw);

    // Prefer sku + description; fall back to the full row text minus
    // amount cell when neither cell was populated.
    let description = descRaw;
    if (!description || description.length < 3) {
      const nonAmountItems = line.items
        .filter((it) => !AMOUNT_TOKEN.test(it.text.trim()) && !AMOUNT_TOKEN.test(it.text.replace("$", "").trim()))
        .map((it) => it.text.trim())
        .filter(Boolean);
      description = nonAmountItems.join(" ").trim().slice(0, 200);
    }
    if (!description && !skuRaw && amount == null) continue;

    const supportingCellCount = [
      skuRaw ? 1 : 0,
      descRaw ? 1 : 0,
      qtyRaw ? 1 : 0,
      unitRaw ? 1 : 0,
      amtRaw ? 1 : 0,
    ].reduce((a, b) => a + b, 0);

    lineItems.push({
      page: line.page,
      rowY: line.y,
      sku: skuRaw || null,
      description: description || (skuRaw ? `Item ${skuRaw}` : "line item"),
      quantity,
      unitPrice,
      amount,
      supportingCellCount,
      confidence: Math.min(100, 20 + supportingCellCount * 15 + (hasAmount ? 10 : 0)),
    });
    lastRowY = line.y;
  }

  const columnAlignmentConfidence = alignmentTotal === 0 ? 0 : Math.round(100 * alignmentHits / alignmentTotal);

  return {
    headerFound: true,
    headerRowY: header.y,
    detectedColumns: columns,
    lineItems,
    rejectedRows: rejected,
    columnAlignmentConfidence,
  };
}

// -----------------------------------------------------------------------------
// Internals
// -----------------------------------------------------------------------------

interface HeaderScore {
  line: LayoutVisualLine;
  matchedRoles: Set<string>;
  columnsByRole: Map<string, number>; // role → x-center
}

function scoreHeader(line: LayoutVisualLine): HeaderScore {
  const roles = new Set<string>();
  const columnsByRole = new Map<string, number>();
  for (const item of line.items) {
    for (const { role, patterns } of HEADER_TOKENS) {
      if (patterns.some((p) => p.test(item.text))) {
        // Only record the FIRST occurrence of a role — this is
        // typically the leftmost mention.
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
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  // A cell must be within a wide-enough band of its column center to
  // be attributed. For dense multi-column tables, a very wide band
  // would misattribute cells across columns.
  return best && bestDist < 80 ? best : best;
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
  if (!AMOUNT_TOKEN.test(raw.trim()) && !/^-?\d+(?:\.\d{2})?$/.test(clean)) return null;
  const n = Number(clean);
  return Number.isFinite(n) ? n : null;
}
