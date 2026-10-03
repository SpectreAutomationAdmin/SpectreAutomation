// MEM-HIST-2A §1 — reconcile 3,084 reported vs 3,080 committed.
// Prints every row the parser rejects + the reason, so the discrepancy
// is explained exhaustively.
//
// Aggregate output only; no synthetic names are logged except where
// the row index + reason requires it.

import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const PATH = "C:/Users/cturcato/Downloads/Membership Master - Sanitized for Spectre.xlsx";
const bytes = readFileSync(PATH);
const sha = createHash("sha256").update(bytes).digest("hex");

const wb = new ExcelJS.Workbook();
await wb.xlsx.load(bytes);
const ws = wb.worksheets[0];

const dim = {
  actualColumnCount: ws.actualColumnCount,
  actualRowCount: ws.actualRowCount,
  rowCount: ws.rowCount,
  columnCount: ws.columnCount,
};

const rows = [];
let totalRowsIterated = 0;
let totalRowsIncludingEmpty = 0;
let blankRows = 0;

// Iterate ALL rows (including empty) so we can account for every one.
ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
  totalRowsIncludingEmpty++;
  const cells = [];
  const raw = row.values ?? [];
  for (let i = 1; i < raw.length; i++) cells.push(raw[i]);
  const nonEmpty = cells.filter((c) => c != null && String(c).trim() !== "").length;
  rows.push({ rowNumber, cells, nonEmptyCellCount: nonEmpty });
  totalRowsIterated++;
  if (nonEmpty === 0) blankRows++;
});

// Find header row.
let headerIdx = -1;
for (let i = 0; i < Math.min(15, rows.length); i++) {
  const low = rows[i].cells.map((c) => String(c ?? "").toLowerCase().trim());
  if (low.some((v) => v === "member #" || v === "member#")) { headerIdx = i; break; }
}
const header = rows[headerIdx].cells.map((c) => String(c ?? "").trim());
const idx = (names) => {
  for (const n of names) {
    const i = header.findIndex((h) => h.toLowerCase() === n.toLowerCase());
    if (i !== -1) return i;
  }
  return -1;
};
const COL = {
  status: idx(["Status"]),
  memberNo: idx(["Member #"]),
  last: idx(["Last Name"]),
  first: idx(["First Name"]),
};

const headerPlus = headerIdx + 1;
const dataRows = rows.slice(headerPlus);

let kept = 0;
const excluded = [];
for (const r of dataRows) {
  const memberNo = r.cells[COL.memberNo];
  const memberNoStr = memberNo == null ? "" : (typeof memberNo === "number" ? String(memberNo) : String(memberNo).trim());
  const status = String(r.cells[COL.status] ?? "").trim();
  const first = String(r.cells[COL.first] ?? "").trim();
  const last = String(r.cells[COL.last] ?? "").trim();
  const nonEmptyCount = r.nonEmptyCellCount;

  if (memberNoStr === "" && status === "" && nonEmptyCount === 0) {
    excluded.push({ rowNumber: r.rowNumber, reason: "COMPLETELY_BLANK", memberNoCharClass: null, statusCharClass: null, nonEmptyCount, firstPresent: false, lastPresent: false });
  } else if (memberNoStr === "" && nonEmptyCount > 0) {
    excluded.push({ rowNumber: r.rowNumber, reason: "MISSING_MEMBER_NO", memberNoCharClass: "empty", statusCharClass: statusCharClass(status), nonEmptyCount, firstPresent: first !== "", lastPresent: last !== "" });
  } else if (status === "") {
    excluded.push({ rowNumber: r.rowNumber, reason: "MISSING_STATUS", memberNoCharClass: memberNoCharClass(memberNoStr), statusCharClass: "empty", nonEmptyCount, firstPresent: first !== "", lastPresent: last !== "" });
  } else {
    kept++;
  }
}

function memberNoCharClass(s) {
  if (s === "") return "empty";
  if (/^\d+$/.test(s)) return `digits-only-len${s.length}`;
  if (/^0\d+[A-Z]?$/.test(s)) return `leading-zero-${/[A-Z]$/.test(s) ? "alpha-suffix" : "no-suffix"}-len${s.length}`;
  if (/^\d+[A-Z]+$/i.test(s)) return `digits-alpha-suffix-len${s.length}`;
  return "other";
}
function statusCharClass(s) {
  if (s === "") return "empty";
  return `len${s.length}`;
}

console.log(JSON.stringify({
  path: PATH,
  sha256: sha,
  worksheetDimensions: dim,
  totalRowsIncludingEmpty,
  headerRowIndex: headerIdx,
  dataRowsAfterHeader: dataRows.length,
  blankRowsAnywhere: blankRows,
  parserKept: kept,
  parserExcluded: excluded.length,
  excludedBreakdown: {
    completelyBlank: excluded.filter((e) => e.reason === "COMPLETELY_BLANK").length,
    missingMemberNo: excluded.filter((e) => e.reason === "MISSING_MEMBER_NO").length,
    missingStatus: excluded.filter((e) => e.reason === "MISSING_STATUS").length,
  },
  excludedDetail: excluded,
  reconciliation: {
    headerRows: headerPlus,
    dataRows: dataRows.length,
    committableRows: kept,
    rejectedRows: excluded.length,
    sum: headerPlus + dataRows.length,
  },
}, null, 2));
