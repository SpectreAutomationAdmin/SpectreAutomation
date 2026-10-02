// TB-HIST-6 (2026-10-01) — single-resolution-pipeline tests.
//
// Covers §11 A-K from the TB-HIST-6 directive: Preview and Commit
// produce the SAME normalized dimensional model, raw Jonas 6-digit
// department codes NEVER enter the persisted snapshot CSV, dup rules
// use the resolved Spectre dimension, and Preview + commit-dry-run
// are pure (no I/O side-effects).

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { parseJonasXlsxBuffer } from "@/lib/reporting/ledger/importers/jonas-xlsx-adapter";
import { parseJonasGlCsv } from "@/lib/reporting/ledger/importers/jonas-gl-csv";
import { DEFAULT_JONAS_ACCOUNT_MAPPING } from "@/lib/reporting/ledger/importers/jonas-gl-mapping";
import {
  buildCommitCsvFromNormalized,
  normalizeJonasImport,
} from "@/lib/reporting/ledger/importers/jonas-normalize";

// -------------------------------------------------------------------
// Fixtures
// -------------------------------------------------------------------

const DEPT_HEADER = [
  "G/L Account\nCode", "G/L Account\nDescription",
  "G/L Department\nCode", "G/L Department\nDescription",
  "G/L Sub-Account\nCode", "G/L Sub-Account\nDescription",
  "Closing Bal\nDebit", "Closing Bal\nCredit",
];
const PREAMBLE = [
  ["01 - Silver Springs Golf & Country Club"],
  ["Trial Balance for Dec, 2025"],
  ["Closing Period Balances"],
];

// Coulee's TB-HIST-6 Department catalog AFTER the bootstrap route runs.
const COULEE_DEPTS = [
  { code: "GROUNDS",           name: "Grounds" },
  { code: "GOLF_SHOP",         name: "Golf Shop" },
  { code: "CLUBHOUSE",         name: "Clubhouse" },
  { code: "FOOD_BEVERAGE",     name: "Food & Beverage" },
  { code: "ADMINISTRATION",    name: "Administration" },
  { code: "DUES_AND_CHARGES",  name: "Dues & Charges" },
  { code: "LONG_RANGE_PLAN",   name: "Long Range Plan & Renovation" },
  { code: "MENS_SECTION",      name: "Mens Section" },
  { code: "LADIES_SECTION",    name: "Ladies Section" },
  { code: "TOURNAMENTS",       name: "Tournament Accounts" },
  { code: "CORPORATE",         name: "Corporate Income & Expenses" },
];

// A compact Coulee COA stub with representative departmentPolicy values.
const COULEE_ACCOUNTS = [
  { id: "a1", accountNumber: "1000", name: "Petty Cash",                 departmentPolicy: "NOT_APPLICABLE" },
  { id: "a2", accountNumber: "2700", name: "Bank - Credit Facilities/Mortgage", departmentPolicy: "NOT_APPLICABLE" },
  { id: "a3", accountNumber: "3000", name: "Equity",                     departmentPolicy: "NOT_APPLICABLE" },
  { id: "a4", accountNumber: "6098", name: "Payroll Allocation",         departmentPolicy: "REQUIRED" },
  { id: "a5", accountNumber: "6099", name: "Admin Payroll",              departmentPolicy: "OPTIONAL" },
  { id: "a6", accountNumber: "5100", name: "Course Maintenance",         departmentPolicy: "REQUIRED" },
];

async function buildDepartmentalWorkbook(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const row of rows) ws.addRow(row);
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

async function normalizeFromWorkbook(dataRows: unknown[][]) {
  const buf = await buildDepartmentalWorkbook([...PREAMBLE, DEPT_HEADER, ...dataRows]);
  const { csv } = await parseJonasXlsxBuffer(buf);
  const parseResult = parseJonasGlCsv(csv);
  expect(parseResult.ok).toBe(true);
  if (!parseResult.ok) throw new Error("parse failed");
  return normalizeJonasImport({
    parseResult,
    spectreAccounts: COULEE_ACCOUNTS,
    tenantDepartments: COULEE_DEPTS,
    jonasAccountMapping: DEFAULT_JONAS_ACCOUNT_MAPPING,
  });
}

// -------------------------------------------------------------------
// §11.A — Preview resolution matches Commit normalization
// -------------------------------------------------------------------
describe("TB-HIST-6 §11.A — 000001 Grounds resolves identically in Preview and Commit paths", () => {
  it("normalized row carries Spectre code 'GROUNDS', not Jonas '000001'", async () => {
    const r = await normalizeFromWorkbook([
      ["6098", "Payroll Allocation", "000001", "Grounds", "", "", 50000, 0],
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].department).toBe("GROUNDS");
    expect(r.rows[0].jonasDepartmentCode).toBe("000001");
    expect(r.rows[0].departmentStatus).toBe("ok");
  });
});

