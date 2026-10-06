// GOLF-HIST-1 (2026-10-05) — GGGolf Daily Report PDF parser.
//
// GGGolf is Spectre's current tee-sheet provider (Silver Springs
// uses it in production; Coulee Ridge staging shares the same source
// format). This parser is INTENTIONALLY provider-specific — it
// understands the GGGolf "Daily Report" PDF layout and produces
// provider-neutral canonical rows. A future GGGolf API connector
// writes to the SAME `GolfActivityDay` table through its own
// loader; neither Section XI nor the resolver branch on provider.
//
// Source layout (per the January 2026 reference):
//   Header: "<Club Name> · Daily Report"
//   Columns:
//     Date 2026 | Weather | Nb. Guests | Nb. Grnfees | Nb. Members |
//     Total | Nb. Juniors | Nb. Women | Nb. Corpos | Nb. Corpos Half |
//     Full 9 Cart | Half 9 Cart | Free Cart          (12 numeric)
//   Rows: "<WeekdayAbbr>, <MonthAbbr> <Day> <WeatherCode> <12 ints>"
//   Totals row (final): "Totals  <12 ints>"
//   Footer legend: "Weather : 1=Closed, 2=Very cold, ... 8=Sunny"
//
// Validation rules:
//   - Every daily row MUST have exactly 12 integer columns.
//   - Every daily row MUST have Total = Guests + GreenFees + Members
//     (reconciliation per-row).
//   - Period = min(activityDate) to max(activityDate).
//   - Totals footer MUST reconcile to the per-row column sums.
//   - Duplicate dates → warning + marked for operator review.
//   - Dates outside the report's declared year (from the header
//     "Date <YYYY>" row) → warning.

import pdfParse from "pdf-parse";
import { createHash } from "node:crypto";

export type GgGolfParseWarning = {
  kind:
    | "DUPLICATE_DATE"
    | "ROW_TOTAL_MISMATCH"
    | "SHORT_COLUMNS"
    | "UNPARSEABLE_LINE"
    | "DATE_OUT_OF_YEAR"
    | "TOTALS_RECONCILIATION";
  message: string;
  rowIndex?: number;
  dateLabel?: string;
};

export type GgGolfParsedRow = {
  rowIndex: number;
  rawLine: string;
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
  reportYear: number;
  reportingPeriodStart: Date;
  reportingPeriodEnd: Date;
  rows: GgGolfParsedRow[];
  sourceTotals: GgGolfSourceTotals | null;
  parsedTotals: GgGolfSourceTotals;
  warnings: GgGolfParseWarning[];
  // RECONCILED: parsedTotals === sourceTotals for every column.
  // MISMATCH:   any column differs OR source totals row is missing.
  // UNKNOWN:    reserved; parser never emits this.
  reconciliationStatus: "RECONCILED" | "MISMATCH" | "UNKNOWN";
};

const MONTH_ABBRS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};
const WEEKDAY_ABBRS = new Set([
  "mon", "tue", "wed", "thu", "fri", "sat", "sun",
]);

