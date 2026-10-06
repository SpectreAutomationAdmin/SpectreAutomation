// GOLF-HIST-1A (2026-10-06) — GGGolf Daily Report PDF parser.
//
// REWRITTEN after the GOLF-HIST-1 real-upload defect. The previous
// parser consumed the output of `pdf-parse`'s text flattening and
// assumed inter-column whitespace. The real pdf-parse output strips
// all inter-column spacing — a daily row like
//
//   "Thu, Jan 1 - 0 0 0 0 0 0 0 0 0 0 0 0"
//
// comes back as
//
//   "Thu, Jan 1-000000000000"
//
// which is non-deterministically splittable from the text alone. The
// GOLF-HIST-1 fixture tested a hand-normalized text payload (what the
// Claude Read tool rendered); it never exercised real PDF bytes.
// 100 % test-fidelity failure.
//
// Fix: positional (pdfjs) extraction via `pdf-parse`'s pagerender
// hook. Each glyph item carries (x, yBaselineRaw); items with the
// same yBaselineRaw on the same page form one visual row. Rows are
// sorted left-to-right by x. Daily rows become arrays of 14 cells;
// the Totals row becomes an array of 13 cells. No whitespace-dependent
// splitting anywhere.
//
// `parseGgGolfPdf(buffer)` is the production entry point. The
// synthetic `parseGgGolfLayout(layout, hash)` is exposed so unit
// tests can exercise edge cases (missing totals row, duplicate dates,
// etc.) without crafting valid PDF binaries. There is NO flat-text
// parser any more.

import pdfParse from "pdf-parse";
import { createHash } from "node:crypto";

// =============================================================================
// Public types
// =============================================================================

export type GgGolfParseWarning = {
  kind:
    | "DUPLICATE_DATE"
    | "ROW_TOTAL_MISMATCH"
    | "SHORT_COLUMNS"
    | "UNPARSEABLE_ROW"
    | "DATE_OUT_OF_YEAR"
    | "TOTALS_RECONCILIATION"
    | "NO_DAILY_ROWS"
    | "YEAR_UNRESOLVED";
  message: string;
  rowIndex?: number;
  dateLabel?: string;
};

export type GgGolfParsedRow = {
  rowIndex: number;
  rawCells: ReadonlyArray<string>;
  rawDateLabel: string;     // "Thu, Jan 1"
  activityDate: Date;       // UTC midnight for the local calendar date
  rawWeatherCode: string;   // "-" when the source left it blank
  guests: number;
  greenFees: number;
  members: number;
  totalRounds: number;
  juniors: number;
  women: number;
  corpos: number;
  corposHalf: number;
  fullCart: number;
  nineCart: number;
  halfCart: number;
  freeCart: number;
};

export type GgGolfSourceTotals = {
  guests: number;
  greenFees: number;
  members: number;
  totalRounds: number;
  juniors: number;
  women: number;
  corpos: number;
  corposHalf: number;
  fullCart: number;
  nineCart: number;
  halfCart: number;
  freeCart: number;
};

export type GgGolfParseResult = {
  sourceFileHash: string;
  reportYear: number | null;
  reportingPeriodStart: Date | null;
  reportingPeriodEnd: Date | null;
  rows: GgGolfParsedRow[];
  sourceTotals: GgGolfSourceTotals | null;
  parsedTotals: GgGolfSourceTotals;
  warnings: GgGolfParseWarning[];
  // RECONCILED:  parsedTotals === sourceTotals for every column.
  // MISMATCH:    parsed rows exist but totals mismatch (or source
  //              footer missing).
  // PARSE_FAILED: 0 daily rows OR year unresolvable OR period
  //              cannot be derived. The batch is unusable; the
  //              admin API refuses to persist a batch in this state.
  reconciliationStatus: "RECONCILED" | "MISMATCH" | "PARSE_FAILED";
};