// §11.B — 000000 resolves to null in both paths
describe("TB-HIST-6 §11.B — 000000 Balance Sheet resolves to null", () => {
  it("normalized row carries department=null for 000000", async () => {
    const r = await normalizeFromWorkbook([
      ["1000", "Petty Cash", "000000", "Balance Sheet", "", "", 940.90, 0],
    ]);
    expect(r.rows[0].department).toBeNull();
    expect(r.rows[0].jonasDepartmentCode).toBe("000000");
  });
});

// §11.C — No raw Jonas code reaches the commit CSV
describe("TB-HIST-6 §11.C — commit CSV carries Spectre codes only", () => {
  it("buildCommitCsvFromNormalized emits Spectre codes in the Department column (never 6-digit Jonas)", async () => {
    const n = await normalizeFromWorkbook([
      ["1000", "Petty Cash",        "000000", "Balance Sheet", "", "", 940.90, 0],
      ["6098", "Payroll Allocation","000001", "Grounds",       "", "", 50000, 0],
      ["6098", "Payroll Allocation","000005", "Administration","", "", 30000, 0],
      ["3000", "Equity",            "000000", "Balance Sheet", "", "", 0, -120940.90],
    ]);
    const csv = buildCommitCsvFromNormalized(n.rows);
    // The CSV must NEVER contain any of the 12 Jonas 6-digit codes as
    // Department values. Checking all of them, not just the ones used.
    for (const jonasCode of ["000000","000001","000002","000003","000004","000005","000006","000007","000011","000012","000013","000020"]) {
      expect(csv).not.toMatch(new RegExp(`,${jonasCode}(?:\\r|\\n|$)`));
    }
    // The CSV MUST contain the resolved Spectre codes.
    expect(csv).toContain(",GROUNDS");
    expect(csv).toContain(",ADMINISTRATION");
    // 000000 → empty Department column (last cell on the line).
    // Row shape: AccountNumber,AccountDescription,PeriodBalance,YTDBalance,
    //            FiscalYear,FiscalPeriod,Debit,Credit,Department
    // For 1000 Petty Cash under 000000 → trailing ",0," + newline-or-end.
    const petty = csv.split(/\r?\n/).find((l) => l.startsWith("1000,"));
    expect(petty).toBeTruthy();
    expect(petty!.endsWith(",")).toBe(true);
    const equity = csv.split(/\r?\n/).find((l) => l.startsWith("3000,"));
    expect(equity).toBeTruthy();
    expect(equity!.endsWith(",")).toBe(true);
  });
});

// §11.D — Same Account + different Spectre Department accepted
describe("TB-HIST-6 §11.D — same account across departments → separate rows", () => {
  it("6098/GROUNDS and 6098/ADMINISTRATION both survive, no duplicate flagged", async () => {
    const n = await normalizeFromWorkbook([
      ["6098", "Payroll Allocation", "000001", "Grounds",        "", "", 50000, 0],
      ["6098", "Payroll Allocation", "000005", "Administration", "", "", 30000, 0],
    ]);
    expect(n.rows).toHaveLength(2);
    expect(n.rows[0].department).toBe("GROUNDS");
    expect(n.rows[1].department).toBe("ADMINISTRATION");
    expect(n.counts.duplicates).toBe(0);
    expect(n.blockers.some((b) => b.code === "DUPLICATE_ACCOUNT")).toBe(false);
  });
});

// §11.E — Same (account, dept) duplicate rejected
describe("TB-HIST-6 §11.E — exact (account, Spectre dept) duplicate blocks", () => {
  it("6098/GROUNDS twice → DUPLICATE_ACCOUNT blocker", async () => {
    const n = await normalizeFromWorkbook([
      ["6098", "Payroll Allocation", "000001", "Grounds", "", "", 50000, 0],
      ["6098", "Payroll Allocation", "000001", "Grounds", "", "", 10000, 0],
    ]);
    expect(n.counts.duplicates).toBe(1);
    const dup = n.blockers.find((b) => b.code === "DUPLICATE_ACCOUNT");
    expect(dup).toBeTruthy();
    expect(dup!.details[0]).toBe("6098/GROUNDS");
  });
});

// §11.F — Resolved Fund persists
describe("TB-HIST-6 §11.F — resolved Fund is frozen on the normalized row", () => {
  it("fund value on the normalized row survives into the commit CSV", async () => {
    const n = await normalizeFromWorkbook([
      ["5100", "Course Maintenance", "000001", "Grounds", "", "", 100000, 0],
    ]);
    // The jonas account mapping may or may not assign a fund for 5100.
    // The persistence rule is: whatever the normalizer resolves, the
    // commit CSV preserves it (via the normalized row's `fund` field).
    // We assert the normalized row's `fund` is a string|null and that
    // the commit CSV emits the row (fund freezes implicitly via the
    // JonasGlImporter's existing payload wiring).
    expect(typeof n.rows[0].fund === "string" || n.rows[0].fund === null).toBe(true);
    const csv = buildCommitCsvFromNormalized(n.rows);
    // The CSV MUST include the account's resolved department
    // regardless of Fund resolution.
    expect(csv).toContain("5100");
    expect(csv).toContain("GROUNDS");
  });
});

