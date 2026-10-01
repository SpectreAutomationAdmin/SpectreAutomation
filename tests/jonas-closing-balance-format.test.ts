// TB-HIST-4 (2026-10-01) — synthetic workbook tests for the Jonas
// four-column "Closing Balance Trial Balance" (Format C): the
// founder's actual month-end TB export shape.
//
// Covers §12 of the directive:
//   • XLSX parsing (via the existing adapter)
//   • header line breaks and tolerant matching
//   • effective-date-derived FY/period
//   • debit balance preservation
//   • negative credit balance preservation
//   • zero balance round-trip
//   • reconciliation ($0.01 tolerance)
//   • effective-date-required actionable error
//   • Format A/B regression (both still parse)
//
// Does NOT create any accounting records (parser is pure).

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { parseJonasXlsxBuffer } from "@/lib/reporting/ledger/importers/jonas-xlsx-adapter";
import {
  parseJonasGlCsv,
  type JonasGlCsvParseOpts,
} from "@/lib/reporting/ledger/importers/jonas-gl-csv";
import { tallyJonasReconciliation } from "@/lib/reporting/ledger/importers/jonas-reconciliation";

async function buildClosingBalanceWorkbook(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const row of rows) ws.addRow(row);
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

// Founder's actual column headers — NO embedded newlines, NO
// preamble, four columns on the first row.
const FOUNDER_HEADER = [
  "G/L Account Code",
  "G/L Account Description",
  "Closing Bal Debit",
  "Closing Bal Credit",
];

// Dec 31 2025, Coulee fiscal year end Dec 31 → FY2025 · period 12.
const DEC_31_FALLBACK: JonasGlCsvParseOpts["fallbackPeriodEnd"] = {
  calendarYear: 2025,
  calendarMonth: 12,
  fiscalYear: 2025,
  fiscalPeriod: 12,
};

