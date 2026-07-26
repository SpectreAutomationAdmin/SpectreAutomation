// Sprint 1 acceptance correction — before/after captures for the
// header select-all checkbox alignment fix.

import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:3000";
const OUT = process.argv[2] || "test-results/data-workspace-production/checkbox-alignment";
fs.mkdirSync(OUT, { recursive: true });

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="${email}"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

const shots = [
  { name: "01-1440x900-standard", url: "/app/admin/coa", w: 1440, h: 900,  density: "standard" },
  { name: "02-1440x900-comfy",    url: "/app/admin/coa", w: 1440, h: 900,  density: "comfortable" },
  { name: "03-1440x900-compact",  url: "/app/admin/coa", w: 1440, h: 900,  density: "compact" },
  { name: "04-1920x1080-standard",url: "/app/admin/coa", w: 1920, h: 1080, density: "standard" },
  { name: "05-tablet-768",        url: "/app/admin/coa", w: 768,  h: 1024, density: "standard" },
  { name: "06-cropped-checkbox-column", url: "/app/admin/coa", w: 1440, h: 900, density: "standard", clip: { x: 240, y: 340, width: 200, height: 220 } },
];

const browser = await chromium.launch();
try {
  for (const shot of shots) {
    const ctx = await browser.newContext({ viewport: { width: shot.w, height: shot.h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    // Persist density preference so the workspace hydrates to the requested mode
    await page.addInitScript((d) => {
      try { window.localStorage.setItem("spectre-dw-coa-density", d); } catch {}
    }, shot.density);
    await login(page, "super@spectre.app");
    await page.goto(BASE + shot.url);
    await page.waitForLoadState("networkidle");
    const out = `${OUT}/${shot.name}.png`;
    if (shot.clip) {
      await page.screenshot({ path: out, clip: shot.clip });
    } else {
      await page.screenshot({ path: out, fullPage: false });
    }
    console.log(`captured ${out}`);
    await ctx.close();
  }
} finally { await browser.close(); }
