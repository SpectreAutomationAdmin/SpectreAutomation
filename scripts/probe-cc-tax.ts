import fs from "node:fs";
import path from "node:path";
import { parseXlsxRows } from "../src/lib/imports/xlsx-parse";
async function main() {
  const buf = fs.readFileSync(path.resolve("test-results/uploaded/TEST.xlsx"));
  const rows = await parseXlsxRows(buf, { domain: "COA" });
  for (const r of rows) {
    const n = String(r.name ?? "");
    if (/visa|mastercard|amex|american express|credit card|p[-\s]?card|\bgst\b|\bhst\b|\bpst\b|\bqst\b/i.test(n)) {
      console.log(`${r.number}  '${n}'`);
    }
  }
}
main();
