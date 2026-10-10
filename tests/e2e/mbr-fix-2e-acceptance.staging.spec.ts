// MBR-FIX-2E — authenticated staging acceptance for Section X
// Departmental P&L Summary.
//
// Pre-2E: Section X showed ONE card "Nondepartmental $0.00".
// Post-2E: Section X renders one card per Spectre dept represented
// on the Feb 2026 TB (10 depts), with Revenue + COGS + Payroll +
// Opex + Net Income + Budget YTD + Variance populated.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

async function dumpDeptSection(page: Page, label: string) {
  const section = page.locator('text=Departmental P&L Summary').first();
  await section.waitFor({ state: "attached", timeout: 20_000 });
  const container = section.locator('xpath=ancestor::*[self::section or self::div][2]');
  await container.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  const txt = (await container.innerText()).replace(/\s+/g, " ").trim();
  await container.screenshot({ path: `test-results/mbr-fix-2e-${label}.png` }).catch(() => undefined);
  // Collect all card headings (dept names) + each card's text.
  const cardTitles = await container.evaluate((el) => {
    const titles: string[] = [];
    // Match reasonably-common Spectre dept names.
    const names = ["Course & Grounds", "Golf Shop", "Clubhouse", "Food & Beverage",
      "Administration", "Dues & Charges", "Long Range Plan", "Mens Section",
      "Ladies Section", "Corporate", "Nondepartmental"];
    for (const n of names) {
      if ((el as HTMLElement).innerText.includes(n)) titles.push(n);
    }
    return titles;
  });
  console.log(`MBR_FIX_2E_${label}_DEPT_CARDS ${JSON.stringify(cardTitles)}`);
  console.log(`MBR_FIX_2E_${label}_TEXT_HEAD ${txt.slice(0, 2000)}`);
  return { txt, cardTitles };
}

runAt("MBR-FIX-2E · Feb 2026 — Section X shows multiple departmental cards with budget", async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-02#departmental-p-and-l`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
  const { txt, cardTitles } = await dumpDeptSection(page, "feb");

  // At least 5 real-dept cards present (not just Nondepartmental).
  expect(cardTitles.filter((t) => t !== "Nondepartmental").length).toBeGreaterThanOrEqual(5);

  // Must NOT be the pre-fix "Nondepartmental $0.00" only output.
  expect(txt).not.toMatch(/^.*Departmental P&L Summary[^\d]*Nondepartmental[^\d]*\$0\.00\s*$/i);

  // "Budget comparisons omitted until a tenant budget importer lands"
  // (pre-fix stale copy) must be gone.
  expect(txt).not.toContain("Budget comparisons are omitted until a tenant budget importer lands.");

  // Each card should carry Payroll + Budget YTD rows.  Count how many.
  const payrollRowCount = (txt.match(/Payroll & Benefits/gi) || []).length;
  const budgetRowCount = (txt.match(/Budget YTD/gi) || []).length;
  const varianceRowCount = (txt.match(/Variance vs\.? Budget/gi) || []).length;
  console.log(`MBR_FIX_2E_FEB_COUNTS payroll=${payrollRowCount} budget=${budgetRowCount} variance=${varianceRowCount}`);
  expect(payrollRowCount).toBeGreaterThanOrEqual(5);
  expect(budgetRowCount).toBeGreaterThanOrEqual(5);
  expect(varianceRowCount).toBeGreaterThanOrEqual(5);

  await ctx.close();
});

runAt("MBR-FIX-2E · Jan 2026 regression guard — Section X renders live cards", async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#departmental-p-and-l`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
  const { cardTitles } = await dumpDeptSection(page, "jan");
  expect(cardTitles.filter((t) => t !== "Nondepartmental").length).toBeGreaterThanOrEqual(5);
  await ctx.close();
});
