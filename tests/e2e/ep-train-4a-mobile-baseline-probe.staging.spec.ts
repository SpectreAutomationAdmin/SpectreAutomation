// EP-TRAIN-4A §5 — mobile baseline probe.
//
// Measures `document.documentElement.scrollWidth` at mobile-390x844
// on multiple admin pages to determine whether the horizontal overflow
// observed on the version editor is caused by EP-TRAIN-4A's changes
// or is a pre-existing property of the admin shell itself.

import { test, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env.playwright.local");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("="); if (eq <= 0) continue;
      const k = t.slice(0, eq); const v = t.slice(eq + 1);
      if (!(k in process.env)) process.env[k] = v;
    }
  }
}
loadEnv();

async function managerLogin(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(process.env.SPECTRE_STAGING_EMAIL!);
  await page.locator('input[name="password"]').fill(process.env.SPECTRE_STAGING_PASSWORD!);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
}

test("admin shell baseline overflow at mobile 390", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  await managerLogin(page);
  const paths = [
    "/app/admin/people/employees",
    "/app/admin/people/safety-training",
    "/app/admin/people/safety-training/compliance",
  ];
  for (const p of paths) {
    await page.goto(`${BASE}${p}`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle").catch(() => { /* ignore */ });
    const w = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    // eslint-disable-next-line no-console
    console.log(`[BASELINE] ${p} scrollWidth=${w.scrollWidth} clientWidth=${w.clientWidth} overflow=${w.scrollWidth - w.clientWidth}`);
  }
});