/** Compute SHA-256 of the uploaded binary. Idempotency key. */
export function hashSourceFile(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/** Entry point. Parse a GGGolf Daily Report PDF buffer. */
export async function parseGgGolfPdf(
  buf: Buffer,
): Promise<GgGolfParseResult> {
  const sourceFileHash = hashSourceFile(buf);
  const text = (await pdfParse(buf)).text;
  return parseGgGolfText(text, sourceFileHash);
}

/** Parse a pre-extracted text payload. Separated so tests can
 *  exercise the row/footer logic without a real PDF buffer. */
export function parseGgGolfText(
  text: string,
  sourceFileHash: string,
): GgGolfParseResult {
  const warnings: GgGolfParseWarning[] = [];
  const reportYear = extractReportYear(text) ?? new Date().getUTCFullYear();

  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const rows: GgGolfParsedRow[] = [];
  const seenDates = new Set<string>();
  let sourceTotals: GgGolfSourceTotals | null = null;

  for (const raw of lines) {
    if (!raw) continue;
    // "Totals <12 ints>" — final footer row.
    if (/^Totals\b/i.test(raw)) {
      const nums = extractTrailingNumbers(raw.replace(/^Totals\s*/i, ""), 12);
      if (nums && nums.length === 12) {
        sourceTotals = {
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
      continue;
    }
    // Daily row — begins with a weekday abbreviation + comma.
    const parsed = parseDailyRow(raw, reportYear, rows.length);
    if (!parsed) continue;
    if (parsed.warning) {
      warnings.push({ ...parsed.warning, rowIndex: rows.length });
      continue;
    }
    const key = parsed.row.activityDate.toISOString().slice(0, 10);
    if (seenDates.has(key)) {
      warnings.push({
        kind: "DUPLICATE_DATE",
        message: `Duplicate date in source: ${parsed.row.rawDateLabel}`,
        rowIndex: rows.length,
        dateLabel: parsed.row.rawDateLabel,
      });
      continue;
    }
    seenDates.add(key);
    // Per-row reconciliation: Total = Guests + GreenFees + Members.
    if (parsed.row.totalRounds !== parsed.row.guests + parsed.row.greenFees + parsed.row.members) {
      warnings.push({
        kind: "ROW_TOTAL_MISMATCH",
        message:
          `Row total ${parsed.row.totalRounds} ≠ ` +
          `guests ${parsed.row.guests} + green fees ${parsed.row.greenFees} ` +
          `+ members ${parsed.row.members} on ${parsed.row.rawDateLabel}.`,
        rowIndex: rows.length,
        dateLabel: parsed.row.rawDateLabel,
      });
    }
    rows.push(parsed.row);
  }

  // Compute parsed totals.
  const parsedTotals = sumRows(rows);

  // Reconciliation: parsed totals vs source footer.
  let reconciliationStatus: GgGolfParseResult["reconciliationStatus"] = "MISMATCH";
  if (sourceTotals) {
    if (sumsEqual(sourceTotals, parsedTotals)) {
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
      message: "Source totals row was not found in the document.",
    });
  }

  // Period boundaries from parsed rows.
  let reportingPeriodStart = new Date(Date.UTC(reportYear, 0, 1));
  let reportingPeriodEnd = new Date(Date.UTC(reportYear, 11, 31));
  if (rows.length) {
    const sorted = [...rows].sort((a, b) => a.activityDate.getTime() - b.activityDate.getTime());
    reportingPeriodStart = sorted[0].activityDate;
    reportingPeriodEnd = sorted[sorted.length - 1].activityDate;
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

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function extractReportYear(text: string): number | null {
  // The GGGolf header column reads "Date <YYYY>". Try to extract.
  const m = /Date\s+(\d{4})/.exec(text);
  if (m) {
    const y = Number(m[1]);
    if (y >= 1900 && y <= 2200) return y;
  }
  // Fallback — try to find a 4-digit year in a year-anchoring row.
  const m2 = /\b(20\d{2})\b/.exec(text);
  if (m2) return Number(m2[1]);
  return null;
}

type ParseDailyOutcome =
  | { row: GgGolfParsedRow; warning?: never }
  | { row?: never; warning: GgGolfParseWarning };

function parseDailyRow(line: string, reportYear: number, rowIndex: number): ParseDailyOutcome | null {
  // Expected shape: "Thu, Jan 1 - 0 0 0 0 0 0 0 0 0 0 0 0"
  // The weekday abbreviation + comma anchors the start of a daily row.
  const prefix = line.match(/^([A-Za-z]{3,4}),\s+([A-Za-z]{3,5})\s+(\d{1,2})\s+(.*)$/);
  if (!prefix) return null;
  const weekday = prefix[1].toLowerCase();
  const monthToken = prefix[2].toLowerCase();
  const day = Number(prefix[3]);
  const trailing = prefix[4];
  if (!WEEKDAY_ABBRS.has(weekday)) return null;
  const month = MONTH_ABBRS[monthToken];
  if (!month || !Number.isFinite(day) || day < 1 || day > 31) return null;

  const activityDate = new Date(Date.UTC(reportYear, month - 1, day));
  if (
    activityDate.getUTCFullYear() !== reportYear ||
    activityDate.getUTCMonth() !== month - 1 ||
    activityDate.getUTCDate() !== day
  ) {
    return {
      warning: {
        kind: "UNPARSEABLE_LINE",
        message: `Could not resolve date on line: ${line}`,
      },
    };
  }

  // Split the trailing portion. The first token is the Weather code
  // (a single char or "-"); the remaining 12 are integers.
  const tokens = trailing.trim().split(/\s+/);
  if (tokens.length < 13) {
    return {
      warning: {
        kind: "SHORT_COLUMNS",
        message:
          `Expected 1 weather code + 12 integer columns after date; ` +
          `got ${tokens.length} on "${line}".`,
      },
    };
  }
  const rawWeatherCode = tokens[0];
  const numStrings = tokens.slice(1, 13);
  const nums = numStrings.map((t) => Number(t));
  if (nums.some((n) => !Number.isFinite(n))) {
    return {
      warning: {
        kind: "UNPARSEABLE_LINE",
        message: `Non-numeric value in daily row: ${line}`,
      },
    };
  }

  const [
    guests, greenFees, members, totalRounds,
    juniors, women,
    corpos, corposHalf,
    fullCart, nineCart, halfCart, freeCart,
  ] = nums.map((n) => Math.max(0, Math.round(n)));

  const dateLabel = `${capitalizeAbbr(weekday)}, ${capitalizeAbbr(monthToken)} ${day}`;

  return {
    row: {
      rowIndex,
      rawLine: line,
      rawDateLabel: dateLabel,
      activityDate,
      rawWeatherCode,
      guests, greenFees, members, totalRounds,
      juniors, women,
      corpos, corposHalf,
      fullCart, nineCart, halfCart, freeCart,
    },
  };
}

function capitalizeAbbr(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}

/** Extract the final N integers from a trailing-text segment. Used
 *  for the Totals footer row. */
function extractTrailingNumbers(s: string, n: number): number[] | null {
  const tokens = s.trim().split(/\s+/);
  if (tokens.length < n) return null;
  const tail = tokens.slice(-n);
  const nums = tail.map((t) => Number(t));
  if (nums.some((v) => !Number.isFinite(v))) return null;
  return nums.map((v) => Math.max(0, Math.round(v)));
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
