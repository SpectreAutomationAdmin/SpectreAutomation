// Scheduling Foundation — visual-correction acceptance capture.
//
// Captures Playwright screenshots of every corrected surface at
// 1440×900 (desktop) and 390×844 (mobile) on hosted staging so
// the founder can compare directly against the approved concept.

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/scheduling-visual-correction");
fs.mkdirSync(OUT, { recursive: true });

const STAGING = "https://staging.spectreautomation.com";

async function login(page: Page, email: string, password: string) {
  await page.goto(`${STAGING}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('[data-testid="employee-login-submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 });
}

test.describe.serial("Scheduling — visual-correction acceptance", () => {
  test.setTimeout(300_000);

  test("desktop 1440×900 — Taylor /employee/schedule populated (with Bartender Sat + Recent Mon)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, "taylor.hourly@fixture.spectre.test", "TA1C-Preview-99");
    await page.goto(`${STAGING}/employee/schedule?weekStart=2026-09-07`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("portal-schedule-populated").first()).toBeVisible();
    await expect(page.getByTestId("portal-schedule-week-grid").first()).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "desktop-1440-taylor-schedule.png"), fullPage: true });
    await ctx.close();
  });

  test("desktop 1440×900 — Taylor Give Up drawer (opens on click a shift)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, "taylor.hourly@fixture.spectre.test", "TA1C-Preview-99");
    await page.goto(`${STAGING}/employee/schedule?weekStart=2026-09-07`, { waitUntil: "domcontentloaded" });
    // Click the first visible shift button in the week grid.
    const firstShift = page.locator('[data-testid^="portal-schedule-shift-"]').first();
    await firstShift.click();
    await expect(page.getByTestId("portal-schedule-shift-panel")).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "desktop-1440-taylor-give-up-drawer.png"), fullPage: true });
    await ctx.close();
  });

  test("desktop 1440×900 — Riley FORE! Shift Opportunities tab (empty state)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, "riley@fixture.spectre.test", "PhaseE-Preview-99");
    await page.goto(`${STAGING}/employee/announcements?tab=shifts`, { waitUntil: "domcontentloaded" });
    await expect(page.getByTestId("fore-tabs").first()).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "desktop-1440-riley-fore-shifts.png"), fullPage: true });
    await ctx.close();
  });

  test("mobile 390×844 — Taylor /employee/schedule", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await login(page, "taylor.hourly@fixture.spectre.test", "TA1C-Preview-99");
    await page.goto(`${STAGING}/employee/schedule?weekStart=2026-09-07`, { waitUntil: "domcontentloaded" });
    await page.screenshot({ path: path.join(OUT, "mobile-390-taylor-schedule.png"), fullPage: true });
    await ctx.close();
  });

  test("mobile 390×844 — Taylor Give Up bottom-sheet", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await login(page, "taylor.hourly@fixture.spectre.test", "TA1C-Preview-99");
    await page.goto(`${STAGING}/employee/schedule?weekStart=2026-09-07`, { waitUntil: "domcontentloaded" });
    // Mobile: click first shift in the SelectedDayDetail
    const shift = page.locator('[data-testid^="portal-schedule-mobile-shift-"]').first();
    if (await shift.isVisible()) {
      await shift.click();
      await expect(page.getByTestId("portal-schedule-shift-panel")).toBeVisible();
    }
    await page.screenshot({ path: path.join(OUT, "mobile-390-taylor-give-up.png"), fullPage: false });
    await ctx.close();
  });

  test("mobile 390×844 — Riley FORE! Shift Opportunities tab", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await login(page, "riley@fixture.spectre.test", "PhaseE-Preview-99");
    await page.goto(`${STAGING}/employee/announcements?tab=shifts`, { waitUntil: "domcontentloaded" });
    await page.screenshot({ path: path.join(OUT, "mobile-390-riley-fore-shifts.png"), fullPage: true });
    await ctx.close();
  });

  test("desktop 1440×900 — home regression (portal shell + announcements untouched)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, "riley@fixture.spectre.test", "PhaseE-Preview-99");
    await page.goto(`${STAGING}/employee`, { waitUntil: "domcontentloaded" });
    await page.screenshot({ path: path.join(OUT, "desktop-1440-home-regression.png"), fullPage: true });
    await ctx.close();
  });
});
