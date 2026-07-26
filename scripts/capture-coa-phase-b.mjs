// Phase B — capture the completed workspace across every inspector
// state so the founder can see the final foundation without opening
// a browser.

import { chromium } from "playwright";
import fs from "node:fs";

const BASE = "http://localhost:3000";
const OUT = "test-results/data-workspace-production/phase-b";
fs.mkdirSync(OUT, { recursive: true });

async function login(page, email) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="${email}"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}
async function firstAccountId(page) {
  return await page.locator("[data-account-id]").first().getAttribute("data-account-id");
}
async function firstUnmappedId(page) {
  return await page.locator('[data-testid^="coa-account-fund-unmapped-"]').first()
    .evaluate((el) => el.closest("[data-account-id]")?.getAttribute("data-account-id"))
    .catch(() => null);
}

const shots = [
  { name: "01-workspace-1440x900",             w: 1440, h: 900,  act: async (page) => { await page.goto(`${BASE}/app/admin/coa`); } },
  { name: "02-workspace-1920x1080",            w: 1920, h: 1080, act: async (page) => { await page.goto(`${BASE}/app/admin/coa`); } },
  { name: "03-workspace-tablet-768",           w: 768,  h: 1024, act: async (page) => { await page.goto(`${BASE}/app/admin/coa`); } },
  { name: "04-inspector-viewing-1440x900",     w: 1440, h: 900,  act: async (page) => {
      await page.goto(`${BASE}/app/admin/coa`);
      const id = await firstAccountId(page);
      await page.goto(`${BASE}/app/admin/coa?select=${id}`);
      await page.waitForLoadState("networkidle");
    } },
  { name: "05-inspector-editing-1440x900",     w: 1440, h: 900,  act: async (page) => {
      await page.goto(`${BASE}/app/admin/coa`);
      const id = await firstAccountId(page);
      await page.goto(`${BASE}/app/admin/coa?edit=${id}`);
      await page.waitForLoadState("networkidle");
    } },
  { name: "06-inspector-dirty-1440x900",       w: 1440, h: 900,  act: async (page) => {
      await page.goto(`${BASE}/app/admin/coa`);
      const id = await firstAccountId(page);
      await page.goto(`${BASE}/app/admin/coa?edit=${id}`);
      await page.waitForLoadState("networkidle");
      // Type into name to make it dirty
      const nameInput = page.locator('[data-testid="coa-inspector-field-name"]');
      await nameInput.click();
      await page.keyboard.press("End");
      await nameInput.type(" — updated");
      await page.waitForTimeout(300);
    } },
  { name: "07-view-needs-attention-1440x900",  w: 1440, h: 900,  act: async (page) => {
      await page.goto(`${BASE}/app/admin/coa?view=needs-attention`);
    } },
  { name: "08-view-unassigned-fs-1440x900",    w: 1440, h: 900,  act: async (page) => {
      await page.goto(`${BASE}/app/admin/coa?view=unassigned-fs`);
    } },
  { name: "09-view-recently-changed-1440x900", w: 1440, h: 900,  act: async (page) => {
      await page.goto(`${BASE}/app/admin/coa?view=recently-changed`);
    } },
  { name: "10-selection-bar-1440x900",         w: 1440, h: 900,  act: async (page) => {
      await page.goto(`${BASE}/app/admin/coa`);
      const boxes = page.locator("input.spectre-dw-check[type='checkbox']");
      const count = Math.min(await boxes.count(), 4);
      for (let i = 1; i < count; i++) await boxes.nth(i).click();
      await page.waitForTimeout(300);
    } },
  { name: "11-fund-applicability-1440x900",    w: 1440, h: 900,  act: async (page) => {
      await page.goto(`${BASE}/app/admin/coa?mode=fund`);
    } },
];

const browser = await chromium.launch();
try {
  for (const shot of shots) {
    const ctx = await browser.newContext({ viewport: { width: shot.w, height: shot.h }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    page.on("pageerror", (err) => console.error(`[${shot.name}] pageerror`, err.message));
    page.on("console", (msg) => { if (msg.type() === "error") console.error(`[${shot.name}] console.error`, msg.text()); });
    // super@spectre.app is SUPER_ADMIN with `coa:write`. admin@silversprings.club
    // is CLUB_ADMIN which does NOT get `coa:write` by default per v13.2, so
    // logging in as CLUB_ADMIN would (correctly) surface the permission-denied
    // inspector state on every ?edit=<id> capture.
    await login(page, "super@spectre.app");
    await shot.act(page);
    await page.waitForLoadState("networkidle");
    const out = `${OUT}/${shot.name}.png`;
    await page.screenshot({ path: out, fullPage: false });
    console.log(`captured ${out}`);
    await ctx.close();
  }
} finally { await browser.close(); }
