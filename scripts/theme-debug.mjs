import { chromium } from "playwright";
const BASE = "http://localhost:3000";
async function main() {
  const b = await chromium.launch({ headless: true });
  const c = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await c.newPage();
  await p.goto(`${BASE}/login`);
  await p.locator('form:has(input[name="email"][value="admin@silversprings.club"]) button').first().click();
  await p.waitForURL(/\/app/, { timeout: 20_000 });
  await p.goto(`${BASE}/app/admin/design-system`);
  await p.waitForLoadState("networkidle", { timeout: 30_000 });
  console.log("Before click, attribute:", await p.evaluate(() => document.documentElement.getAttribute("data-theme")));
  await p.locator('[data-testid="spectre-theme-toggle"]').click();
  await p.waitForTimeout(500);
  console.log("After click, attribute:", await p.evaluate(() => document.documentElement.getAttribute("data-theme")));
  console.log("Body computed canvas:", await p.evaluate(() => getComputedStyle(document.querySelector('.spectre-shell')).backgroundColor));
  console.log("--spectre-canvas value:", await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--spectre-canvas')));
  await b.close();
}
main().catch(e => { console.error(e); process.exit(1); });
