import fs from "node:fs";
import path from "node:path";
import { parseXlsxRows } from "../src/lib/imports/xlsx-parse";

async function main() {
  const buf = fs.readFileSync(path.resolve("test-results/uploaded/TEST.xlsx"));
  const rows = await parseXlsxRows(buf, { domain: "COA" });
  const wanted = new Set(["1200", "1201", "1010", "2009", "4100", "5200", "6100"]);
  for (const r of rows) {
    if (wanted.has(String(r.number ?? ""))) {
      console.log(`${r.number}  ${r.name}`);
    }
  }
}
main();
