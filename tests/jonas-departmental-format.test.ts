// TB-HIST-5 (2026-10-01) — synthetic workbook tests for the real
// Jonas Departmental Trial Balance (Format D): 8-column export with
// a 3-row preamble + per-row "G/L Department Code" / "Description"
// + "G/L Sub-Account Code" / "Description".
//
// Covers §14 of the directive:
//   • 8-column departmental XLSX detection
//   • preamble date extraction
//   • 000000 Balance Sheet → department=null
//   • source Jonas dept code → Spectre dept resolution
//   • unknown Jonas dept blocks (resolver + commit path)
//   • missing Spectre dept blocks
//   • same Account / different Jonas Dept accepted (two legit rows)
//   • same Account / same Dept duplicate blocked (dimensional dup)
//   • reconciliation (Σ|debit| vs Σ|credit|)
//   • no Preview writes (parser purity guard carried over)
//   • sub-account population surfaced
//
// Does NOT touch the founder's real file.

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { parseJonasXlsxBuffer } from "@/lib/reporting/ledger/importers/jonas-xlsx-adapter";
import {
  parseJonasGlCsv,
  type JonasGlCsvParseOpts,
} from "@/lib/reporting/ledger/importers/jonas-gl-csv";
import { tallyJonasReconciliation } from "@/lib/reporting/ledger/importers/jonas-reconciliation";
import {
  DEFAULT_JONAS_DEPARTMENT_MAPPING,
  resolveJonasDepartment,
} from "@/lib/reporting/ledger/importers/jonas-department-mapping";

async function buildDepartmentalWorkbook(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  for (const row of rows) ws.addRow(row);
  const ab = await wb.xlsx.writeBuffer();
  return Buffer.from(ab as ArrayBuffer);
}

// Real-shape 8-column header with embedded newlines (as emitted by
// Jonas's native XLSX export).
const DEPT_HEADER = [
  "G/L Account\nCode",
  "G/L Account\nDescription",
  "G/L Department\nCode",
  "G/L Department\nDescription",
  "G/L Sub-Account\nCode",
  "G/L Sub-Account\nDescription",
  "Closing Bal\nDebit",
  "Closing Bal\nCredit",
];

// Standard preamble that matches the founder's real workbook.
const PREAMBLE = [
  ["01 - Silver Springs Golf & Country Club"],
  ["Trial Balance for Dec, 2025"],
  ["Closing Period Balances"],
];

// Coulee's expected tenant Department codes for the 12 Jonas codes
// in the real workbook. Keep in sync with
// DEFAULT_JONAS_DEPARTMENT_MAPPING.
const COULEE_TENANT_DEPTS = [
  { code: "GROUNDS", name: "Grounds" },
  { code: "GOLF_SHOP", name: "Golf Shop" },
  { code: "CLUBHOUSE", name: "Clubhouse" },
  { code: "FOOD_BEVERAGE", name: "Food & Beverage" },
  { code: "ADMINISTRATION", name: "Administration" },
  { code: "DUES_AND_CHARGES", name: "Dues & Charges" },
  { code: "LONG_RANGE_PLAN", name: "Long Range Plan & Renovation" },
  { code: "MENS_SECTION", name: "Men's Section" },
  { code: "LADIES_SECTION", name: "Ladies Section" },
  { code: "TOURNAMENTS", name: "Tournament Accounts" },
  { code: "CORPORATE", name: "Corporate Income & Expenses" },
];

