// STAGING desktop schedule visual capture — mirrors the local
// hard-reset spec but authenticates as Taylor on
// https://staging.spectreautomation.com and captures the REAL
// /employee/schedule route at exactly 1440x900. Produces:
//   test-results/schedule-visual-hard-reset/staging-render-1440x900.png
//   test-results/schedule-visual-hard-reset/staging-reference-vs-render.png
//   test-results/schedule-visual-hard-reset/staging-reference-overlay.png

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/schedule-visual-hard-reset");
fs.mkdirSync(OUT, { recursive: true });
const REFERENCE = path.resolve("docs/design/scheduling/employee-schedule-desktop-approved.png");
const RENDER    = path.join(OUT, "staging-render-1440x900.png");
const SIDEBYSIDE = path.join(OUT, "staging-reference-vs-render.png");
const OVERLAY    = path.join(OUT, "staging-reference-overlay.png");

const STAGING = "https://staging.spectreautomation.com";

async function login(page: Page, email: string, password: string) {
  await page.goto(`${STAGING}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('[data-testid="employee-login-submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 });
}

test.describe.serial("Staging desktop schedule — hard reset capture", () => {
  test.setTimeout(180_000);

  test("capture staging 1440x900 + side-by-side + overlay", async ({ browser }) => {
    if (!fs.existsSync(REFERENCE)) {
      throw new Error(`Reference image missing at ${REFERENCE}.`);
    }
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, "taylor.hourly@fixture.spectre.test", "TA1C-Preview-99");
    await page.goto(`${STAGING}/employee/schedule?weekStart=2026-09-07`, { waitUntil: "domcontentloaded" });
    await page.getByTestId('portal-desktop-shell').getByTestId('portal-schedule-week-grid').waitFor({ state: "visible" });
    await page.waitForTimeout(500);
    await page.screenshot({ path: RENDER, fullPage: false });
    await ctx.close();

    const refB64 = fs.readFileSync(REFERENCE).toString("base64");
    const rendB64 = fs.readFileSync(RENDER).toString("base64");

    // side-by-side
    const sideHtml = `<!doctype html><html><body style="margin:0;background:#111;">
<div style="display:flex;gap:8px;padding:8px;background:#111;">
  <div style="flex:1;background:#fff;">
    <div style="padding:6px 10px;background:#eef;color:#123;font:600 12px system-ui;">REFERENCE (approved)</div>
    <img src="data:image/png;base64,${refB64}" style="display:block;width:100%;height:auto;"/>
  </div>
  <div style="flex:1;background:#fff;">
    <div style="padding:6px 10px;background:#efe;color:#123;font:600 12px system-ui;">STAGING RENDER (v351 @ 1440x900)</div>
    <img src="data:image/png;base64,${rendB64}" style="display:block;width:100%;height:auto;"/>
  </div>
</div>
</body></html>`;
    const ctx1 = await browser.newContext({ viewport: { width: 1920, height: 800 } });
    const page1 = await ctx1.newPage();
    await page1.setContent(sideHtml);
    await page1.waitForLoadState("networkidle");
    const dim = await page1.evaluate(() => ({ w: document.body.scrollWidth, h: document.body.scrollHeight }));
    await page1.setViewportSize({ width: Math.min(dim.w, 3840), height: Math.min(dim.h, 2400) });
    await page1.screenshot({ path: SIDEBYSIDE, fullPage: true });
    await ctx1.close();

    // overlay
    const overlayHtml = `<!doctype html><html><body style="margin:0;background:#222;">
<div style="position:relative;width:1440px;height:900px;background:#fff;">
  <img src="data:image/png;base64,${refB64}"
       style="position:absolute;inset:0;width:1440px;height:900px;object-fit:fill;"/>
  <img src="data:image/png;base64,${rendB64}"
       style="position:absolute;inset:0;width:1440px;height:900px;object-fit:fill;opacity:0.5;mix-blend-mode:multiply;"/>
  <div style="position:absolute;top:6px;left:8px;background:rgba(255,255,255,0.85);padding:4px 8px;font:600 12px system-ui;color:#222;">
    STAGING overlay · reference (opaque base) + staging render (50% multiply) · both stretched to 1440x900
  </div>
</div>
</body></html>`;
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page2 = await ctx2.newPage();
    await page2.setContent(overlayHtml);
    await page2.waitForLoadState("networkidle");
    await page2.screenshot({ path: OVERLAY, fullPage: false });
    await ctx2.close();

    expect(fs.existsSync(RENDER)).toBe(true);
    expect(fs.existsSync(SIDEBYSIDE)).toBe(true);
    expect(fs.existsSync(OVERLAY)).toBe(true);
    console.log(`\nRENDER:      ${RENDER}`);
    console.log(`SIDEBYSIDE:  ${SIDEBYSIDE}`);
    console.log(`OVERLAY:     ${OVERLAY}`);
  });
});
