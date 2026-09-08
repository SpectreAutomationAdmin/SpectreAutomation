// Produces a NORMAL side-by-side comparison of:
//   LEFT:  the authoritative reference PNG
//   RIGHT: the actual 1440x900 local browser render
// No diff. No overlay. Just two normal full-color renders next to
// each other so the founder can inspect the browser rendering
// directly.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/schedule-responsive");
fs.mkdirSync(OUT, { recursive: true });
const REF = path.resolve("docs/design/scheduling/employee-schedule-desktop-1440x900-approved.png");
const RENDER_1440 = path.join(OUT, "schedule-local-1440x900.png");
const SIDEBYSIDE = path.join(OUT, "schedule-local-1440-side-by-side.png");

test("build normal side-by-side (reference | render-1440)", async ({ browser }) => {
  test.setTimeout(60_000);
  if (!fs.existsSync(REF)) throw new Error(`Reference missing at ${REF}`);
  if (!fs.existsSync(RENDER_1440)) throw new Error(`1440 render missing at ${RENDER_1440} — run the width-diagnostic spec first`);
  const refB64 = fs.readFileSync(REF).toString("base64");
  const rendB64 = fs.readFileSync(RENDER_1440).toString("base64");

  const html = `<!doctype html><html><body style="margin:0;background:#111;color:#eee;">
<div style="display:flex;gap:12px;padding:12px;background:#111;">
  <div style="flex:0 0 auto;background:#fff;">
    <div style="padding:6px 10px;background:#eef;color:#123;font:600 12px system-ui;">REFERENCE 1440x900 (authoritative repo PNG)</div>
    <img src="data:image/png;base64,${refB64}" style="display:block;width:1440px;height:900px;image-rendering:pixelated;"/>
  </div>
  <div style="flex:0 0 auto;background:#fff;">
    <div style="padding:6px 10px;background:#efe;color:#123;font:600 12px system-ui;">LOCAL RENDER 1440x900 (Playwright, real browser)</div>
    <img src="data:image/png;base64,${rendB64}" style="display:block;width:1440px;height:900px;image-rendering:pixelated;"/>
  </div>
</div>
</body></html>`;

  const ctx = await browser.newContext({ viewport: { width: 2920, height: 940 } });
  const page = await ctx.newPage();
  await page.setContent(html);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: SIDEBYSIDE, fullPage: true });
  await ctx.close();
  expect(fs.existsSync(SIDEBYSIDE)).toBe(true);
  console.log(`SIDEBYSIDE: ${SIDEBYSIDE}`);
});
