// MEM-HIST-2 §5 — one-shot workbook audit (scratchpad; aggregate output only).
import ExcelJS from "exceljs";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const PATH = "C:/Users/cturcato/Downloads/Membership Master - Sanitized for Spectre.xlsx";
const bytes = readFileSync(PATH);
const sha = createHash("sha256").update(bytes).digest("hex");

const wb = new ExcelJS.Workbook();
await wb.xlsx.load(bytes);
const ws = wb.worksheets[0];

const rows = [];
ws.eachRow({ includeEmpty: false }, (row) => {
  const cells = [];
  const raw = row.values ?? [];
  for (let i = 1; i < raw.length; i++) cells.push(raw[i]);
  rows.push(cells);
});

console.log(JSON.stringify({ sheetName: ws.name, rowCount: rows.length, sha256: sha }));

// Scan first 15 rows for the real header row (one containing "Member #")
let headerIdx = -1;
for (let i = 0; i < Math.min(15, rows.length); i++) {
  const r = rows[i];
  const low = r.map(c => String(c ?? "").toLowerCase().trim());
  if (low.some(v => v === "member #" || v === "member#" || v === "member no" || v === "member number")) {
    headerIdx = i;
    break;
  }
}
console.log("HEADER_IDX " + headerIdx);
if (headerIdx === -1) {
  // Print first 5 rows for inspection
  for (let i = 0; i < Math.min(5, rows.length); i++) {
    console.log(`ROW ${i}: ${JSON.stringify(rows[i])}`);
  }
  process.exit(1);
}
const header = rows[headerIdx].map(c => String(c ?? "").trim());
console.log("HEADER " + JSON.stringify(header));

const idx = (names) => {
  for (const n of names) {
    const i = header.findIndex(h => h.toLowerCase() === n.toLowerCase());
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
console.log("COL " + JSON.stringify(COL));

const data = rows.slice(headerIdx + 1);
const distinct = (col) => {
  if (col === -1) return { distinct: [], blank: 0 };
  const m = new Map();
  let blank = 0;
  for (const r of data) {
    const v = r[col];
    if (v == null || String(v).trim() === "") { blank++; continue; }
    const k = String(v).trim();
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return { distinct: Array.from(m.entries()).sort((a,b) => b[1]-a[1]), blank };
};

// Member # extraction — preserve string form, don't coerce
const memberNos = data.map(r => {
  if (COL.memberNo === -1) return "";
  const v = r[COL.memberNo];
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  return String(v).trim();
});
const memberNoBlank = memberNos.filter(m => m === "").length;
const memberNoCounts = new Map();
for (const m of memberNos) {
  if (m === "") continue;
  memberNoCounts.set(m, (memberNoCounts.get(m) ?? 0) + 1);
}
const dupMemberNos = Array.from(memberNoCounts.entries()).filter(([,c]) => c > 1).map(([k,c]) => `${k}:${c}`);
const uniqueMemberNos = Array.from(memberNoCounts.keys());

// Bill-to analysis
const billTos = data.map(r => {
  if (COL.billTo === -1) return "";
  const v = r[COL.billTo];
  if (v == null) return "";
  if (typeof v === "number") return String(v);
  return String(v).trim();
});
const billToPopulated = billTos.filter(b => b !== "").length;
const memberNoSet = new Set(uniqueMemberNos);
let selfBill = 0, otherBill = 0, unresolvedBill = 0;
for (let i = 0; i < data.length; i++) {
  const mn = memberNos[i];
  const bt = billTos[i];
  if (bt === "") continue;
  if (bt === mn) selfBill++;
  else if (memberNoSet.has(bt)) otherBill++;
  else unresolvedBill++;
}

// Date analysis
let joinedPopulated = 0, resignedPopulated = 0;
let joinedNA = 0, resignedNA = 0;
const sampleJoined = [], sampleResigned = [];
let joinedBlank = 0, resignedBlank = 0;
for (const r of data) {
  if (COL.joined !== -1) {
    const j = r[COL.joined];
    if (j == null || String(j).trim() === "") joinedBlank++;
    else {
      joinedPopulated++;
      if (String(j).trim().toUpperCase() === "N/A") joinedNA++;
      if (sampleJoined.length < 5) sampleJoined.push({ type: typeof j, raw: j instanceof Date ? j.toISOString() : String(j) });
    }
  }
  if (COL.resigned !== -1) {
    const q = r[COL.resigned];
    if (q == null || String(q).trim() === "") resignedBlank++;
    else {
      resignedPopulated++;
      if (String(q).trim().toUpperCase() === "N/A") resignedNA++;
      if (sampleResigned.length < 5) sampleResigned.push({ type: typeof q, raw: q instanceof Date ? q.toISOString() : String(q) });
    }
  }
}

const leadingZero = memberNos.filter(m => /^0\d/.test(m)).length;
const alphaSuffix = memberNos.filter(m => /[A-Za-z]$/.test(m)).length;
const sampleMemberNos = [...memberNos].slice(0, 12);

// Prohibited PII scan — but EXCLUDE the banner row header (which is club name)
const prohibitedPatterns = /email|phone|address|postal|zip|dob|birth|street|city|province|state|country|signature|photo|password|credit|bank|routing|account.*number|iban|swift|ssn|sin|medicare|insurance/i;
const prohibitedHeaders = header.filter(h => prohibitedPatterns.test(h));

const out = {
  sheet: ws.name,
  totalDataRows: data.length,
  sha256: sha,
  memberNumber: {
    uniqueCount: uniqueMemberNos.length,
    duplicatesCount: dupMemberNos.length,
    duplicatesSample: dupMemberNos.slice(0, 10),
    blank: memberNoBlank,
    withLeadingZero: leadingZero,
    withAlphaSuffix: alphaSuffix,
    sample: sampleMemberNos,
  },
  status: distinct(COL.status),
  membershipDescription: distinct(COL.memDesc),
  category1: distinct(COL.cat1),
  category1Description: distinct(COL.cat1Desc),
  category2: distinct(COL.cat2),
  sex: distinct(COL.sex),
  golfClassification: distinct(COL.golfClass),
  billTo: {
    populated: billToPopulated,
    self: selfBill,
    otherResolved: otherBill,
    unresolved: unresolvedBill,
  },
  joined: { populated: joinedPopulated, blank: joinedBlank, naLiteral: joinedNA, sample: sampleJoined },
  resigned: { populated: resignedPopulated, blank: resignedBlank, naLiteral: resignedNA, sample: sampleResigned },
  prohibitedHeaders,
};

console.log("AUDIT " + JSON.stringify(out, null, 2));
