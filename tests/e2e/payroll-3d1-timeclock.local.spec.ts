// Payroll-3D-1 (2026-09-05) — Time & Attendance Playwright acceptance.
//
// Covers §84 (mobile clock flow), §85 (refresh persistence), §86
// (desktop), §87 (salary employee — Sam Complex still usable + no
// active clock action).
//
// Preconditions:
//   • dev server on http://localhost:3000
//   • `npm run fixture:payroll-3d1-taylor-hourly` has run
//     (Taylor Hourly synthetic employee, CLOCK_REQUIRED, portal login).

import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-3d1");
fs.mkdirSync(OUT, { recursive: true });

const TAYLOR   = "taylor.hourly@preview.spectre.test";
const SAM      = "complex.pay@preview.spectre.test";
const PASSWORD = "TA1C-Preview-99";

async function portalSignIn(page: Page, email: string) {
  await page.goto("/employee/login");
  await page.locator('[data-testid="employee-login-email"]').fill(email);
  await page.locator('[data-testid="employee-login-password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL(/\/employee(?!\/login).*/, { timeout: 30_000 }),
    page.locator('[data-testid="employee-login-submit"]').click(),
  ]);
}

function runFixture(script: string) {
  execFileSync("npm", ["run", script], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
  });
}

test.describe.serial("Payroll-3D-1 · Taylor Hourly mobile @390x844", () => {
  test.beforeAll(async () => {
    // Deterministic reset: wipe any prior clock events for Taylor.
    runFixture("fixture:payroll-3d1-taylor-hourly");
  });

  test("mobile Clock In → Break → Clock Out flow + no horizontal overflow", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await portalSignIn(page, TAYLOR);

    await page.goto("/employee/time");
    await expect(page.locator('[data-testid="portal-time-clock"]:visible').first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT, "mobile-01-off-clock.png"), fullPage: true });

    // OFF_CLOCK — primary action visible.
    await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "OFF_CLOCK");
    await expect(page.locator('[data-testid="portal-time-clock-in"]:visible').first()).toBeVisible();

    // Clock In.
    await page.locator('[data-testid="portal-time-clock-in"]:visible').first().click();
    await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "WORKING", { timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, "mobile-02-working.png"), fullPage: true });

    // Start break.
    await page.locator('[data-testid="portal-time-break-start"]:visible').first().click();
    await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "ON_BREAK", { timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, "mobile-03-on-break.png"), fullPage: true });

    // End break.
    await page.locator('[data-testid="portal-time-break-end"]:visible').first().click();
    await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "WORKING", { timeout: 10_000 });

    // Clock Out.
    await page.locator('[data-testid="portal-time-clock-out"]:visible').first().click();
    await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "OFF_CLOCK", { timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, "mobile-04-off-clock-after.png"), fullPage: true });

    // Recent history is visible with all 4 events.
    const history = page.locator('[data-testid="portal-time-history"]:visible').first();
    await expect(history).toBeVisible();
    const histText = await history.innerText();
    for (const label of ["Clock In", "Break Start", "Break End", "Clock Out"]) {
      expect(histText).toContain(label);
    }

    // No horizontal overflow on mobile.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await context.close();
  });

  test("mobile refresh persistence — state survives browser reload", async ({ browser }) => {
    // Reset + re-clock-in.
    runFixture("fixture:payroll-3d1-taylor-hourly");
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await portalSignIn(page, TAYLOR);
    await page.goto("/employee/time");
    await expect(page.locator('[data-testid="portal-time-clock"]:visible').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-testid="portal-time-clock-in"]:visible').first().click();
    await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "WORKING", { timeout: 10_000 });

    // Reload — WORKING must survive.
    await page.reload();
    await expect(page.locator('[data-testid="portal-time-clock"]:visible').first()).toBeVisible({ timeout: 30_000 });
    await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "WORKING");

    // Start break, reload again — ON_BREAK must survive.
    await page.locator('[data-testid="portal-time-break-start"]:visible').first().click();
    await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "ON_BREAK", { timeout: 10_000 });
    await page.reload();
    await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "ON_BREAK", { timeout: 30_000 });

    await context.close();
  });
});

test.describe.serial("Payroll-3D-1 · desktop @1440x900", () => {
  test.beforeAll(async () => {
    runFixture("fixture:payroll-3d1-taylor-hourly");
  });

  test("desktop Clock In → Clock Out basic path", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await portalSignIn(page, TAYLOR);
    await page.goto("/employee/time");
    await expect(page.locator('[data-testid="portal-time-clock"]:visible').first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT, "desktop-01-off-clock.png"), fullPage: true });
    await page.locator('[data-testid="portal-time-clock-in"]:visible').first().click();
    await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "WORKING", { timeout: 10_000 });
    await page.locator('[data-testid="portal-time-clock-out"]:visible').first().click();
    await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "OFF_CLOCK", { timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, "desktop-02-after-out.png"), fullPage: true });
    await context.close();
  });
});

test.describe("Payroll-3D-1 · salary employee (Sam Complex) — NO_TIME_ENTRY_REQUIRED", () => {
  test("Sam sees the time page but no active Clock In action", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await portalSignIn(page, SAM);
    await page.goto("/employee/time");
    await expect(page.locator('[data-testid="portal-time-clock"]:visible').first()).toBeVisible({ timeout: 30_000 });
    // NO active Clock In / Out / Break controls.
    await expect(page.locator('[data-testid="portal-time-clock-in"]:visible')).toHaveCount(0);
    await expect(page.locator('[data-testid="portal-time-clock-out"]:visible')).toHaveCount(0);
    await expect(page.locator('[data-testid="portal-time-break-start"]:visible')).toHaveCount(0);
    await expect(page.locator('[data-testid="portal-time-break-end"]:visible')).toHaveCount(0);
    // Non-interactive message present.
    const stateBanner = page.locator('[data-testid="portal-time-state"]:visible').first();
    await expect(stateBanner).toContainText(/Time entry not required/i);
    await page.screenshot({ path: path.join(OUT, "salary-01-non-interactive.png"), fullPage: true });
    await context.close();
  });
});
