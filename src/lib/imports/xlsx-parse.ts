// XLSX import parser. Mirror of csv-parse.ts: extracts a
// `string[][]` of header + data rows from a workbook buffer so the
// existing createBatch pipeline can consume it as-is.
//
// Founder spec 2026-07-04: the Chart of Accounts import accepts the
// generated XLSX template directly. The template has six tabs;
// this parser reads ONLY the "Chart of Accounts" tab (the import
// surface) and ignores reference tabs.

import ExcelJS from "exceljs";

import { parseCsvRows, detectTrialBalancePeriod } from "./csv-parse";
import type { ImportDomain } from "./templates";

type ParsedRow = Record<string, string>;

const COA_SHEET_NAME = "Chart of Accounts";

/**
 * Parse an uploaded .xlsx into the same `string[][]` shape
 * `parseCsvRows` produces for CSV input.
 *
 * Strategy: extract the rows from the relevant sheet as CSV, then
 * route through the existing CSV parser. This guarantees identical
 * header-aliasing, type-key normalisation, and validation behaviour
 * regardless of whether the operator uploaded a CSV or an XLSX.
 */
export async function parseXlsxRows(
  buffer: Buffer,
  opts: { domain: ImportDomain },
): Promise<ParsedRow[]> {
  const wb = new ExcelJS.Workbook();
  // ExcelJS's typings expect an ArrayBuffer-backed view; pass the
  // underlying buffer to satisfy the loader regardless of how the
  // caller constructed the Buffer.
  await wb.xlsx.load(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  );

  // Pick the right tab. For COA imports, prefer the
  // "Chart of Accounts" tab name (the template's import surface).
  // Fall back to the first non-reference tab if the user renamed
  // it. For other domains use the first sheet.
  let ws: ExcelJS.Worksheet | undefined;
  if (opts.domain === "COA") {
    ws = wb.getWorksheet(COA_SHEET_NAME);
    if (!ws) {
      // Fall back to the first sheet that ISN'T a known reference
      // tab. This lets a power user rename the COA tab without
      // breaking the import.
      const referenceNames = new Set([
        "Instructions",
        "Types",
        "Categories",
        "FS Groups",
        "Departments",
      ]);
      ws = wb.worksheets.find((w) => !referenceNames.has(w.name));
    }
  } else {
    ws = wb.worksheets[0];
  }
  if (!ws) {
    throw new Error("Workbook contains no readable worksheet.");
  }

  // Pull every non-empty row as CSV. The first non-empty row that
  // looks like the spectre title band ("Spectre · Chart of …" /
  // "Chart of Accounts · Import Sheet") OR the subtitle band is
  // skipped — the parser starts at the first row that has a
  // recognisable header word like "Account Number" or "number".
  //
  // For non-COA domains: skip rows until the first row with ≥ 2
  // non-empty cells.
  const allRows = collectRows(ws);
  const headerStart = locateHeaderRow(allRows, opts.domain);
  const trimmed = headerStart >= 0 ? allRows.slice(headerStart) : allRows;
  if (trimmed.length === 0) {
    throw new Error("No data rows found in the workbook.");
  }
  const csv = toCsv(trimmed);
  return parseCsvRows(csv, { domain: opts.domain });
}

function collectRows(ws: ExcelJS.Worksheet): string[][] {
  const out: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const values: string[] = [];
    // ExcelJS row.values is 1-indexed; slice(1) to drop the
    // sentinel.
    const raw = Array.isArray(row.values) ? row.values.slice(1) : [];
    for (const v of raw) {
      values.push(stringify(v));
    }
    // Skip rows where every cell is empty.
    if (values.some((c) => c.trim().length > 0)) {
      out.push(values);
    }
  });
  return out;
}

function locateHeaderRow(rows: string[][], domain: ImportDomain): number {
  // For COA: the import sheet has a title band on row 1, subtitle
  // on row 2, and the header row on row 3. The header row contains
  // recognisable column names. Find the FIRST row whose cells
  // include any expected header alias.
  //
  // Founder rule 2026-06-30 v14 — Jonas TB headers have embedded
  // \n between words (e.g. "G/L Account\nCode"). Collapse ALL
  // whitespace runs to a single space BEFORE compare so Jonas
  // rows match keywords like "g/l account code".
  const headerKeywords = headerKeywordsFor(domain);
  for (let i = 0; i < rows.length; i++) {
    const lc = rows[i].map((c) => c.replace(/\s+/g, " ").trim().toLowerCase());
    if (headerKeywords.some((kw) => lc.includes(kw))) {
      return i;
    }
  }
  return -1;
}

