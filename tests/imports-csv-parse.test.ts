// CSV parser + per-domain header aliasing — unit tests.
//
// Two responsibilities:
//   1. A correct RFC 4180 parser (quoted fields, embedded newlines,
//      RFC-doubled quote escapes). This is the parse that runs at
//      upload before any domain-specific validator sees the rows.
//   2. Per-domain header aliasing so an admin can drop in a Jonas
//      Trial Balance / COA CSV (embedded-newline headers like
//      "G/L Account\nCode") and have it map cleanly to the
//      canonical `number` + `name` keys.
//
// These tests pin both behaviours so a future regression in the
// parser won't silently mangle 237 account rows into blanks.

import { describe, expect, it } from "vitest";

import {
  aliasHeaders,
  parseCsvRecords,
  parseCsvRows,
} from "@/lib/imports/csv-parse";

// ---------------------------------------------------------------------------
// 1. parseCsvRecords — RFC 4180 tokenisation.
// ---------------------------------------------------------------------------

describe("parseCsvRecords — RFC 4180", () => {
  it("parses a simple two-column CSV", () => {
    const out = parseCsvRecords("a,b\n1,2\n3,4\n");
    expect(out).toEqual([
      ["a", "b"],
      ["1", "2"],
      ["3", "4"],
    ]);
  });

  it("handles quoted fields containing commas", () => {
    const out = parseCsvRecords('name,note\n"Acme, Inc.",hi\n');
    expect(out).toEqual([
      ["name", "note"],
      ["Acme, Inc.", "hi"],
    ]);
  });

  it("handles doubled-quote escape inside a quoted field", () => {
    const out = parseCsvRecords('label\n"Bob ""Big"" Robertson"\n');
    expect(out).toEqual([["label"], ['Bob "Big" Robertson']]);
  });

  it("handles a quoted field with an embedded newline (the Jonas-style header case)", () => {
    // This is the exact header shape the founder's COA.csv ships:
    //   "G/L Account\nCode","G/L Account\nDescription"
    //   1000,"Petty Cash"
    const csv = '"G/L Account\nCode","G/L Account\nDescription"\n1000,"Petty Cash"\n';
    const records = parseCsvRecords(csv);
    expect(records).toHaveLength(2);
    expect(records[0]).toEqual(["G/L Account\nCode", "G/L Account\nDescription"]);
    expect(records[1]).toEqual(["1000", "Petty Cash"]);
  });

  it("accepts CRLF line endings", () => {
    const out = parseCsvRecords("a,b\r\n1,2\r\n");
    expect(out).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });

  it("strips fully-blank rows but keeps rows with empty trailing cells", () => {
    const out = parseCsvRecords("a,b,c\n1,,3\n\n4,5,6\n");
    expect(out).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
      ["4", "5", "6"],
    ]);
  });

  it("handles a trailing row without a final newline", () => {
    const out = parseCsvRecords("a,b\n1,2");
    expect(out).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2. aliasHeaders — COA header normalisation.
// ---------------------------------------------------------------------------

describe("aliasHeaders — COA", () => {
  it('maps Jonas-style "G/L Account Code" / "G/L Account Description" with embedded newlines', () => {
    const out = aliasHeaders("COA", [
      "G/L Account\nCode",
      "G/L Account\nDescription",
    ]);
    expect(out).toEqual(["number", "name"]);
  });

  it("maps Excel-style headers", () => {
    expect(aliasHeaders("COA", ["Account #", "Account Name"])).toEqual([
      "number",
      "name",
    ]);
  });

  it("maps camel-cased ERP headers", () => {
    expect(
      aliasHeaders("COA", ["accountNumber", "accountDescription"]),
    ).toEqual(["number", "name"]);
  });

  it("passes through the spectre-native headers unchanged", () => {
    expect(aliasHeaders("COA", ["number", "name"])).toEqual(["number", "name"]);
  });

  it("maps the legacy full-format extra columns to canonical keys", () => {
    expect(
      aliasHeaders("COA", [
        "Account Code",
        "Account Description",
        "Account Type",
        "Category Key",
        "FS Group",
        "Department Codes",
      ]),
    ).toEqual([
      "number",
      "name",
      "type",
      "categoryKey",
      "fsGroupKey",
      "departmentCodes",
    ]);
  });

  it("preserves unknown column names (trimmed, whitespace-collapsed)", () => {
    expect(
      aliasHeaders("COA", ["  Unknown\n Column  ", "operatorNote"]),
    ).toEqual(["Unknown Column", "operatorNote"]);
  });

  it("is case-insensitive", () => {
    expect(aliasHeaders("COA", ["G/L ACCOUNT CODE", "g/l account description"]))
      .toEqual(["number", "name"]);
  });
});

// ---------------------------------------------------------------------------
// 3. parseCsvRows — end-to-end (records → objects with aliased keys).
// ---------------------------------------------------------------------------

describe("parseCsvRows — end-to-end", () => {
  it("returns row objects keyed by canonical names for a COA CSV with Jonas-style headers", () => {
    const csv =
      '"G/L Account\nCode","G/L Account\nDescription"\n' +
      '1000,"Petty Cash"\n' +
      '9901,"Depreciation"\n';
    const rows = parseCsvRows(csv, { domain: "COA" });
    expect(rows).toEqual([
      { number: "1000", name: "Petty Cash" },
      { number: "9901", name: "Depreciation" },
    ]);
  });

  it("preserves the legacy simple-format COA upload", () => {
    const csv = "number,name\n1010,Operating Bank\n2000,AP\n";
    const rows = parseCsvRows(csv, { domain: "COA" });
    expect(rows).toEqual([
      { number: "1010", name: "Operating Bank" },
      { number: "2000", name: "AP" },
    ]);
  });

  it("preserves the legacy full-format COA upload through aliasing", () => {
    const csv =
      "Account Code,Account Description,Account Type,Category Key,FS Group,Department Codes\n" +
      "4000,Membership Dues,REVENUE,MEMBERSHIP_REVENUE,IS_MEMBERSHIP_DUES,ADMIN\n";
    const rows = parseCsvRows(csv, { domain: "COA" });
    expect(rows).toEqual([
      {
        number: "4000",
        name: "Membership Dues",
        type: "REVENUE",
        categoryKey: "MEMBERSHIP_REVENUE",
        fsGroupKey: "IS_MEMBERSHIP_DUES",
        departmentCodes: "ADMIN",
      },
    ]);
  });

  it("returns [] for a file with only a header row", () => {
    expect(parseCsvRows("number,name\n", { domain: "COA" })).toEqual([]);
  });

  it("returns [] for an empty file", () => {
    expect(parseCsvRows("", { domain: "COA" })).toEqual([]);
  });

  it("non-COA domains do NOT alias COA headers (so MEMBERS imports stay literal)", () => {
    const csv = "memberNumber,firstName\nM-001,Jane\n";
    const rows = parseCsvRows(csv, { domain: "MEMBERS" });
    expect(rows).toEqual([{ memberNumber: "M-001", firstName: "Jane" }]);
  });
});

// ---------------------------------------------------------------------------
// 4. Founder's exact failure shape — 237 account rows, Jonas-style.
// ---------------------------------------------------------------------------

describe("COA.csv — 237-row Jonas-shaped fixture", () => {
  const FIRST = { number: "1000", name: "Petty Cash" };
  const LAST = { number: "9901", name: "Depreciation" };

  function buildCsv(): string {
    // Programmatically construct 237 plausible account rows with
    // the bookends the founder specified (1000 Petty Cash first,
    // 9901 Depreciation last). The middle is just unique numbers
    // + descriptive names; the test cares about row count + header
    // parsing, not the names.
    const lines: string[] = [];
    // Jonas-style embedded-newline headers — the exact failure shape.
    lines.push('"G/L Account\nCode","G/L Account\nDescription"');
    lines.push(`${FIRST.number},"${FIRST.name}"`);
    // 235 middle rows. Use a number range that doesn't collide with
    // 1000 / 9901.
    for (let i = 0; i < 235; i++) {
      const acctNumber = 1100 + i; // 1100..1334
      lines.push(`${acctNumber},"Account ${acctNumber}"`);
    }
    lines.push(`${LAST.number},"${LAST.name}"`);
    return lines.join("\n") + "\n";
  }

  it("parses to exactly 237 account rows with the first + last rows intact", () => {
    const csv = buildCsv();
    const rows = parseCsvRows(csv, { domain: "COA" });
    expect(rows).toHaveLength(237);
    expect(rows[0]).toEqual(FIRST);
    expect(rows[rows.length - 1]).toEqual(LAST);
  });

  it("populates number + name for every parsed row (zero blanks)", () => {
    const csv = buildCsv();
    const rows = parseCsvRows(csv, { domain: "COA" });
    const blanks = rows.filter((r) => !r.number || !r.name);
    expect(blanks).toEqual([]);
  });

  it("does NOT leak the raw Jonas header keys onto any row", () => {
    const csv = buildCsv();
    const rows = parseCsvRows(csv, { domain: "COA" });
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(["name", "number"]);
    }
  });
});
