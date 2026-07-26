import ExcelJS from "exceljs";
async function main() {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile("test-results/jonas-tb.xlsx");
  const ws = wb.worksheets[0];
  let posD = 0, posC = 0, negD = 0, negC = 0, sumD = 0, sumC = 0;
  const sampleNegC: unknown[] = [];
  for (let i = 2; i <= ws.rowCount; i++) {
    const r = ws.getRow(i);
    const d = Number(r.getCell(3).value ?? 0);
    const c = Number(r.getCell(4).value ?? 0);
    if (d > 0) posD++;
    if (d < 0) negD++;
    if (c > 0) posC++;
    if (c < 0) { negC++; if (sampleNegC.length < 3) sampleNegC.push([r.getCell(1).value, r.getCell(2).value, c]); }
    sumD += d; sumC += c;
  }
  console.log(`Rows: ${ws.rowCount - 1}`);
  console.log(`Debits — positive: ${posD}, negative: ${negD}, raw sum: ${sumD.toFixed(2)}`);
  console.log(`Credits — positive: ${posC}, negative: ${negC}, raw sum: ${sumC.toFixed(2)}`);
  console.log(`Sample negative credits:`, sampleNegC);
}
main();
