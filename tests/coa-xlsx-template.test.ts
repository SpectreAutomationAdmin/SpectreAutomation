// COA XLSX template builder + parser contract tests.
//
// These tests EXERCISE the workbook generator end-to-end (build →
// load → assert) rather than relying on source-string matching.
// The contract:
//
//   • 6 worksheets in the founder-named tab order
//   • Every reference tab is sourced from the live CoaMappingOptions
//     (no hard-coded mapping values)
//   • Chart of Accounts has Excel data-validation dropdowns on the
//     optional Type / Category / FS Group cells, formula references
//     pointing at the matching reference sheet
//   • Departments column has NO list validation (multi-value via
//     semicolons doesn't fit Excel's single-cell dropdown model)
//   • No department names appear on the FS Groups sheet
//   • Header rows are frozen
//   • Parser round-trips the workbook + recovers the optional
//     mapping fields when present

import { describe, it, expect } from "vitest";
import ExcelJS from "exceljs";

import type { CoaMappingOptions } from "@/lib/imports/coa-mapping";
import {
  buildCoaXlsxWorkbook,
  coaWorkbookFilename,
} from "@/lib/imports/xlsx-template";
import { parseXlsxRows, looksLikeXlsx } from "@/lib/imports/xlsx-parse";

// A synthetic options fixture that includes both
// founder-canonical entries AND a future-fictional taxonomy entry
// for each axis — the test asserts the generator pipes them all
// through to the reference sheets / dropdowns dynamically without
// hard-coding.
const OPTIONS: CoaMappingOptions = {
  types: ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const,
  categories: [
    { id: "c1", key: "CURRENT_ASSETS",     name: "Current Assets",      accountType: "ASSET" },
    { id: "c2", key: "OPERATING_REVENUE",  name: "Operating Revenue",   accountType: "REVENUE" },
    { id: "c3", key: "OPERATING_EXPENSES", name: "Operating Expenses",  accountType: "EXPENSE" },
    // Future-fictional entry to prove dynamism.
    { id: "c4", key: "FUTURE_SPECIAL_RES", name: "Future Special Reserves", accountType: "ASSET" },
  ],
  fsGroups: [
    { id: "g1", key: "BS_CURRENT_ASSETS",  name: "Current Assets",        statement: "BALANCE_SHEET" },
    { id: "g2", key: "IS_REVENUE_MEMBERSHIP", name: "Membership Revenue", statement: "INCOME_STATEMENT" },
    { id: "g3", key: "IS_OPEX_WAGES",      name: "Wages and Benefits",    statement: "INCOME_STATEMENT" },
    { id: "g4", key: "IS_OPEX_RM",         name: "Repairs and Maintenance", statement: "INCOME_STATEMENT" },
    // Future-fictional entry.
    { id: "g5", key: "IS_OPEX_FUTURE",     name: "Future Operating Bucket", statement: "INCOME_STATEMENT" },
  ],
  departments: [
    { id: "d1", code: "PROSHOP",   name: "Pro Shop" },
    { id: "d2", code: "F&B",       name: "F&B" },
    { id: "d3", code: "GROUNDS",   name: "Grounds" },
    { id: "d4", code: "CLUBHOUSE", name: "Clubhouse" },
    { id: "d5", code: "ADMIN",     name: "Admin" },
    { id: "d6", code: "EVENTS",    name: "Events" },
    // Future-fictional entry.
    { id: "d7", code: "AMENITIES", name: "Amenities" },
  ],
};

async function loadGeneratedWorkbook(): Promise<ExcelJS.Workbook> {
  const buf = await buildCoaXlsxWorkbook(OPTIONS, "Test Club");
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  );
  return wb;
}

describe("Workbook structure — 6 sheets in the founder tab order", () => {
  it("contains exactly 6 worksheets named Instructions / Chart of Accounts / Types / Categories / FS Groups / Departments", async () => {
    const wb = await loadGeneratedWorkbook();
    const names = wb.worksheets.map((w) => w.name);
    expect(names).toEqual([
      "Instructions",
      "Chart of Accounts",
      "Types",
      "Categories",
      "FS Groups",
      "Departments",
    ]);
  });

  it("filename matches `{club}-Chart-of-Accounts-Template.xlsx`", () => {
    expect(coaWorkbookFilename("Silver Springs Golf & Country Club")).toMatch(
      /^Silver-Springs-Golf-.*Chart-of-Accounts-Template\.xlsx$/,
    );
  });
});