// Re-export from csv-parse so callers that already reach for the
// xlsx-parse namespace keep working. `detectTrialBalancePeriod`
// is pure (string[][] → Date | null) so it lives in csv-parse to
// avoid a circular init between the two modules.
export { detectTrialBalancePeriod };

// Founder rule 2026-06-30 v14.3 — Trial Balance parser wrapper.
// Reads the workbook once, extracts raw rows, runs period
// detection against the pre-header rows, then re-uses the
// existing header-locate + alias pipeline to produce canonical
// rows. Returns both so the server action can persist the
// detected date on the batch alongside the row set.
export async function parseTrialBalanceXlsx(
  buffer: Buffer,
): Promise<{ rows: Record<string, string>[]; detectedAsOfDate: Date | null }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(
    buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer,
  );
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("Workbook contains no readable worksheet.");
  const allRows = collectRows(ws);
  const detectedAsOfDate = detectTrialBalancePeriod(allRows);
  const rows = await parseXlsxRows(buffer, { domain: "OPENING_TRIAL_BALANCE" });
  return { rows, detectedAsOfDate };
}

function headerKeywordsFor(domain: ImportDomain): string[] {
  if (domain === "COA") {
    return [
      "account number",
      "account #",
      "number",
      "account name",
      "name",
      "g/l account code",
      "g/l account description",
    ];
  }
  if (domain === "OPENING_TRIAL_BALANCE") {
    // Founder rule 2026-06-30 v14 — Jonas Trial Balance headers
    // (with the embedded \n between the two words already
    // collapsed by canonicaliseHeader by the time this list
    // matters; the raw match here compares after Row.map's
    // trim + lower).
    return [
      "accountnumber",
      "account number",
      "account code",
      "g/l account code",
      "gl account code",
      "closing bal debit",
      "closing balance debit",
      "debit",
    ];
  }
  // Other domains — return a permissive empty list so the first
  // non-empty row is used as-is.
  return [];
}

function stringify(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  // ExcelJS RichText / Hyperlink shapes.
  if (typeof v === "object") {
    const obj = v as { text?: string; richText?: Array<{ text?: string }>; result?: unknown };
    if (typeof obj.text === "string") return obj.text;
    if (Array.isArray(obj.richText)) return obj.richText.map((r) => r.text ?? "").join("");
    if (obj.result != null) return stringify(obj.result);
  }
  return String(v);
}

function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map(csvEscape).join(",")).join("\n");
}

function csvEscape(cell: string): string {
  if (/[",\r\n]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
  return cell;
}

/**
 * Quick "is this a plausibly-textual file?" check used by the
 * import action's unsupported-file-type guard. Reads the first
 * 4 KB and rejects when more than 5 % of bytes are NUL or
 * non-printable control characters (excluding whitespace) —
 * Word .doc, PDF, image, and other binary uploads land here
 * cleanly, while UTF-8 / Latin-1 / Windows-1252 CSVs pass.
 *
 * Only called by the action when `looksLikeXlsx` already returned
 * false, so a real .xlsx never hits this path.
 */
export function isLikelyTextual(buffer: Buffer): boolean {
  if (buffer.length === 0) return false;
  const sample = buffer.subarray(0, Math.min(4096, buffer.length));
  let suspicious = 0;
  for (let i = 0; i < sample.length; i++) {
    const b = sample[i];
    if (b === 0) {
      suspicious++;
      continue;
    }
    // Allow tab (9), LF (10), CR (13). Reject other < 32 controls.
    if (b < 32 && b !== 9 && b !== 10 && b !== 13) {
      suspicious++;
    }
  }
  return suspicious / sample.length < 0.05;
}

/** Detect XLSX by file extension OR by the OPC magic bytes. */
export function looksLikeXlsx(fileName: string, buffer?: Buffer): boolean {
  if (/\.xlsx$/i.test(fileName)) return true;
  if (buffer && buffer.length >= 4) {
    // XLSX files are ZIP containers — magic bytes PK\x03\x04.
    if (
      buffer[0] === 0x50 &&
      buffer[1] === 0x4b &&
      buffer[2] === 0x03 &&
      buffer[3] === 0x04
    ) {
      return true;
    }
  }
  return false;
}
