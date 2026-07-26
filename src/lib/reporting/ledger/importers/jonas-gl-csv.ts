// Jonas GL Trial Balance / GL export — CSV format + parser.
//
// Real Jonas Club Management exports a CSV with one row per account.
// This parser accepts TWO input shapes transparently:
//
//   (1) JONAS-NATIVE export — the file you get when you "Export to
//       CSV" from Jonas's Trial Balance screen, unmodified. Layout:
//         row 1 — club name
//         row 2 — "Trial Balance for <Month>, <Year>"
//         row 3 — sub-heading ("Closing Period Balances")
//         row 4 — header with embedded newlines:
//                   "G/L Account\nCode",
//                   "G/L Account\nDescription",
//                   "Closing Bal\nDebit",
//                   "Closing Bal\nCredit"
//         row 5+ — account rows; currency values may include "$",
//                  commas, and signs (Jonas exports credits as
//                  NEGATIVE values, e.g. "-$1,481,969.03").
//       The parser detects this shape, infers fiscalYear /
//       fiscalPeriod from the period heading, computes
//       periodBalance = |debit| − |credit| (safe across both
//       sign conventions), defaults ytdBalance = periodBalance,
//       then hands the normalized CSV to the standard parser.
//
//   (2) SPECTRE-NORMALISED — the founder-spec'd column set:
//         AccountNumber, AccountDescription, PeriodBalance,
//         YTDBalance, FiscalYear, FiscalPeriod
//       Optional columns: Debit, Credit, Department, AccountType.
//
// Numbers may be quoted, may contain commas as thousands
// separators, and may use parentheses for negatives — all
// Jonas-output conventions. The parser normalises into raw
// JavaScript numbers.

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Canonical row shape after parse + validation. One per CSV line. */
export type JonasGlCsvRow = {
  /** Source line number (1-indexed, header is line 1). */
  lineNumber: number;
  accountNumber: string;
  accountDescription: string;
  /** Activity for the reporting period (signed; positive = natural
   *  balance side). */
  periodBalance: number;
  /** Year-to-date balance through the reporting period (signed). */
  ytdBalance: number;
  fiscalYear: string;
  fiscalPeriod: number;
  /** Optional debit/credit splits when the source provides them. */
  debit: number | null;
  credit: number | null;
  /** Optional department code from the Jonas extract. */
  department: string | null;
  /** Optional Jonas-side account type ("Asset" / "Liability" / ...).
   *  Used as a fallback hint when no explicit category mapping
   *  exists for the account number. */
  jonasAccountType: string | null;
};

/** Per-row validation error. */
export type JonasGlCsvRowError = {
  lineNumber: number;
  /** Source CSV text of the offending line (truncated). */
  rawLine: string;
  /** Column name that triggered the error (when known). */
  column: string | null;
  /** Human-readable description. */
  message: string;
};

/** File-level validation error. */
export type JonasGlCsvFileError = {
  kind: "missing-header" | "missing-column" | "empty" | "parse-failure";
  message: string;
  /** Headers seen — populated for missing-column errors. */
  seenHeaders?: string[];
};

/** Metadata inferred from a Jonas-native trial-balance heading.
 *  Populated only when the source CSV was the raw Jonas export
 *  (with the "Trial Balance for <Month>, <Year>" preamble). Null
 *  for spectre-normalised inputs that lack a period heading. */
export type JonasHeadingMetadata = {
  /** Calendar year from the period heading (e.g. 2026). */
  calendarYear: number;
  /** Calendar month from the period heading (1..12). */
  calendarMonth: number;
  /** Inferred statement date — final calendar day of the heading's
   *  month, at end-of-day UTC. A Jonas Trial Balance is always
   *  as-at month-end. */
  periodEndDate: Date;
  /** Fiscal year inferred from the heading (same as calendarYear
   *  when the club aligns its FY to the calendar year). */
  fiscalYear: number;
  /** Fiscal period 1..12 — derived from calendarMonth (the parser
   *  treats month and fiscal-period as equivalent; clubs whose FY
   *  doesn't align to the calendar can re-interpret downstream). */
  fiscalPeriod: number;
};

