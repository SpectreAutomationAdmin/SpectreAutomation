import ExcelJS from "exceljs";
async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile("test-results/jonas-tb.xlsx");
  console.log("Sheets:", wb.worksheets.map((w) => w.name));
  const ws = wb.worksheets[0];
  console.log("Rows:", ws.rowCount, "Cols:", ws.columnCount);
  console.log("--- First 6 rows ---");
  for (let i = 1; i <= Math.min(6, ws.rowCount); i++) {
    const r = ws.getRow(i);
    const vals: unknown[] = [];
    for (let c = 1; c <= ws.columnCount; c++) vals.push(r.getCell(c).value);
    console.log(i, JSON.stringify(vals));
  }
  console.log("--- Last 3 rows ---");
  for (let i = Math.max(1, ws.rowCount - 2); i <= ws.rowCount; i++) {
    const r = ws.getRow(i);
    const vals: unknown[] = [];
    for (let c = 1; c <= ws.columnCount; c++) vals.push(r.getCell(c).value);
    console.log(i, JSON.stringify(vals));
  }
}
main();
