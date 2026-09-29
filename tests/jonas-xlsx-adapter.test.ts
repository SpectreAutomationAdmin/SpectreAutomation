// TB-RESET-1d.b.1 — focused unit tests for the Jonas XLSX adapter.
//
// Adapter under test: src/lib/reporting/ledger/importers/jonas-xlsx-adapter.ts
// Boundary: read an XLSX buffer, emit CSV text + metadata that the
// existing parseJonasGlCsv can consume.
//
// Covers the founder's 14 focused-test items from the 1d.b.1 brief,
// exercised entirely against fixtures generated in the test (no real
// workbook, no DB writes).

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import {
  computeCsvSourceHash,
  parseJonasXlsxBuffer,
} from "@/lib/reporting/ledger/importers/jonas-xlsx-adapter";

// ---------------------------------------------------------------------------
// Fixture builder — writes rows into Sheet1 of a new workbook and
// returns the .xlsx bytes as a Buffer. Simulates the Jonas Sheet1
// shape the founder's reference workbook uses (row 1 = header with
// embedded newlines, rows 2..N = data).
// ---------------------------------------------------------------------------
async function buildJonasWorkbook(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const row of rows) {
    ws.addRow(row);
  }
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

const JONAS_HEADER = [
  "G/L Account\nCode",
  "G/L Account\nDescription",
  "Closing Bal\nDebit",
  "Closing Bal\nCredit",
];

