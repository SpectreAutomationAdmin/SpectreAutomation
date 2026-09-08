// Founder-directed staging acceptance capture at test-results/schedule-staging-final/.
// Captures the REAL authenticated /employee/schedule page as Taylor Hourly
// on the deployed staging release at 1440x900 and produces:
//   - reference.png (copied from docs/design/scheduling/...approved.png)
//   - staging-render.png
//   - side-by-side.png
//   - landmarks.txt

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/schedule-staging-final");
fs.mkdirSync(OUT, { recursive: true });
const REF_SOURCE = path.resolve("docs/design/scheduling/employee-schedule-desktop-1440x900-approved.png");
const REFERENCE  = path.join(OUT, "reference.png");
const RENDER     = path.join(OUT, "staging-render.png");
const SIDEBYSIDE = path.join(OUT, "side-by-side.png");
const LANDMARKS  = path.join(OUT, "landmarks.txt");

const STAGING = "https://staging.spectreautomation.com";

async function login(page: Page, email: string, password: string) {
  await page.goto(`${STAGING}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('[data-testid="employee-login-submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 });
}

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
      breadcrumb: b('[data-testid="portal-desktop-shell"] [data-testid="portal-schedule-populated"] header p'),
      title: b('[data-testid="portal-desktop-shell"] [data-testid="portal-schedule-populated"] header h1'),
      toolbar: b('[data-testid="portal-desktop-shell"] [data-testid="portal-schedule-populated"] > div.flex.flex-col.md\\:flex-row'),
      calendar: b('[data-testid="portal-desktop-shell"] [data-testid="portal-schedule-week-grid"]'),
      kpiRow: b('[data-testid="portal-desktop-shell"] [data-testid="portal-schedule-populated"] > div.grid.grid-cols-1.md\\:grid-cols-3'),
      recent: b('[data-testid="portal-desktop-shell"] [data-testid="portal-schedule-recent"]'),
    };
  });
}

test.describe.serial("Founder-final staging Schedule capture", () => {
  test.setTimeout(180_000);

  test("staging visual capture + landmarks vs approved local reference", async ({ browser }) => {
    if (!fs.existsSync(REF_SOURCE)) throw new Error(`Reference missing at ${REF_SOURCE}`);
    fs.copyFileSync(REF_SOURCE, REFERENCE);

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, "taylor.hourly@fixture.spectre.test", "TA1C-Preview-99");
    await page.goto(`${STAGING}/employee/schedule?weekStart=2026-09-07`, { waitUntil: "domcontentloaded" });
    await page.getByTestId("portal-desktop-shell").getByTestId("portal-schedule-week-grid").waitFor({ state: "visible" });
    await page.waitForTimeout(400);
    await page.screenshot({ path: RENDER, fullPage: false });
    const m = await landmarks(page);
    const contentBottom = m.recent?.bottom ?? 0;
    const bottomGutter = m.viewport.h - contentBottom;

    // Reference (measured externally from approved reference PNG).
    const REF = {
      breadcrumb: { top: 130 },
      title: { top: 155, bottom: 195, height: 40 },
      toolbar: { top: 215, bottom: 260, height: 45 },
      calendar: { top: 278, bottom: 490, height: 212 },
      kpiRow: { top: 505, bottom: 695, height: 190 },
      recent: { top: 715, bottom: 830, height: 115 },
      bottomGutter: 70,
    };
    const LOCAL_APPROVED = {
      title: { height: 36 }, toolbar: { height: 39 },
      calendar: { height: 217 }, kpiRow: { height: 194 }, recent: { height: 109 },
      recent_bottom: 810, bottomGutter: 90,
    };
    function delta(real: number | undefined, ref: number) {
      if (real == null) return "?";
      const d = real - ref;
      return `${real} (delta ${d >= 0 ? "+" : ""}${d})`;
    }
    const report = `STAGING FINAL LANDMARKS at ${m.viewport.w}x${m.viewport.h}
=======================================================
                       REFERENCE   LOCAL-APPROVED   STAGING
title height           ${REF.title.height}          ${LOCAL_APPROVED.title.height}              ${delta(m.title?.height, REF.title.height)}
toolbar height         ${REF.toolbar.height}          ${LOCAL_APPROVED.toolbar.height}              ${delta(m.toolbar?.height, REF.toolbar.height)}
CALENDAR HEIGHT        ${REF.calendar.height}         ${LOCAL_APPROVED.calendar.height}             ${delta(m.calendar?.height, REF.calendar.height)}
KPI HEIGHT             ${REF.kpiRow.height}         ${LOCAL_APPROVED.kpiRow.height}             ${delta(m.kpiRow?.height, REF.kpiRow.height)}
RECENT HEIGHT          ${REF.recent.height}         ${LOCAL_APPROVED.recent.height}             ${delta(m.recent?.height, REF.recent.height)}
RECENT BOTTOM          ${REF.recent.bottom}         ${LOCAL_APPROVED.recent_bottom}             ${delta(m.recent?.bottom, REF.recent.bottom)}
BOTTOM GUTTER          ${REF.bottomGutter}          ${LOCAL_APPROVED.bottomGutter}              ${delta(bottomGutter, REF.bottomGutter)}
viewport height        900         900             ${m.viewport.h}

Also raw staging top/bot positions:
breadcrumb top         ${m.breadcrumb?.top}
title top/bot          ${m.title?.top} / ${m.title?.bottom}
toolbar top/bot        ${m.toolbar?.top} / ${m.toolbar?.bottom}
calendar top/bot       ${m.calendar?.top} / ${m.calendar?.bottom}
KPI top/bot            ${m.kpiRow?.top} / ${m.kpiRow?.bottom}
Recent top/bot         ${m.recent?.top} / ${m.recent?.bottom}
`;
    fs.writeFileSync(LANDMARKS, report);
    console.log(report);
    await ctx.close();

    const refB64 = fs.readFileSync(REFERENCE).toString("base64");
    const rendB64 = fs.readFileSync(RENDER).toString("base64");
    const html = `<!doctype html><html><body style="margin:0;background:#111;color:#eee;">
<div style="display:flex;gap:12px;padding:12px;background:#111;">
  <div style="flex:0 0 auto;background:#fff;">
    <div style="padding:6px 10px;background:#eef;color:#123;font:600 12px system-ui;">REFERENCE 1440x900 (approved local)</div>
    <img src="data:image/png;base64,${refB64}" style="display:block;width:1440px;height:900px;image-rendering:pixelated;"/>
  </div>
  <div style="flex:0 0 auto;background:#fff;">
    <div style="padding:6px 10px;background:#efe;color:#123;font:600 12px system-ui;">STAGING RENDER 1440x900 (Taylor Hourly)</div>
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
});
