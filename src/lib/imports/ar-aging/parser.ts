// TB-HIST-12A §9-13 (2026-10-03) — AR Aging importer parser.
//
// PURPOSE
//   Parse a sanitized AR-aging workbook into a validated, in-memory
//   result. The parser NEVER writes to the database. It is the
//   foundation for a future Chapter VIII subledger import; today it
//   exists for architecture + privacy-safe synthetic testing.
//
// PRIVACY CONTRACT
//   • The parser accepts any identity values (Member Code, Member
//     Name) verbatim from the sanitized source.
//   • The founder's real AR workbook MUST NEVER be fed to this
//     parser — only the sanitized version with synthetic identities
//     (CR-0001 / Member 0001). The repo's `.gitignore` protects
//     against the real workbook being committed; the parser itself
//     has no awareness of identity semantics.
//   • The returned shape intentionally keeps identity fields OPT-IN
//     at the Board-reporting layer — downstream reports should use
//     bucket totals, not member rows.
//
// SOURCE COLUMNS (per the founder's spec, §9 of the TB-HIST-12A
// directive):
//   Member Code · Member Name · Net Amount · Current · 1 Mths ·
//   2 Mths · 3 Mths · Over 4 Mths · Club · Club Description ·
//   Primary Club · Primary Club Description
//
// RECONCILIATION CONTRACTS
//   §10 row-level: Net Amount == Current + 1 Mths + 2 Mths + 3 Mths
//                  + Over 4 Mths (within $0.01).
//   §10 aggregate: sum(Net Amount) == sum(bucket columns per bucket)
//                  reconciles to totals returned to the caller.
//   §11 GL control: subledger total vs. January 31 GL AR control
//                   balance (Jonas account 1100 natural balance).
//                   The caller feeds the GL control number in; the
//                   parser does not read the TB.
//
// This parser is pure (deterministic, no I/O other than the input
// buffer / rows). It is callable from tests, APIs, or future
// workers alike.

import ExcelJS from "exceljs";
import { Prisma } from "@prisma/client";
import { toMoney, ZERO } from "@/lib/accounting/decimal";

// -------------------------------------------------------------------
// TYPES
// -------------------------------------------------------------------

export type ArAgingRow = {
  memberCode: string;
  memberName: string;
  netAmount: Prisma.Decimal;
  current: Prisma.Decimal;
  oneMonth: Prisma.Decimal;
  twoMonths: Prisma.Decimal;
  threeMonths: Prisma.Decimal;
  overFourMonths: Prisma.Decimal;
  club: string | null;
  clubDescription: string | null;
  primaryClub: string | null;
  primaryClubDescription: string | null;
};

export type ArAgingRowReconciliation = {
  rowIndex: number;
  memberCode: string;
  computedFromBuckets: Prisma.Decimal;
  netAmountFromSource: Prisma.Decimal;
  difference: Prisma.Decimal;
  withinTolerance: boolean;
};

export type ArAgingTotals = {
  totalAR: Prisma.Decimal;
  current: Prisma.Decimal;
  oneMonth: Prisma.Decimal;
  twoMonths: Prisma.Decimal;
  threeMonths: Prisma.Decimal;
  overFourMonths: Prisma.Decimal;
  /** sum(Current) ÷ sum(Net Amount) × 100 — returned already
   *  computed so callers never divide by zero themselves. Null when
   *  total AR is zero (no rows / all-zero file). */
  currentPct: number | null;
  /** 1 - currentPct — returned together so Board cards don't repeat
   *  the subtraction. Null when total AR is zero. */
  nonCurrentPct: number | null;
  /** Count of DISTINCT member rows parsed. */
  accountCount: number;
  /** Count of rows with ANY non-current balance (1 Mths + 2 Mths +
   *  3 Mths + Over 4 Mths > 0). */
  nonCurrentAccountCount: number;
};

export type ArAgingGlReconciliation = {
  subledgerTotal: Prisma.Decimal;
  glControlTotal: Prisma.Decimal;
  difference: Prisma.Decimal;
  withinTolerance: boolean;
  tolerance: Prisma.Decimal;
};

export type ArAgingParseResult = {
  rows: ArAgingRow[];
  totals: ArAgingTotals;
  rowReconciliations: ArAgingRowReconciliation[];
  rowsFailingReconciliation: ArAgingRowReconciliation[];
  /** Aggregate row-reconciliation. True when every row ∈ tolerance. */
  aggregateReconcilesPerRow: boolean;
  /** Hard parser warnings (unexpected columns / blank header /
   *  malformed numerics). Non-empty = caller should surface. */
  warnings: string[];
};

// -------------------------------------------------------------------
// CONSTANTS
// -------------------------------------------------------------------

/** $0.01 tolerance per founder's directive (§10 "within currency
 *  tolerance"). */
const BUCKET_TOLERANCE = toMoney("0.01");

