// Diagnostic probe: dump Section X card raw text after 2F deploy.
import { test } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

runAt("MBR-FIX-2F · probe Section X raw DOM", async ({ browser }) => {
  test.setTimeout(300_000);
  const ctx = await browser.newContext({ viewport: { width: 1650, height: 930 } });
  const page = await loginAsFounder(ctx);
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-02#departmental-p-and-l`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(4500);
  const section = page.locator('text=Departmental P&L Summary').first();
  const container = section.locator('xpath=ancestor::*[self::section or self::div][2]');
  const txt = (await container.innerText()).replace(/\s+/g, " ");
  console.log("MBR_FIX_2F_PROBE " + txt.slice(0, 4000));
  await ctx.close();
});
