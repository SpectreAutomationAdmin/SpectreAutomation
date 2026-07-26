import { chromium } from "playwright";
import fs from "node:fs/promises";

const BASE = "http://localhost:3000/design-concepts/executive-ops-centre";
const OUT = "public/design-concepts/executive-ops-centre/captures";

async function main() {
  await fs.mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  for (const size of [
    { name: "1440", w: 1440, h: 900 },
    { name: "1920", w: 1920, h: 1080 },
  ]) {
    const ctx = await browser.newContext({ viewport: { width: size.w, height: size.h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/b2-operations-centre.html`);
    await page.evaluate(async () => { if ("fonts" in document) await document.fonts.ready; });
    await page.waitForTimeout(400);
    const outPath = `${OUT}/b2-operations-centre-${size.name}.png`;
    await page.screenshot({ path: outPath, fullPage: false });
    console.log(`  captured ${outPath}`);
    await ctx.close();
  }
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