/** Successful parse output. */
export type JonasGlCsvParseSuccess = {
  ok: true;
  rows: JonasGlCsvRow[];
  /** Per-row warnings (e.g. unrecognised optional columns). */
  warnings: JonasGlCsvRowError[];
  /** Set when the source CSV was a Jonas-native trial-balance
   *  export (3 preamble rows + multi-line headers). Lets the
   *  importer derive period dates without operator input. */
  headingMetadata: JonasHeadingMetadata | null;
};

/** Failed parse output. */
export type JonasGlCsvParseFailure = {
  ok: false;
  fileErrors: JonasGlCsvFileError[];
  rowErrors: JonasGlCsvRowError[];
};

export type JonasGlCsvParseResult = JonasGlCsvParseSuccess | JonasGlCsvParseFailure;

// ---------------------------------------------------------------------------
// Required vs optional columns
// ---------------------------------------------------------------------------

const REQUIRED_COLUMNS = [
  "accountnumber",
  "accountdescription",
  "periodbalance",
  "ytdbalance",
  "fiscalyear",
  "fiscalperiod",
] as const;

const OPTIONAL_COLUMNS = [
  "debit",
  "credit",
  "department",
  "accounttype",
] as const;

/** Normalise header text — lowercase, strip spaces, hyphens,
 *  underscores. So "Account Number", "Account_Number", "AcctNum"
 *  (no, that's different) all collapse to a single key. We accept
 *  small spelling variations on the column header. */
function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[\s_\-]+/g, "");
}

// ---------------------------------------------------------------------------
// Tiny CSV tokenizer — comma-separated, optionally double-quoted
// ---------------------------------------------------------------------------

/** Split a CSV line into fields, honouring "..." quoting and `""`
 *  escape sequences inside quoted fields. Leading/trailing
 *  whitespace inside unquoted fields is trimmed. */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let i = 0;
  while (i <= line.length) {
    let field = "";
    if (line[i] === '"') {
      // Quoted field.
      i++;
      while (i < line.length) {
        if (line[i] === '"') {
          if (line[i + 1] === '"') {
            field += '"';
            i += 2;
          } else {
            i++;
            break;
          }
        } else {
          field += line[i];
          i++;
        }
      }
      // Skip until the next comma or end.
      while (i < line.length && line[i] !== ",") i++;
    } else {
      // Unquoted field — read until comma / EOL.
      while (i < line.length && line[i] !== ",") {
        field += line[i];
        i++;
      }
      field = field.trim();
    }
    fields.push(field);
    if (i >= line.length) break;
    // Skip the comma.
    if (line[i] === ",") i++;
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Number parsing — handles "$1,234.56", "(1,234.56)", "-1234"
// ---------------------------------------------------------------------------

/** Parse a Jonas-formatted numeric string. Accepts:
 *    - "1234.56"
 *    - "1,234.56"     (thousands separators)
 *    - "$1,234.56"    (currency prefix)
 *    - "(1,234.56)"   (accountant-style negatives)
 *    - ""             → null (empty cell)
 *  Returns `null` when the cell is empty; throws on unparseable. */
function parseJonasNumber(raw: string): number | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  // Negative if wrapped in parens.
  const isNegative = trimmed.startsWith("(") && trimmed.endsWith(")");
  // Strip currency, commas, parens, and any leading sign.
  const cleaned = trimmed
    .replace(/[$,()]/g, "")
    .trim();
  const value = Number(cleaned);
  if (!Number.isFinite(value)) {
    throw new Error(`'${raw}' is not a valid number`);
  }
  return isNegative ? -Math.abs(value) : value;
}

