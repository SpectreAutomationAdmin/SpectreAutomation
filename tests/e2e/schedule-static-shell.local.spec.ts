// Isolated static-prototype visual capture.
// Renders /preview/schedule-desktop-static at 1440x900 and builds a
// NORMAL full-color side-by-side vs the authoritative reference.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/schedule-static-shell");
fs.mkdirSync(OUT, { recursive: true });
const REF_SOURCE = path.resolve("docs/design/scheduling/employee-schedule-desktop-1440x900-approved.png");
const REFERENCE  = path.join(OUT, "reference.png");
const RENDER     = path.join(OUT, "render.png");
const SIDEBYSIDE = path.join(OUT, "side-by-side.png");
const LOCAL = process.env.PREVIEW_URL ?? "http://localhost:3000/preview/schedule-desktop-static";

test.use({ viewport: { width: 1440, height: 900 } });

test("static shell capture + normal side-by-side", async ({ browser, page }) => {
  test.setTimeout(120_000);
  if (!fs.existsSync(REF_SOURCE)) throw new Error(`Reference missing at ${REF_SOURCE}`);
  fs.copyFileSync(REF_SOURCE, REFERENCE);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(LOCAL, { waitUntil: "networkidle" });
  await page.getByTestId("static-schedule-shell").waitFor({ state: "visible" });
  await page.waitForTimeout(300);
  await page.screenshot({ path: RENDER, fullPage: false });

  const refB64 = fs.readFileSync(REFERENCE).toString("base64");
  const rendB64 = fs.readFileSync(RENDER).toString("base64");
  const html = `<!doctype html><html><body style="margin:0;background:#111;color:#eee;">
<div style="display:flex;gap:12px;padding:12px;background:#111;">
  <div style="flex:0 0 auto;background:#fff;">
    <div style="padding:6px 10px;background:#eef;color:#123;font:600 12px system-ui;">REFERENCE 1440x900 (authoritative repo PNG)</div>
    <img src="data:image/png;base64,${refB64}" style="display:block;width:1440px;height:900px;image-rendering:pixelated;"/>
  </div>
  <div style="flex:0 0 auto;background:#fff;">
    <div style="padding:6px 10px;background:#efe;color:#123;font:600 12px system-ui;">STATIC RENDER 1440x900 (isolated prototype)</div>
    <img src="data:image/png;base64,${rendB64}" style="display:block;width:1440px;height:900px;image-rendering:pixelated;"/>
  </div>
</div>
</body></html>`;
  const ctx1 = await browser.newContext({ viewport: { width: 2920, height: 940 } });
  const page1 = await ctx1.newPage();
  await page1.setContent(html);
  await page1.waitForLoadState("networkidle");
  await page1.screenshot({ path: SIDEBYSIDE, fullPage: true });
  await ctx1.close();

  expect(fs.existsSync(RENDER)).toBe(true);
  expect(fs.existsSync(SIDEBYSIDE)).toBe(true);
  console.log(`REFERENCE:  ${REFERENCE}`);
  console.log(`RENDER:     ${RENDER}`);
  console.log(`SIDEBYSIDE: ${SIDEBYSIDE}`);
});