describe("Reference tabs — content is sourced dynamically (no hard-coded mapping values)", () => {
  it("Types tab lists every option from the live config (including future-fictional entries)", async () => {
    const wb = await loadGeneratedWorkbook();
    const ws = wb.getWorksheet("Types");
    expect(ws).toBeDefined();
    // Column A starting at row 4 holds the key.
    const keys = new Set<string>();
    ws!.getColumn("A").eachCell({ includeEmpty: false }, (cell, rowNo) => {
      if (rowNo >= 4 && typeof cell.value === "string") keys.add(cell.value);
    });
    for (const expected of OPTIONS.types) {
      expect(keys.has(expected)).toBe(true);
    }
  });

  it("Categories tab carries Type column so the operator can see which type each category applies to", async () => {
    const wb = await loadGeneratedWorkbook();
    const ws = wb.getWorksheet("Categories");
    const rows: Array<{ key: string; type: string }> = [];
    ws!.eachRow((row, rowNo) => {
      if (rowNo < 4) return;
      const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
      rows.push({ key: String(vals[0] ?? ""), type: String(vals[2] ?? "") });
    });
    const futureRow = rows.find((r) => r.key === "FUTURE_SPECIAL_RES");
    expect(futureRow).toBeDefined();
    expect(futureRow?.type).toBe("ASSET");
  });

  it("FS Groups tab contains the Financial Statement column and ZERO department-name entries", async () => {
    const wb = await loadGeneratedWorkbook();
    const ws = wb.getWorksheet("FS Groups");
    const labels = new Set<string>();
    ws!.eachRow((row) => {
      const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
      for (const v of vals) {
        if (typeof v === "string") labels.add(v);
      }
    });
    for (const dept of [
      "Food & Beverage",
      "Pro Shop",
      "Clubhouse",
      "Golf Operations",
      "Course & Grounds",
      "Administration",
    ]) {
      expect(labels.has(dept)).toBe(false);
    }
    // Confirm the founder-spec FS-group names are present.
    expect(labels.has("Wages and Benefits")).toBe(true);
    expect(labels.has("Repairs and Maintenance")).toBe(true);
    expect(labels.has("Future Operating Bucket")).toBe(true);
  });

  it("Departments tab lists every department code from the live config", async () => {
    const wb = await loadGeneratedWorkbook();
    const ws = wb.getWorksheet("Departments");
    const codes = new Set<string>();
    ws!.getColumn("A").eachCell({ includeEmpty: false }, (cell, rowNo) => {
      if (rowNo >= 4 && typeof cell.value === "string") codes.add(cell.value);
    });
    for (const d of OPTIONS.departments) {
      expect(codes.has(d.code)).toBe(true);
    }
    // The future-fictional code came through too.
    expect(codes.has("AMENITIES")).toBe(true);
  });
});

describe("Chart of Accounts sheet — Excel data validation on optional mapping columns", () => {
  it("Type column (C) carries list validation referencing the Types tab", async () => {
    const wb = await loadGeneratedWorkbook();
    const ws = wb.getWorksheet("Chart of Accounts")!;
    const dv = ws.getCell("C4").dataValidation;
    expect(dv).toBeDefined();
    expect(dv?.type).toBe("list");
    expect(dv?.allowBlank).toBe(true);
    expect((dv?.formulae ?? [""])[0]).toMatch(/Types!\$A\$4:\$A\$\d+/);
  });

  it("Category column (D) carries list validation referencing the Categories tab", async () => {
    const wb = await loadGeneratedWorkbook();
    const ws = wb.getWorksheet("Chart of Accounts")!;
    const dv = ws.getCell("D4").dataValidation;
    expect(dv).toBeDefined();
    expect((dv?.formulae ?? [""])[0]).toMatch(/Categories!\$A\$4:\$A\$\d+/);
  });

  it("FS Group column (E) references 'FS Groups' (sheet name quoted for the space)", async () => {
    const wb = await loadGeneratedWorkbook();
    const ws = wb.getWorksheet("Chart of Accounts")!;
    const dv = ws.getCell("E4").dataValidation;
    expect(dv).toBeDefined();
    expect((dv?.formulae ?? [""])[0]).toMatch(/'FS Groups'!\$A\$4:\$A\$\d+/);
  });

  it("Departments column (F) has NO list validation (multi-value via semicolons)", async () => {
    const wb = await loadGeneratedWorkbook();
    const ws = wb.getWorksheet("Chart of Accounts")!;
    const dv = ws.getCell("F4").dataValidation;
    expect(dv).toBeUndefined();
  });

  it("data validation extends across a large pre-populated range (not just row 4)", async () => {
    const wb = await loadGeneratedWorkbook();
    const ws = wb.getWorksheet("Chart of Accounts")!;
    // Row 100 is well below the sample rows; validation should still
    // be there so a power user can fill in 100+ accounts.
    expect(ws.getCell("C100").dataValidation).toBeDefined();
    expect(ws.getCell("D100").dataValidation).toBeDefined();
    expect(ws.getCell("E100").dataValidation).toBeDefined();
  });

  it("freezes the header row + title bands so they stay visible while scrolling", async () => {
    const wb = await loadGeneratedWorkbook();
    const ws = wb.getWorksheet("Chart of Accounts")!;
    expect(ws.views?.[0]).toMatchObject({ state: "frozen", ySplit: 3 });
  });

  it("Chart of Accounts header row carries the founder-named columns", async () => {
    const wb = await loadGeneratedWorkbook();
    const ws = wb.getWorksheet("Chart of Accounts")!;
    const headerVals = Array.isArray(ws.getRow(3).values)
      ? (ws.getRow(3).values as unknown[]).slice(1).map((v) => String(v ?? ""))
      : [];
    expect(headerVals).toEqual([
      "Account Number",
      "Account Name",
      "Type (optional)",
      "Category (optional)",
      "FS Group (optional)",
      "Departments (optional, semicolon-delimited)",
    ]);
  });
});

