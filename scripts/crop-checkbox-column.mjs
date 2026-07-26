// Tight crops of the checkbox column (header + first several rows)
// showing before + after side-by-side.

import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:3000";
const OUT = process.argv[2] || "test-results/data-workspace-production/checkbox-alignment/crops";
fs.mkdirSync(OUT, { recursive: true });

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="${email}"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

const shots = [
  { name: "01-crop-standard", density: "standard" },
  { name: "02-crop-comfy",    density: "comfortable" },
  { name: "03-crop-compact",  density: "compact" },
];

const browser = await chromium.launch();
try {
  for (const shot of shots) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.addInitScript((d) => {
      try { window.localStorage.setItem("spectre-dw-coa-density", d); } catch {}
    }, shot.density);
    await login(page, "super@spectre.app");
    await page.goto(`${BASE}/app/admin/coa`);
    await page.waitForLoadState("networkidle");
    // Tight crop around the checkbox column: table starts at ~340px, checkbox column ends at ~410px, header at y~370, several rows below
    // Tight crop: table header at y~370, first row at ~415; include
    // the header + first 4 body rows so alignment is obvious.
    const headerY = await page.locator("table.spectre-dw-table thead th:first-child").evaluate((el) => el.getBoundingClientRect().y);
    await page.screenshot({
      path: `${OUT}/${shot.name}.png`,
      clip: { x: 240, y: Math.max(0, headerY - 20), width: 220, height: 340 },
    });
    console.log(`captured ${OUT}/${shot.name}.png`);
    await ctx.close();
  }
} finally { await browser.close(); }