/** Positional glyph item recovered from the PDF. */
export type GgGolfLayoutItem = {
  text: string;
  page: number;
  x: number;
  yBaseline: number;
};

export type GgGolfLayout = {
  items: ReadonlyArray<GgGolfLayoutItem>;
};

// =============================================================================
// Entry points
// =============================================================================

/** Compute SHA-256 of the uploaded binary. Idempotency key. */
export function hashSourceFile(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Production entry point. Extracts positional glyph layout from the
 * PDF, groups items into rows by y-baseline, and parses each row.
 */
export async function parseGgGolfPdf(buf: Buffer): Promise<GgGolfParseResult> {
  const sourceFileHash = hashSourceFile(buf);
  const layout = await extractGgGolfLayout(buf);
  return parseGgGolfLayout(layout, sourceFileHash);
}

/**
 * Extract positional glyph items from a GGGolf PDF using
 * `pdf-parse`'s pagerender hook. Each item carries (text, page, x,
 * yBaseline). Returns an empty-items layout when extraction fails
 * (an image-only / corrupt PDF).
 */
export async function extractGgGolfLayout(buf: Buffer): Promise<GgGolfLayout> {
  const items: GgGolfLayoutItem[] = [];
  try {
    await pdfParse(buf, {
      pagerender: async (pageData: unknown) => {
        try {
          const page = pageData as {
            pageNumber?: number;
            pageIndex?: number;
            getTextContent: (opts?: unknown) => Promise<{
              items: Array<{ str: string; transform: number[] }>;
            }>;
          };
          const pageNum = page.pageNumber ?? ((page.pageIndex ?? 0) + 1);
          const content = await page.getTextContent({
            normalizeWhitespace: false,
            disableCombineTextItems: true,
          });
          for (const it of content.items) {
            const t = it.transform ?? [0, 0, 0, 0, 0, 0];
            const x = round2(t[4] ?? 0);
            const yBase = round2(t[5] ?? 0);
            items.push({ text: it.str ?? "", page: pageNum, x, yBaseline: yBase });
          }
          return "";
        } catch {
          return "";
        }
      },
    });
  } catch {
    // Extraction failed. Return the empty layout; the parser will
    // emit PARSE_FAILED.
  }
  return { items };
}

/**
 * Parse a GGGolf layout into daily rows + totals. Used directly by
 * unit tests to exercise edge cases without crafting PDF binaries;
 * production always goes through `parseGgGolfPdf`.
 */
export function parseGgGolfLayout(
  layout: GgGolfLayout,
  sourceFileHash: string,
): GgGolfParseResult {
  const warnings: GgGolfParseWarning[] = [];
  const visualRows = groupItemsIntoRows(layout.items);

  const reportYear = extractReportYear(visualRows);
  if (reportYear == null) {
    warnings.push({
      kind: "YEAR_UNRESOLVED",
      message: "Could not identify the report year (`Date <YYYY>` header missing).",
    });
  }

  const rows: GgGolfParsedRow[] = [];
  let sourceTotals: GgGolfSourceTotals | null = null;
  const seenDates = new Set<string>();

  for (const vr of visualRows) {
    // Totals row: first cell is literal "Totals"; remaining 12 are integers.
    if (vr.cells[0] && /^Totals$/i.test(vr.cells[0])) {
      const nums = parseIntegerCells(vr.cells.slice(1));
      if (nums && nums.length === 12) {
        sourceTotals = toSourceTotals(nums);
      }
      continue;
    }
    // Daily row: first cell is "<WeekdayAbbr>, <MonthAbbr> <Day>".
    const dateMatch = parseDateCell(vr.cells[0] ?? "");
    if (!dateMatch) continue;
    if (reportYear == null) continue;

    // Expected shape: [date] [weather] [12 ints] = 14 cells.
    if (vr.cells.length < 14) {
      warnings.push({
        kind: "SHORT_COLUMNS",
        message: `Expected 14 cells (date + weather + 12 ints); got ${vr.cells.length} on "${vr.cells.join(" ")}".`,
      });
      continue;
    }
    const weatherCell = vr.cells[1];
    const nums = parseIntegerCells(vr.cells.slice(2, 14));
    if (!nums) {
      warnings.push({
        kind: "UNPARSEABLE_ROW",
        message: `Non-integer value in daily row "${vr.cells.join(" ")}".`,
      });
      continue;
    }

    const activityDate = new Date(Date.UTC(reportYear, dateMatch.month - 1, dateMatch.day));
    if (
      activityDate.getUTCFullYear() !== reportYear ||
      activityDate.getUTCMonth() !== dateMatch.month - 1 ||
      activityDate.getUTCDate() !== dateMatch.day
    ) {
      warnings.push({
        kind: "UNPARSEABLE_ROW",
        message: `Date resolution failed for cell "${vr.cells[0]}".`,
      });
      continue;
    }

    const isoKey = activityDate.toISOString().slice(0, 10);
    if (seenDates.has(isoKey)) {
      warnings.push({
        kind: "DUPLICATE_DATE",
        message: `Duplicate date in source: ${dateMatch.label}`,
        rowIndex: rows.length,
        dateLabel: dateMatch.label,
      });
      continue;
    }
    seenDates.add(isoKey);

    const row: GgGolfParsedRow = {
      rowIndex: rows.length,
      rawCells: vr.cells,
      rawDateLabel: dateMatch.label,
      activityDate,
      rawWeatherCode: weatherCell,
      guests:      nums[0],
      greenFees:   nums[1],
      members:     nums[2],
      totalRounds: nums[3],
      juniors:     nums[4],
      women:       nums[5],
      corpos:      nums[6],
      corposHalf:  nums[7],
      fullCart:    nums[8],
      nineCart:    nums[9],
      halfCart:    nums[10],
      freeCart:    nums[11],
    };
    // Per-row reconciliation: Total = Guests + GreenFees + Members.
    if (row.totalRounds !== row.guests + row.greenFees + row.members) {
      warnings.push({
        kind: "ROW_TOTAL_MISMATCH",
        message:
          `Row total ${row.totalRounds} ≠ ` +
          `guests ${row.guests} + green fees ${row.greenFees} ` +
          `+ members ${row.members} on ${row.rawDateLabel}.`,
        rowIndex: rows.length,
        dateLabel: row.rawDateLabel,
      });
    }
    rows.push(row);
  }

  // Compute parsed totals.
  const parsedTotals = sumRows(rows);

  // Resolve period from parsed rows.
  let reportingPeriodStart: Date | null = null;
  let reportingPeriodEnd: Date | null = null;
  if (rows.length > 0) {
    const sorted = [...rows].sort((a, b) => a.activityDate.getTime() - b.activityDate.getTime());
    reportingPeriodStart = sorted[0].activityDate;
    reportingPeriodEnd = sorted[sorted.length - 1].activityDate;
  }

  // Fail-closed: 0 rows OR year unresolvable → PARSE_FAILED. No
  // period is fabricated; downstream admin API refuses to persist.
  if (rows.length === 0 || reportYear == null) {
    warnings.push({
      kind: "NO_DAILY_ROWS",
      message: "No GGGolf daily rows detected in the uploaded source. The parser requires a positional PDF (not a scanned image).",
    });
    return {
      sourceFileHash,
      reportYear,
      reportingPeriodStart,
      reportingPeriodEnd,
      rows: [],
      sourceTotals,
      parsedTotals,
      warnings,
      reconciliationStatus: "PARSE_FAILED",
    };
  }

  // Reconciliation.
  let reconciliationStatus: GgGolfParseResult["reconciliationStatus"] = "MISMATCH";
  if (sourceTotals) {
    if (sumsEqual(sourceTotals, parsedTotals) && !warnings.some((w) => w.kind === "ROW_TOTAL_MISMATCH")) {
      reconciliationStatus = "RECONCILED";
    } else {
      warnings.push({
        kind: "TOTALS_RECONCILIATION",
        message:
          `Source totals row does not match parsed daily sums. ` +
          `source={members:${sourceTotals.members}, total:${sourceTotals.totalRounds}}, ` +
          `parsed={members:${parsedTotals.members}, total:${parsedTotals.totalRounds}}.`,
      });
    }
  } else {
    warnings.push({
      kind: "TOTALS_RECONCILIATION",
      message: "Source Totals row was not found in the document.",
    });
  }

  return {
    sourceFileHash,
    reportYear,
    reportingPeriodStart,
    reportingPeriodEnd,
    rows,
    sourceTotals,
    parsedTotals,
    warnings,
    reconciliationStatus,
  };
}

// =============================================================================
// Internals
// =============================================================================

const MONTH_ABBRS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const WEEKDAY_ABBRS = new Set([
  "mon", "tue", "wed", "thu", "fri", "sat", "sun",
]);

type VisualRow = {
  page: number;
  yBaseline: number;
  cells: ReadonlyArray<string>;
};

/** Group positional items into rows by (page, rounded yBaseline). */
export function groupItemsIntoRows(items: ReadonlyArray<GgGolfLayoutItem>): VisualRow[] {
  const groups = new Map<string, GgGolfLayoutItem[]>();
  for (const it of items) {
    // Round y-baseline to the nearest integer unit. GGGolf rows are
    // ~17 pts apart; within-row glyphs share the baseline exactly.
    const key = `${it.page}:${Math.round(it.yBaseline)}`;
    const arr = groups.get(key);
    if (arr) arr.push(it);
    else groups.set(key, [it]);
  }
  const rows: VisualRow[] = [];
  for (const [key, arr] of groups) {
    arr.sort((a, b) => a.x - b.x);
    const [pageStr] = key.split(":");
    const page = Number(pageStr);
    const yBaseline = arr[0]?.yBaseline ?? 0;
    const cells: string[] = [];
    for (const it of arr) {
      // Collapse adjacent items at nearly the same x (sub-glyph
      // splits that pdfjs sometimes emits) into a single cell.
      // Threshold: < 4 points of horizontal gap.
      const prev = cells.length ? arr[cells.length - 1] : null;
      // (We can't look back by cell index because we already pushed
      // text; fall through to simple push + merge at the end.)
      cells.push(it.text);
    }
    // Second pass: merge glyph fragments that pdfjs emits for the
    // same visual cell. We treat two items as the same cell when
    // they sit within 4 pts of horizontal gap.
    const merged: string[] = [];
    for (let i = 0; i < arr.length; i++) {
      const t = arr[i].text ?? "";
      if (!t) continue;
      if (merged.length === 0) { merged.push(t); continue; }
      const prevRight = arr[i - 1].x + estimateGlyphWidth(arr[i - 1].text);
      const gap = arr[i].x - prevRight;
      if (gap < 2) merged[merged.length - 1] = merged[merged.length - 1] + t;
      else merged.push(t);
    }
    rows.push({ page, yBaseline, cells: merged });
  }
  // Sort rows top-to-bottom (y decreasing in PDF user space).
  rows.sort((a, b) => a.page === b.page ? b.yBaseline - a.yBaseline : a.page - b.page);
  return rows;
}

function estimateGlyphWidth(s: string): number {
  // Average character width in points at the font sizes GGGolf uses
  // (~10pt body). Only used to decide whether two items belong to
  // the same visual cell; conservative small value biases toward
  // treating adjacent glyphs as the same cell.
  return 2.5 * (s?.length ?? 1);
}

/** Extract the report year from the header row ("Date <YYYY>"). */
function extractReportYear(rows: VisualRow[]): number | null {
  for (const r of rows) {
    for (const c of r.cells) {
      const m = /^Date\s+(\d{4})$/.exec(c);
      if (m) {
        const y = Number(m[1]);
        if (y >= 1900 && y <= 2200) return y;
      }
    }
  }
  // Fallback: any 4-digit year in any header cell.
  for (const r of rows) {
    for (const c of r.cells) {
      const m = /\b(20\d{2})\b/.exec(c);
      if (m) return Number(m[1]);
    }
  }
  return null;
}

function parseDateCell(cell: string): { month: number; day: number; label: string } | null {
  // Expected: "Thu, Jan 1" / "Fri, Jan 2" / "Thu, Jan 1"
  const m = /^([A-Za-z]{3,4}),\s+([A-Za-z]{3,5})\s+(\d{1,2})$/.exec(cell.trim());
  if (!m) return null;
  const weekday = m[1].toLowerCase();
  const monthToken = m[2].toLowerCase();
  const day = Number(m[3]);
  if (!WEEKDAY_ABBRS.has(weekday)) return null;
  const month = MONTH_ABBRS[monthToken];
  if (!month) return null;
  if (!Number.isFinite(day) || day < 1 || day > 31) return null;
  return {
    month, day,
    label: `${capitalizeAbbr(weekday)}, ${capitalizeAbbr(monthToken)} ${day}`,
  };
}

function parseIntegerCells(cells: ReadonlyArray<string>): number[] | null {
  const out: number[] = [];
  for (const c of cells) {
    const t = c.trim();
    if (!/^\d+$/.test(t)) {
      // Weather code / "-" lands in position 1 of a daily row; this
      // function is called ONLY on the integer slice so a non-integer
      // here is a true parse error.
      return null;
    }
    out.push(Number(t));
  }
  return out;
}

function toSourceTotals(nums: number[]): GgGolfSourceTotals {
  return {
    guests:      nums[0],
    greenFees:   nums[1],
    members:     nums[2],
    totalRounds: nums[3],
    juniors:     nums[4],
    women:       nums[5],
    corpos:      nums[6],
    corposHalf:  nums[7],
    fullCart:    nums[8],
    nineCart:    nums[9],
    halfCart:    nums[10],
    freeCart:    nums[11],
  };
}

function sumRows(rows: GgGolfParsedRow[]): GgGolfSourceTotals {
  const zero: GgGolfSourceTotals = {
    guests: 0, greenFees: 0, members: 0, totalRounds: 0,
    juniors: 0, women: 0, corpos: 0, corposHalf: 0,
    fullCart: 0, nineCart: 0, halfCart: 0, freeCart: 0,
  };
  return rows.reduce<GgGolfSourceTotals>((acc, r) => ({
    guests:      acc.guests      + r.guests,
    greenFees:   acc.greenFees   + r.greenFees,
    members:     acc.members     + r.members,
    totalRounds: acc.totalRounds + r.totalRounds,
    juniors:     acc.juniors     + r.juniors,
    women:       acc.women       + r.women,
    corpos:      acc.corpos      + r.corpos,
    corposHalf:  acc.corposHalf  + r.corposHalf,
    fullCart:    acc.fullCart    + r.fullCart,
    nineCart:    acc.nineCart    + r.nineCart,
    halfCart:    acc.halfCart    + r.halfCart,
    freeCart:    acc.freeCart    + r.freeCart,
  }), zero);
}

function sumsEqual(a: GgGolfSourceTotals, b: GgGolfSourceTotals): boolean {
  return (
    a.guests      === b.guests      &&
    a.greenFees   === b.greenFees   &&
    a.members     === b.members     &&
    a.totalRounds === b.totalRounds &&
    a.juniors     === b.juniors     &&
    a.women       === b.women       &&
    a.corpos      === b.corpos      &&
    a.corposHalf  === b.corposHalf  &&
    a.fullCart    === b.fullCart    &&
    a.nineCart    === b.nineCart    &&
    a.halfCart    === b.halfCart    &&
    a.freeCart    === b.freeCart
  );
}

function capitalizeAbbr(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
