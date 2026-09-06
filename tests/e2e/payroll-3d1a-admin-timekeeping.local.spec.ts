// Payroll-3D-1A (2026-09-05) — admin timekeeping-method UI Playwright.
//
// Covers §19 admin UI acceptance + §8 employee round-trip:
//   1. Raelene signs in as authorized admin
//   2. Opens Taylor Hourly's employee profile
//   3. Timekeeping Method visible; currently CLOCK_REQUIRED
//   4. Change to NO_TIME_ENTRY_REQUIRED, save
//   5. Portal login as Taylor → active Clock In control DISAPPEARS
//   6. Change back to CLOCK_REQUIRED
//   7. Portal login as Taylor → active Clock In returns

import { test, expect, type Page } from "@playwright/test";
import { PrismaClient } from "@prisma/client";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/payroll-3d1a");
fs.mkdirSync(OUT, { recursive: true });

// Payroll-3D-1A — CLUB_ADMIN holds `hr:employee:write`; PAYROLL_ADMIN
// does not, so the Timekeeping panel only exposes the edit control
// when the CLUB_ADMIN is signed in. Alex Preview is the fixture's
// CLUB_ADMIN (see payroll-founder-preview-fixture.ts).
const RAELENE = "alex.preview@preview.spectre.test";
const TAYLOR  = "taylor.hourly@preview.spectre.test";
const PASSWORD = "TA1C-Preview-99";

const prisma = new PrismaClient();

async function adminSignIn(page: Page, email: string) {
  await page.goto("/login");
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL(/\/app(?!\/.*login).*/, { timeout: 30_000 }),
    page.getByRole("button", { name: /^Sign in$/ }).click(),
  ]);
}
async function portalSignIn(page: Page, email: string) {
  await page.goto("/employee/login");
  await page.locator('[data-testid="employee-login-email"]').fill(email);
  await page.locator('[data-testid="employee-login-password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL(/\/employee(?!\/login).*/, { timeout: 30_000 }),
    page.locator('[data-testid="employee-login-submit"]').click(),
  ]);
}

async function selectMethodInAdmin(page: Page, value: string) {
  const select = page.locator('[data-testid="timekeeping-select"]:visible').first();
  await select.selectOption(value);
  await page.locator('[data-testid="timekeeping-save"]:visible').first().click();
  await expect(page.locator('[data-testid="timekeeping-message"]:visible').first()).toHaveText(/Saved/i, { timeout: 15_000 });
}

test.describe.serial("Payroll-3D-1A · Timekeeping admin UI", () => {
  test.beforeAll(async () => {
    // Ensure Taylor exists + is CLOCK_REQUIRED + no open clock events.
    execFileSync("npm", ["run", "fixture:payroll-3d1-taylor-hourly"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
    });
  });
  test.afterAll(async () => {
    // Restore Taylor to CLOCK_REQUIRED regardless of test outcome.
    execFileSync("npm", ["run", "fixture:payroll-3d1-taylor-hourly"], {
      encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: true,
    });
    await prisma.$disconnect();
  });

  test("Raelene changes Taylor's timekeeping method + Taylor's portal reflects it", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();

    // Resolve Taylor's employee id.
    const taylor = await prisma.employee.findFirstOrThrow({
      where: { email: TAYLOR, club: { slug: "coulee-ridge" } },
    });

    // 1. Admin opens Taylor's employee profile.
    await adminSignIn(page, RAELENE);
    await page.goto(`/app/admin/people/employees/${taylor.id}?tab=employment`);
    await expect(page.locator('[data-testid="timekeeping-panel"]').first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(OUT, "01-admin-panel.png"), fullPage: true });

    // 2. Flip Taylor to NO_TIME_ENTRY_REQUIRED.
    await selectMethodInAdmin(page, "NO_TIME_ENTRY_REQUIRED");
    await page.screenshot({ path: path.join(OUT, "02-admin-flipped-no-time.png"), fullPage: true });

    // 3. Verify DB.
    const flipped = await prisma.employee.findUniqueOrThrow({ where: { id: taylor.id } });
    expect(flipped.timekeepingMethod).toBe("NO_TIME_ENTRY_REQUIRED");
    await context.close();

    // 4. Portal side: Taylor signs in → no active Clock In control.
    const taylorCtx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    });
    const taylorPage = await taylorCtx.newPage();
    await portalSignIn(taylorPage, TAYLOR);
    await taylorPage.goto("/employee/time");
    await expect(taylorPage.locator('[data-testid="portal-time-clock"]:visible').first()).toBeVisible({ timeout: 30_000 });
    await expect(taylorPage.locator('[data-testid="portal-time-clock-in"]:visible')).toHaveCount(0);
    await expect(taylorPage.locator('[data-testid="portal-time-state"]:visible').first()).toContainText(/Time entry not required/i);
    await taylorPage.screenshot({ path: path.join(OUT, "03-taylor-no-clock.png"), fullPage: true });
    await taylorCtx.close();

    // 5. Admin flips back to CLOCK_REQUIRED.
    const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page2 = await ctx2.newPage();
    await adminSignIn(page2, RAELENE);
    await page2.goto(`/app/admin/people/employees/${taylor.id}?tab=employment`);
    await expect(page2.locator('[data-testid="timekeeping-panel"]').first()).toBeVisible({ timeout: 30_000 });
    await selectMethodInAdmin(page2, "CLOCK_REQUIRED");
    const restored = await prisma.employee.findUniqueOrThrow({ where: { id: taylor.id } });
    expect(restored.timekeepingMethod).toBe("CLOCK_REQUIRED");
    await page2.screenshot({ path: path.join(OUT, "04-admin-restored.png"), fullPage: true });
    await ctx2.close();

    // 6. Portal side: Taylor sees Clock In again.
    const t2 = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true, isMobile: true, deviceScaleFactor: 2,
    });
    const t2Page = await t2.newPage();
    await portalSignIn(t2Page, TAYLOR);
    await t2Page.goto("/employee/time");
    await expect(t2Page.locator('[data-testid="portal-time-clock-in"]:visible').first()).toBeVisible({ timeout: 30_000 });
    await t2Page.screenshot({ path: path.join(OUT, "05-taylor-clock-restored.png"), fullPage: true });
    await t2.close();
  });
});