// ---------------------------------------------------------------------------
// Jonas-native multi-line CSV record parser
// ---------------------------------------------------------------------------
//
// The Jonas trial-balance export wraps column headers in quoted
// fields that contain literal newlines, e.g.
//   "G/L Account
//   Code"
// `splitCsvLine` above splits on physical lines and CAN'T see
// these as a single field. This helper walks the whole document
// character-by-character so quoted fields can span multiple
// physical lines.
//
// Returns an array of records; each record is an array of field
// strings (whitespace and quotes preserved).

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let currentRecord: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let pending = false; // any character read into the current record?
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          currentField += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
        continue;
      }
      currentField += ch;
      pending = true;
      i++;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      pending = true;
      i++;
      continue;
    }
    if (ch === ",") {
      currentRecord.push(currentField);
      currentField = "";
      pending = true;
      i++;
      continue;
    }
    if (ch === "\r") {
      i++; // collapse \r\n into a single \n event
      continue;
    }
    if (ch === "\n") {
      if (pending) {
        currentRecord.push(currentField);
        records.push(currentRecord);
        currentRecord = [];
        currentField = "";
        pending = false;
      }
      i++;
      continue;
    }
    currentField += ch;
    pending = true;
    i++;
  }
  if (pending) {
    currentRecord.push(currentField);
    records.push(currentRecord);
  }
  // Drop trailing all-empty records.
  while (records.length > 0) {
    const last = records[records.length - 1];
    if (last.every((f) => f.trim() === "")) records.pop();
    else break;
  }
  return records;
}

// ---------------------------------------------------------------------------
// Jonas-native detection + normalisation
// ---------------------------------------------------------------------------

const MONTH_PREFIXES = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];

function monthNameToNumber(name: string): number | null {
  const lower = name.toLowerCase().slice(0, 3);
  const idx = MONTH_PREFIXES.indexOf(lower);
  return idx >= 0 ? idx + 1 : null;
}

/** Whitespace-collapse + lowercase a Jonas header cell so embedded
 *  newlines/multi-space variants match a regex predictably. */
