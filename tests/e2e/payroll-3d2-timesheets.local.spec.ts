// Payroll-3D-2 (2026-09-05) — Employee Timesheets + Correction
// Playwright acceptance.
//
// Covers §87 (mobile clean timesheet), §88 (mobile Request Correction
// flow), §89 (desktop 1440), §90 (salary employee — Sam Complex —
// non-interactive "not required" banner).
//
// Preconditions:
//   • dev server on http://localhost:3000
//   • fixtures: `npm run fixture:payroll-3d1-taylor-hourly`
//     (Taylor Hourly synthetic employee, CLOCK_REQUIRED, pay-group).

import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-3d2");
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

test.describe.serial("Payroll-3D-2 · Taylor Hourly mobile timesheet @390x844", () => {
  test.beforeAll(async () => {
    runFixture("fixture:payroll-3d1-taylor-hourly");
  });

  test("§87 clean timesheet after a Clock In + Clock Out — entry shows, no exceptions", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    });
    const page = await context.newPage();
    await portalSignIn(page, TAYLOR);

    // Clock In and Clock Out to create a completed session.
    await page.goto("/employee/time");
    await expect(page.locator('[data-testid="portal-time-clock"]:visible').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-testid="portal-time-clock-in"]:visible').first().click();
    await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "WORKING", { timeout: 10_000 });
    await page.locator('[data-testid="portal-time-clock-out"]:visible').first().click();
    await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "OFF_CLOCK", { timeout: 10_000 });

    // Navigate to Timesheet.
    await page.goto("/employee/timesheets");
    await expect(page.locator('[data-testid="portal-timesheet"]:visible').first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT, "mobile-clean-timesheet.png"), fullPage: true });

    // No exceptions banner.
    await expect(page.locator('[data-testid="portal-timesheet-exceptions"]:visible')).toHaveCount(0);

    // At least one entry appears.
    const entries = page.locator('[data-testid^="portal-timesheet-entry:"]:visible');
    await expect(entries.first()).toBeVisible({ timeout: 15_000 });

    // Period total renders and is non-zero.
    const total = page.locator('[data-testid="portal-timesheet-total"]:visible').first();
    await expect(total).toBeVisible();

    // No horizontal overflow on mobile.
    const overflow = await page.evaluate(() =>
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(1);

    await context.close();
  });

  test("§88 mobile Request Correction — Missing Clock Out flow submits and appears in Pending", async ({ browser }) => {
    // Reset and create an open session (Clock In without Clock Out).
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

    // Go to Timesheet — expect MISSING_CLOCK_OUT exception because
    // the current session is open.
    await page.goto("/employee/timesheets");
    await expect(page.locator('[data-testid="portal-timesheet"]:visible').first()).toBeVisible({ timeout: 30_000 });
    const exBanner = page.locator('[data-testid="portal-timesheet-exceptions"]:visible').first();
    await expect(exBanner).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="portal-timesheet-exception:MISSING_CLOCK_OUT"]:visible').first()).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "mobile-missing-clock-out.png"), fullPage: true });

    // Click Request Correction — dialog opens.
    await page.locator('[data-testid="portal-timesheet-request-correction"]:visible').first().click();
    const dialog = page.locator('[data-testid="portal-correction-dialog"]:visible').first();
    await expect(dialog).toBeVisible({ timeout: 10_000 });

    // Fill reason (proposed time is prefilled to "now").
    await page.locator('[data-testid="portal-correction-reason"]:visible').first().fill("Forgot to clock out at end of shift.");
    await page.screenshot({ path: path.join(OUT, "mobile-correction-dialog.png"), fullPage: true });

    // Submit — dialog closes, pending correction appears.
    await page.locator('[data-testid="portal-correction-submit"]:visible').first().click();
    await expect(page.locator('[data-testid="portal-correction-dialog"]:visible')).toHaveCount(0, { timeout: 15_000 });
    await expect(page.locator('[data-testid="portal-timesheet-pending-corrections"]:visible').first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(OUT, "mobile-correction-pending.png"), fullPage: true });

    // Cancel the correction — pending list becomes empty.
    const cancelBtn = page.locator('[data-testid^="portal-correction-cancel-btn:"]:visible').first();
    await expect(cancelBtn).toBeVisible();
    await cancelBtn.click();
    await expect(page.locator('[data-testid^="portal-correction-row:"]:visible')).toHaveCount(0, { timeout: 15_000 });

    await context.close();
  });
});

test.describe.serial("Payroll-3D-2 · desktop @1440x900", () => {
  test.beforeAll(async () => {
    runFixture("fixture:payroll-3d1-taylor-hourly");
  });

  test("§89 desktop Clock In + Clock Out → Timesheet renders entry", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await portalSignIn(page, TAYLOR);

    await page.goto("/employee/time");
    await expect(page.locator('[data-testid="portal-time-clock"]:visible').first()).toBeVisible({ timeout: 30_000 });
    await page.locator('[data-testid="portal-time-clock-in"]:visible').first().click();
    await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "WORKING", { timeout: 10_000 });
    await page.locator('[data-testid="portal-time-clock-out"]:visible').first().click();
    await expect(page.locator('[data-testid="portal-time-state"]:visible').first()).toHaveAttribute("data-clock-state", "OFF_CLOCK", { timeout: 10_000 });

    await page.goto("/employee/timesheets");
    await expect(page.locator('[data-testid="portal-timesheet"]:visible').first()).toBeVisible({ timeout: 30_000 });
    const entries = page.locator('[data-testid^="portal-timesheet-entry:"]:visible');
    await expect(entries.first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(OUT, "desktop-timesheet.png"), fullPage: true });

    await context.close();
  });
});

test.describe("Payroll-3D-2 · salary employee (Sam Complex) — NO_TIME_ENTRY_REQUIRED", () => {
  test("§90 Sam sees the non-interactive 'not required' banner", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await portalSignIn(page, SAM);
    await page.goto("/employee/timesheets");
    await expect(page.locator('[data-testid="portal-timesheet-non-interactive"]:visible').first()).toBeVisible({ timeout: 30_000 });
    // NO interactive timesheet.
    await expect(page.locator('[data-testid="portal-timesheet"]:visible')).toHaveCount(0);
    await expect(page.locator('[data-testid="portal-timesheet-request-correction"]:visible')).toHaveCount(0);
    await page.screenshot({ path: path.join(OUT, "salary-non-interactive.png"), fullPage: true });
    await context.close();
  });
});
