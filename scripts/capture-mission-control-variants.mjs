import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "..");
const variantsDir = path.join(repoRoot, "public", "design-concepts", "mission-control");
const outDir = path.join(repoRoot, "test-results", "mission-control-variants");
fs.mkdirSync(outDir, { recursive: true });

const variants = [
  { key: "a", file: "variant-a-conservative.html" },
  { key: "b", file: "variant-b-executive.html" },
  { key: "c", file: "variant-c-aspirational.html" },
  { key: "d", file: "variant-d-instrument.html" },
];

const viewports = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
];

const browser = await chromium.launch();
try {
  for (const v of variants) {
    const url = pathToFileURL(path.join(variantsDir, v.file)).toString();
    for (const vp of viewports) {
      const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: 2 });
      const page = await ctx.newPage();
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      const out = path.join(outDir, `variant-${v.key}-${vp.name}.png`);
      await page.screenshot({ path: out, fullPage: false });
      console.log(`captured ${out}`);
      await ctx.close();
    }
  }
} finally {
  await browser.close();
}
