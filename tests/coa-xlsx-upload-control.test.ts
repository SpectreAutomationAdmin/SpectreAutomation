// Upload-control contract for the COA Excel transition (founder
// spec 2026-07-05).
//
// Three concerns:
//   1. The browser file picker for COA accepts .xlsx + .csv
//      (legacy MEMBERS/VENDORS/etc. stay CSV-only).
//   2. The action's parse + unsupported-file-type messaging surfaces
//      the founder-spec wording for COA AND falls back to the
//      generic wording for every other domain.
//   3. The download button reads "Download Excel Template" for
//      COA and the prior "(.csv)" label otherwise.
//   4. The xlsx-parse helpers (looksLikeXlsx + isLikelyTextual)
//      correctly classify common upload types.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import { looksLikeXlsx, isLikelyTextual } from "@/lib/imports/xlsx-parse";

const FORM = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/app/admin/imports/NewBatchForm.tsx"),
  "utf8",
);
const HELPER = fs.readFileSync(
  path.resolve(
    process.cwd(),
    "src/app/app/admin/imports/ImportTemplateHelper.tsx",
  ),
  "utf8",
);
const ACTIONS = fs.readFileSync(
  path.resolve(process.cwd(), "src/app/app/admin/imports/_actions.ts"),
  "utf8",
);

const codeOnly = (s: string) =>
  s
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("/*") && !l.trim().startsWith("*"))
    .join("\n");

describe("NewBatchForm — file picker accepts .xlsx + .csv for COA", () => {
  it("emits the founder-spec accept attribute when the active domain is COA", () => {
    // The accept value contains every founder-listed token.
    expect(FORM).toContain('.xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv');
    // The form branches the accept value by domain via isCoa.
    expect(FORM).toMatch(/const isCoa = metadata\.domain === "COA"/);
    expect(FORM).toMatch(/accept=\{acceptAttr\}/);
    // Non-COA still passes the prior csv-only value.
    expect(FORM).toContain('".csv,text/csv"');
  });

  it("COA label reads the founder-spec text; non-COA keeps the legacy 'Upload CSV file'", () => {
    expect(FORM).toContain(
      "Upload Chart of Accounts (.xlsx recommended, .csv supported)",
    );
    expect(FORM).toContain('"Upload CSV file"');
  });

  it("label element carries a stable testid so the picker can be queried in e2e tests", () => {
    expect(FORM).toMatch(/data-testid="new-batch-file-label"/);
  });

  it("clear-the-paste hint mentions 'workbook' for COA + plain 'file' otherwise", () => {
    expect(FORM).toContain(
      "Clear the pasted CSV below to upload a workbook or file instead.",
    );
    expect(FORM).toContain("Clear the pasted CSV below to upload a file instead.");
  });
});

describe("ImportTemplateHelper — download button label", () => {
  it('COA reads "Download Excel Template"; other domains keep ".csv" wording', () => {
    expect(HELPER).toContain('"Download Excel Template"');
    expect(HELPER).toContain('"Download Template (.csv)"');
    // The prior (.xlsx) shorthand is replaced.
    const c = codeOnly(HELPER);
    expect(c).not.toContain('"Download Template (.xlsx)"');
  });
});

