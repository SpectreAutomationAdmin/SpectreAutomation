// Real-browser geometry measurement of the /employee/schedule
// desktop at exactly 1440x900. Produces concrete numbers so the
// visual iteration has objective inputs, not eyeballing.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/schedule-geometry");
fs.mkdirSync(OUT, { recursive: true });

const STAGING = "https://staging.spectreautomation.com";

async function login(page: Page, email: string, password: string) {
  await page.goto(`${STAGING}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('[data-testid="employee-login-submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 });
}

test("desktop 1440x900 Taylor schedule — real browser measurements", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await login(page, "taylor.hourly@fixture.spectre.test", "TA1C-Preview-99");
  await page.goto(`${STAGING}/employee/schedule?weekStart=2026-09-07`, { waitUntil: "domcontentloaded" });
  await page.getByTestId('portal-desktop-shell').getByTestId('portal-schedule-week-grid').waitFor({ state: "visible" });

  const measurements = await page.evaluate(() => {
    function bbox(sel: string): { l: number; r: number; t: number; b: number; w: number; h: number } | null {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) };
    }
    return {
      viewport: { w: window.innerWidth, h: window.innerHeight },
      sidebar: bbox('[data-testid="portal-desktop-shell"] aside, [data-testid="portal-desktop-shell"] > div:first-child'),
      main: bbox('[data-testid="portal-desktop-shell"] main'),
      topbar: bbox('[data-testid="portal-header"]'),
      scheduleWrap: bbox('[data-testid="portal-desktop-shell"] [data-testid="portal-schedule-populated"]'),
      title: bbox('[data-testid="portal-desktop-shell"] [data-testid="portal-schedule-populated"] h1'),
      weekLabel: bbox('[data-testid="portal-desktop-shell"] [data-testid="portal-schedule-week-label"]'),
      weekGrid: bbox('[data-testid="portal-desktop-shell"] [data-testid="portal-schedule-week-grid"]'),
      firstDay: bbox('[data-testid="portal-desktop-shell"] [data-testid="portal-schedule-week-grid"] > div > div:first-child'),
      firstShift: bbox('[data-testid="portal-desktop-shell"] [data-testid^="portal-schedule-shift-"]'),
      nextShiftCard: bbox('[data-testid="portal-desktop-shell"] [data-testid="portal-schedule-next-shift"]'),
      thisWeekCard: bbox('[data-testid="portal-desktop-shell"] [data-testid="portal-schedule-this-week"]'),
      actionsCard: bbox('[data-testid="portal-desktop-shell"] [data-testid="portal-schedule-actions"]'),
      recentTitle: bbox('[data-testid="portal-desktop-shell"] #portal-schedule-recent-heading'),
      recentCard: bbox('[data-testid="portal-desktop-shell"] [data-testid="portal-schedule-recent"] > div'),
      recentRow: bbox('[data-testid="portal-desktop-shell"] [data-testid^="portal-schedule-recent-"]'),
    };
  });

  const outFile = path.join(OUT, "measurements.json");
  fs.writeFileSync(outFile, JSON.stringify(measurements, null, 2));
  await page.screenshot({ path: path.join(OUT, "render-1440x900.png"), fullPage: false });
  await page.screenshot({ path: path.join(OUT, "render-fullpage.png"), fullPage: true });

  console.log("\n=== MEASUREMENTS ===");
  console.log(JSON.stringify(measurements, null, 2));
  expect(measurements.viewport.w).toBe(1440);
  await ctx.close();
});
