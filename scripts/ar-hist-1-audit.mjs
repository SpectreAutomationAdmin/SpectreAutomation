// AR-HIST-1 §5 — audit via raw XML regex (no XML parser dep).
// ExcelJS 4.4 chokes on this workbook's xl/tables entry; we read
// sheet1.xml directly.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import JSZip from "jszip";

const PATH = "C:/Users/cturcato/Downloads/Jan 31 2026 Aged AR - Sanitized for Spectre.xlsx";
const bytes = readFileSync(PATH);
const sha = createHash("sha256").update(bytes).digest("hex");

const zip = await JSZip.loadAsync(bytes);
const ss = await zip.file("xl/sharedStrings.xml").async("string");

// Extract shared strings — each <si> may contain <t>…</t> or
// <r><t>…</t></r>+. Simple regex that captures all <t> payloads
// within each <si>, concatenated.
function stripTags(s) {
  // Entity decode common XML entities + strip inner tags.
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
const sharedStrings = [];
const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
let m;
while ((m = siRegex.exec(ss)) !== null) {
  const inner = m[1];
  const tMatches = inner.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) ?? [];
  const combined = tMatches.map((t) => stripTags(t)).join("");
  sharedStrings.push(combined);
}

let sheet1 = await zip.file("xl/worksheets/sheet1.xml").async("string");
// Strip namespace prefixes to make the regexes simpler.
sheet1 = sheet1.replace(/<\/?x:/g, (m) => (m[1] === "/" ? "</" : "<"));

function colIndexFromRef(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

// Parse each <row>…</row>; inside, parse <c r="A1" t="s"><v>…</v></c>.
const rows = [];
const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
let rowMatch;
while ((rowMatch = rowRegex.exec(sheet1)) !== null) {
  const rowAttr = rowMatch[1] ?? "";
  const rNum = /r="(\d+)"/.exec(rowAttr)?.[1];
  const inner = rowMatch[2] ?? "";
  const cells = [];
  let maxIdx = -1;
  const cellRegex = /<c\b([^>]*)(?:\/\s*>|>([\s\S]*?)<\/c>)/g;
  let cellMatch;
  while ((cellMatch = cellRegex.exec(inner)) !== null) {
    const attrs = cellMatch[1] ?? "";
    const innerCell = cellMatch[2] ?? "";
    const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "A1";
    const t = /t="([^"]+)"/.exec(attrs)?.[1] ?? "n";
    const idx = colIndexFromRef(ref);
    maxIdx = Math.max(maxIdx, idx);
    let value = null;
    const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(innerCell);
    const isMatch = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(innerCell);
    if (vMatch) {
      const raw = vMatch[1];
      if (t === "s") value = sharedStrings[Number(raw)] ?? "";
      else if (t === "b") value = raw === "1";
      else {
        const n = Number(raw);
        value = Number.isFinite(n) ? n : raw;
      }
    } else if (isMatch) {
      const tMatches = isMatch[1].match(/<t\b[^>]*>[\s\S]*?<\/t>/g) ?? [];
      value = tMatches.map((t) => stripTags(t)).join("");
    }
    cells[idx] = value;
  }
  for (let i = 0; i <= maxIdx; i++) if (cells[i] === undefined) cells[i] = null;
  rows.push(cells);
}

// Locate header row (contains "Member Code")
let headerIdx = -1;
for (let i = 0; i < Math.min(15, rows.length); i++) {
  const low = rows[i].map((c) => String(c ?? "").toLowerCase().trim());
  if (low.some((v) => v === "member code" || v === "membercode")) { headerIdx = i; break; }
}
if (headerIdx === -1) {
  console.log("HEADER_IDX -1");
  for (let i = 0; i < Math.min(10, rows.length); i++) console.log(`ROW${i}:`, JSON.stringify(rows[i]));
  process.exit(1);
}
const header = rows[headerIdx].map((c) => String(c ?? "").trim());
console.log("HEADER_IDX " + headerIdx);
console.log("HEADER " + JSON.stringify(header));

