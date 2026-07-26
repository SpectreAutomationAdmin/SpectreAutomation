// Capture the three Executive Operations Centre design concepts at
// 1440x900 for the founder's review gallery. These are static HTML
// mockups only — no production wiring.

import { chromium } from "playwright";
import fs from "node:fs/promises";

const BASE = "http://localhost:3000/design-concepts/executive-ops-centre";
const OUT = "public/design-concepts/executive-ops-centre/captures";
const CONCEPTS = [
  { name: "a-council-table", file: "a-council-table.html" },
  { name: "b-situation-wall", file: "b-situation-wall.html" },
  { name: "c-club-statement", file: "c-club-statement.html" },
];

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  for (const c of CONCEPTS) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/${c.file}`);
    // Wait for Google Fonts to load — critical for capturing the
    // real serif rendering, not the fallback.
    await page.evaluate(async () => {
      if ("fonts" in document) {
        await document.fonts.ready;
      }
    });
    await page.waitForTimeout(500);
    const outPath = `${OUT}/${c.name}-1440.png`;
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`  captured ${outPath}`);
    await ctx.close();
  }
  await browser.close();
  console.log("\nDONE");
}

main().catch((e) => { console.error(e); process.exit(1); });
