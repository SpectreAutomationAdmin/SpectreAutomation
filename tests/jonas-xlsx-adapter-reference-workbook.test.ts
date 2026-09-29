// TB-RESET-1d.b.1 — READ-ONLY parser check against the founder's
// authoritative reference workbook.
//
// Founder direction (1d.b.1 brief, "READ-ONLY FOUNDER WORKBOOK CHECK"):
//   • May run the completed adapter against the workbook.
//   • MUST NOT invoke the importer writer or create any DB record.
//   • Report the sums, detected entity, and any duplicates.
//
// The workbook lives outside the repo at
// `C:/Users/cturcato/Downloads/1. Trial Balance Key.xlsx`. This test
// is intentionally SKIPPED when that file is absent (e.g. in CI, in
// another developer's environment) so the suite never fails on
// external-file access.

import { readFileSync, existsSync } from "node:fs";
import { describe, it, expect } from "vitest";

import { parseJonasXlsxBuffer } from "@/lib/reporting/ledger/importers/jonas-xlsx-adapter";

const REFERENCE_PATH = "C:/Users/cturcato/Downloads/1. Trial Balance Key.xlsx";

// The founder-stated acceptance characteristics from TB-RESET-1
// investigation:
const EXPECTED_ACCOUNTS = 237;
const EXPECTED_TOTAL_ABS = 29656391.67; // $29,656,391.67 (each side)

// A tokeniser identical to the adapter's inverse operation — same
// RFC-4180 rules used by parseJonasGlCsv. This is deliberately
// self-contained so this test proves the adapter's OUTPUT is
// consumable, not that it agrees with the downstream parser.
function tokenise(row: string): string[] {
  const tokens: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (inQ) {
      if (ch === '"' && row[i + 1] === '"') { cur += '"'; i++; continue; }
      if (ch === '"') { inQ = false; continue; }
      cur += ch;
      continue;
    }
    if (ch === '"') { inQ = true; continue; }
    if (ch === ",") { tokens.push(cur); cur = ""; continue; }
    cur += ch;
  }
  tokens.push(cur);
  return tokens;
}

const workbookAvailable = existsSync(REFERENCE_PATH);
const suite = workbookAvailable ? describe : describe.skip;

suite("jonas-xlsx-adapter · READ-ONLY reference-workbook parser check (TB-RESET-1d.b.1)", () => {
  it("reproduces the founder's stated reference acceptance characteristics — no DB writes performed", async () => {
    const buf = readFileSync(REFERENCE_PATH);
    const result = await parseJonasXlsxBuffer(buf);

    // Adapter shape sanity.
    expect(result.sheetName).toBe("Sheet1");
    expect(result.sourceFileHash).toMatch(/^[0-9a-f]{64}$/);

    // Extract accounts + totals from the adapter output.
    // The reference workbook is a data-only variant (no Jonas heading
    // rows — the founder confirmed detectedEntity should be null and
    // no effective date should be inferred). Every non-empty row
    // starting from row 2 is data; row 1 is the column header.
    const lines = result.csv.split(/\r\n|\n/).filter((l) => l.trim().length > 0);
    // Concatenate quoted-newline continuations back into single rows.
    const rows: string[] = [];
    let pending = "";
    let openQuotes = 0;
    for (const line of lines) {
      pending += (pending ? "\n" : "") + line;
      openQuotes += (line.match(/"/g) || []).length;
      if (openQuotes % 2 === 0) {
        rows.push(pending);
        pending = "";
        openQuotes = 0;
      }
    }
    // Row 0 = header (with embedded newlines quoted). Row 1..N = data.
    const dataRows = rows.slice(1);

    // Tokenise + accumulate totals.
    const accountCodes: string[] = [];
    let sumDebit = 0;
    let sumCredit = 0;
    for (const row of dataRows) {
      const cells = tokenise(row);
      if (cells.length < 4) continue;
      accountCodes.push(cells[0]);
      const d = Number(cells[2]) || 0;
      const c = Number(cells[3]) || 0;
      sumDebit += d;
      sumCredit += c;
    }

    // 237 accounts.
    expect(accountCodes.length).toBe(EXPECTED_ACCOUNTS);

    // Zero duplicates.
    const dupCount = accountCodes.length - new Set(accountCodes).size;
    expect(dupCount).toBe(0);

    // Jonas negative-credit convention: sumDebit + sumCredit ≈ 0
    // when credits are stored as negative. Present as absolute
    // magnitudes for founder-facing UI. The founder-stated
    // reference: $29,656,391.67 each side.
    const absDebit = Math.abs(sumDebit);
    const absCredit = Math.abs(sumCredit);
    // $0.01 tolerance (per TB-RESET-1d.b brief §8).
    expect(absDebit).toBeCloseTo(EXPECTED_TOTAL_ABS, 2);
    expect(absCredit).toBeCloseTo(EXPECTED_TOTAL_ABS, 2);
    // Net (debit + credit-with-Jonas-sign) should be ≤ $0.01.
    expect(Math.abs(sumDebit + sumCredit)).toBeLessThanOrEqual(0.01);

    // Reference workbook has NO Jonas heading rows and NO club-name
    // row per founder observation — the adapter must not fabricate one.
    expect(result.detectedEntity).toBeNull();
    expect(result.hasJonasHeading).toBe(false);

    // Print the founder-facing summary to the test log for the
    // acceptance evidence bundle.
    // eslint-disable-next-line no-console
    console.log("\n== TB-RESET-1d.b.1 · Reference workbook adapter parse ==");
    // eslint-disable-next-line no-console
    console.log("  Rows total:", result.rowCount, "· cols:", result.columnCount);
    // eslint-disable-next-line no-console
    console.log("  Account rows:", accountCodes.length);
    // eslint-disable-next-line no-console
    console.log("  Sum Debit:      $" + absDebit.toFixed(2));
    // eslint-disable-next-line no-console
    console.log("  Sum |Credit|:   $" + absCredit.toFixed(2));
    // eslint-disable-next-line no-console
    console.log("  Net (D + C):    $" + (sumDebit + sumCredit).toFixed(2));
    // eslint-disable-next-line no-console
    console.log("  Duplicate accounts:", dupCount);
    // eslint-disable-next-line no-console
    console.log("  Detected entity:", result.detectedEntity ?? "(none)");
    // eslint-disable-next-line no-console
    console.log("  Detected Jonas heading:", result.hasJonasHeading);
    // eslint-disable-next-line no-console
    console.log("  Source file hash:", result.sourceFileHash);
  });
});
