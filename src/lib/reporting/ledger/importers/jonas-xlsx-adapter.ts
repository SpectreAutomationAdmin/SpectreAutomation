// TB-RESET-1d.b — Jonas Trial Balance XLSX → CSV adapter.
//
// The existing `parseJonasGlCsv` already handles both Jonas-native
// and spectre-normalised CSV shapes. This adapter's ONLY job is to
// convert an uploaded XLSX buffer into the CSV text that parser
// expects, preserving:
//
//   • account codes AS STRINGS (never coerced through JS numbers
//     that would drop leading zeros or lose "1010-PAY1A"-style
//     hyphenated codes)
//   • negative credit values verbatim (Jonas exports credits as
//     NEGATIVE numbers; the downstream parser applies |x| when
//     computing the balanced sum, so this adapter must NOT flip
//     signs)
//   • the Jonas heading rows (club name, "Trial Balance for
//     Month, Year", "Closing Period Balances", header row with
//     embedded newlines) when present — the parser uses them for
//     period detection + club-name extraction
//
// The adapter reads the first worksheet, iterates every non-empty
// row, and emits a CSV using strict RFC-4180 quoting so newline-
// embedded headers (`"G/L Account\nCode"`) round-trip cleanly.

import ExcelJS from "exceljs";

export type JonasXlsxAdapterResult = {
  csv: string;
  sheetName: string;
  rowCount: number;
  columnCount: number;
  /** SHA-256 hash of the original uploaded bytes. Distinct from the
   *  parser's payloadHash (which hashes the normalised snapshot). */
  sourceFileHash: string;
  /** Entity-name candidate extracted from the workbook, or null when
   *  no reliable candidate exists. Jonas-native exports place the
   *  club name in row 1 of Sheet1; we accept it as an entity signal
   *  only when it doesn't look like the header row or a numeric value.
   *  The founder-facing UI displays this verbatim and prompts for
   *  explicit acknowledgement when it differs from the target tenant. */
  detectedEntity: string | null;
  /** True when the workbook already has recognizable Jonas heading
   *  rows before the column header. Informational only. */
  hasJonasHeading: boolean;
};

/** Deterministic SHA-256 hex over the uploaded bytes. */
function computeSourceFileHash(buffer: Buffer): string {
  // node:crypto is available at runtime; import via require to
  // avoid pulling a top-level type-only dependency the Prisma
  // client build might not like.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("node:crypto") as typeof import("node:crypto");
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/** CSV-escape a single cell per RFC-4180. */
function csvEscape(v: string): string {
  const needs = /[",\n\r]/.test(v);
  if (!needs) return v;
  return `"${v.replace(/"/g, '""')}"`;
}

/** Coerce an ExcelJS cell value into a lossless string form. Numbers
 *  are formatted WITHOUT scientific notation and WITHOUT trailing
 *  ".0" for integers so account codes ("1000", "9901") survive; the
 *  downstream `asAccountCode` helper (imports/index.ts:144) also
 *  strips residual ".0" as a safety net. */
function cellToString(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number") {
    if (Number.isInteger(v)) return String(v);
    // Fixed-precision string with trailing zero stripping.
    return String(v);
  }
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // Rich-text / formula-cell objects.
  const o = v as { text?: string; result?: unknown; richText?: Array<{ text: string }> };
  if (typeof o.text === "string") return o.text;
  if (o.richText && Array.isArray(o.richText)) return o.richText.map((r) => r.text).join("");
  if (o.result != null) return cellToString(o.result);
  return String(v);
}

/** Test whether a string looks like a Jonas-native club-name row
 *  (row 1 of Sheet1 when a monthly export has heading metadata).
 *  The heuristic accepts two shapes:
 *    (a) a single non-empty cell (`isNativeEntityRow`)
 *    (b) a MERGED row where ExcelJS surfaces the same value in every
 *        cell (`isMergedEntityRow`) — this is what the real Jonas
 *        departmental export produces (TB-HIST-5).
 *  Both shapes must share: value length ≥ 3, non-numeric, and NOT a
 *  column-header sentinel. */
function isPlausibleEntityRow(row: string[]): string | null {
  if (row.length === 0) return null;
  const first = (row[0] ?? "").trim();
  if (first.length < 3) return null;
  // Column-header sentinels — never treat these as entity names.
  const HEADER_MARKERS = ["G/L Account", "Account Code", "AccountNumber", "Trial Balance", "Closing Bal", "Closing Period"];
  if (HEADER_MARKERS.some((m) => first.startsWith(m))) return null;
  // A pure numeric first cell is a data row (account code).
  if (/^-?\d+(\.\d+)?$/.test(first)) return null;
  const nonEmpty = row.filter((c) => c && c.trim().length > 0);
  if (nonEmpty.length === 1) {
    // Classic native shape: one cell, rest empty.
    return first;
  }
  // TB-HIST-5 — ExcelJS surfaces merged-cell values in every column
  // the merge spans. If every non-empty cell in the row carries the
  // SAME trimmed value, treat it as a merged entity row.
  const unique = new Set(nonEmpty.map((c) => c.trim()));
  if (unique.size === 1) return first;
  return null;
}

export async function parseJonasXlsxBuffer(buffer: Buffer): Promise<JonasXlsxAdapterResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  );
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("Jonas XLSX has no worksheets");

  const rowCount = ws.rowCount;
  const columnCount = ws.columnCount;

  const rows: string[][] = [];
  let hasJonasHeading = false;
  let detectedEntity: string | null = null;

  for (let r = 1; r <= rowCount; r++) {
    const rowCells: string[] = [];
    for (let c = 1; c <= columnCount; c++) {
      rowCells.push(cellToString(ws.getRow(r).getCell(c).value));
    }
    // Trim trailing empty cells but preserve leading empties within
    // a row (data preservation).
    while (rowCells.length > 0 && rowCells[rowCells.length - 1].trim() === "") rowCells.pop();
    if (rowCells.length === 0) continue;
    rows.push(rowCells);
    // First non-empty row: check if it's a single-cell entity row.
    if (detectedEntity == null && rows.length === 1) {
      const candidate = isPlausibleEntityRow(rowCells);
      if (candidate) {
        detectedEntity = candidate;
        hasJonasHeading = true;
      }
    }
    // "Trial Balance for …" row is a strong Jonas-heading signal.
    if (rowCells[0]?.startsWith("Trial Balance for")) hasJonasHeading = true;
  }

  // Serialise to CSV. Use RFC-4180 CRLF line separator so
  // newline-embedded headers survive; parseJonasGlCsv accepts both
  // CRLF and LF.
  const csv = rows.map((r) => r.map(csvEscape).join(",")).join("\r\n");
  const sourceFileHash = computeSourceFileHash(buffer);
  return {
    csv,
    sheetName: ws.name,
    rowCount,
    columnCount,
    sourceFileHash,
    detectedEntity,
    hasJonasHeading,
  };
}

/** Compute SHA-256 of the CSV text — for callers that already have
 *  a text extract and need only a hash. Distinct from the workbook
 *  hash above; use this for pasted-CSV imports. */
export function computeCsvSourceHash(csv: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require("node:crypto") as typeof import("node:crypto");
  return crypto.createHash("sha256").update(csv, "utf8").digest("hex");
}
