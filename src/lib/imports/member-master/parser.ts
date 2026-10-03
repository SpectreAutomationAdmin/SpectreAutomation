// MEM-HIST-1 §12 (2026-10-03) — member-master importer parser.
//
// Pure parser. Zero DB writes. Reads a SANITIZED workbook (synthetic
// external identifiers only), validates each row, emits structured
// output. The caller (future MEM-HIST-2 API handler) feeds the
// results into the match resolver + preview UI.
//
// PRIVACY CONTRACT
//   This parser accepts whatever identity strings arrive in the
//   workbook — it does NOT sanitize. Sanitization is the operator's
//   responsibility BEFORE upload. The repo's .gitignore blocks real
//   member workbooks from entering source control. See the
//   sanitize-helper module for the deterministic synthetic-identity
//   generator the operator uses locally.
//
// VALIDATION
//   §12 requirements: row counts, duplicate external IDs, invalid
//   classifications, missing required fields, effective-date
//   conflicts.
//
// IDEMPOTENCY
//   Idempotency keys live on the eventual MemberMasterImportBatch
//   row (clubId, sourceSystem, sourceFileHash, sourceEffectiveDate).
//   The parser emits `sourceFileHash: null` so API callers set it
//   from the uploaded bytes; `sourceEffectiveDate` is passed through
//   from the operator.

import ExcelJS from "exceljs";
import type {
  MemberMasterRow,
  MemberMasterParseResult,
  MembershipClassificationCode,
  MembershipStatus,
} from "./types";
import {
  CLASSIFICATION_CODES,
  STATUS_CODES,
  SHAREHOLDER_CLASSIFICATION_CODES,
} from "./types";

// -------------------------------------------------------------------
// HEADER MATCHING
// -------------------------------------------------------------------

const EXPECTED_HEADERS: Record<string, string[]> = {
  externalIdentifier: ["external identifier", "member code", "member number", "account number"],
  displayName: ["display name", "name", "member name"],
  classificationCode: ["classification code", "classification", "class code", "membership category"],
  status: ["status", "membership status"],
  isShareholder: ["is shareholder", "shareholder", "shareholder flag"],
  effectiveFrom: ["effective from", "classification effective date", "effective date"],
  joinDate: ["join date", "original join date", "member since"],
  resignationDate: ["resignation date", "resigned at"],
  previousClassificationCode: ["previous classification", "previous class code"],
  previousClassificationChangedAt: ["previous classification changed at", "classification change date"],
  householdPrimary: ["household primary", "household head", "primary"],
};

function normalizeHeader(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

type ColumnMap = Partial<Record<keyof MemberMasterRow, number>>;

// -------------------------------------------------------------------
// PUBLIC — parse from an in-memory XLSX buffer
// -------------------------------------------------------------------

export async function parseMemberMasterWorkbook(opts: {
  buffer: ArrayBuffer | Buffer;
  sourceEffectiveDate: Date | null;
}): Promise<MemberMasterParseResult> {
  const wb = new ExcelJS.Workbook();
  const buf = Buffer.isBuffer(opts.buffer) ? opts.buffer : Buffer.from(opts.buffer);
  await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
  const ws = wb.worksheets[0];
  if (!ws) return emptyResult(["Workbook has no worksheets."], opts.sourceEffectiveDate);

  const rowValues: unknown[][] = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells: unknown[] = [];
    const raw = (row.values as unknown[]) ?? [];
    for (let i = 1; i < raw.length; i++) cells.push(raw[i]);
    rowValues.push(cells);
  });
  return parseMemberMasterRowValues({ rows: rowValues, sourceEffectiveDate: opts.sourceEffectiveDate });
}

// -------------------------------------------------------------------
// PUBLIC — parse from in-memory row arrays (test seam)
// -------------------------------------------------------------------

