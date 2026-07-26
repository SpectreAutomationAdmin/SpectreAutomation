import ExcelJS from "exceljs";
import path from "node:path";
async function main() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["01 - Silver Springs Golf & Country Club"]);
  ws.addRow(["Trial Balance for May, 2026"]);
  ws.addRow(["Closing Period Balances"]);
  ws.addRow(["G/L Account\nCode", "G/L Account\nDescription", "Closing Bal\nDebit", "Closing Bal\nCredit"]);
  ws.addRow([1000, "Petty Cash", 500.00, 0]);
  ws.addRow([2000, "Accounts Payable", 0, -500.00]);
  const out = path.resolve("tests/fixtures/jonas-may-2026-tb-preheader.xlsx");
  await wb.xlsx.writeFile(out);
  console.log("wrote", out);
}
main();
