// Playwright browser verification for the founder's account-2017 fix.
// Runs against the local dev server on http://localhost:3000.

import { chromium } from "playwright";

const BASE = "http://localhost:3000";

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await context.newPage();

  // 1) Log in via demo quick-access button (server action)
  await page.goto(`${BASE}/login`);
  await page.locator('input[name="email"][value="admin@silversprings.club"] + button, form:has(input[name="email"][value="admin@silversprings.club"]) button').first().click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  console.log("logged in — url:", page.url());

  // 2) Navigate to the Monthly Reporting Package
  await page.goto(`${BASE}/app/admin/reporting/monthly`);
  await page.waitForLoadState("networkidle", { timeout: 30_000 });

  // Take screenshot for the record before drilling in
  await page.screenshot({ path: "test-results/v1522-1-monthly-loaded.png", fullPage: true });

  // 3) Find the Accounts Payable row and click its toggle to expand
  const apToggle = page.locator('[data-testid$="-toggle"]').filter({ hasText: /Accounts Payable/i }).first();
  await apToggle.scrollIntoViewIfNeeded();
  await apToggle.click();
  await page.waitForTimeout(200); // allow expansion animation

  // 4) Screenshot the expanded AP section
  await page.screenshot({ path: "test-results/v1522-2-ap-expanded.png", fullPage: true });

  // 5) Read the parent AP amount + the 2017 detail line
  const apRow = apToggle;
  const apRowText = await apRow.innerText();
  console.log("=== AP summary row text ===");
  console.log(apRowText);

  // Find every sofp-row with account-2017 testid substring so we
  // pick up whatever prefix the SoFP builder chose for this section.
  const allAccountRows = page.locator('[data-testid*="account-2017"]');
  const acct2017Count = await allAccountRows.count();
  console.log(`=== accounts containing 2017 in testid: ${acct2017Count} ===`);
  for (let i = 0; i < acct2017Count; i++) {
    const t = await allAccountRows.nth(i).innerText();
    const tid = await allAccountRows.nth(i).getAttribute("data-testid");
    console.log(`  testid=${tid}\n  text="${t.replace(/\n/g, " | ")}"`);
  }

  // Also enumerate all AP-scoped account rows.
  const apScopedRows = page.locator('[data-testid*="BS_AP-account-"]');
  const c = await apScopedRows.count();
  console.log(`=== BS_AP account-* rows: ${c} ===`);
  for (let i = 0; i < c; i++) {
    const t = await apScopedRows.nth(i).innerText();
    const tid = await apScopedRows.nth(i).getAttribute("data-testid");
    console.log(`  testid=${tid}\n  text="${t.replace(/\n/g, " | ")}"`);
  }

  await browser.close();
  console.log("DONE — screenshots at test-results/v1522-*.png");
}

main().catch((e) => { console.error(e); process.exit(1); });
