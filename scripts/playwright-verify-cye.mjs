// Playwright verification for v15.23 Current-Year Earnings fix.
// Runs against the local dev server on http://localhost:3000.

import { chromium } from "playwright";

const BASE = "http://localhost:3000";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
  const page = await context.newPage();

  // 1) Log in via demo quick-access (admin@silversprings.club)
  await page.goto(`${BASE}/login`);
  await page.locator('form:has(input[name="email"][value="admin@silversprings.club"]) button').first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  console.log("logged in — url:", page.url());

  // 2) Open the May 2026 monthly package
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-05`);
  await page.waitForLoadState("networkidle", { timeout: 30_000 });
  await page.screenshot({ path: "test-results/v1523-1-monthly-loaded.png", fullPage: true });

  // 3) Enumerate every sofp-row in the liabilities-and-equity section
  const rows = page.locator('[data-testid^="sofp-row-"]');
  const count = await rows.count();
  console.log(`\n=== All sofp-row entries (${count}) ===`);
  for (let i = 0; i < count; i++) {
    const el = rows.nth(i);
    const tid = await el.getAttribute("data-testid");
    // skip drill-down account rows for signal-to-noise
    if (tid?.includes("-account-")) continue;
    const t = (await el.innerText()).replace(/\n/g, " | ");
    console.log(`  ${tid?.padEnd(60)}  ${t}`);
  }

  // 4) Data-testid checks
  const cye = page.locator('[data-testid*="ytd-net-income-fsg-BS_CURRENT_YEAR_EARNINGS"]').first();
  if ((await cye.count()) > 0) {
    console.log("\n=== Current-Year Earnings row ===");
    console.log("  text:", (await cye.innerText()).replace(/\n/g, " | "));
  } else {
    console.log("\n=== Current-Year Earnings row: NOT FOUND ===");
  }

  const totalME = page.locator('[data-testid="sofp-row-total-members-equity"]').first();
  if ((await totalME.count()) > 0) {
    console.log("\n=== Total Members' Equity row ===");
    console.log("  text:", (await totalME.innerText()).replace(/\n/g, " | "));
  }

  const grandTotal = page.locator('[data-testid="sofp-row-total-liabilities-and-equity"]').first();
  if ((await grandTotal.count()) > 0) {
    console.log("\n=== Total Liabilities & Members' Equity row ===");
    console.log("  text:", (await grandTotal.innerText()).replace(/\n/g, " | "));
  }

  const totalAssets = page.locator('[data-testid="sofp-row-total-assets"]').first();
  if ((await totalAssets.count()) > 0) {
    console.log("\n=== Total Assets row ===");
    console.log("  text:", (await totalAssets.innerText()).replace(/\n/g, " | "));
  }

  // 5) Reconciliation banner detection — any text mentioning "out of balance" / "does not reconcile"
  const bodyText = await page.locator("body").innerText();
  const warning = bodyText.match(/out of balance|does not reconcile|not reconcile|reconciliation.*warning|reconciliation.*error/i);
  console.log("\n=== Reconciliation warning present? ===");
  console.log(" ", warning ? `YES ("${warning[0]}")` : "NO — no warning found");

  await browser.close();
  console.log("\nDONE — screenshot at test-results/v1523-1-monthly-loaded.png");
}

main().catch((e) => { console.error(e); process.exit(1); });
