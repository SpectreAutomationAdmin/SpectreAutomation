// MEM-HIST-2 §5 / §16 / §13 (2026-10-03) — Jonas Member Master parser.
//
// Pure parser targeting the ACTUAL sanitized workbook column shape:
//
//   Status · Member # · Last Name · First Name · Membership Description
//   · Category#1 · Category#1 Description · Category#2 · Sex · Joined
//   · Resigned · Golf Classification · Member # to Bill · Minimum Billing
//   · BillBackUp
//
// Row 1 is a banner ("Coulee Ridge Golf & Country Club" × 15); the
// actual header lands at row 3 in the authorized workbook. The
// parser scans the first 15 rows for a "Member #" cell.
//
// Member # (and Member # to Bill) are STRINGS. Leading zeros and
// alphabetic suffixes are preserved verbatim per §2 / §12.
//
// Joined / Resigned may be:
//   - Excel date values (ExcelJS emits them as JS Date objects)
//   - the literal string "N/A"
//   - blank
// N/A and blank parse to null. Never fabricate dates.

import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import {
  interpretSourceStatus,
  isShareholderFromSourceStatus,
  type InterpretedMembershipStatus,
} from "./jonas-semantics";

export type JonasBillToOutcome = "SELF" | "RESOLVED" | "UNRESOLVED" | "INVALID";

export type JonasMemberMasterRow = {
  /** The source Member # verbatim — e.g. "0073", "0073A", "0110B". */
  memberNumber: string;
  firstName: string;
  lastName: string;
  sourceStatus: string;
  sourceMembershipDescription: string | null;
  sourceCategory1: string | null;
  sourceCategory1Description: string | null;
  sourceCategory2: string | null;
  sourceSex: string | null;
  sourceGolfClassification: string | null;
  joinedDate: Date | null;
  resignedDate: Date | null;
  billToMemberNumber: string | null;
  minimumBilling: string | null;
  billBackUp: string | null;
  interpretedStatus: InterpretedMembershipStatus;
  isShareholder: boolean;
};

export type JonasParseResult = {
  rows: JonasMemberMasterRow[];
  invalidRows: Array<{ rowIndex: number; reason: string; memberNumber: string | null }>;
  warnings: string[];
  sourceFileHash: string;
  sourceFileName: string | null;
  sourceEffectiveDate: Date;
  /** Pre-commit bill-to resolution outcomes (SELF/RESOLVED/UNRESOLVED
   *  per row). Populated by `resolveBillToOutcomes()`. */
  billToOutcomes: Array<{
    rowIndex: number;
    memberNumber: string;
    billToMemberNumber: string | null;
    outcome: JonasBillToOutcome;
  }>;
};

/** Public entry — parse an in-memory XLSX buffer. */
export async function parseJonasMemberMasterWorkbook(opts: {
  buffer: ArrayBuffer | Buffer;
  sourceFileName: string | null;
  sourceEffectiveDate: Date;
}): Promise<JonasParseResult> {
  const wb = new ExcelJS.Workbook();
  const buf = Buffer.isBuffer(opts.buffer) ? opts.buffer : Buffer.from(opts.buffer);
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  if (!ws) {
    return emptyResult(opts, "Workbook has no worksheets.");
  }
  const rows: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: unknown[] = [];
    const raw = (row.values as unknown[]) ?? [];
    for (let i = 1; i < raw.length; i++) cells.push(raw[i]);
    rows.push(cells);
  });
  const sourceFileHash = createHash("sha256").update(buf).digest("hex");
  return parseJonasMemberMasterRowValues({
    rows,
    sourceFileHash,
    sourceFileName: opts.sourceFileName,
    sourceEffectiveDate: opts.sourceEffectiveDate,
  });
}

/** Test seam — parse pre-extracted row arrays. The hash + name +
 *  effective date are passed in; the parser does not read the file
 *  system. */