// ---------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------
describe("TB-HIST-4 · Format detection — closing-balance workbook", () => {
  it("header-only four-column workbook + fallback → parses as closing-balance", async () => {
    const buf = await buildClosingBalanceWorkbook([
      FOUNDER_HEADER,
      ["1000", "Petty Cash", 940.90, 0],
      ["3000", "Retained Earnings", 0, -940.90],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv, { fallbackPeriodEnd: DEC_31_FALLBACK });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.detectedFormat).toBe("closing-balance");
    expect(r.headingMetadata).not.toBeNull();
    expect(r.headingMetadata!.fiscalYear).toBe(2025);
    expect(r.headingMetadata!.fiscalPeriod).toBe(12);
    expect(r.headingMetadata!.sourceFormat).toBe("closing-balance");
  });

  it("header-only four-column workbook + NO fallback → effective-date-required (actionable error)", async () => {
    const buf = await buildClosingBalanceWorkbook([
      FOUNDER_HEADER,
      ["1000", "Petty Cash", 940.90, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fileErrors).toHaveLength(1);
    expect(r.fileErrors[0].kind).toBe("effective-date-required");
    // The message must be actionable (name the remediation).
    expect(r.fileErrors[0].message).toMatch(/effective date/i);
    expect(r.fileErrors[0].message).toMatch(/G\/L Account Code/);
  });

  it("full Jonas-native workbook (preamble + 4-col header) → still parses as jonas-native (REGRESSION)", async () => {
    const buf = await buildClosingBalanceWorkbook([
      ["Coulee Country Club"],
      ["Trial Balance for Dec, 2025"],
      ["Closing Period Balances"],
      [
        "G/L Account\nCode",
        "G/L Account\nDescription",
        "Closing Bal\nDebit",
        "Closing Bal\nCredit",
      ],
      ["1000", "Petty Cash", 940.90, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.detectedFormat).toBe("jonas-native");
    expect(r.headingMetadata!.fiscalYear).toBe(2025);
    expect(r.headingMetadata!.fiscalPeriod).toBe(12);
  });

  it("spectre-normalised schema (AccountNumber,…) → still parses (Format A REGRESSION)", () => {
    const csv = [
      "AccountNumber,AccountDescription,PeriodBalance,YTDBalance,FiscalYear,FiscalPeriod",
      "1000,Petty Cash,940.90,940.90,2025,12",
    ].join("\n");
    const r = parseJonasGlCsv(csv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.detectedFormat).toBe("spectre-normalised");
    expect(r.headingMetadata).toBeNull();
  });
});

// ---------------------------------------------------------------
// Column aliasing & tolerant header matching
// ---------------------------------------------------------------
describe("TB-HIST-4 · column aliasing + tolerant header matching", () => {
  it("accepts the exact founder headers verbatim (case, spaces, no newlines)", async () => {
    const buf = await buildClosingBalanceWorkbook([
      FOUNDER_HEADER,
      ["1000", "Petty Cash", 940.90, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv, { fallbackPeriodEnd: DEC_31_FALLBACK });
    expect(r.ok).toBe(true);
  });

  it("tolerates case + whitespace variation on the four header cells", async () => {
    const buf = await buildClosingBalanceWorkbook([
      // Multiple consecutive spaces, lowercase, trailing spaces.
      ["g/l   account  code", "g/l account description ", "closing bal  debit", "CLOSING BAL CREDIT"],
      ["1000", "Petty Cash", 940.90, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv, { fallbackPeriodEnd: DEC_31_FALLBACK });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.detectedFormat).toBe("closing-balance");
  });

  it("tolerates embedded newlines in header cells (adapter CSV with \\n inside quoted cells)", async () => {
    // ExcelJS doesn't let us embed newlines through addRow + plain
    // strings easily, so simulate via raw CSV identical to what the
    // adapter would emit for a true multi-line header cell.
    const csv = [
      '"G/L Account\nCode","G/L Account\nDescription","Closing Bal\nDebit","Closing Bal\nCredit"',
      '1000,"Petty Cash","940.90","0"',
    ].join("\n");
    const r = parseJonasGlCsv(csv, { fallbackPeriodEnd: DEC_31_FALLBACK });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.detectedFormat).toBe("closing-balance");
  });
});

// ---------------------------------------------------------------
// Effective-date-derived FY/period
// ---------------------------------------------------------------
describe("TB-HIST-4 · effective-date → FY/period derivation", () => {
  it("Dec 31 2025 + Dec-31 FY end → FY2025 · period 12", async () => {
    const buf = await buildClosingBalanceWorkbook([
      FOUNDER_HEADER,
      ["1000", "Petty Cash", 940.90, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv, { fallbackPeriodEnd: DEC_31_FALLBACK });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0].fiscalYear).toBe("2025");
    expect(r.rows[0].fiscalPeriod).toBe(12);
  });

  it("Jan 31 2026 + Dec-31 FY end → FY2026 · period 1", async () => {
    const buf = await buildClosingBalanceWorkbook([
      FOUNDER_HEADER,
      ["1000", "Petty Cash", 1234.56, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv, {
      fallbackPeriodEnd: {
        calendarYear: 2026,
        calendarMonth: 1,
        fiscalYear: 2026,
        fiscalPeriod: 1,
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0].fiscalYear).toBe("2026");
    expect(r.rows[0].fiscalPeriod).toBe(1);
  });

  it("non-calendar fiscal year (e.g. Jun 30 FY-end): May 31 2026 → FY2026 · period 11", async () => {
    const buf = await buildClosingBalanceWorkbook([
      FOUNDER_HEADER,
      ["4000", "Revenue", 50000, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    // Caller resolved FY labels upstream — parser trusts the fallback.
    const r = parseJonasGlCsv(csv, {
      fallbackPeriodEnd: {
        calendarYear: 2026,
        calendarMonth: 5,
        fiscalYear: 2026,
        fiscalPeriod: 11,
      },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0].fiscalYear).toBe("2026");
    expect(r.rows[0].fiscalPeriod).toBe(11);
  });
});

// ---------------------------------------------------------------
// Natural-side balance preservation
// ---------------------------------------------------------------
describe("TB-HIST-4 · natural-side balance preservation (no sign flip)", () => {
  it("debit balance survives: Petty Cash 940.90 / 0 → debit=940.90", async () => {
    const buf = await buildClosingBalanceWorkbook([
      FOUNDER_HEADER,
      ["1000", "Petty Cash", 940.90, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv, { fallbackPeriodEnd: DEC_31_FALLBACK });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0].debit).toBe(940.90);
    expect(r.rows[0].credit).toBe(0);
    expect(r.rows[0].periodBalance).toBeCloseTo(940.90, 2);
    expect(r.rows[0].ytdBalance).toBeCloseTo(940.90, 2);
  });

  it("negative credit balance survives: Bank Mortgage 0 / -1,523,915.64 → credit magnitude 1,523,915.64", async () => {
    const buf = await buildClosingBalanceWorkbook([
      FOUNDER_HEADER,
      ["2700", "Bank - Credit Facilities/Mortgage", 0, -1523915.64],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv, { fallbackPeriodEnd: DEC_31_FALLBACK });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The normaliser emits ABS magnitudes for debit/credit (reconciliation
    // uses them as unsigned sums). The signed periodBalance stays
    // debit-positive, so a credit account comes out negative.
    expect(r.rows[0].debit).toBe(0);
    expect(r.rows[0].credit).toBe(1523915.64);
    expect(r.rows[0].periodBalance).toBeCloseTo(-1523915.64, 2);
    // ytdBalance = natural-side magnitude (positive).
    expect(r.rows[0].ytdBalance).toBeCloseTo(1523915.64, 2);
  });

  it("positive-credit convention also survives (same magnitude handled by |x|)", async () => {
    const buf = await buildClosingBalanceWorkbook([
      FOUNDER_HEADER,
      ["3000", "Equity", 0, 500000],  // positive credit
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv, { fallbackPeriodEnd: DEC_31_FALLBACK });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0].credit).toBe(500000);
    expect(r.rows[0].periodBalance).toBeCloseTo(-500000, 2);
    expect(r.rows[0].ytdBalance).toBeCloseTo(500000, 2);
  });

  it("zero balance round-trips (0 / 0)", async () => {
    const buf = await buildClosingBalanceWorkbook([
      FOUNDER_HEADER,
      ["1990", "Suspense", 0, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv, { fallbackPeriodEnd: DEC_31_FALLBACK });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0].debit).toBe(0);
    expect(r.rows[0].credit).toBe(0);
    expect(r.rows[0].periodBalance).toBe(0);
    expect(r.rows[0].ytdBalance).toBe(0);
  });

  it("contra balance (unexpected debit on a credit account) is preserved verbatim — not forced to the natural side", async () => {
    // A revenue account (natural credit) with a DEBIT balance (contra /
    // credit-reversal). The parser must preserve the raw source, not
    // flip it to the "expected" side.
    const buf = await buildClosingBalanceWorkbook([
      FOUNDER_HEADER,
      ["4100", "Member Dues - Revenue (contra posted)", 2500, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv, { fallbackPeriodEnd: DEC_31_FALLBACK });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0].debit).toBe(2500);
    expect(r.rows[0].credit).toBe(0);
    expect(r.rows[0].periodBalance).toBe(2500);
  });
});

// ---------------------------------------------------------------
// Reconciliation
// ---------------------------------------------------------------
describe("TB-HIST-4 · reconciliation + $0.01 tolerance", () => {
  it("balanced TB: debit account + credit account of equal magnitude → delta 0", async () => {
    const buf = await buildClosingBalanceWorkbook([
      FOUNDER_HEADER,
      ["1000", "Cash", 1000, 0],
      ["3000", "Equity", 0, -1000],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv, { fallbackPeriodEnd: DEC_31_FALLBACK });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tally = tallyJonasReconciliation(r.rows);
    expect(tally.totalDebits).toBe(1000);
    expect(tally.totalCredits).toBe(1000);
    expect(tally.delta).toBe(0);
    expect(tally.isBalanced).toBe(true);
  });

  it("unbalanced TB: 100.00 vs 99.98 → delta 0.02 (fails $0.01 tolerance)", async () => {
    const buf = await buildClosingBalanceWorkbook([
      FOUNDER_HEADER,
      ["1000", "Cash", 100.00, 0],
      ["3000", "Equity", 0, -99.98],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv, { fallbackPeriodEnd: DEC_31_FALLBACK });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tally = tallyJonasReconciliation(r.rows);
    expect(Math.abs(tally.delta)).toBeCloseTo(0.02, 2);
  });

  it("negative-credit source still contributes positive magnitude to the credit total", async () => {
    const buf = await buildClosingBalanceWorkbook([
      FOUNDER_HEADER,
      ["1000", "Cash", 1523915.64, 0],
      ["2700", "Bank Mortgage", 0, -1523915.64],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv, { fallbackPeriodEnd: DEC_31_FALLBACK });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tally = tallyJonasReconciliation(r.rows);
    expect(tally.totalDebits).toBeCloseTo(1523915.64, 2);
    expect(tally.totalCredits).toBeCloseTo(1523915.64, 2);
    expect(tally.delta).toBeCloseTo(0, 2);
  });
});

// ---------------------------------------------------------------
// Dimensional: no Department column + REQUIRED policy
// ---------------------------------------------------------------
describe("TB-HIST-4 · Format C has no Department column (parser-level)", () => {
  it("every parsed row has department=null (no fabrication)", async () => {
    const buf = await buildClosingBalanceWorkbook([
      FOUNDER_HEADER,
      ["1000", "Cash", 1000, 0],
      ["3000", "Equity", 0, -1000],
      ["6098", "F&B Payroll", 50000, 0],
      ["6099", "Admin Payroll", 30000, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv, { fallbackPeriodEnd: DEC_31_FALLBACK });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    for (const row of r.rows) {
      expect(row.department).toBeNull();
    }
  });
});

// ---------------------------------------------------------------
// Preview must NOT create any accounting records (structural guard)
// ---------------------------------------------------------------
describe("TB-HIST-4 · parser is pure (no I/O guard)", () => {
  it("parseJonasGlCsv does not import prisma or any writer", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(__dirname, "..", "src/lib/reporting/ledger/importers/jonas-gl-csv.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from ["']@\/lib\/prisma/);
    expect(src).not.toMatch(/prisma\./);
    expect(src).not.toMatch(/PrismaReportingLedger/);
  });
});
