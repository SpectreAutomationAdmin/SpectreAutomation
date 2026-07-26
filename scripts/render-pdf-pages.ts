// Render the first few PDF pages to PNGs for visual verification.
// Used to confirm landscape orientation + TOC page numbers WITHOUT
// opening the PDF manually.
//
// Approach: Chromium can render PDFs natively. We open the file
// in a Playwright page, then screenshot each visible page region.

import fs from "node:fs";
import path from "node:path";

const PDF_ABS = path.resolve("test-results/smoke-monthly-package.pdf");
const OUT_DIR = path.resolve("test-results/pdf-pages");

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  if (!fs.existsSync(PDF_ABS)) {
    throw new Error("Smoke PDF missing — run scripts/smoke-pdf-export.ts first.");
  }
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const ctx = await browser.newContext({
      viewport: { width: 1400, height: 900 },
    });
    const page = await ctx.newPage();
    // Render PDF pages to PNG by using the file URL + Chromium's
    // built-in PDF viewer. We pass `#page=N&zoom=125` to navigate
    // to a specific page; the screenshot captures the rendered
    // viewport.
    for (const n of [1, 2, 3]) {
      const url = `file:///${PDF_ABS.replace(/\\/g, "/")}#page=${n}&zoom=85`;
      console.log(`Rendering page ${n}: ${url}`);
      await page.goto(url, { waitUntil: "load", timeout: 30_000 });
      await page.waitForTimeout(900);
      const out = path.join(OUT_DIR, `page-${n}.png`);
      await page.screenshot({ path: out, fullPage: false });
      console.log(`  saved ${out}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