export function parseJonasMemberMasterRowValues(opts: {
  rows: unknown[][];
  sourceFileHash: string;
  sourceFileName: string | null;
  sourceEffectiveDate: Date;
}): JonasParseResult {
  const warnings: string[] = [];
  if (opts.rows.length === 0) {
    return emptyResult({ ...opts, buffer: Buffer.alloc(0) }, "Workbook has no non-empty rows.");
  }

  // Find the header row (one containing "Member #") in the first 15.
  let headerIdx = -1;
  for (let i = 0; i < Math.min(15, opts.rows.length); i++) {
    const low = opts.rows[i].map((c) => normalizeHeader(String(c ?? "")));
    if (low.some((v) => v === "member #" || v === "member#" || v === "member no" || v === "member number")) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx === -1) {
    return {
      rows: [], invalidRows: [], warnings: [`Could not locate "Member #" column in the first 15 rows.`],
      sourceFileHash: opts.sourceFileHash, sourceFileName: opts.sourceFileName,
      sourceEffectiveDate: opts.sourceEffectiveDate, billToOutcomes: [],
    };
  }

  const header = opts.rows[headerIdx].map((c) => normalizeHeader(String(c ?? "")));
  const idx = (names: string[]): number => {
    for (const n of names) {
      const i = header.findIndex((h) => h === normalizeHeader(n));
      if (i !== -1) return i;
    }
    return -1;
  };
  const COL = {
    status: idx(["Status"]),
    memberNo: idx(["Member #", "Member#", "MemberNumber"]),
    last: idx(["Last Name"]),
    first: idx(["First Name"]),
    memDesc: idx(["Membership Description"]),
    cat1: idx(["Category#1", "Category #1"]),
    cat1Desc: idx(["Category#1 Description", "Category #1 Description"]),
    cat2: idx(["Category#2", "Category #2"]),
    sex: idx(["Sex"]),
    joined: idx(["Joined"]),
    resigned: idx(["Resigned"]),
    golfClass: idx(["Golf Classification"]),
    billTo: idx(["Member # to Bill"]),
    minBilling: idx(["Minimum Billing"]),
    billBackUp: idx(["BillBackUp"]),
  };
  if (COL.status === -1) warnings.push("Missing required column: Status");
  if (COL.memberNo === -1) warnings.push("Missing required column: Member #");

  if (warnings.length > 0) {
    return {
      rows: [], invalidRows: [], warnings,
      sourceFileHash: opts.sourceFileHash, sourceFileName: opts.sourceFileName,
      sourceEffectiveDate: opts.sourceEffectiveDate, billToOutcomes: [],
    };
  }

  const parsed: JonasMemberMasterRow[] = [];
  const invalid: JonasParseResult["invalidRows"] = [];
  const seenMemberNos = new Map<string, number>();

  for (let r = headerIdx + 1; r < opts.rows.length; r++) {
    const row = opts.rows[r];
    const memberNo = extractIdString(row[COL.memberNo]);
    if (memberNo === "") {
      invalid.push({ rowIndex: r, reason: "Missing Member #", memberNumber: null });
      continue;
    }
    const sourceStatus = String(row[COL.status] ?? "").trim();
    if (sourceStatus === "") {
      invalid.push({ rowIndex: r, reason: "Missing Status", memberNumber: memberNo });
      continue;
    }
    const parsedRow: JonasMemberMasterRow = {
      memberNumber: memberNo,
      firstName: COL.first !== -1 ? String(row[COL.first] ?? "").trim() : "",
      lastName: COL.last !== -1 ? String(row[COL.last] ?? "").trim() : "",
      sourceStatus,
      sourceMembershipDescription: COL.memDesc !== -1 ? strOrNull(row[COL.memDesc]) : null,
      sourceCategory1: COL.cat1 !== -1 ? strOrNull(row[COL.cat1]) : null,
      sourceCategory1Description: COL.cat1Desc !== -1 ? strOrNull(row[COL.cat1Desc]) : null,
      sourceCategory2: COL.cat2 !== -1 ? strOrNull(row[COL.cat2]) : null,
      sourceSex: COL.sex !== -1 ? strOrNull(row[COL.sex]) : null,
      sourceGolfClassification: COL.golfClass !== -1 ? strOrNull(row[COL.golfClass]) : null,
      joinedDate: COL.joined !== -1 ? parseDateOrNA(row[COL.joined]) : null,
      resignedDate: COL.resigned !== -1 ? parseDateOrNA(row[COL.resigned]) : null,
      billToMemberNumber: COL.billTo !== -1 ? strOrNull(extractIdString(row[COL.billTo])) : null,
      minimumBilling: COL.minBilling !== -1 ? strOrNull(row[COL.minBilling]) : null,
      billBackUp: COL.billBackUp !== -1 ? strOrNull(row[COL.billBackUp]) : null,
      interpretedStatus: interpretSourceStatus(sourceStatus),
      isShareholder: isShareholderFromSourceStatus(sourceStatus),
    };
    parsed.push(parsedRow);

    // Duplicate detection.
    const prev = seenMemberNos.get(memberNo);
    if (prev != null) {
      warnings.push(`Duplicate Member # ${memberNo} at rows ${prev} + ${r}`);
    } else {
      seenMemberNos.set(memberNo, r);
    }
  }

  // Bill-to resolution (pure, in-memory — the index is the parsed
  // member-number universe).
  const billToOutcomes = resolveBillToOutcomes(parsed, headerIdx + 1);

  return {
    rows: parsed,
    invalidRows: invalid,
    warnings,
    sourceFileHash: opts.sourceFileHash,
    sourceFileName: opts.sourceFileName,
    sourceEffectiveDate: opts.sourceEffectiveDate,
    billToOutcomes,
  };
}

