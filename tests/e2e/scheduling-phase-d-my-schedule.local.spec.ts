// Scheduling Foundation · Phase D (2026-09-07) — My Schedule
// visual acceptance for training-eligible, locked, and empty states.
//
// Uses the scheduling-phase-d-fixture.mjs helper to prime a fresh
// Club + hourly employee + portal credential per scenario. The spec
// logs in via /employee/login (matches the Phase C portal-auth path)
// and screenshots the desktop 1440×900 + mobile 390×844 viewports.
//
// NOTE: the Employee Portal layout renders BOTH desktop
// (portal-desktop-shell) and mobile (portal-mobile-shell) branches
// concurrently, toggled by CSS `hidden md:flex` / `md:hidden`. To
// avoid strict-mode duplicate-testid resolution, every assertion is
// scoped to the shell branch appropriate for the current viewport.

import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const OUT = path.resolve("test-results/scheduling-phase-d-my-schedule");
fs.mkdirSync(OUT, { recursive: true });

const FIXTURE_SCRIPT = path.resolve("scripts/scheduling-phase-d-fixture.mjs");

interface FixtureOut {
  scenario: "populated" | "locked" | "empty";
  clubId: string;
  employeeId: string;
  loginEmail: string;
  loginPassword: string;
  weekStartIso: string;
}
function primeFixture(scenario: "populated" | "locked" | "empty"): FixtureOut {
  const out = execFileSync("node", [FIXTURE_SCRIPT, `--scenario=${scenario}`], {
    cwd: path.resolve("."), encoding: "utf8", timeout: 60_000,
  });
  return JSON.parse(out) as FixtureOut;
}

/** Return the shell-branch Locator visible at this viewport. */
function shellFor(page: Page, viewport: "desktop" | "mobile"): Locator {
  return page.getByTestId(viewport === "desktop" ? "portal-desktop-shell" : "portal-mobile-shell");
}

async function loginAsEmployee(page: Page, email: string, password: string) {
  await page.goto("http://localhost:3000/employee/login", { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('[data-testid="employee-login-submit"]').click();
  await page.waitForURL((url) => !url.pathname.startsWith("/employee/login"), { timeout: 30_000 })
    .catch(async () => {
      const err = await page.locator('[data-testid="employee-login-error"]').textContent().catch(() => "");
      throw new Error(`Employee login did not leave /employee/login. Visible error: "${err ?? ""}". Current URL: ${page.url()}`);
    });
}

test.describe.serial("Scheduling Foundation · Phase D · My Schedule visual acceptance", () => {
  test.setTimeout(300_000);

  test("§24 desktop 1440×900 — populated schedule (week view, next shift, this week, recent)", async ({ browser }) => {
    const fixture = primeFixture("populated");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await loginAsEmployee(page, fixture.loginEmail, fixture.loginPassword);
    await page.goto("http://localhost:3000/employee/schedule", { waitUntil: "domcontentloaded" });
    const shell = shellFor(page, "desktop");
    await expect(shell.getByTestId("portal-schedule-populated")).toBeVisible();
    await expect(shell.getByTestId("portal-schedule-week-label")).toBeVisible();
    await expect(shell.getByTestId("portal-schedule-view-week")).toBeVisible();
    await expect(shell.getByTestId("portal-schedule-week-grid")).toBeVisible();
    await expect(shell.getByTestId("portal-schedule-hours-scheduled")).toBeVisible();
    await expect(shell.getByTestId("portal-schedule-hours-worked")).toBeVisible();
    await expect(shell.getByTestId("portal-schedule-hours-remaining")).toBeVisible();
    await expect(shell.getByTestId("portal-schedule-actions-time-off-disabled")).toBeVisible();
    await expect(shell.getByTestId("portal-schedule-recent")).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "desktop-1440x900-populated.png"), fullPage: true });
    await ctx.close();
  });

  test("§24 desktop 1440×900 — training-locked state", async ({ browser }) => {
    const fixture = primeFixture("locked");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await loginAsEmployee(page, fixture.loginEmail, fixture.loginPassword);
    await page.goto("http://localhost:3000/employee/schedule", { waitUntil: "domcontentloaded" });
    const shell = shellFor(page, "desktop");
    await expect(shell.getByTestId("portal-schedule-locked")).toBeVisible();
    await expect(shell.getByTestId("portal-schedule-training-progress")).toBeVisible();
    await expect(shell.getByTestId("portal-schedule-locked-view-training")).toBeVisible();
    // No shift functionality on the locked state.
    expect(await shell.getByTestId("portal-schedule-populated").count()).toBe(0);
    expect(await shell.getByTestId("portal-schedule-week-grid").count()).toBe(0);
    await page.screenshot({ path: path.join(OUT, "desktop-1440x900-locked.png"), fullPage: true });
    await ctx.close();
  });

  test("§24 desktop 1440×900 — empty eligible state", async ({ browser }) => {
    const fixture = primeFixture("empty");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await loginAsEmployee(page, fixture.loginEmail, fixture.loginPassword);
    await page.goto("http://localhost:3000/employee/schedule", { waitUntil: "domcontentloaded" });
    const shell = shellFor(page, "desktop");
    await expect(shell.getByTestId("portal-schedule-empty")).toBeVisible();
    await expect(shell.getByTestId("portal-schedule-empty-view-availability")).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "desktop-1440x900-empty.png"), fullPage: true });
    await ctx.close();
  });

  test("§24 mobile 390×844 — populated schedule (date strip + next shift + this week)", async ({ browser }) => {
    const fixture = primeFixture("populated");
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await loginAsEmployee(page, fixture.loginEmail, fixture.loginPassword);
    await page.goto("http://localhost:3000/employee/schedule", { waitUntil: "domcontentloaded" });
    const shell = shellFor(page, "mobile");
    await expect(shell.getByTestId("portal-schedule-populated")).toBeVisible();
    // Desktop grid must NOT be visible in the mobile shell.
    expect(await shell.getByTestId("portal-schedule-week-grid").isVisible().catch(() => false)).toBe(false);
    // Mobile date strip renders (7 day buttons in the mobile shell).
    const dateStripButtons = shell.locator('[data-testid^="portal-schedule-mobile-day-"]');
    expect(await dateStripButtons.count()).toBe(7);
    await page.screenshot({ path: path.join(OUT, "mobile-390x844-populated-upper.png"), fullPage: false });
    await shell.getByTestId("portal-schedule-this-week").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(OUT, "mobile-390x844-populated-lower.png"), fullPage: false });
    const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyScrollWidth, `expected no horizontal scroll at 390px, saw scrollWidth=${bodyScrollWidth}`)
      .toBeLessThanOrEqual(400);
    await ctx.close();
  });

  test("§24 mobile 390×844 — locked state", async ({ browser }) => {
    const fixture = primeFixture("locked");
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await loginAsEmployee(page, fixture.loginEmail, fixture.loginPassword);
    await page.goto("http://localhost:3000/employee/schedule", { waitUntil: "domcontentloaded" });
    const shell = shellFor(page, "mobile");
    await expect(shell.getByTestId("portal-schedule-locked")).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "mobile-390x844-locked.png"), fullPage: false });
    const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyScrollWidth).toBeLessThanOrEqual(400);
    await ctx.close();
  });
});