describe("XLSX parser — round-trips the generated workbook", () => {
  it("parseXlsxRows extracts every account row + recovers optional mapping fields", async () => {
    const buf = await buildCoaXlsxWorkbook(OPTIONS, "Test Club");
    const rows = await parseXlsxRows(buf, { domain: "COA" });
    expect(rows.length).toBeGreaterThanOrEqual(5);
    // The template's sample rows include the founder's R&M-across-
    // five-departments example. Confirm the parser surfaces both
    // the number/name AND the optional mapping columns.
    const rm = rows.find((r) => r.number === "6700");
    expect(rm).toBeDefined();
    expect(rm?.name).toBe("Repairs and Maintenance");
    // Note: the CSV parser normalises Excel-style "Type (optional)"
    // header back to "type" via aliasing.
    expect(rm?.type).toBe("EXPENSE");
    // Sample row in the canonical XLSX template uses the new
    // canonical FS Group key (IS_OPEX_RM was retired 2026-07-19).
    expect(rm?.fsGroupKey).toBe("IS_REPAIRS_MAINTENANCE");
    expect(rm?.departmentCode || rm?.departmentCodes).toBeDefined();
  });

  it("looksLikeXlsx detects by extension AND by ZIP magic bytes", () => {
    expect(looksLikeXlsx("foo.xlsx")).toBe(true);
    expect(looksLikeXlsx("FOO.XLSX")).toBe(true);
    expect(looksLikeXlsx("foo.csv")).toBe(false);
    // Magic-byte detection (PK\x03\x04 — the OPC zip signature).
    const magic = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]);
    expect(looksLikeXlsx("uploaded-without-extension", magic)).toBe(true);
    const plainCsv = Buffer.from("number,name\n1010,Bank\n", "utf8");
    expect(looksLikeXlsx("anything.csv", plainCsv)).toBe(false);
  });
});

describe("Future-proofing — added taxonomy entries flow through automatically", () => {
  it("a future Type that doesn't exist today is included on the Types tab AND the Chart of Accounts data validation", async () => {
    const futureOptions: CoaMappingOptions = {
      ...OPTIONS,
      types: [...OPTIONS.types, "DEFERRED_INFLOW"] as unknown as CoaMappingOptions["types"],
    };
    const buf = await buildCoaXlsxWorkbook(futureOptions, "Test Club");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
    );
    const types = wb.getWorksheet("Types");
    const keys = new Set<string>();
    types!.getColumn("A").eachCell({ includeEmpty: false }, (cell, rowNo) => {
      if (rowNo >= 4 && typeof cell.value === "string") keys.add(cell.value);
    });
    expect(keys.has("DEFERRED_INFLOW")).toBe(true);

    // The Type dropdown range extends to cover the new row.
    const coa = wb.getWorksheet("Chart of Accounts");
    const dv = coa!.getCell("C4").dataValidation;
    const formula = (dv?.formulae ?? [""])[0];
    // 5 originals + 1 future = 6 entries; rows 4..9 → $A$4:$A$9.
    expect(formula).toBe("=Types!$A$4:$A$9");
  });
});