/** Resolve each parsed row's Member # to Bill against the universe of
 *  Member # we just parsed. Outcomes feed the commit service. */
export function resolveBillToOutcomes(
  rows: JonasMemberMasterRow[],
  rowIndexOffset: number,
): JonasParseResult["billToOutcomes"] {
  const universe = new Set(rows.map((r) => r.memberNumber));
  return rows.map((r, i) => {
    const bt = r.billToMemberNumber;
    let outcome: JonasBillToOutcome;
    if (bt == null || bt === "") outcome = "INVALID";
    else if (bt === r.memberNumber) outcome = "SELF";
    else if (universe.has(bt)) outcome = "RESOLVED";
    else outcome = "UNRESOLVED";
    return {
      rowIndex: rowIndexOffset + i,
      memberNumber: r.memberNumber,
      billToMemberNumber: bt,
      outcome,
    };
  });
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

/** Extract an ID-shaped STRING from a cell, preserving leading zeros
 *  and alphabetic suffixes. ExcelJS may surface numeric cells as
 *  `number`; we String() them WITHOUT numeric coercion by trimming
 *  only. For blank/undefined → "". */
function extractIdString(cell: unknown): string {
  if (cell == null) return "";
  if (typeof cell === "number") {
    // Never fabricate leading zeros — if the source cell was typed as
    // a number, the leading zeros are already lost. Record the digits
    // only. The founder's sanitization step preserves them as text.
    return String(cell);
  }
  return String(cell).trim();
}

function strOrNull(cell: unknown): string | null {
  if (cell == null) return null;
  const s = String(cell).trim();
  return s === "" ? null : s;
}

/** Parse a cell that may be an Excel date, "N/A", or blank. Returns
 *  null for N/A / blank / malformed. Never fabricates a date. */
export function parseDateOrNA(cell: unknown): Date | null {
  if (cell == null || cell === "") return null;
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : cell;
  const s = String(cell).trim();
  if (s === "" || s.toUpperCase() === "N/A") return null;
  // ExcelJS normally emits Date objects; fall-through string parse
  // for robustness.
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function emptyResult(
  opts: { buffer?: unknown; sourceFileHash?: string; sourceFileName: string | null; sourceEffectiveDate: Date },
  warning: string,
): JonasParseResult {
  return {
    rows: [],
    invalidRows: [],
    warnings: [warning],
    sourceFileHash: opts.sourceFileHash ?? "",
    sourceFileName: opts.sourceFileName,
    sourceEffectiveDate: opts.sourceEffectiveDate,
    billToOutcomes: [],
  };
}
