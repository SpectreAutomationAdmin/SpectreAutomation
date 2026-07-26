import fs from "node:fs";
import path from "node:path";
import { parseXlsxRows } from "../src/lib/imports/xlsx-parse";
import { predictCoaRow } from "../src/lib/imports/coa-predictor";
async function main() {
  const buf = fs.readFileSync(path.resolve("test-results/uploaded/TEST.xlsx"));
  const rows = await parseXlsxRows(buf, { domain: "COA" });
  for (const r of rows) {
    const num = String(r.number ?? "");
    const n = String(r.name ?? "");
    if (/^40[4-7]/.test(num) || /banquet|catering|wedding|liquor|\bbeer\b|\bwine\b|\bpop\b|food/i.test(n)) {
      const p = predictCoaRow({ number: num, name: n });
      console.log(`${num.padEnd(5)} ${n.padEnd(45)} → ${p.fsGroupKey}`);
    }
  }
}
main();