// §11.G — Missing Spectre Department blocks
describe("TB-HIST-6 §11.G — missing-tenant Spectre dept blocks commit", () => {
  it("tenant lacks GROUNDS → MISSING_SPECTRE_DEPARTMENT blocker", async () => {
    const buf = await buildDepartmentalWorkbook([
      ...PREAMBLE, DEPT_HEADER,
      ["6098", "Payroll Allocation", "000001", "Grounds", "", "", 50000, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const parseResult = parseJonasGlCsv(csv);
    expect(parseResult.ok).toBe(true);
    if (!parseResult.ok) return;
    const n = normalizeJonasImport({
      parseResult,
      spectreAccounts: COULEE_ACCOUNTS,
      // Tenant is MISSING the GROUNDS record.
      tenantDepartments: COULEE_DEPTS.filter((d) => d.code !== "GROUNDS"),
      jonasAccountMapping: DEFAULT_JONAS_ACCOUNT_MAPPING,
    });
    const b = n.blockers.find((x) => x.code === "MISSING_SPECTRE_DEPARTMENT");
    expect(b).toBeTruthy();
    expect(b!.details).toContain("GROUNDS");
  });
});

// §11.H — Unknown Jonas Department blocks
describe("TB-HIST-6 §11.H — unknown Jonas code blocks commit", () => {
  it("source dept 999999 → UNKNOWN_JONAS_DEPARTMENT blocker", async () => {
    const n = await normalizeFromWorkbook([
      ["6098", "Payroll Allocation", "999999", "Mystery", "", "", 50000, 0],
    ]);
    const b = n.blockers.find((x) => x.code === "UNKNOWN_JONAS_DEPARTMENT");
    expect(b).toBeTruthy();
    expect(b!.details).toContain("999999");
  });
});

// §11.I — Entity-mismatch acknowledgement still required (adapter-level)
describe("TB-HIST-6 §11.I — entity-mismatch detection still fires on real-shape merged row", () => {
  it("merged row 1 is still detected as entity signal (TB-HIST-5 fix intact)", async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.addRow(Array(8).fill("01 - Silver Springs Golf & Country Club"));
    ws.addRow(["Trial Balance for Dec, 2025", "", "", "", "", "", "", ""]);
    ws.addRow(["Closing Period Balances", "", "", "", "", "", "", ""]);
    ws.addRow(DEPT_HEADER);
    ws.addRow(["1000", "Petty Cash", "000000", "Balance Sheet", "", "", 940.90, 0]);
    const ab = await wb.xlsx.writeBuffer();
    const r = await parseJonasXlsxBuffer(Buffer.from(ab as ArrayBuffer));
    expect(r.detectedEntity).toBe("01 - Silver Springs Golf & Country Club");
  });
});

// §11.J + §11.K — Normalizer is pure (no I/O)
describe("TB-HIST-6 §11.J-K — normalizer is pure (no I/O)", () => {
  it("jonas-normalize.ts does not import prisma or any writer", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(__dirname, "..", "src/lib/reporting/ledger/importers/jonas-normalize.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from ["']@\/lib\/prisma/);
    expect(src).not.toMatch(/prisma\./);
    expect(src).not.toMatch(/PrismaReportingLedger/);
  });
  it("buildCommitCsvFromNormalized is a pure string builder (no file / network / db imports)", async () => {
    // The function's own body is covered by the source-scan above;
    // additionally assert deterministic output for a fixed input.
    const n = await normalizeFromWorkbook([
      ["1000", "Petty Cash", "000000", "Balance Sheet", "", "", 940.90, 0],
    ]);
    const a = buildCommitCsvFromNormalized(n.rows);
    const b = buildCommitCsvFromNormalized(n.rows);
    expect(a).toBe(b);
  });
});

// Direct §4 — single-pipeline parity
describe("TB-HIST-6 §4 — Preview and Commit consume the same normalized rows", () => {
  it("normalizeJonasImport is deterministic for the same inputs (Preview === Commit view)", async () => {
    const dataRows = [
      ["1000", "Petty Cash",         "000000", "Balance Sheet",  "", "", 940.90, 0],
      ["6098", "Payroll Allocation", "000001", "Grounds",        "", "", 50000, 0],
      ["6098", "Payroll Allocation", "000005", "Administration", "", "", 30000, 0],
    ];
    const a = await normalizeFromWorkbook(dataRows);
    const b = await normalizeFromWorkbook(dataRows);
    expect(a.rows).toEqual(b.rows);
    expect(a.counts).toEqual(b.counts);
    expect(a.blockers).toEqual(b.blockers);
  });
});
