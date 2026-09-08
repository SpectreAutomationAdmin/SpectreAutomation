// Final vertical-composition acceptance capture.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/schedule-functional-vertical-final");
fs.mkdirSync(OUT, { recursive: true });
const REF_SOURCE = path.resolve("docs/design/scheduling/employee-schedule-desktop-1440x900-approved.png");
const REFERENCE  = path.join(OUT, "reference.png");
const RENDER     = path.join(OUT, "functional-render.png");
const SIDEBYSIDE = path.join(OUT, "side-by-side.png");
const LANDMARKS  = path.join(OUT, "landmarks.txt");
const LOCAL = process.env.PREVIEW_URL ?? "http://localhost:3000/preview/schedule-functional";

test.use({ viewport: { width: 1440, height: 900 } });

async function landmarks(page: Page) {
  return await page.evaluate(() => {
    function b(sel: string) {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height), width: Math.round(r.width) };
    }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      breadcrumb: b('[data-testid="portal-schedule-populated"] header p'),
      title: b('[data-testid="portal-schedule-populated"] header h1'),
      toolbar: b('[data-testid="portal-schedule-populated"] > div.flex.flex-col.md\\:flex-row'),
      calendar: b('[data-testid="portal-schedule-week-grid"]'),
      kpiRow: b('[data-testid="portal-schedule-populated"] > div.grid.grid-cols-1.md\\:grid-cols-3'),
      recent: b('[data-testid="portal-schedule-recent"]'),
    };
  });
}

test("vertical composition capture + landmarks", async ({ browser, page }) => {
  test.setTimeout(120_000);
  if (!fs.existsSync(REF_SOURCE)) throw new Error(`Reference missing at ${REF_SOURCE}`);
  fs.copyFileSync(REF_SOURCE, REFERENCE);

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(LOCAL, { waitUntil: "networkidle" });
  await page.getByTestId("portal-schedule-populated").first().waitFor({ state: "visible" });
  await page.waitForTimeout(400);
  await page.screenshot({ path: RENDER, fullPage: false });

  const m = await landmarks(page);
  const contentBottom = m.recent?.bottom ?? 0;
  const bottomGutter = m.viewport.h - contentBottom;
  const REF = {
    breadcrumb: { top: 130 },
    title: { top: 155, bottom: 195, height: 40 },
    toolbar: { top: 215, bottom: 260, height: 45 },
    calendar: { top: 278, bottom: 490, height: 212 },
    kpiRow: { top: 505, bottom: 695, height: 190 },
    recent: { top: 715, bottom: 830, height: 115 },
    bottomGutter: 70,
  };
  function delta(real: number | undefined, ref: number) {
    if (real == null) return "?";
    const d = real - ref;
    return `${real}  (delta ${d >= 0 ? "+" : ""}${d})`;
  }
  const report = `FUNCTIONAL VERTICAL FINAL LANDMARKS at ${m.viewport.w}x${m.viewport.h}
=======================================================
                       REFERENCE   FUNCTIONAL   DELTA
breadcrumb top         ${REF.breadcrumb.top}         ${delta(m.breadcrumb?.top, REF.breadcrumb.top)}
title top              ${REF.title.top}         ${delta(m.title?.top, REF.title.top)}
title bottom           ${REF.title.bottom}         ${delta(m.title?.bottom, REF.title.bottom)}
title height           ${REF.title.height}          ${delta(m.title?.height, REF.title.height)}
toolbar top            ${REF.toolbar.top}         ${delta(m.toolbar?.top, REF.toolbar.top)}
toolbar bottom         ${REF.toolbar.bottom}         ${delta(m.toolbar?.bottom, REF.toolbar.bottom)}
toolbar height         ${REF.toolbar.height}          ${delta(m.toolbar?.height, REF.toolbar.height)}
calendar top           ${REF.calendar.top}         ${delta(m.calendar?.top, REF.calendar.top)}
calendar bottom        ${REF.calendar.bottom}         ${delta(m.calendar?.bottom, REF.calendar.bottom)}
CALENDAR HEIGHT        ${REF.calendar.height}         ${delta(m.calendar?.height, REF.calendar.height)}
kpi top                ${REF.kpiRow.top}         ${delta(m.kpiRow?.top, REF.kpiRow.top)}
kpi bottom             ${REF.kpiRow.bottom}         ${delta(m.kpiRow?.bottom, REF.kpiRow.bottom)}
KPI HEIGHT             ${REF.kpiRow.height}         ${delta(m.kpiRow?.height, REF.kpiRow.height)}
recent top             ${REF.recent.top}         ${delta(m.recent?.top, REF.recent.top)}
RECENT BOTTOM          ${REF.recent.bottom}         ${delta(m.recent?.bottom, REF.recent.bottom)}
RECENT HEIGHT          ${REF.recent.height}         ${delta(m.recent?.height, REF.recent.height)}
BOTTOM GUTTER          ${REF.bottomGutter}          ${delta(bottomGutter, REF.bottomGutter)}
viewport bottom        900         ${m.viewport.h}
`;
  fs.writeFileSync(LANDMARKS, report);
  console.log(report);

  const refB64 = fs.readFileSync(REFERENCE).toString("base64");
  const rendB64 = fs.readFileSync(RENDER).toString("base64");
  const html = `<!doctype html><html><body style="margin:0;background:#111;color:#eee;">
<div style="display:flex;gap:12px;padding:12px;background:#111;">
  <div style="flex:0 0 auto;background:#fff;">
    <div style="padding:6px 10px;background:#eef;color:#123;font:600 12px system-ui;">REFERENCE 1440x900 (approved shell)</div>
    <img src="data:image/png;base64,${refB64}" style="display:block;width:1440px;height:900px;image-rendering:pixelated;"/>
  </div>
  <div style="flex:0 0 auto;background:#fff;">
    <div style="padding:6px 10px;background:#efe;color:#123;font:600 12px system-ui;">FUNCTIONAL 1440x900 (vertical corrected)</div>
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
});
