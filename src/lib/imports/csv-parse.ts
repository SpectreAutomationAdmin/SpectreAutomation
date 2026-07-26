// CSV parsing + per-domain header aliasing for the New Batch flow.
//
// The legacy parser was a one-liner `line.split(",")` that broke on:
//   • quoted fields containing commas        ("Acme, Inc.")
//   • quoted fields containing newlines      Jonas-style headers like
//                                            "G/L Account\nCode" become
//                                            two separate "lines" and
//                                            the header row is mangled
//   • RFC 4180 doubled-quote escaping        ("Bob ""Big"" Robertson")
//
// This module replaces it with a strict RFC 4180 state machine
// (`parseCsvRecords` → `parseCsvRows`) and exposes per-domain header
// aliases. For COA, an admin who exports their chart from Jonas (or
// any other accounting system) gets sensible mappings without having
// to edit the file by hand: "G/L Account Code" → number,
// "G/L Account Description" → name, etc.

import type { ImportDomain } from "./templates";

// ---------------------------------------------------------------------------
// RFC 4180 parser
// ---------------------------------------------------------------------------

/**
 * Tokenise the CSV text into rows of string fields. Handles quoted
 * fields with embedded commas + newlines + doubled-quote escapes.
 * Strips fully-blank rows.
 */
export function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        // Doubled quote inside a quoted field → literal quote.
        if (text[i + 1] === '"') {
          field += '"';
          i++;
          continue;
        }
        // End of quoted field.
        inQuotes = false;
        continue;
      }
      field += ch;
      continue;
    }
    // Not in quotes.
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(field);
      field = "";
      continue;
    }
    if (ch === "\r") {
      // Swallow \r — \n on next iteration closes the row.
      continue;
    }
    if (ch === "\n") {
      row.push(field);
      pushRowIfNotEmpty(records, row);
      row = [];
      field = "";
      continue;
    }
    field += ch;
  }
  // Trailing row without a final newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    pushRowIfNotEmpty(records, row);
  }
  return records;
}

function pushRowIfNotEmpty(records: string[][], row: string[]) {
  if (row.some((c) => c.trim().length > 0)) records.push(row);
}

// ---------------------------------------------------------------------------
// Header normalisation
// ---------------------------------------------------------------------------

/** Collapse newlines + repeated whitespace, lowercase, trim.
 *  Also strips trailing parenthetical hints like "(optional)" or
 *  "(optional, semicolon-delimited)" — the COA XLSX template uses
 *  these as in-cell labels for power users, but the alias table
 *  matches against the bare column name. */
function canonicaliseHeader(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .trim()
    .toLowerCase();
}

// COA — every common variant an admin might emit, mapping to the
// canonical key the validator understands.
//
// Source variants observed in the wild:
//   • Jonas Trial Balance / COA exports → "G/L Account Code" /
//     "G/L Account Description" (with embedded newline between the
//     two words)
//   • Excel-exported COAs → "Account #", "Account Name"
//   • Spectre-native       → "number", "name"
//   • Camel-cased ERP      → "accountNumber", "accountName" /
//                            "accountDescription"
//
// All map to the canonical pair `number` + `name`. The validator
// + mapping UI take it from there.
const COA_HEADER_ALIASES: Record<string, string> = {
  // number
  "number": "number",
  "account number": "number",
  "account no": "number",
  "account no.": "number",
  "account #": "number",
  "account code": "number",
  "accountnumber": "number",
  "accountcode": "number",
  "g/l account code": "number",
  "gl account code": "number",
  "g/l code": "number",
  "gl code": "number",
  "code": "number",
  // name
  "name": "name",
  "account name": "name",
  "accountname": "name",
  "account description": "name",
  "accountdescription": "name",
  "description": "name",
  "g/l account description": "name",
  "gl account description": "name",
  "g/l account name": "name",
  "gl account name": "name",
  // type (legacy full-format columns continue to feed through)
  "type": "type",
  "account type": "type",
  "accounttype": "type",
  // categoryKey
  "categorykey": "categoryKey",
  "category key": "categoryKey",
  "category": "categoryKey",
  // fsGroupKey
  "fsgroupkey": "fsGroupKey",
  "fs group key": "fsGroupKey",
  "fs group": "fsGroupKey",
  "financial statement group": "fsGroupKey",
  // departmentCode / departmentCodes
  "departmentcode": "departmentCode",
  "department code": "departmentCode",
  "department": "departmentCode",
  "departmentcodes": "departmentCodes",
  "department codes": "departmentCodes",
  "departments": "departmentCodes",
};

