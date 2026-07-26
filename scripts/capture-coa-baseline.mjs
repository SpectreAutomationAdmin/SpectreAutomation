// Phase 0 baseline: capture the current production CoA presentation
// BEFORE any Data Workspace changes. Serves as the visual regression
// reference every subsequent phase is compared against.

import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:3000";
const OUT = "test-results/data-workspace-production/baseline";
fs.mkdirSync(OUT, { recursive: true });

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="${email}"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

const shots = [
  { name: "01-list-default-1440x900",         url: "/app/admin/coa",                    w: 1440, h: 900 },
  { name: "02-list-default-1920x1080",        url: "/app/admin/coa",                    w: 1920, h: 1080 },
  { name: "03-fund-mode-1440x900",            url: "/app/admin/coa?mode=fund",          w: 1440, h: 900 },
  { name: "04-fund-filter-none-1440x900",     url: "/app/admin/coa?fund=NONE",          w: 1440, h: 900 },
  { name: "05-show-inactive-1440x900",        url: "/app/admin/coa?showInactive=1",     w: 1440, h: 900 },
];

const browser = await chromium.launch();
try {
  for (const shot of shots) {
    const ctx = await browser.newContext({ viewport: { width: shot.w, height: shot.h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await login(page, "admin@silversprings.club");
    await page.goto(BASE + shot.url);
    await page.waitForLoadState("networkidle");
    const out = `${OUT}/${shot.name}.png`;
    await page.screenshot({ path: out, fullPage: false });
    console.log(`captured ${out}`);
    await ctx.close();
  }
} finally { await browser.close(); }