describe("createBatchAction — wording + unsupported-file guard", () => {
  it("uses the founder-spec COA wording for the no-source / dual-source / parse-error / unsupported-type paths", () => {
    // COA-specific copy.
    expect(ACTIONS).toContain(
      "Upload a Chart of Accounts workbook (.xlsx) or CSV file, or paste CSV content before submitting.",
    );
    expect(ACTIONS).toContain(
      "Use only one input source — either upload a workbook / CSV file OR paste CSV content, not both.",
    );
    expect(ACTIONS).toContain(
      "Chart of Accounts file could not be parsed.",
    );
    expect(ACTIONS).toContain(
      "Chart of Accounts file had a header row but no data rows.",
    );
    // Generic copy for non-COA domains stays available.
    expect(ACTIONS).toContain(
      "Use only one input source — either upload a CSV file OR paste CSV content, not both.",
    );
    expect(ACTIONS).toContain("File could not be parsed.");
  });

  it("rejects obviously-binary uploads (PDF, Word, image) with a clear error", () => {
    // The action gates on isLikelyTextual when the upload is NOT
    // an .xlsx (which has its own well-known magic bytes).
    expect(ACTIONS).toContain("isLikelyTextual(buf)");
    expect(ACTIONS).toContain(
      "Unsupported file type. Upload an .xlsx workbook or a .csv file.",
    );
    expect(ACTIONS).toContain(
      "Unsupported file type. Upload a .csv file.",
    );
  });

  it("auto-routes XLSX vs CSV via looksLikeXlsx + the magic-byte fallback", () => {
    expect(ACTIONS).toContain("looksLikeXlsx(fileName, buf)");
    expect(ACTIONS).toContain("parseXlsxRows(buf, { domain })");
    expect(ACTIONS).toContain("parseCsvRows(csv, { domain })");
  });
});

describe("xlsx-parse helpers — file-type classification", () => {
  it("looksLikeXlsx accepts .xlsx by extension (case-insensitive)", () => {
    expect(looksLikeXlsx("foo.xlsx")).toBe(true);
    expect(looksLikeXlsx("FOO.XLSX")).toBe(true);
    expect(looksLikeXlsx("anything")).toBe(false);
  });

  it("looksLikeXlsx accepts the OPC magic bytes (PK\\x03\\x04) even without an extension", () => {
    const opc = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00]);
    expect(looksLikeXlsx("upload", opc)).toBe(true);
  });

  it("looksLikeXlsx rejects plain CSV bytes", () => {
    const csv = Buffer.from("number,name\n1010,Bank\n", "utf8");
    expect(looksLikeXlsx("upload.csv", csv)).toBe(false);
  });

  it("isLikelyTextual accepts UTF-8 CSVs + ASCII text + UTF-8 with em-dashes", () => {
    expect(isLikelyTextual(Buffer.from("number,name\n1010,Bank\n", "utf8"))).toBe(true);
    expect(isLikelyTextual(Buffer.from("a,b,c\n1,2,3\n", "utf8"))).toBe(true);
    expect(isLikelyTextual(Buffer.from("Title — em-dash test\nContent\n", "utf8"))).toBe(true);
  });

  it("isLikelyTextual rejects PDF / PNG / typical binary uploads", () => {
    // PDF signature.
    const pdf = Buffer.concat([
      Buffer.from("%PDF-1.4\n"),
      Buffer.alloc(200, 0),
    ]);
    expect(isLikelyTextual(pdf)).toBe(false);
    // PNG signature + NUL-heavy body.
    const png = Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.alloc(500, 0),
    ]);
    expect(isLikelyTextual(png)).toBe(false);
    // A long span of NULs.
    expect(isLikelyTextual(Buffer.alloc(500, 0))).toBe(false);
  });
});

describe("Backward compatibility — CSV imports still work end-to-end (the .csv path is unchanged in spirit)", () => {
  it("ACTIONS still imports the CSV parser AND routes pasted text through it", () => {
    expect(ACTIONS).toContain('import { parseCsvRows }');
    expect(ACTIONS).toContain('parseCsvRows(csvText, { domain })');
  });

  it("ACTIONS still calls createBatch with `source: \"CSV\"` for the CSV branch", () => {
    // The mutable `source` defaults to "CSV"; only the XLSX branch
    // flips it to "XLSX". This keeps every existing CSV import
    // (legacy MEMBERS / VENDORS / etc.) on the original code path.
    expect(ACTIONS).toMatch(/let source: "CSV" \| "XLSX" = "CSV"/);
    expect(ACTIONS).toMatch(/source = "XLSX"/);
  });
});