/** Expected header labels (case-insensitive match, trimmed). */
const EXPECTED_HEADERS: Record<keyof Omit<ArAgingRow, never>, string[]> = {
  memberCode: ["member code", "membercode"],
  memberName: ["member name", "membername"],
  netAmount: ["net amount", "netamount", "net"],
  current: ["current"],
  oneMonth: ["1 mths", "1 month", "1 months", "1 mo"],
  twoMonths: ["2 mths", "2 months", "2 mo"],
  threeMonths: ["3 mths", "3 months", "3 mo"],
  overFourMonths: ["over 4 mths", "over 4 months", "4+ mths", "4+ months"],
  club: ["club"],
  clubDescription: ["club description", "clubdescription"],
  primaryClub: ["primary club", "primaryclub"],
  primaryClubDescription: ["primary club description", "primaryclubdescription"],
};

type ColumnMap = Partial<Record<keyof ArAgingRow, number>>;

// -------------------------------------------------------------------
// PUBLIC — parse from an in-memory XLSX buffer
// -------------------------------------------------------------------

/** Parse a sanitized AR-aging workbook (XLSX bytes) → validated
 *  rows + totals + reconciliations. Call this from an API handler
 *  that received an upload buffer; the parser performs no I/O. */
export async function parseArAgingWorkbook(
  buffer: ArrayBuffer | Buffer,
): Promise<ArAgingParseResult> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS accepts both Buffer and Uint8Array. Cast through unknown
  // to accommodate Node 24's narrower Buffer<ArrayBufferLike> type;
  // ExcelJS's declared parameter is still the older Buffer alias.
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  if (!ws) {
    return emptyResult(["Workbook has no worksheets."]);
  }
  // Collect every row as a cell-value array.
  const rowValues: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: unknown[] = [];
    // ExcelJS row.values is 1-indexed with [undefined, c1, c2, …].
    const raw = (row.values as unknown[]) ?? [];
    for (let i = 1; i < raw.length; i++) cells.push(raw[i]);
    rowValues.push(cells);
  });
  return parseArAgingRowValues(rowValues);
}

// -------------------------------------------------------------------
// PUBLIC — parse from in-memory row arrays (test entry point)
// -------------------------------------------------------------------

/** Parse pre-extracted cell rows → validated AR-aging result. Keeps
 *  the test seam fast: tests build row arrays directly (no XLSX
 *  round-trip) and call this. */
export function parseArAgingRowValues(rows: unknown[][]): ArAgingParseResult {
  const warnings: string[] = [];
  if (rows.length === 0) {
    return emptyResult(["Workbook has no non-empty rows."]);
  }

  // Find the header row. Many Jonas exports put a banner row before
  // the actual header; we scan the first 10 rows for a cell that
  // matches "member code".
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const normalized = rows[i].map((c) => normalizeHeader(String(c ?? "")));
    if (normalized.some((h) => EXPECTED_HEADERS.memberCode.includes(h))) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) {
    return emptyResult([`Could not locate a "Member Code" header in the first 10 rows.`]);
  }

  const headerRow = rows[headerRowIdx].map((c) => normalizeHeader(String(c ?? "")));
  const colMap: ColumnMap = {};
  for (const [field, candidates] of Object.entries(EXPECTED_HEADERS) as Array<
    [keyof ArAgingRow, string[]]
  >) {
    const idx = headerRow.findIndex((h) => candidates.includes(h));
    if (idx !== -1) colMap[field] = idx;
  }
  // Mandatory fields.
  const mandatory: Array<keyof ArAgingRow> = [
    "memberCode", "memberName", "netAmount", "current",
    "oneMonth", "twoMonths", "threeMonths", "overFourMonths",
  ];
  for (const f of mandatory) {
    if (colMap[f] == null) warnings.push(`Missing required column: ${f}`);
  }
  if (warnings.length > 0) {
    return emptyResult(warnings);
  }

  // Walk data rows.
  const parsed: ArAgingRow[] = [];
  const rowReconciliations: ArAgingRowReconciliation[] = [];

  for (let r = headerRowIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    // Skip blank rows (every mandatory cell empty).
    const codeCell = row[colMap.memberCode!];
    if (codeCell == null || String(codeCell).trim() === "") continue;

    const parsedRow: ArAgingRow = {
      memberCode: String(codeCell).trim(),
      memberName: String(row[colMap.memberName!] ?? "").trim(),
      netAmount: parseMoney(row[colMap.netAmount!]),
      current: parseMoney(row[colMap.current!]),
      oneMonth: parseMoney(row[colMap.oneMonth!]),
      twoMonths: parseMoney(row[colMap.twoMonths!]),
      threeMonths: parseMoney(row[colMap.threeMonths!]),
      overFourMonths: parseMoney(row[colMap.overFourMonths!]),
      club: colMap.club != null ? strOrNull(row[colMap.club!]) : null,
      clubDescription: colMap.clubDescription != null ? strOrNull(row[colMap.clubDescription!]) : null,
      primaryClub: colMap.primaryClub != null ? strOrNull(row[colMap.primaryClub!]) : null,
      primaryClubDescription: colMap.primaryClubDescription != null ? strOrNull(row[colMap.primaryClubDescription!]) : null,
    };
    parsed.push(parsedRow);

    const computed = parsedRow.current
      .plus(parsedRow.oneMonth)
      .plus(parsedRow.twoMonths)
      .plus(parsedRow.threeMonths)
      .plus(parsedRow.overFourMonths);
    const diff = parsedRow.netAmount.minus(computed);
    rowReconciliations.push({
      rowIndex: r,
      memberCode: parsedRow.memberCode,
      computedFromBuckets: computed,
      netAmountFromSource: parsedRow.netAmount,
      difference: diff,
      withinTolerance: diff.abs().lte(BUCKET_TOLERANCE),
    });
  }

  const totals = computeTotals(parsed);
  const rowsFailingReconciliation = rowReconciliations.filter((r) => !r.withinTolerance);
  const aggregateReconcilesPerRow = rowsFailingReconciliation.length === 0;

  return {
    rows: parsed,
    totals,
    rowReconciliations,
    rowsFailingReconciliation,
    aggregateReconcilesPerRow,
    warnings,
  };
}

