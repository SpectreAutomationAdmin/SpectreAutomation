// Inspect the user-supplied TEST.xlsx workbook WITHOUT modifying
// it. Reports the sheet inventory, the Chart of Accounts sheet's
// header row, and the first ~12 data rows so we can confirm the
// importer's contract.

import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";

import { parseXlsxRows } from "../src/lib/imports/xlsx-parse";

const SRC = path.resolve("test-results/uploaded/TEST.xlsx");

async function main() {
  if (!fs.existsSync(SRC)) {
    throw new Error(`Workbook not found at ${SRC}`);
  }
  const buf = fs.readFileSync(SRC);
  console.log(`Loaded ${SRC} (${buf.length.toLocaleString()} bytes)\n`);

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  );

  console.log("Worksheet inventory:");
  for (const ws of wb.worksheets) {
    console.log(`  · ${ws.name.padEnd(28)} rows=${ws.rowCount} cols=${ws.columnCount}`);
  }

  const coa = wb.getWorksheet("Chart of Accounts");
  if (!coa) {
    console.log("\n⚠ No 'Chart of Accounts' worksheet found!");
    return;
  }

  console.log("\n──── Chart of Accounts — first 14 rows (raw cell values) ────");
  let printed = 0;
  coa.eachRow({ includeEmpty: false }, (row, rowNo) => {
    if (printed >= 14) return;
    const vals = Array.isArray(row.values) ? row.values.slice(1) : [];
    const compact = vals.map((v) => {
      if (v == null) return "";
      if (typeof v === "object") {
        const obj = v as { text?: string; result?: unknown };
        return obj.text ?? String(obj.result ?? "");
      }
      return String(v);
    });
    console.log(`  row ${String(rowNo).padStart(3, " ")}: ${JSON.stringify(compact)}`);
    printed++;
  });

  console.log("\n──── Importer parse pass (parseXlsxRows, domain=COA) ────");
  const rows = await parseXlsxRows(buf, { domain: "COA" });
  console.log(`Parsed ${rows.length} data rows from the Chart of Accounts tab.`);
  console.log("First 5 parsed rows (canonical keys):");
  for (const r of rows.slice(0, 5)) {
    console.log("  ", JSON.stringify(r));
  }
  if (rows.length > 5) {
    console.log(`  …and ${rows.length - 5} more.`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