// Founder rule 2026-06-30 v14 — Jonas Trial Balance import.
// The Jonas TB export ships with these exact column headers:
//   "G/L Account Code"        (with embedded \n between "Account" and "Code")
//   "G/L Account Description" (with embedded \n)
//   "Closing Bal Debit"       (with embedded \n)
//   "Closing Bal Credit"      (with embedded \n)
// canonicaliseHeader collapses the newlines to a single space,
// so the lookup keys below are the post-normalisation forms.
const OPENING_TRIAL_BALANCE_ALIASES: Record<string, string> = {
  // account number / code
  "accountnumber": "accountNumber",
  "account number": "accountNumber",
  "account code": "accountNumber",
  "account no": "accountNumber",
  "account no.": "accountNumber",
  "account #": "accountNumber",
  "code": "accountNumber",
  "number": "accountNumber",
  "g/l account code": "accountNumber",
  "gl account code": "accountNumber",
  "g/l code": "accountNumber",
  "gl code": "accountNumber",
  // description / name
  "description": "description",
  "account description": "description",
  "accountdescription": "description",
  "account name": "description",
  "accountname": "description",
  "name": "description",
  "g/l account description": "description",
  "gl account description": "description",
  "g/l account name": "description",
  "gl account name": "description",
  // debit
  "debit": "debit",
  "debits": "debit",
  "debit amount": "debit",
  "closing debit": "debit",
  "closing bal debit": "debit",
  "closing balance debit": "debit",
  "debit balance": "debit",
  // credit
  "credit": "credit",
  "credits": "credit",
  "credit amount": "credit",
  "closing credit": "credit",
  "closing bal credit": "credit",
  "closing balance credit": "credit",
  "credit balance": "credit",
};

const DOMAIN_HEADER_ALIASES: Partial<Record<ImportDomain, Record<string, string>>> = {
  COA: COA_HEADER_ALIASES,
  OPENING_TRIAL_BALANCE: OPENING_TRIAL_BALANCE_ALIASES,
};

/**
 * Rewrite raw header cells into the canonical keys the validator
 * expects, per domain. Unrecognised columns are passed through
 * verbatim (still trimmed) so callers can read them by their
 * original name.
 */