export function parseMemberMasterRowValues(opts: {
  rows: unknown[][];
  sourceEffectiveDate: Date | null;
}): MemberMasterParseResult {
  const warnings: string[] = [];
  if (opts.rows.length === 0) {
    return emptyResult(["Workbook has no non-empty rows."], opts.sourceEffectiveDate);
  }

  // Find header row.
  let headerRowIdx = -1;
  for (let i = 0; i < Math.min(10, opts.rows.length); i++) {
    const normalized = opts.rows[i].map((c) => normalizeHeader(String(c ?? "")));
    if (
      EXPECTED_HEADERS.externalIdentifier.some((h) => normalized.includes(h)) &&
      EXPECTED_HEADERS.classificationCode.some((h) => normalized.includes(h))
    ) {
      headerRowIdx = i;
      break;
    }
  }
  if (headerRowIdx === -1) {
    return emptyResult(
      [`Could not locate a header row containing both an external identifier column and a classification column (searched first 10 rows).`],
      opts.sourceEffectiveDate,
    );
  }

  const headerRow = opts.rows[headerRowIdx].map((c) => normalizeHeader(String(c ?? "")));
  const colMap: ColumnMap = {};
  for (const [field, candidates] of Object.entries(EXPECTED_HEADERS) as Array<
    [keyof MemberMasterRow, string[]]
  >) {
    const idx = headerRow.findIndex((h) => candidates.includes(h));
    if (idx !== -1) colMap[field] = idx;
  }
  // Mandatory fields.
  const mandatory: Array<keyof MemberMasterRow> = [
    "externalIdentifier", "classificationCode", "status", "effectiveFrom",
  ];
  for (const f of mandatory) {
    if (colMap[f] == null) warnings.push(`Missing required column: ${f}`);
  }
  if (warnings.length > 0) {
    return emptyResult(warnings, opts.sourceEffectiveDate);
  }

  const parsed: MemberMasterRow[] = [];
  const invalid: MemberMasterParseResult["invalidRows"] = [];

  for (let r = headerRowIdx + 1; r < opts.rows.length; r++) {
    const row = opts.rows[r];
    const extRaw = row[colMap.externalIdentifier!];
    const ext = extRaw != null ? String(extRaw).trim() : "";
    if (ext === "") {
      invalid.push({
        rowIndex: r,
        externalIdentifier: null,
        reason: "Missing externalIdentifier",
      });
      continue;
    }

    const classRaw = String(row[colMap.classificationCode!] ?? "").trim();
    const classCode = classRaw as MembershipClassificationCode;
    if (!CLASSIFICATION_CODES.includes(classCode)) {
      invalid.push({
        rowIndex: r,
        externalIdentifier: ext,
        reason: `Unknown classification code: "${classRaw}"`,
      });
      continue;
    }

    const statusRaw = String(row[colMap.status!] ?? "").trim();
    const status = statusRaw as MembershipStatus;
    if (!STATUS_CODES.includes(status)) {
      invalid.push({
        rowIndex: r,
        externalIdentifier: ext,
        reason: `Unknown status code: "${statusRaw}"`,
      });
      continue;
    }

    const effectiveFrom = parseDate(row[colMap.effectiveFrom!]);
    if (!effectiveFrom) {
      invalid.push({
        rowIndex: r,
        externalIdentifier: ext,
        reason: "Missing or malformed effectiveFrom date",
      });
      continue;
    }

    const prevCode = colMap.previousClassificationCode != null
      ? String(row[colMap.previousClassificationCode] ?? "").trim()
      : "";
    const prevClassCode = prevCode === "" ? null : (CLASSIFICATION_CODES.includes(prevCode as MembershipClassificationCode) ? (prevCode as MembershipClassificationCode) : null);

    const explicitShareholder = colMap.isShareholder != null
      ? parseBool(row[colMap.isShareholder])
      : null;
    const isShareholder = explicitShareholder ?? SHAREHOLDER_CLASSIFICATION_CODES.has(classCode);

    const parsedRow: MemberMasterRow = {
      externalIdentifier: ext,
      displayName: colMap.displayName != null ? String(row[colMap.displayName] ?? "").trim() : "",
      classificationCode: classCode,
      status,
      isShareholder,
      effectiveFrom,
      joinDate: colMap.joinDate != null ? parseDate(row[colMap.joinDate]) : null,
      resignationDate: colMap.resignationDate != null ? parseDate(row[colMap.resignationDate]) : null,
      previousClassificationCode: prevClassCode,
      previousClassificationChangedAt: colMap.previousClassificationChangedAt != null ? parseDate(row[colMap.previousClassificationChangedAt]) : null,
      householdPrimary: colMap.householdPrimary != null ? parseBool(row[colMap.householdPrimary]) : null,
    };
    parsed.push(parsedRow);
  }

  // Duplicate externalIdentifier check — not an INVALID per se; the
  // match resolver will emit AMBIGUOUS downstream. We surface as a
  // warning for the operator.
  const seen = new Set<string>();
  const dups = new Set<string>();
  for (const r of parsed) {
    if (seen.has(r.externalIdentifier)) dups.add(r.externalIdentifier);
    seen.add(r.externalIdentifier);
  }
  if (dups.size > 0) {
    warnings.push(`Duplicate externalIdentifier(s): ${Array.from(dups).join(", ")}`);
  }

  // Overlapping effective-date check (same externalIdentifier, two
  // rows with the same effectiveFrom but different classifications).
  const byExt = new Map<string, MemberMasterRow[]>();
  for (const r of parsed) {
    const list = byExt.get(r.externalIdentifier) ?? [];
    list.push(r);
    byExt.set(r.externalIdentifier, list);
  }
  for (const [ext, list] of byExt) {
    if (list.length < 2) continue;
    const sameDate = new Map<string, Set<string>>();
    for (const r of list) {
      const key = r.effectiveFrom.toISOString().slice(0, 10);
      const s = sameDate.get(key) ?? new Set();
      s.add(r.classificationCode);
      sameDate.set(key, s);
    }
    for (const [date, codes] of sameDate) {
      if (codes.size > 1) {
        warnings.push(`Conflicting effective-date entries for ${ext} on ${date}: ${Array.from(codes).join(", ")}`);
      }
    }
  }

  return {
    rows: parsed,
    invalidRows: invalid,
    warnings,
    sourceFileHash: null,
    sourceEffectiveDate: opts.sourceEffectiveDate,
  };
}

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

function parseDate(cell: unknown): Date | null {
  if (cell == null || cell === "") return null;
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : cell;
  if (typeof cell === "number") {
    // Excel serial date — ExcelJS normally emits Date objects, but
    // row arrays supplied by tests might carry a numeric serial.
    const ms = Math.round((cell - 25569) * 86400 * 1000);
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(cell).trim();
  if (s === "") return null;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseBool(cell: unknown): boolean | null {
  if (cell == null || cell === "") return null;
  if (typeof cell === "boolean") return cell;
  const s = String(cell).trim().toLowerCase();
  if (["y", "yes", "true", "1"].includes(s)) return true;
  if (["n", "no", "false", "0"].includes(s)) return false;
  return null;
}

function emptyResult(warnings: string[], sourceEffectiveDate: Date | null): MemberMasterParseResult {
  return {
    rows: [],
    invalidRows: [],
    warnings,
    sourceFileHash: null,
    sourceEffectiveDate,
  };
}
