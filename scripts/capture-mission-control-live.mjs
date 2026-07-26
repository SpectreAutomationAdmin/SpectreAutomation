// Smoke test: log in as Patricia Bell, capture /app/admin at 1440x900
// and 1920x1080 in light theme. Verifies the Foundation v1.0 Mission
// Control page renders through the Spectre chrome.

import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:3000";
const OUT = "test-results/mission-control-live";
fs.mkdirSync(OUT, { recursive: true });

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="${email}"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

const viewports = [
  { name: "1440x900",  w: 1440, h: 900 },
  { name: "1920x1080", w: 1920, h: 1080 },
];

const browser = await chromium.launch();
try {
  for (const vp of viewports) {
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await login(page, "admin@silversprings.club");
    await page.goto(`${BASE}/app/admin`);
    await page.waitForLoadState("networkidle");

    // Verify Foundation classes are in the DOM
    const hasBriefing = await page.locator(".spectre-mc-briefing").count();
    const hasFeed = await page.locator(".spectre-mc-item").count();
    const hasGreeting = await page.locator(".spectre-mc-greeting").count();
    const hasRail = await page.locator(".spectre-mc-rail-card").count();

    console.log(`${vp.name}: greeting=${hasGreeting} briefing=${hasBriefing} items=${hasFeed} rail-cards=${hasRail}`);

    const out = `${OUT}/mc-${vp.name}.png`;
    await page.screenshot({ path: out, fullPage: false });
    console.log(`  captured ${out}`);
    await ctx.close();
  }
} finally {
  await browser.close();
}