const idx = (names) => {
  for (const n of names) {
    const i = header.findIndex((h) => h.toLowerCase() === n.toLowerCase());
    if (i !== -1) return i;
  }
  return -1;
};
const COL = {
  code: idx(["Member Code"]),
  name: idx(["Member Name"]),
  net: idx(["Net Amount"]),
  cur: idx(["Current"]),
  m1: idx(["1 Mths", "1 Month"]),
  m2: idx(["2 Mths", "2 Months"]),
  m3: idx(["3 Mths", "3 Months"]),
  m4plus: idx(["Over 4 Mths", "Over 4 Months"]),
  club: idx(["Club"]),
  clubDesc: idx(["Club Description"]),
  primaryClub: idx(["Primary Club"]),
  primaryClubDesc: idx(["Primary Club Description"]),
};
console.log("COL " + JSON.stringify(COL));

const r2 = (n) => Math.round(n * 100) / 100;
const data = rows.slice(headerIdx + 1);
let kept = 0;
let totalNet = 0, totalCur = 0, totalM1 = 0, totalM2 = 0, totalM3 = 0, totalM4 = 0;
const codeCounts = new Map();
let blankCode = 0;
let bucketExceptions = 0;
let nonCurrentRows = 0;
let rowsWithNonzero1M = 0, rowsWithNonzero2M = 0, rowsWithNonzero3M = 0, rowsWithNonzero4M = 0;
const sampleCodes = [];

for (const r of data) {
  const codeRaw = r[COL.code];
  if (codeRaw == null || String(codeRaw).trim() === "") { blankCode++; continue; }
  const code = typeof codeRaw === "number" ? String(codeRaw) : String(codeRaw).trim();
  codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1);
  if (sampleCodes.length < 12) sampleCodes.push(code);
  const net = Number(r[COL.net] ?? 0);
  const cur = Number(r[COL.cur] ?? 0);
  const m1 = Number(r[COL.m1] ?? 0);
  const m2 = Number(r[COL.m2] ?? 0);
  const m3 = Number(r[COL.m3] ?? 0);
  const m4 = Number(r[COL.m4plus] ?? 0);
  totalNet += net; totalCur += cur; totalM1 += m1; totalM2 += m2; totalM3 += m3; totalM4 += m4;
  if (Math.abs(r2(cur + m1 + m2 + m3 + m4) - r2(net)) > 0.01) bucketExceptions++;
  const nonCur = r2(m1 + m2 + m3 + m4);
  if (Math.abs(nonCur) > 0.001) nonCurrentRows++;
  if (Math.abs(m1) > 0.001) rowsWithNonzero1M++;
  if (Math.abs(m2) > 0.001) rowsWithNonzero2M++;
  if (Math.abs(m3) > 0.001) rowsWithNonzero3M++;
  if (Math.abs(m4) > 0.001) rowsWithNonzero4M++;
  kept++;
}

const dupCodes = Array.from(codeCounts.entries()).filter(([, c]) => c > 1).map(([k, c]) => `${k}:${c}`);
const prohibitedPatterns = /email|phone|address|postal|zip|dob|birth|street|city|province|state|country|password|credit|bank/i;
const prohibitedHeaders = header.filter((h) => prohibitedPatterns.test(h));

console.log("AUDIT " + JSON.stringify({
  path: PATH,
  sha256: sha,
  physicalRowCount: rows.length,
  headerRowIndex: headerIdx,
  dataRowsAfterHeader: data.length,
  arDataRowCount: kept,
  uniqueMemberCodes: codeCounts.size,
  duplicateMemberCodes: dupCodes.length,
  duplicateSample: dupCodes.slice(0, 5),
  blankMemberCodes: blankCode,
  sampleCodes,
  totals: {
    net: r2(totalNet),
    current: r2(totalCur),
    oneMonth: r2(totalM1),
    twoMonths: r2(totalM2),
    threeMonths: r2(totalM3),
    overFourMonths: r2(totalM4),
    nonCurrent: r2(totalM1 + totalM2 + totalM3 + totalM4),
    currentPct: totalNet > 0 ? r2((totalCur / totalNet) * 10000) / 100 : null,
  },
  rowBucketReconciliationExceptions: bucketExceptions,
  nonCurrentRows,
  nonzeroByBucket: {
    oneMonth: rowsWithNonzero1M,
    twoMonths: rowsWithNonzero2M,
    threeMonths: rowsWithNonzero3M,
    overFourMonths: rowsWithNonzero4M,
  },
  prohibitedHeaders,
}, null, 2));
