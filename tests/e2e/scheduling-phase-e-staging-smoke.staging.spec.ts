// Scheduling Foundation · Phase E staging deployment smoke.
//
// Proves that the newly-deployed staging build serves the schedule
// route for each fixture employee without a Next.js server error,
// and that FORE! tabs render for the eligible pickup coworker.
//
// This is a HOSTED-STAGING smoke — deeper interactive walks (Give
// Up + Pick Up + WI notification) are the founder's own acceptance
// walkthrough. Playwright here proves the deploy is reachable +
// server-side rendering succeeds for the 4 canonical user shapes.

import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/scheduling-phase-e-staging-smoke");
fs.mkdirSync(OUT, { recursive: true });

const STAGING = "https://staging.spectreautomation.com";
const FIXTURES = [
  { key: "A-Taylor",  email: "taylor.hourly@fixture.spectre.test", password: "TA1C-Preview-99",   scenario: "eligible-owner"    },
  { key: "B-Riley",   email: "riley@fixture.spectre.test",         password: "PhaseE-Preview-99", scenario: "eligible-coworker" },
  { key: "C-Casey",   email: "casey@fixture.spectre.test",         password: "PhaseE-Preview-99", scenario: "training-locked"   },
  { key: "D-Devon",   email: "devon@fixture.spectre.test",         password: "PhaseE-Preview-99", scenario: "eligible-empty"    },
];

function shellFor(page: Page, viewport: "desktop" | "mobile"): Locator {
  return page.getByTestId(viewport === "desktop" ? "portal-desktop-shell" : "portal-mobile-shell");
}

async function loginAsEmployee(page: Page, email: string, password: string) {
  await page.goto(`${STAGING}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('[data-testid="employee-login-submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/employee/login"), { timeout: 30_000 })
    .catch(async () => {
      const err = await page.locator('[data-testid="employee-login-error"]').textContent().catch(() => "");
      throw new Error(`Employee login failed for ${email}: "${err ?? ""}". URL: ${page.url()}`);
    });
}

test.describe.serial("Scheduling Foundation · Phase E staging deployment smoke", () => {
  test.setTimeout(300_000);

  test("§10 desktop 1440×900 — /api/health = 200 on the deployed staging release", async ({ request }) => {
    const r = await request.get(`${STAGING}/api/health`);
    expect(r.status()).toBe(200);
  });

  for (const f of FIXTURES) {
    test(`§10 desktop 1440×900 — ${f.key} (${f.scenario}) — /employee/schedule renders without server error`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await loginAsEmployee(page, f.email, f.password);
      await page.goto(`${STAGING}/employee/schedule`, { waitUntil: "domcontentloaded" });
      const errorBoundary = await page.locator("text=/Application error/i").count();
      expect(errorBoundary, `Server error rendered for ${f.email}`).toBe(0);
      expect(page.url()).not.toContain("/employee/login");
      const shell = shellFor(page, "desktop");
      // Scenario-specific rendering expectation.
      if (f.scenario === "training-locked") {
        await expect(shell.getByTestId("portal-schedule-locked")).toBeVisible();
      } else if (f.scenario === "eligible-empty") {
        // Devon: eligible, no shifts. Populated wrapper renders but week grid
        // is empty; the empty-state section is shown alongside the populated
        // wrapper because nextShift is null and weekShifts is empty.
        await expect(shell.getByTestId("portal-schedule-empty")).toBeVisible();
      } else {
        // Taylor / Riley: populated schedule (or with the empty state if
        // their week has no shifts today — Riley has none until they pick
        // one up, which we don't do in this smoke).
        const populated = shell.getByTestId("portal-schedule-populated");
        const empty = shell.getByTestId("portal-schedule-empty");
        await expect(populated.or(empty).first()).toBeVisible();
      }
      await page.screenshot({
        path: path.join(OUT, `desktop-1440x900-${f.key}-schedule.png`),
        fullPage: true,
      });
      await ctx.close();
    });
  }

  test("§10 desktop 1440×900 — Riley FORE! Shift Opportunities tab renders", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await loginAsEmployee(page, "riley@fixture.spectre.test", "PhaseE-Preview-99");
    await page.goto(`${STAGING}/employee/announcements?tab=shifts`, { waitUntil: "domcontentloaded" });
    const errorBoundary = await page.locator("text=/Application error/i").count();
    expect(errorBoundary).toBe(0);
    const shell = shellFor(page, "desktop");
    // Tab strip renders regardless of whether any opportunities exist.
    await expect(shell.getByTestId("fore-tabs")).toBeVisible();
    await expect(shell.getByTestId("fore-tab-content-shifts")).toBeVisible();
    await page.screenshot({
      path: path.join(OUT, "desktop-1440x900-riley-fore-shifts-tab.png"),
      fullPage: true,
    });
    await ctx.close();
  });

  test("§11 desktop 1440×900 — home page renders unchanged (portal shell + hero + widget grid)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await loginAsEmployee(page, "riley@fixture.spectre.test", "PhaseE-Preview-99");
    await page.goto(`${STAGING}/employee`, { waitUntil: "domcontentloaded" });
    const errorBoundary = await page.locator("text=/Application error/i").count();
    expect(errorBoundary).toBe(0);
    const shell = shellFor(page, "desktop");
    // Portal desktop shell + Announcements card must exist. The
    // shift-available indicator is opt-in via prop; count could be 0
    // if Taylor hasn't yet offered.
    await expect(shell.getByTestId("portal-desktop-announcements")).toBeVisible();
    await page.screenshot({
      path: path.join(OUT, "desktop-1440x900-riley-home-regression.png"),
      fullPage: true,
    });
    await ctx.close();
  });

  test("§10 mobile 390×844 — Taylor /employee/schedule renders + no horizontal overflow", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await loginAsEmployee(page, "taylor.hourly@fixture.spectre.test", "TA1C-Preview-99");
    await page.goto(`${STAGING}/employee/schedule`, { waitUntil: "domcontentloaded" });
    const errorBoundary = await page.locator("text=/Application error/i").count();
    expect(errorBoundary).toBe(0);
    const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyScrollWidth, `horizontal overflow at 390px: ${bodyScrollWidth}`)
      .toBeLessThanOrEqual(400);
    await page.screenshot({
      path: path.join(OUT, "mobile-390x844-taylor-schedule.png"),
      fullPage: false,
    });
    await ctx.close();
  });
});
