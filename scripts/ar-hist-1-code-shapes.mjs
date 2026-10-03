// AR-HIST-1 — characterize the full distribution of Member Code
// SHAPES in the sanitized AR workbook (plain digits? leading-zero?
// alphabetic suffix?). No synthetic names surfaced.

import { readFileSync } from "node:fs";
import JSZip from "jszip";

const bytes = readFileSync("C:/Users/cturcato/Downloads/Jan 31 2026 Aged AR - Sanitized for Spectre.xlsx");
const zip = await JSZip.loadAsync(bytes);
const ss = await zip.file("xl/sharedStrings.xml").async("string");
function stripTags(s) {
  return s.replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'");
}
const sharedStrings = [];
const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
let m;
while ((m = siRegex.exec(ss)) !== null) {
  const inner = m[1];
  const tMatches = inner.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) ?? [];
  sharedStrings.push(tMatches.map(stripTags).join(""));
}

let sheet1 = await zip.file("xl/worksheets/sheet1.xml").async("string");
sheet1 = sheet1.replace(/<\/?x:/g, (m) => (m[1] === "/" ? "</" : "<"));

function colIndexFromRef(ref) {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const codesWithType = [];
const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
let rowMatch;
let rowCounter = 0;
while ((rowMatch = rowRegex.exec(sheet1)) !== null) {
  const inner = rowMatch[2];
  rowCounter++;
  if (rowCounter <= 4) continue; // skip banner + header
  const cellRegex = /<c\b([^>]*)(?:\/\s*>|>([\s\S]*?)<\/c>)/g;
  let cellMatch;
  while ((cellMatch = cellRegex.exec(inner)) !== null) {
    const attrs = cellMatch[1] ?? "";
    const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "A1";
    const idx = colIndexFromRef(ref);
    if (idx !== 0) continue; // only col A = Member Code
    const t = /t="([^"]+)"/.exec(attrs)?.[1] ?? "n";
    const innerCell = cellMatch[2] ?? "";
    const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(innerCell);
    if (!vMatch) break;
    const raw = vMatch[1];
    let value;
    if (t === "s") value = sharedStrings[Number(raw)] ?? "";
    else value = raw;
    codesWithType.push({ type: t, value: String(value) });
    break;
  }
}

// Shape classification.
let plainDigits = 0, leadingZero = 0, alphaSuffix = 0, other = 0;
const samples = { plainDigits: [], leadingZero: [], alphaSuffix: [], other: [] };
for (const c of codesWithType) {
  const v = c.value;
  if (/^\d+$/.test(v) && v[0] !== "0") {
    plainDigits++;
    if (samples.plainDigits.length < 3) samples.plainDigits.push({ ...c });
  } else if (/^0\d+$/.test(v)) {
    leadingZero++;
    if (samples.leadingZero.length < 5) samples.leadingZero.push({ ...c });
  } else if (/[A-Za-z]/.test(v)) {
    alphaSuffix++;
    if (samples.alphaSuffix.length < 5) samples.alphaSuffix.push({ ...c });
  } else {
    other++;
    if (samples.other.length < 5) samples.other.push({ ...c });
  }
}

// Cell-type distribution: how many 's' (shared string) vs 'n'/'str' (numeric/inline string)?
const typeDistribution = {};
for (const c of codesWithType) {
  typeDistribution[c.type] = (typeDistribution[c.type] ?? 0) + 1;
}

console.log(JSON.stringify({
  totalMemberCodeCellsInColA: codesWithType.length,
  typeDistribution,
  shapeDistribution: { plainDigits, leadingZero, alphaSuffix, other },
  samples,
}, null, 2));
