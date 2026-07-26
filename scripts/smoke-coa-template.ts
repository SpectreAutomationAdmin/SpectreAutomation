// Smoke test for the COA XLSX template builder. Generates a
// workbook against the dev DB's live options, writes it to
// test-results/, then re-opens it and prints the sheet structure +
// data-validation references so we can verify without manually
// opening Excel.

import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import { PrismaClient } from "@prisma/client";

import { getCoaMappingOptions } from "../src/lib/imports/coa-mapping";
import {
  buildCoaXlsxWorkbook,
  coaWorkbookFilename,
} from "../src/lib/imports/xlsx-template";

async function main() {
  const prisma = new PrismaClient();
  const club = await prisma.club.findFirst({ orderBy: { createdAt: "asc" } });
  if (!club) {
    console.log("No club in dev DB.");
    await prisma.$disconnect();
    return;
  }
  const options = await getCoaMappingOptions(club.id);
  await prisma.$disconnect();

  console.log(`Building workbook for ${club.name}…`);
  console.log(
    `  options:`,
    `${options.types.length} types ·`,
    `${options.categories.length} categories ·`,
    `${options.fsGroups.length} FS groups ·`,
    `${options.departments.length} departments`,
  );

  const buf = await buildCoaXlsxWorkbook(options, club.name);
  fs.mkdirSync("test-results", { recursive: true });
  const out = path.join("test-results", coaWorkbookFilename(club.name));
  fs.writeFileSync(out, buf);
  console.log(`Wrote ${out} (${buf.length.toLocaleString()} bytes)\n`);

  // Re-open and dump the structure.
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(
    buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer,
  );
  console.log("Sheets (in tab order):");
  for (const ws of wb.worksheets) {
    console.log(`  · ${ws.name}  (${ws.rowCount} rows × ${ws.columnCount} cols)`);
  }

  const coa = wb.getWorksheet("Chart of Accounts");
  if (coa) {
    console.log("\nChart of Accounts — data-validation samples (row 4):");
    for (const col of ["C", "D", "E", "F"]) {
      const dv = coa.getCell(`${col}4`).dataValidation;
      if (dv) {
        console.log(`  ${col}4  type=${dv.type}  allowBlank=${dv.allowBlank}  formula=${(dv.formulae ?? []).join(" ")}`);
      } else {
        console.log(`  ${col}4  (no data validation)`);
      }
    }
    const frozen = coa.views?.[0];
    console.log(`\n  frozen panes: ${JSON.stringify(frozen ?? null)}`);
  }

  // Confirm no department names slipped into the FS Groups tab.
  const fs_groups_sheet = wb.getWorksheet("FS Groups");
  if (fs_groups_sheet) {
    const DEPT_NAMES = new Set([
      "Food & Beverage",
      "Pro Shop",
      "Clubhouse",
      "Golf Operations",
      "Course & Grounds",
      "Administration",
    ]);
    const leaks: string[] = [];
    fs_groups_sheet.eachRow((row) => {
      const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
      for (const v of vals) {
        if (typeof v === "string" && DEPT_NAMES.has(v)) leaks.push(v);
      }
    });
    console.log(`\nFS Groups sheet — department-name leaks: ${leaks.length === 0 ? "✓ none" : leaks.join(", ")}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