function collapseHeader(cell: string): string {
  return cell.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Detect a Jonas-native trial-balance export. Looks for BOTH:
 *   • a "Trial Balance for <Month>, <Year>" line in the preamble
 *     (first ~10 records), and
 *   • a header record containing "g/l account" + "closing bal"
 *     after whitespace collapse.
 *
 * Returns the header-record index and the inferred fiscal year +
 * fiscal period, or null when the input isn't Jonas-native.
 */
function detectJonasNativeFormat(records: string[][]): {
  headerRecordIndex: number;
  fiscalYear: number;
  fiscalPeriod: number;
} | null {
  const scanDepth = Math.min(10, records.length);

  // Pass 1 — period heading.
  let fiscalYear: number | null = null;
  let fiscalPeriod: number | null = null;
  for (let i = 0; i < scanDepth; i++) {
    for (const field of records[i]) {
      const m = /Trial\s+Balance\s+for\s+([A-Za-z]+)[,\s]+(\d{4})/i.exec(field);
      if (m) {
        const fp = monthNameToNumber(m[1]);
        const fy = Number(m[2]);
        if (fp !== null && Number.isFinite(fy)) {
          fiscalPeriod = fp;
          fiscalYear = fy;
        }
        break;
      }
    }
    if (fiscalYear !== null) break;
  }

  // Pass 2 — header row.
  let headerRecordIndex = -1;
  for (let i = 0; i < scanDepth; i++) {
    const cells = records[i].map(collapseHeader);
    const hasAccountCol = cells.some((c) => /g\/?l\s*account/.test(c));
    const hasClosingBal = cells.some((c) => /closing\s*bal/.test(c));
    if (hasAccountCol && hasClosingBal) {
      headerRecordIndex = i;
      break;
    }
  }

  if (headerRecordIndex < 0 || fiscalYear === null || fiscalPeriod === null) {
    return null;
  }
  return { headerRecordIndex, fiscalYear, fiscalPeriod };
}

/**
 * If the input is Jonas-native, transform it into the
 * spectre-normalised CSV string the standard parser consumes.
 * Returns null when the input doesn't look like Jonas-native — the
 * caller falls through to the standard parser unchanged.
 *
 * Numeric convention:
 *   periodBalance = |debit| − |credit|
 *   This handles Jonas's credit-as-negative convention AND the
 *   standard credit-as-positive convention safely:
 *     • debit=$2,126,855.30 credit=$0           → +2,126,855.30
 *     • debit=$0           credit=-$1,481,969.03 → −1,481,969.03
 *     • debit=$0           credit=$1,481,969.03  → −1,481,969.03
 */
/** Result of the Jonas-native pre-normalisation step. */
type JonasNormalisationResult = {
  /** The spectre-canonical CSV string ready for the standard parser. */
  normalisedCsv: string;
  /** Heading metadata captured from the Jonas preamble. */
  metadata: JonasHeadingMetadata;
};

function lastDayOfMonthUtcEnd(year: number, month1to12: number): Date {
  // Day 0 of next month = last day of current month, at end-of-day.
  return new Date(Date.UTC(year, month1to12, 0, 23, 59, 59, 999));
}

function normalizeJonasNativeCsv(csv: string): JonasNormalisationResult | null {
  const records = parseCsvRecords(csv);
  if (records.length === 0) return null;

  const detection = detectJonasNativeFormat(records);
  if (!detection) return null;

  const headerCells = records[detection.headerRecordIndex].map(collapseHeader);
  const findIdx = (pattern: RegExp): number =>
    headerCells.findIndex((c) => pattern.test(c));

  const codeIdx = findIdx(/g\/?l\s*account\s*code|^account\s*(code|number)$/);
  const descIdx = findIdx(/g\/?l\s*account\s*description|^account\s*description$/);
  const debitIdx = findIdx(/closing\s*bal\s*debit|^debit$/);
  const creditIdx = findIdx(/closing\s*bal\s*credit|^credit$/);
  // Optional Jonas extras.
  const deptIdx = findIdx(/^department$/);
  const typeIdx = findIdx(/^account\s*type$/);

  if (codeIdx < 0 || descIdx < 0 || debitIdx < 0 || creditIdx < 0) {
    return null;
  }

  const out: string[][] = [];
  const outHeader = [
    "AccountNumber",
    "AccountDescription",
    "PeriodBalance",
    "YTDBalance",
    "FiscalYear",
    "FiscalPeriod",
    "Debit",
    "Credit",
  ];
  if (deptIdx >= 0) outHeader.push("Department");
  if (typeIdx >= 0) outHeader.push("AccountType");
  out.push(outHeader);

  for (let i = detection.headerRecordIndex + 1; i < records.length; i++) {
    const record = records[i];
    const code = (record[codeIdx] ?? "").trim();
    const desc = (record[descIdx] ?? "").trim();
    // Skip blanks, footers, and obvious total rows.
    if (!code) continue;
    if (/\s/.test(code)) continue; // "Grand Total", "Net Income", etc.

    let debit = 0;
    let credit = 0;
    try {
      debit = parseJonasNumber(record[debitIdx] ?? "") ?? 0;
      credit = parseJonasNumber(record[creditIdx] ?? "") ?? 0;
    } catch {
      continue; // unparseable numeric → skip the row
    }
    // periodBalance = |debit| − |credit| (signed, debit-positive).
    // For a credit account this is NEGATIVE — matches the user's
    // spec example.
    const periodBalance = Math.abs(debit) - Math.abs(credit);
    // ytdBalance = natural-side magnitude (positive regardless of
    // whether the balance lives on the debit or credit side). The
    // standard parser + downstream reconciliation expect YTD to be
    // positive on the account's natural side; the IS/BS projections
    // re-sign per category. Emitting ABS here keeps the
    // reconciliation totals honest.
    const ytdBalance = Math.abs(periodBalance);
    // Emit Debit + Credit as POSITIVE magnitudes so the standard
    // importer's reconcile() sums them as plain unsigned numbers.
    const debitOut = Math.abs(debit);
    const creditOut = Math.abs(credit);

    const row = [
      code,
      desc,
      String(periodBalance),
      String(ytdBalance),
      String(detection.fiscalYear),
      String(detection.fiscalPeriod),
      String(debitOut),
      String(creditOut),
    ];
    if (deptIdx >= 0) row.push((record[deptIdx] ?? "").trim());
    if (typeIdx >= 0) row.push((record[typeIdx] ?? "").trim());
    out.push(row);
  }

  const normalisedCsv = out.map((r) => r.map(csvQuote).join(",")).join("\n");
  return {
    normalisedCsv,
    metadata: {
      calendarYear: detection.fiscalYear,
      calendarMonth: detection.fiscalPeriod,
      periodEndDate: lastDayOfMonthUtcEnd(detection.fiscalYear, detection.fiscalPeriod),
      fiscalYear: detection.fiscalYear,
      fiscalPeriod: detection.fiscalPeriod,
    },
  };
}

function csvQuote(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

/**
 * Parse a Jonas GL CSV extract. Pure function — no I/O. Returns
 * either a success result with normalized rows or a failure result
 * with file-level and per-row errors.
 *
 * Parse strategy:
 *   1. Split into non-empty lines.
 *   2. Treat the first line as the header.
 *   3. Verify every required column is present (case + spacing
 *      insensitive). Missing → file-level error.
 *   4. Walk each data row. Per-row errors don't abort the parse —
 *      they're collected so the importer can report the full
 *      diagnostics in one pass.
 *   5. Return success only when zero file errors AND zero row
 *      errors. Warnings (e.g. unused columns) don't fail.
 */
export function parseJonasGlCsv(csv: string): JonasGlCsvParseResult {
  const fileErrors: JonasGlCsvFileError[] = [];
  const rowErrors: JonasGlCsvRowError[] = [];
  const warnings: JonasGlCsvRowError[] = [];

  // Pre-process: if this looks like a raw Jonas-native trial-balance
  // export (3 preamble rows + multi-line headers + currency-string
  // numerics), normalise it to the spectre-canonical column shape
  // AND capture the heading metadata (period end, fiscal year/period)
  // so callers can populate the import form without operator input.
  // Returns null for any input that doesn't match the Jonas-native
  // signature — the standard parser then handles it unchanged.
  const normalisation = normalizeJonasNativeCsv(csv);
  const csvToParse = normalisation?.normalisedCsv ?? csv;
  const headingMetadata: JonasHeadingMetadata | null =
    normalisation?.metadata ?? null;

  const allLines = csvToParse.split(/\r?\n/);
  // Trim trailing empty lines (typical of CSV files that end with
  // a newline).
  while (allLines.length > 0 && allLines[allLines.length - 1].trim() === "") {
    allLines.pop();
  }

  if (allLines.length === 0) {
    fileErrors.push({ kind: "empty", message: "CSV is empty (no rows)." });
    return { ok: false, fileErrors, rowErrors };
  }

  // Parse header.
  const headerLine = allLines[0];
  const rawHeaders = splitCsvLine(headerLine);
  if (rawHeaders.length === 0 || rawHeaders.every((h) => h.trim() === "")) {
    fileErrors.push({
      kind: "missing-header",
      message: "CSV has no header row.",
    });
    return { ok: false, fileErrors, rowErrors };
  }

  const normalisedHeaders = rawHeaders.map(normalizeHeader);
  const columnIndex = new Map<string, number>();
  normalisedHeaders.forEach((h, idx) => columnIndex.set(h, idx));

  // Verify every required column is present.
  const missingColumns = REQUIRED_COLUMNS.filter((c) => !columnIndex.has(c));
  if (missingColumns.length > 0) {
    fileErrors.push({
      kind: "missing-column",
      message: `Required column(s) missing: ${missingColumns.join(", ")}.`,
      seenHeaders: rawHeaders,
    });
    return { ok: false, fileErrors, rowErrors };
  }

  // Warn (but don't fail) on unrecognised headers — the source may
  // include extra columns we don't use.
  const knownHeaders = new Set<string>([...REQUIRED_COLUMNS, ...OPTIONAL_COLUMNS]);
  for (const h of normalisedHeaders) {
    if (!knownHeaders.has(h)) {
      // Not a per-row warning, but informational — keep it cheap.
      // We don't add to fileErrors (it's not a failure).
    }
  }

  const rows: JonasGlCsvRow[] = [];

  for (let i = 1; i < allLines.length; i++) {
    const line = allLines[i];
    if (line.trim() === "") continue; // skip blank lines
    const lineNumber = i + 1;
    const fields = splitCsvLine(line);

    function getField(col: string): string {
      const idx = columnIndex.get(col);
      if (idx === undefined) return "";
      return fields[idx]?.trim() ?? "";
    }

    function addError(column: string | null, message: string): void {
      rowErrors.push({
        lineNumber,
        rawLine: line.length > 200 ? `${line.slice(0, 200)}…` : line,
        column,
        message,
      });
    }

    try {
      const accountNumber = getField("accountnumber");
      const accountDescription = getField("accountdescription");

      if (accountNumber === "") {
        addError("accountnumber", "AccountNumber is empty.");
        continue;
      }
      if (accountDescription === "") {
        addError("accountdescription", "AccountDescription is empty.");
        continue;
      }

      // Parse numerics.
      let periodBalance: number;
      let ytdBalance: number;
      try {
        periodBalance = parseJonasNumber(getField("periodbalance")) ?? 0;
      } catch (err) {
        addError("periodbalance", (err as Error).message);
        continue;
      }
      try {
        ytdBalance = parseJonasNumber(getField("ytdbalance")) ?? 0;
      } catch (err) {
        addError("ytdbalance", (err as Error).message);
        continue;
      }

      const fiscalYear = getField("fiscalyear");
      if (fiscalYear === "") {
        addError("fiscalyear", "FiscalYear is empty.");
        continue;
      }

      const fiscalPeriodRaw = getField("fiscalperiod");
      const fiscalPeriod = Number(fiscalPeriodRaw);
      if (
        !Number.isInteger(fiscalPeriod) ||
        fiscalPeriod < 1 ||
        fiscalPeriod > 12
      ) {
        addError(
          "fiscalperiod",
          `FiscalPeriod must be an integer 1..12; got '${fiscalPeriodRaw}'.`,
        );
        continue;
      }

      // Optional fields.
      let debit: number | null = null;
      let credit: number | null = null;
      const debitRaw = getField("debit");
      const creditRaw = getField("credit");
      if (debitRaw !== "") {
        try {
          debit = parseJonasNumber(debitRaw);
        } catch (err) {
          warnings.push({
            lineNumber,
            rawLine: line,
            column: "debit",
            message: `Debit value '${debitRaw}' ignored: ${(err as Error).message}.`,
          });
          debit = null;
        }
      }
      if (creditRaw !== "") {
        try {
          credit = parseJonasNumber(creditRaw);
        } catch (err) {
          warnings.push({
            lineNumber,
            rawLine: line,
            column: "credit",
            message: `Credit value '${creditRaw}' ignored: ${(err as Error).message}.`,
          });
          credit = null;
        }
      }

      const department = getField("department") || null;
      const jonasAccountType = getField("accounttype") || null;

      rows.push({
        lineNumber,
        accountNumber,
        accountDescription,
        periodBalance,
        ytdBalance,
        fiscalYear,
        fiscalPeriod,
        debit,
        credit,
        department,
        jonasAccountType,
      });
    } catch (err) {
      addError(null, `Unexpected parse error: ${(err as Error).message}`);
    }
  }

  if (fileErrors.length > 0 || rowErrors.length > 0) {
    return { ok: false, fileErrors, rowErrors };
  }
  return { ok: true, rows, warnings, headingMetadata };
}
