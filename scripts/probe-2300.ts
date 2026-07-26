import fs from "node:fs";
import path from "node:path";
import { parseXlsxRows } from "../src/lib/imports/xlsx-parse";
async function main() {
  const buf = fs.readFileSync(path.resolve("test-results/uploaded/TEST.xlsx"));
  const rows = await parseXlsxRows(buf, { domain: "COA" });
  for (const r of rows) {
    const n = String(r.name ?? "");
    const num = String(r.number ?? "");
    if (/^23/.test(num) || /gift\s*card|credit\s*book|share\s*purch|deferred\s*capital|incentive\s*credit/i.test(n)) {
      console.log(`${num}  '${n}'`);
    }
  }
}
main();
