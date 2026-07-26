// Data Workspace Foundation integration — capture the production
// CoA presentation across the required viewports + interactive states.

import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:3000";
const OUT = "test-results/data-workspace-production/final";
fs.mkdirSync(OUT, { recursive: true });

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="${email}"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

async function firstAccountId(page) {
  return await page.locator("[data-account-id]").first().getAttribute("data-account-id");
}

// One-shot shots — one context per shot for isolation.
const shots = [
  { name: "01-default-1440x900",              w: 1440, h: 900,  url: "/app/admin/coa" },
  { name: "02-default-1920x1080",             w: 1920, h: 1080, url: "/app/admin/coa" },
  { name: "03-default-tablet-768",            w: 768,  h: 1024, url: "/app/admin/coa" },
  { name: "04-account-selected",              w: 1440, h: 900,  url: "/app/admin/coa", act: async (page) => {
      const id = await firstAccountId(page);
      await page.goto(`${BASE}/app/admin/coa?select=${id}`);
      await page.waitForLoadState("networkidle");
    } },
  { name: "05-fund-mode",                     w: 1440, h: 900,  url: "/app/admin/coa?mode=fund" },
  { name: "06-fund-mode-unmapped",            w: 1440, h: 900,  url: "/app/admin/coa?mode=fund&fund=NONE" },
  { name: "07-inactive",                      w: 1440, h: 900,  url: "/app/admin/coa?showInactive=1" },
  { name: "08-no-results",                    w: 1440, h: 900,  url: "/app/admin/coa", act: async (page) => {
      await page.getByPlaceholder(/^Search number/).fill("zzzzz");
      await page.waitForTimeout(300);
    } },
  { name: "09-multi-selection",               w: 1440, h: 900,  url: "/app/admin/coa", act: async (page) => {
      const boxes = page.locator("input.spectre-dw-check[type='checkbox']");
      const count = Math.min(await boxes.count(), 4);
      for (let i = 1; i < count; i++) await boxes.nth(i).click();
      await page.waitForTimeout(200);
    } },
];

const browser = await chromium.launch();
try {
  for (const shot of shots) {
    const ctx = await browser.newContext({ viewport: { width: shot.w, height: shot.h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on("pageerror", (err) => console.error(`[${shot.name}] pageerror`, err.message));
    page.on("console", (msg) => {
      if (msg.type() === "error") console.error(`[${shot.name}] console.error`, msg.text());
    });
    await login(page, "admin@silversprings.club");
    await page.goto(BASE + shot.url);
    await page.waitForLoadState("networkidle");
    if (shot.act) await shot.act(page);
    const out = `${OUT}/${shot.name}.png`;
    await page.screenshot({ path: out, fullPage: false });
    console.log(`captured ${out}`);
    await ctx.close();
  }
} finally { await browser.close(); }