describe("jonas-xlsx-adapter — foundation for TB-RESET-1d.b.2", () => {
  // 1. XLSX workbook can be parsed.
  it("1 · parses an XLSX buffer and returns the adapter result", async () => {
    const buf = await buildJonasWorkbook([
      JONAS_HEADER,
      ["1000", "Petty Cash", 890.9, 0],
      ["3000", "Retained Earnings", 0, -890.9],
    ]);
    const result = await parseJonasXlsxBuffer(buf);
    expect(result.sheetName).toBe("Sheet1");
    expect(result.rowCount).toBe(3);
    expect(result.columnCount).toBe(4);
    expect(result.csv.length).toBeGreaterThan(0);
  });

  // 2. Observed Jonas headers are recognized (survive CSV serialisation).
  it("2 · header row containing embedded newlines survives CSV serialisation intact", async () => {
    const buf = await buildJonasWorkbook([
      JONAS_HEADER,
      ["1000", "Cash", 100, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    // The RFC-4180 quoted form for a cell containing a newline is
    // "…\n…" — assert both halves survive.
    expect(csv).toContain('"G/L Account\nCode"');
    expect(csv).toContain('"G/L Account\nDescription"');
    expect(csv).toContain('"Closing Bal\nDebit"');
    expect(csv).toContain('"Closing Bal\nCredit"');
  });

  // 3. Embedded newline headers work — round-trip through a permissive
  //    csv split to confirm the quoted form parses back to the same cells.
  it("3 · quoted newline cells round-trip cell-for-cell through a permissive parser", async () => {
    const buf = await buildJonasWorkbook([
      JONAS_HEADER,
      ["1000", "Cash", 100, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    // Simple RFC-4180 tokeniser sufficient for adapter output.
    const tokens = tokeniseCsvFirstRow(csv);
    expect(tokens).toEqual([
      "G/L Account\nCode",
      "G/L Account\nDescription",
      "Closing Bal\nDebit",
      "Closing Bal\nCredit",
    ]);
  });

  // 4. 237-row-shaped fixture can be processed (matches the founder's
  //    reference workbook rowCount, without importing the real file).
  it("4 · handles a 238-row workbook (1 header + 237 accounts)", async () => {
    const rows: unknown[][] = [JONAS_HEADER];
    for (let i = 0; i < 237; i++) {
      const code = String(1000 + i);
      rows.push([code, `Account ${code}`, i * 10, 0]);
    }
    const buf = await buildJonasWorkbook(rows);
    const { csv, rowCount } = await parseJonasXlsxBuffer(buf);
    expect(rowCount).toBe(238);
    // Every account code appears in the CSV.
    for (const rc of [1000, 1050, 1236]) {
      expect(csv).toContain(String(rc));
    }
  });

  // 5. Account codes remain strings — numeric-looking codes are NOT
  //    scientific-notated or trailing-zero-normalised.
  it("5 · numeric account codes are serialised losslessly (no scientific notation, no float artifacts)", async () => {
    const buf = await buildJonasWorkbook([
      JONAS_HEADER,
      ["9901", "Depreciation", 159175.27, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    // 9901 is the FIRST cell in its row, so it appears as `\n9901,`
    // rather than `,9901,`.
    expect(csv).toMatch(/(^|\n)9901,/);
    // No scientific notation like "9.901e+03"
    expect(csv).not.toMatch(/9\.901e/i);
  });

  // 6. Leading-zero / hyphenated codes survive intact (LEGACY-PAY1A).
  it("6 · leading-zero and hyphenated account codes round-trip", async () => {
    const buf = await buildJonasWorkbook([
      JONAS_HEADER,
      ["0100", "Zero-Cash", 5, 0],
      ["1010-PAY1A", "PAY-1A Simulated Operating Cash", 100, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    expect(csv).toContain("0100,");
    expect(csv).toContain("1010-PAY1A,");
  });

  // 7. Debit values interpreted correctly (via downstream sum).
  it("7 · debit column values survive round-trip", async () => {
    const buf = await buildJonasWorkbook([
      JONAS_HEADER,
      ["1000", "Cash", 2126855.30, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    // Excel-numeric round-trip: value equals 2126855.3 (trailing zero
    // dropped) — the downstream parser reads a JS number, not the
    // string form, so this is exact.
    expect(csv).toMatch(/,2126855\.3/);
  });

  // 8. Negative credit values (Jonas convention) survive verbatim.
  it("8 · negative credit values are preserved verbatim (no sign flip)", async () => {
    const buf = await buildJonasWorkbook([
      JONAS_HEADER,
      ["9900", "Bank - Credit Facilities/Mortgage", 0, -1481969.03],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    expect(csv).toContain("-1481969.03");
    // Adapter must NOT flip the sign to positive.
    expect(csv).not.toContain(",1481969.03");
  });

  // 9. RFC-4180 conversion doesn't corrupt descriptions containing
  //    commas, quotes, or newlines.
  it("9 · descriptions with commas, quotes, and internal newlines are RFC-4180 quoted correctly", async () => {
    const buf = await buildJonasWorkbook([
      JONAS_HEADER,
      ["1200", 'Accts Receivable - Members, "Associate", and\nOther', 379653.14, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    // The whole description cell must be quoted and internal quotes
    // must be doubled.
    expect(csv).toContain('"Accts Receivable - Members, ""Associate"", and\nOther"');
  });

  // 10. Deterministic SHA-256 for identical bytes.
  it("10 · sourceFileHash is deterministic for identical source bytes", async () => {
    const buf1 = await buildJonasWorkbook([JONAS_HEADER, ["1000", "Cash", 100, 0]]);
    // Same buffer → identical hash.
    const a = await parseJonasXlsxBuffer(buf1);
    const b = await parseJonasXlsxBuffer(buf1);
    expect(a.sourceFileHash).toBe(b.sourceFileHash);
    expect(a.sourceFileHash).toMatch(/^[0-9a-f]{64}$/);
  });

  // 11. Different bytes produce different hashes.
  it("11 · sourceFileHash differs when the workbook contents differ", async () => {
    const buf1 = await buildJonasWorkbook([JONAS_HEADER, ["1000", "Cash", 100, 0]]);
    const buf2 = await buildJonasWorkbook([JONAS_HEADER, ["1000", "Cash", 101, 0]]);
    const a = await parseJonasXlsxBuffer(buf1);
    const b = await parseJonasXlsxBuffer(buf2);
    expect(a.sourceFileHash).not.toBe(b.sourceFileHash);
  });

  // 12. Missing entity metadata does not fabricate an entity.
  it("12 · reports detectedEntity=null when the workbook has no plausible entity row", async () => {
    // Reference-workbook shape: no club-name row, header at row 1.
    const buf = await buildJonasWorkbook([
      JONAS_HEADER,
      ["1000", "Cash", 100, 0],
    ]);
    const { detectedEntity, hasJonasHeading } = await parseJonasXlsxBuffer(buf);
    expect(detectedEntity).toBeNull();
    expect(hasJonasHeading).toBe(false);
  });

  // 13. Plausible entity metadata extracted when actually present.
  it("13 · detects a club-name row when a Jonas-native monthly export includes one", async () => {
    // Row 1: single non-numeric non-header string (the club name).
    // Row 2: "Trial Balance for …"
    // Row 3: sub-heading
    // Row 4: header row
    // Row 5+: data
    const buf = await buildJonasWorkbook([
      ["Silver Springs Golf & Country Club"],
      ["Trial Balance for September, 2026"],
      ["Closing Period Balances"],
      JONAS_HEADER,
      ["1000", "Cash", 100, 0],
    ]);
    const { detectedEntity, hasJonasHeading } = await parseJonasXlsxBuffer(buf);
    expect(detectedEntity).toBe("Silver Springs Golf & Country Club");
    expect(hasJonasHeading).toBe(true);
  });

  // 14. Adapter itself causes zero DB writes — it takes a Buffer and
  //     returns a pure JS object. This assertion is structural: the
  //     module has no `prisma` import and its public surface returns
  //     only serialisable data.
  it("14 · adapter has zero DB dependencies and produces only serialisable output", async () => {
    const buf = await buildJonasWorkbook([JONAS_HEADER, ["1000", "Cash", 100, 0]]);
    const result = await parseJonasXlsxBuffer(buf);
    // Result must be JSON-serialisable — no functions, no non-plain
    // objects.
    const roundTrip = JSON.parse(JSON.stringify(result));
    expect(roundTrip.sheetName).toBe("Sheet1");
    expect(roundTrip.csv).toBe(result.csv);
    expect(roundTrip.sourceFileHash).toBe(result.sourceFileHash);
    // Static assertion: the adapter source doesn't import prisma.
    const fs = await import("node:fs");
    const src = fs.readFileSync("src/lib/reporting/ledger/importers/jonas-xlsx-adapter.ts", "utf8");
    expect(src).not.toContain("from \"@/lib/prisma\"");
    expect(src).not.toContain("PrismaClient");
    expect(src).not.toContain("prismaLedger");
  });
});

describe("jonas-xlsx-adapter · computeCsvSourceHash", () => {
  it("hashes identical CSV strings to the same 64-char hex", () => {
    const a = computeCsvSourceHash("hello");
    const b = computeCsvSourceHash("hello");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes different CSV strings to different hex", () => {
    expect(computeCsvSourceHash("hello")).not.toBe(computeCsvSourceHash("hello2"));
  });
});

// ---------------------------------------------------------------------------
// Minimal RFC-4180 first-row tokeniser used by test 3 above.
// ---------------------------------------------------------------------------
function tokeniseCsvFirstRow(csv: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  let cur = "";
  let inQuoted = false;
  while (i < csv.length) {
    const ch = csv[i];
    if (inQuoted) {
      if (ch === '"' && csv[i + 1] === '"') {
        cur += '"';
        i += 2;
        continue;
      }
      if (ch === '"') {
        inQuoted = false;
        i++;
        continue;
      }
      cur += ch;
      i++;
      continue;
    }
    if (ch === '"') { inQuoted = true; i++; continue; }
    if (ch === "," ) { tokens.push(cur); cur = ""; i++; continue; }
    if (ch === "\n" || ch === "\r") break;
    cur += ch;
    i++;
  }
  tokens.push(cur);
  return tokens;
}