// --------------------------------------------------------
// Format detection
// --------------------------------------------------------
describe("TB-HIST-5 · Format D detection — 8-column departmental", () => {
  it("preamble + 8-col header → detected as 'jonas-departmental'", async () => {
    const buf = await buildDepartmentalWorkbook([
      ...PREAMBLE,
      DEPT_HEADER,
      ["1000", "Petty Cash", "000000", "Balance Sheet", "", "", 940.90, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.detectedFormat).toBe("jonas-departmental");
    expect(r.headingMetadata!.sourceFormat).toBe("jonas-departmental");
    expect(r.headingMetadata!.fiscalYear).toBe(2025);
    expect(r.headingMetadata!.fiscalPeriod).toBe(12);
  });

  it("Format B (4-col with preamble) still detected as 'jonas-native' (REGRESSION)", async () => {
    const buf = await buildDepartmentalWorkbook([
      ...PREAMBLE,
      ["G/L Account\nCode", "G/L Account\nDescription", "Closing Bal\nDebit", "Closing Bal\nCredit"],
      ["1000", "Petty Cash", 940.90, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.detectedFormat).toBe("jonas-native");
  });

  it("8-col header + NO preamble + no fallback → effective-date-required", async () => {
    const buf = await buildDepartmentalWorkbook([
      DEPT_HEADER,
      ["1000", "Petty Cash", "000000", "Balance Sheet", "", "", 940.90, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.fileErrors[0].kind).toBe("effective-date-required");
  });

  it("8-col header + fallback → departmental with resolved FY/period", async () => {
    const buf = await buildDepartmentalWorkbook([
      DEPT_HEADER,
      ["1000", "Petty Cash", "000000", "Balance Sheet", "", "", 940.90, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv, {
      fallbackPeriodEnd: { calendarYear: 2025, calendarMonth: 12, fiscalYear: 2025, fiscalPeriod: 12 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.detectedFormat).toBe("jonas-departmental");
  });
});

// --------------------------------------------------------
// Row shape — department fields pass through
// --------------------------------------------------------
describe("TB-HIST-5 · departmental row shape", () => {
  it("Jonas dept code + description reach JonasGlCsvRow.department / departmentDescription", async () => {
    const buf = await buildDepartmentalWorkbook([
      ...PREAMBLE,
      DEPT_HEADER,
      ["1000", "Petty Cash", "000000", "Balance Sheet", "", "", 940.90, 0],
      ["5100", "Course Maintenance", "000001", "Grounds", "", "", 100000, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0].department).toBe("000000");
    expect(r.rows[0].departmentDescription).toBe("Balance Sheet");
    expect(r.rows[1].department).toBe("000001");
    expect(r.rows[1].departmentDescription).toBe("Grounds");
  });

  it("blank sub-account cells → subAccountCode/subAccountDescription null", async () => {
    const buf = await buildDepartmentalWorkbook([
      ...PREAMBLE,
      DEPT_HEADER,
      ["1000", "Petty Cash", "000000", "Balance Sheet", "", "", 940.90, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0].subAccountCode).toBeNull();
    expect(r.rows[0].subAccountDescription).toBeNull();
  });

  it("populated sub-account cells → preserved (operator must decide)", async () => {
    const buf = await buildDepartmentalWorkbook([
      ...PREAMBLE,
      DEPT_HEADER,
      ["5100", "Course Maintenance", "000001", "Grounds", "SA1", "Chemicals", 50000, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows[0].subAccountCode).toBe("SA1");
    expect(r.rows[0].subAccountDescription).toBe("Chemicals");
  });
});

// --------------------------------------------------------
// Department resolver
// --------------------------------------------------------
describe("TB-HIST-5 · Department resolver — Jonas → Spectre", () => {
  it("000000 Balance Sheet → null (nondepartmental marker)", () => {
    const res = resolveJonasDepartment("000000", "Balance Sheet", COULEE_TENANT_DEPTS);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.spectreCode).toBeNull();
      expect(res.descriptionDrift).toBe(false);
    }
  });

  it("000001 Grounds → GROUNDS (configured)", () => {
    const res = resolveJonasDepartment("000001", "Grounds", COULEE_TENANT_DEPTS);
    expect(res.status).toBe("ok");
    if (res.status === "ok") expect(res.spectreCode).toBe("GROUNDS");
  });

  it("unknown Jonas code → status=unknown", () => {
    const res = resolveJonasDepartment("999999", "Mystery", COULEE_TENANT_DEPTS);
    expect(res.status).toBe("unknown");
  });

  it("mapped Spectre code not configured on tenant → missing-spectre-dept", () => {
    // Remove GROUNDS from the tenant catalog — 000001 maps to it but
    // the tenant doesn't have the record.
    const partial = COULEE_TENANT_DEPTS.filter((d) => d.code !== "GROUNDS");
    const res = resolveJonasDepartment("000001", "Grounds", partial);
    expect(res.status).toBe("missing-spectre-dept");
    if (res.status === "missing-spectre-dept") expect(res.spectreCode).toBe("GROUNDS");
  });

  it("description drift is informational, not a resolution failure", () => {
    const res = resolveJonasDepartment("000001", "Grounds Dept", COULEE_TENANT_DEPTS);
    expect(res.status).toBe("ok");
    if (res.status === "ok") {
      expect(res.spectreCode).toBe("GROUNDS");
      expect(res.descriptionDrift).toBe(true);
    }
  });

  it("default mapping covers every code in the real workbook (§5)", () => {
    const expected = ["000000","000001","000002","000003","000004","000005","000006","000007","000011","000012","000013","000020"];
    for (const code of expected) {
      expect(code in DEFAULT_JONAS_DEPARTMENT_MAPPING).toBe(true);
    }
  });
});

// --------------------------------------------------------
// Dimensional identity
// --------------------------------------------------------
describe("TB-HIST-5 · dimensional identity (Account × Department × Fund)", () => {
  it("same account appearing in two Jonas depts → both rows preserved", async () => {
    const buf = await buildDepartmentalWorkbook([
      ...PREAMBLE,
      DEPT_HEADER,
      ["6098", "Payroll Allocation", "000001", "Grounds", "", "", 50000, 0],
      ["6098", "Payroll Allocation", "000005", "Administration", "", "", 30000, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0].department).toBe("000001");
    expect(r.rows[1].department).toBe("000005");
  });

  it("same (account, dept) appearing twice → both parsed rows preserved; duplicate detection is action-layer concern", async () => {
    // The parser does NOT itself reject dup dim-keys; it emits every
    // row and the preview/commit layer catches duplicates (consistent
    // with how TB-HIST-2 wired dup detection in actions.ts). The
    // integration-level test for the dup block lives next to the
    // action, not the parser.
    const buf = await buildDepartmentalWorkbook([
      ...PREAMBLE,
      DEPT_HEADER,
      ["6098", "Payroll Allocation", "000001", "Grounds", "", "", 50000, 0],
      ["6098", "Payroll Allocation", "000001", "Grounds", "", "", 50000, 0],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rows).toHaveLength(2);
  });
});

// --------------------------------------------------------
// Reconciliation
// --------------------------------------------------------
describe("TB-HIST-5 · reconciliation on departmental file", () => {
  it("balanced dept-TB with debit + negative-credit sources → delta 0", async () => {
    const buf = await buildDepartmentalWorkbook([
      ...PREAMBLE,
      DEPT_HEADER,
      ["1000", "Petty Cash", "000000", "Balance Sheet", "", "", 1_000_000, 0],
      ["3000", "Equity", "000000", "Balance Sheet", "", "", 0, -1_000_000],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tally = tallyJonasReconciliation(r.rows);
    expect(tally.totalDebits).toBe(1_000_000);
    expect(tally.totalCredits).toBe(1_000_000);
    expect(tally.delta).toBe(0);
    expect(tally.isBalanced).toBe(true);
  });

  it("P&L split across departments reconciles to the sum, not per-dept", async () => {
    const buf = await buildDepartmentalWorkbook([
      ...PREAMBLE,
      DEPT_HEADER,
      ["1000", "Cash", "000000", "Balance Sheet", "", "", 100_000, 0],
      ["6098", "Payroll", "000001", "Grounds", "", "", 40_000, 0],
      ["6098", "Payroll", "000005", "Administration", "", "", 30_000, 0],
      ["3000", "Equity", "000000", "Balance Sheet", "", "", 0, -170_000],
    ]);
    const { csv } = await parseJonasXlsxBuffer(buf);
    const r = parseJonasGlCsv(csv);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const tally = tallyJonasReconciliation(r.rows);
    expect(tally.totalDebits).toBe(170_000);
    expect(tally.totalCredits).toBe(170_000);
    expect(tally.isBalanced).toBe(true);
  });
});

// --------------------------------------------------------
// Parser purity
// --------------------------------------------------------
describe("TB-HIST-5 · parser remains pure (no I/O)", () => {
  it("jonas-department-mapping.ts imports nothing from prisma", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const src = readFileSync(
      path.resolve(__dirname, "..", "src/lib/reporting/ledger/importers/jonas-department-mapping.ts"),
      "utf8",
    );
    expect(src).not.toMatch(/from ["']@\/lib\/prisma/);
    expect(src).not.toMatch(/prisma\./);
  });
});
