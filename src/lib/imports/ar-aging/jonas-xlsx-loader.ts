// AR-HIST-1 (2026-10-03) — Jonas AR Aging XLSX loader.
//
// ExcelJS 4.4 fails on the authorized sanitized AR workbook because
// the workbook carries an `xl/tables/table1.xml` entry that ExcelJS's
// workbook model doesn't construct cleanly. We bypass ExcelJS and
// read `xl/worksheets/sheet1.xml` + `xl/sharedStrings.xml` directly
// via JSZip + a thin XML scanner.
//
// The loader emits a 2-D `unknown[][]` row array that TB-HIST-12A's
// `parseArAgingRowValues` consumes without modification.
//
// Member Code column: we preserve the EXACT string stored in the
// cell. Leading zeros + alphabetic suffixes are protected because the
// sanitized workbook stores Member Code cells as `t="str"` (inline
// strings). The loader never numerically coerces a Member Code.

import JSZip from "jszip";
import { createHash } from "node:crypto";

export type JonasXlsxLoadResult = {
  rows: unknown[][];
  sourceFileHash: string;
};

/** Load a Jonas AR Aging workbook from an in-memory buffer. Returns
 *  the raw rows + a SHA-256 of the bytes for the idempotency key. */
export async function loadJonasArAgingWorkbook(buffer: ArrayBuffer | Buffer): Promise<JonasXlsxLoadResult> {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  const sourceFileHash = createHash("sha256").update(buf).digest("hex");
  const zip = await JSZip.loadAsync(buf);

  const ssFile = zip.file("xl/sharedStrings.xml");
  const sharedStrings: string[] = [];
  if (ssFile) {
    const ss = await ssFile.async("string");
    const siRegex = /<si\b[^>]*>([\s\S]*?)<\/si>/g;
    let m;
    while ((m = siRegex.exec(ss)) !== null) {
      const inner = m[1] ?? "";
      const tMatches = inner.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) ?? [];
      sharedStrings.push(tMatches.map(stripTags).join(""));
    }
  }

  const sheetFile = zip.file("xl/worksheets/sheet1.xml");
  if (!sheetFile) return { rows: [], sourceFileHash };
  let sheet = await sheetFile.async("string");
  sheet = sheet.replace(/<\/?x:/g, (m) => (m[1] === "/" ? "</" : "<"));

  const rows: unknown[][] = [];
  const rowRegex = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let rowMatch;
  while ((rowMatch = rowRegex.exec(sheet)) !== null) {
    const inner = rowMatch[2] ?? "";
    const cells: unknown[] = [];
    let maxIdx = -1;
    const cellRegex = /<c\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/c>)/g;
    let cellMatch;
    while ((cellMatch = cellRegex.exec(inner)) !== null) {
      const attrs = cellMatch[1] ?? "";
      const innerCell = cellMatch[2] ?? "";
      const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? "A1";
      const t = /t="([^"]+)"/.exec(attrs)?.[1] ?? "n";
      const idx = colIndexFromRef(ref);
      maxIdx = Math.max(maxIdx, idx);
      const vMatch = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(innerCell);
      const isMatch = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(innerCell);
      let value: unknown = null;
      if (vMatch) {
        const raw = vMatch[1] ?? "";
        if (t === "s") {
          value = sharedStrings[Number(raw)] ?? "";
        } else if (t === "b") {
          value = raw === "1";
        } else if (t === "str" || t === "inlineStr") {
          // Inline string type — keep raw as string (never numerically coerce).
          value = String(raw);
        } else {
          // Numeric default. We rely on the downstream parser's own
          // Member-Code extraction to call String() where identity
          // matters; money columns stay numeric via this branch.
          const n = Number(raw);
          value = Number.isFinite(n) ? n : raw;
        }
      } else if (isMatch) {
        const tMatches = isMatch[1].match(/<t\b[^>]*>[\s\S]*?<\/t>/g) ?? [];
        value = tMatches.map(stripTags).join("");
      }
      cells[idx] = value;
    }
    for (let i = 0; i <= maxIdx; i++) if (cells[i] === undefined) cells[i] = null;
    rows.push(cells);
  }
  return { rows, sourceFileHash };
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function colIndexFromRef(ref: string): number {
  const letters = /^([A-Z]+)/.exec(ref)?.[1] ?? "A";
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
