import fs from "node:fs";
import path from "node:path";
import { parseXlsxRows } from "../src/lib/imports/xlsx-parse";
async function main() {
  const buf = fs.readFileSync(path.resolve("test-results/uploaded/TEST.xlsx"));
  const rows = await parseXlsxRows(buf, { domain: "COA" });
  for (const r of rows) {
    const n = String(r.name ?? "");
    if (/section|match\s*play|member\s*guest|tournament\s*fund|charity\s*fund/i.test(n)) {
      console.log(`${r.number}  '${n}'`);
    }
  }
}
main();
