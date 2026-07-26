// Screenshot capture for the Sprint 1 selection-unification correction.
//
// Outputs to test-results/data-workspace-production/selection-unification/
//   1. state-empty-1440.png          — no checked accounts, empty inspector
//   2. state-one-checked-1440.png    — one checked account, populated inspector
//   3. state-two-checked-1440.png    — two checked accounts, bulk inspector
//   4. state-row-opened-1440.png     — one row opened via row click
//   5. state-cleared-1440.png        — everything cleared, empty inspector restored
//
// The founder specifically asked for these five screenshots to prove
// that the checkbox and inspector are unified. Each capture is at
// 1440 × 900 with 2× DPR.

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = "http://localhost:3000";
const OUT = "test-results/data-workspace-production/selection-unification";
fs.mkdirSync(OUT, { recursive: true });

async function login(page) {
  await page.goto(`${BASE}/login`);
  await page.locator(`form:has(input[name="email"][value="super@spectre.app"]) button`).first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
}

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  await login(page);

  // 1 — Empty state (no checkboxes, no ?select in URL)
  await page.goto(`${BASE}/app/admin/coa`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: path.join(OUT, "state-empty-1440.png"), fullPage: false });

  // 2 — One checkbox → populated inspector
  await page.locator("tr[data-account-id]").first().locator("input[type='checkbox']").click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("select") !== null);
  await page.screenshot({ path: path.join(OUT, "state-one-checked-1440.png"), fullPage: false });

  // 3 — Two checkboxes → bulk state
  await page.locator("tr[data-account-id]").nth(1).locator("input[type='checkbox']").click();
  await page.waitForFunction(() =>
    document.querySelector(".spectre-dw-inspector")?.getAttribute("data-mode") === "bulk",
  );
  await page.screenshot({ path: path.join(OUT, "state-two-checked-1440.png"), fullPage: false });

  // Reset for row-click screenshot
  await page.goto(`${BASE}/app/admin/coa`);
  await page.waitForLoadState("networkidle");

  // 4 — Row-clicked (single-select via click on account number)
  await page.locator("tr[data-account-id] td.num-col").first().click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("select") !== null);
  await page.screenshot({ path: path.join(OUT, "state-row-opened-1440.png"), fullPage: false });

  // 5 — Everything cleared (close inspector via X)
  await page.locator("[data-testid='coa-inspector-close']").click();
  await page.waitForFunction(() => new URL(location.href).searchParams.get("select") === null);
  await page.screenshot({ path: path.join(OUT, "state-cleared-1440.png"), fullPage: false });

  await ctx.close();
} finally {
  await browser.close();
}
console.log("done");