// -------------------------------------------------------------------
// PUBLIC — reconcile the parsed subledger against the GL AR control
// -------------------------------------------------------------------

/** Compare parsed AR subledger total vs. the GL AR control balance
 *  (Jonas account 1100 natural balance at Jan 31). Caller supplies
 *  the GL figure; this function never reads the TB. */
export function reconcileAgainstGlControl(opts: {
  subledgerTotal: Prisma.Decimal;
  glControlTotal: Prisma.Decimal;
  tolerance?: Prisma.Decimal;
}): ArAgingGlReconciliation {
  const tolerance = opts.tolerance ?? toMoney("0.01");
  const difference = opts.subledgerTotal.minus(opts.glControlTotal);
  return {
    subledgerTotal: opts.subledgerTotal,
    glControlTotal: opts.glControlTotal,
    difference,
    withinTolerance: difference.abs().lte(tolerance),
    tolerance,
  };
}

// -------------------------------------------------------------------
// INTERNAL
// -------------------------------------------------------------------

function computeTotals(rows: ArAgingRow[]): ArAgingTotals {
  let totalAR = ZERO;
  let current = ZERO;
  let oneMonth = ZERO;
  let twoMonths = ZERO;
  let threeMonths = ZERO;
  let overFourMonths = ZERO;
  let nonCurrentAccountCount = 0;
  for (const r of rows) {
    totalAR = totalAR.plus(r.netAmount);
    current = current.plus(r.current);
    oneMonth = oneMonth.plus(r.oneMonth);
    twoMonths = twoMonths.plus(r.twoMonths);
    threeMonths = threeMonths.plus(r.threeMonths);
    overFourMonths = overFourMonths.plus(r.overFourMonths);
    const nonCurrent = r.oneMonth.plus(r.twoMonths).plus(r.threeMonths).plus(r.overFourMonths);
    // AR-HIST-1 fix (2026-10-03) — count rows with ANY non-zero
    // non-current bucket (sum.abs() > 0.001). The prior `.gt(0)`
    // undercount missed rows where the net non-current sum is
    // negative (credit balances in aged buckets). The founder's
    // directive §18 reports 93 non-current accounts; this logic
    // reconciles to that figure.
    if (nonCurrent.abs().gt(toMoney("0.001"))) nonCurrentAccountCount++;
  }
  const totalNum = Number(totalAR.toString());
  const currentNum = Number(current.toString());
  const currentPct = totalNum > 0 ? (currentNum / totalNum) * 100 : null;
  const nonCurrentPct = currentPct != null ? 100 - currentPct : null;
  return {
    totalAR,
    current,
    oneMonth,
    twoMonths,
    threeMonths,
    overFourMonths,
    currentPct,
    nonCurrentPct,
    accountCount: rows.length,
    nonCurrentAccountCount,
  };
}

function parseMoney(cell: unknown): Prisma.Decimal {
  if (cell == null || cell === "") return ZERO;
  if (typeof cell === "number") {
    if (!Number.isFinite(cell)) return ZERO;
    return toMoney(cell.toFixed(2));
  }
  const s = String(cell).trim();
  if (s === "") return ZERO;
  // Strip currency formatting: $, commas, parens-for-negative.
  const negative = /^\(.*\)$/.test(s);
  const cleaned = s.replace(/[\$,()\s]/g, "");
  if (cleaned === "" || cleaned === "-") return ZERO;
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return ZERO;
  const abs = Math.abs(n);
  return toMoney((negative ? -abs : n).toFixed(2));
}

function strOrNull(cell: unknown): string | null {
  if (cell == null) return null;
  const s = String(cell).trim();
  return s === "" ? null : s;
}

function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

function emptyResult(warnings: string[]): ArAgingParseResult {
  return {
    rows: [],
    totals: {
      totalAR: ZERO,
      current: ZERO,
      oneMonth: ZERO,
      twoMonths: ZERO,
      threeMonths: ZERO,
      overFourMonths: ZERO,
      currentPct: null,
      nonCurrentPct: null,
      accountCount: 0,
      nonCurrentAccountCount: 0,
    },
    rowReconciliations: [],
    rowsFailingReconciliation: [],
    aggregateReconcilesPerRow: false,
    warnings,
  };
}