export function aliasHeaders(domain: ImportDomain, rawHeaders: string[]): string[] {
  const table = DOMAIN_HEADER_ALIASES[domain];
  return rawHeaders.map((h) => {
    const key = canonicaliseHeader(h);
    if (table && table[key]) return table[key];
    // No alias hit — return the trimmed original (preserving the
    // operator's case for unknown columns so downstream readers can
    // still find them by name if they want).
    return h.replace(/\s+/g, " ").trim();
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// Founder rule 2026-06-30 v14.3 — auto-detect the trial balance
// "as-of" date from a Jonas title row like:
//   Row 1: 01 - Silver Springs Golf & Country Club
//   Row 2: Trial Balance for May, 2026
//   Row 3: Closing Period Balances
//   Row 4: G/L Account Code | G/L Account Description | ...
// Scans the first N rows (default 10) for the title pattern and
// returns the last calendar day of the referenced month. Returns
// null when nothing matches so the caller can fall back to a
// manual entry field.
//
// Kept in csv-parse (not xlsx-parse) because the function is pure
// (`string[][]` → `Date | null`) and xlsx-parse already imports
// from this module. Putting it here avoids a circular init.
const TB_MONTH_NAMES: Record<string, number> = {
  january: 0, february: 1, march: 2, april: 3, may: 4, june: 5,
  july: 6, august: 7, september: 8, october: 9, november: 10, december: 11,
  jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11,
};
const TB_TITLE_RE = /trial\s*balance\s*(?:for|as\s*of|as\s*at|at)?\s*[:\-]?\s*([a-z]+)[\s,]+(\d{4})/i;
export function detectTrialBalancePeriod(rows: string[][], scanRows = 10): Date | null {
  const limit = Math.min(rows.length, scanRows);
  for (let i = 0; i < limit; i++) {
    // Join every cell in the row so a title split across cells
    // ("Trial Balance for" | "May, 2026") still matches.
    const joined = rows[i].map((c) => (c ?? "").replace(/\s+/g, " ").trim()).filter(Boolean).join(" ");
    if (!joined) continue;
    const m = joined.match(TB_TITLE_RE);
    if (!m) continue;
    const monthName = m[1].toLowerCase();
    const monthIdx = TB_MONTH_NAMES[monthName];
    if (monthIdx === undefined) continue;
    const year = parseInt(m[2], 10);
    if (!Number.isFinite(year) || year < 2000 || year > 2100) continue;
    // Last day of month = day 0 of next month.
    return new Date(Date.UTC(year, monthIdx + 1, 0));
  }
  return null;
}

/**
 * Founder rule 2026-06-30 v14.3 — Trial Balance CSV wrapper.
 * Runs `parseCsvRecords` once, scans the first N rows for a
 * "Trial Balance for MONTH, YYYY" title, then locates the
 * canonical header row and applies the alias table to everything
 * after it. Returns { rows, detectedAsOfDate } so the caller can
 * persist the detected period on the batch alongside the row set.
 * Mirror of `parseTrialBalanceXlsx` in xlsx-parse.ts.
 */
export function parseTrialBalanceCsv(
  text: string,
): { rows: Record<string, string>[]; detectedAsOfDate: Date | null } {
  const records = parseCsvRecords(text);
  if (records.length === 0) return { rows: [], detectedAsOfDate: null };
  const detectedAsOfDate = detectTrialBalancePeriod(records);
  // Locate the header row so pre-header title/blank lines don't
  // pollute the data rows. Header aliases already tolerate
  // Jonas's \n-embedded headers because canonicaliseHeader
  // collapses whitespace before matching.
  const HEADER_KEYWORDS = new Set([
    "g/l account code", "gl account code", "account code",
    "account number", "account #", "number", "code",
    "accountnumber", "accountcode",
  ]);
  let headerIdx = -1;
  for (let i = 0; i < records.length; i++) {
    const lc = records[i].map((c) => canonicaliseHeader(String(c ?? "")));
    if (lc.some((cell) => HEADER_KEYWORDS.has(cell))) { headerIdx = i; break; }
  }
  if (headerIdx < 0) return { rows: [], detectedAsOfDate };
  const headers = aliasHeaders("OPENING_TRIAL_BALANCE", records[headerIdx]);
  const rows = records.slice(headerIdx + 1).map((cols) => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => { row[h] = (cols[i] ?? "").trim(); });
    return row;
  });
  return { rows, detectedAsOfDate };
}

/**
 * Parse a CSV file's text into an array of row objects keyed by
 * canonical column names (after domain-specific header aliasing).
 *
 * Returns `[]` if the file is empty or contains only a header row.
 */
export function parseCsvRows(
  text: string,
  opts?: { domain?: ImportDomain },
): Record<string, string>[] {
  const records = parseCsvRecords(text);
  if (records.length === 0) return [];
  const headerRow = records[0];
  const headers = opts?.domain
    ? aliasHeaders(opts.domain, headerRow)
    : headerRow.map((h) => h.replace(/\s+/g, " ").trim());
  return records.slice(1).map((cols) => {
    const row: Record<string, string> = {};
    headers.forEach((h, i) => {
      row[h] = (cols[i] ?? "").trim();
    });
    return row;
  });
}
