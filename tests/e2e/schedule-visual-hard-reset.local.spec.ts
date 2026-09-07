// LOCAL desktop schedule visual iteration. Renders the /preview/
// schedule-desktop route (no auth, hard-coded populated fixture) at
// exactly 1440x900, then builds a side-by-side and an overlay
// against docs/design/scheduling/employee-schedule-desktop-approved.png.
//
// Produces:
//   test-results/schedule-visual-hard-reset/render-1440x900.png
//   test-results/schedule-visual-hard-reset/reference-vs-render.png
//   test-results/schedule-visual-hard-reset/reference-overlay.png

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/schedule-visual-hard-reset");
fs.mkdirSync(OUT, { recursive: true });
const REFERENCE = path.resolve("docs/design/scheduling/employee-schedule-desktop-approved.png");
const RENDER    = path.join(OUT, "render-1440x900.png");
const SIDEBYSIDE = path.join(OUT, "reference-vs-render.png");
const OVERLAY    = path.join(OUT, "reference-overlay.png");

const LOCAL = process.env.PREVIEW_URL ?? "http://localhost:3000/preview/schedule-desktop";

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("Schedule desktop — local visual hard reset", () => {
  test.setTimeout(120_000);

  test("capture 1440x900 render + build side-by-side + overlay against reference", async ({ browser, page }) => {
    // Ensure the reference exists BEFORE proceeding.
    if (!fs.existsSync(REFERENCE)) {
      throw new Error(`Reference image missing at ${REFERENCE}. Aborting per §1.`);
    }

    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(LOCAL, { waitUntil: "networkidle" });
    await page.getByTestId("portal-schedule-week-grid").first().waitFor({ state: "visible" });
    // Wait a tick for any client-side layout settlement.
    await page.waitForTimeout(500);
    await page.screenshot({ path: RENDER, fullPage: false });

    // -------- BUILD side-by-side + overlay via a headless HTML page --------
    const refB64 = fs.readFileSync(REFERENCE).toString("base64");
    const rendB64 = fs.readFileSync(RENDER).toString("base64");

    // 1) side-by-side
    const sideHtml = `<!doctype html><html><body style="margin:0;background:#111;">
<div style="display:flex;gap:8px;padding:8px;background:#111;">
  <div style="flex:1;background:#fff;">
    <div style="padding:6px 10px;background:#eef;color:#123;font:600 12px system-ui;">REFERENCE (approved)</div>
    <img src="data:image/png;base64,${refB64}" style="display:block;width:100%;height:auto;"/>
  </div>
  <div style="flex:1;background:#fff;">
    <div style="padding:6px 10px;background:#efe;color:#123;font:600 12px system-ui;">ACTUAL RENDER (localhost 1440x900)</div>
    <img src="data:image/png;base64,${rendB64}" style="display:block;width:100%;height:auto;"/>
  </div>
</div>
</body></html>`;
    const ctx1 = await browser.newContext({ viewport: { width: 1920, height: 800 } });
    const page1 = await ctx1.newPage();
    await page1.setContent(sideHtml);
    await page1.waitForLoadState("networkidle");
    // Grow viewport to fit content.
    const dim = await page1.evaluate(() => ({ w: document.body.scrollWidth, h: document.body.scrollHeight }));
    await page1.setViewportSize({ width: Math.min(dim.w, 3840), height: Math.min(dim.h, 2400) });
    await page1.screenshot({ path: SIDEBYSIDE, fullPage: true });
    await ctx1.close();

    // 2) overlay — STRETCH both images to identical box dimensions (fill,
    // not contain). Prior use of object-fit:contain letterboxed the
    // 1.6-aspect render inside a 1.43-aspect box, making the render look
    // vertically compressed. `fill` gives an apples-to-apples structural
    // overlay: any x/y drift between the two is caused by layout, not
    // aspect distortion.
    const overlayHtml = `<!doctype html><html><body style="margin:0;background:#222;">
<div style="position:relative;width:1440px;height:900px;background:#fff;">
  <img src="data:image/png;base64,${refB64}"
       style="position:absolute;inset:0;width:1440px;height:900px;object-fit:fill;"/>
  <img src="data:image/png;base64,${rendB64}"
       style="position:absolute;inset:0;width:1440px;height:900px;object-fit:fill;opacity:0.5;mix-blend-mode:multiply;"/>
  <div style="position:absolute;top:6px;left:8px;background:rgba(255,255,255,0.85);padding:4px 8px;font:600 12px system-ui;color:#222;">
    Overlay · reference (opaque base) + render (50% multiply) · both stretched to 1440x900
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
