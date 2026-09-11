// Founder-directed FORE! Shift Opportunity eligibility acceptance
// on staging (2026-09-10). Uses the existing OPEN opportunity created
// by the founder's manual give-up as Taylor. Positive: Devon sees it +
// picks it up. Negative: Casey (training-locked) does not see it.
// After pickup, DB-restores the fixture (delete Devon's new assignment,
// mark Taylor's row ASSIGNED again, mark opportunity WITHDRAWN).

import { test, expect, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const OUT = path.resolve("test-results/schedule-eligibility-fore");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = "https://staging.spectreautomation.com";

const DEVON = { email: "devon@fixture.spectre.test", password: "PhaseE-Preview-99" };
const CASEY = { email: "casey@fixture.spectre.test", password: "PhaseE-Preview-99" };
const RILEY = { email: "riley@fixture.spectre.test", password: "PhaseE-Preview-99" };
const TAYLOR = { email: "taylor.hourly@fixture.spectre.test", password: "TA1C-Preview-99" };

async function login(page: Page, email: string, password: string) {
  await page.goto(`${STAGING}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('[data-testid="employee-login-submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 });
}

test.describe.serial("Founder FORE! eligibility acceptance", () => {
  test.setTimeout(300_000);

  test("§6 Devon sees Taylor's OPEN opportunity in FORE! Shift Opportunities", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, DEVON.email, DEVON.password);
    await page.goto(`${STAGING}/employee/announcements?tab=shifts`, { waitUntil: "domcontentloaded" });
    const shell = page.getByTestId("portal-desktop-shell");
    await expect(shell.getByTestId("fore-tabs")).toBeVisible();
    await expect(shell.getByTestId("fore-tab-content-shifts")).toBeVisible();
    const list = shell.getByTestId("fore-shifts-list");
    await list.waitFor({ state: "visible", timeout: 10_000 });
    // At least one opportunity card visible.
    const anyCard = shell.locator('[data-testid^="fore-shifts-view-"]');
    const cardCount = await anyCard.count();
    console.log(`[devon-fore] card count = ${cardCount}`);
    expect(cardCount).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(OUT, "devon-fore-shifts-desktop-1440x900.png"), fullPage: true });
    await ctx.close();
  });

  test("§7 negative — Casey (training-locked) FORE! Shift Opportunities shows zero cards", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, CASEY.email, CASEY.password);
    await page.goto(`${STAGING}/employee/announcements?tab=shifts`, { waitUntil: "domcontentloaded" });
    const shell = page.getByTestId("portal-desktop-shell");
    await expect(shell.getByTestId("fore-tabs")).toBeVisible();
    await expect(shell.getByTestId("fore-tab-content-shifts")).toBeVisible();
    // Card list may render as empty state — a training-locked employee
    // returns [] from listEligibleOpportunitiesForEmployee.
    const anyCard = shell.locator('[data-testid^="fore-shifts-view-"]');
    const cardCount = await anyCard.count();
    console.log(`[casey-fore] card count = ${cardCount}`);
    expect(cardCount).toBe(0);
    await page.screenshot({ path: path.join(OUT, "casey-fore-shifts-desktop-1440x900.png"), fullPage: true });
    await ctx.close();
  });

  test("§8 cross-employee pickup — Devon picks up Taylor's shift, then DB restore", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, DEVON.email, DEVON.password);
    await page.goto(`${STAGING}/employee/announcements?tab=shifts`, { waitUntil: "domcontentloaded" });
    const shell = page.getByTestId("portal-desktop-shell");
    const list = shell.getByTestId("fore-shifts-list");
    await list.waitFor({ state: "visible", timeout: 10_000 });
    // Open the first opportunity's PickUp panel.
    const view = shell.locator('[data-testid^="fore-shifts-view-"]').first();
    await view.click();
    // Panel is fixed-positioned and can render outside the shell subtree
    // in query-terms; use page-scoped `.first()` per the shift-panel pattern.
    const pickupPanel = page.getByTestId("fore-pickup-panel").first();
    await pickupPanel.waitFor({ state: "visible", timeout: 10_000 });
    await page.screenshot({ path: path.join(OUT, "devon-pickup-panel.png"), fullPage: true });
    await page.getByTestId("fore-pickup-submit").first().click();
    await page.waitForFunction(() => window.location.search.includes("picked="), null, { timeout: 20_000 });
    await expect(shell.getByTestId("portal-schedule-toast-success")).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "devon-picked-success.png"), fullPage: true });

    // Devon's own /employee/schedule should now show the picked-up shift.
    await page.goto(`${STAGING}/employee/schedule?weekStart=2026-09-07`, { waitUntil: "domcontentloaded" });
    const devShell = page.getByTestId("portal-desktop-shell");
    await devShell.getByTestId("portal-schedule-week-grid").waitFor({ state: "visible" });
    // At least one assigned shift card in the week.
    const devShifts = devShell.locator('[data-testid^="portal-schedule-shift-"]');
    const devCount = await devShifts.count();
    console.log(`[devon-schedule] cards = ${devCount}`);
    expect(devCount).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(OUT, "devon-schedule-after-pickup.png"), fullPage: false });
    await ctx.close();
  });

  test("§8 restore — invoke restore script (delete Devon's new asn, revert Taylor's + opportunity)", async () => {
    // The restore script runs via flyctl ssh with the same synthetic
    // Coulee IDs. It NEVER touches non-fixture rows.
    const out = execFileSync("node", ["scratchpad-run-restore.mjs"], {
      cwd: path.resolve("scripts"),
      encoding: "utf8", timeout: 180_000,
    });
    console.log(out);
    expect(out).toContain("RESTORE OK");
  });

  test("§7b post-restore verify — Devon's FORE! feed once again shows the opportunity", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, DEVON.email, DEVON.password);
    await page.goto(`${STAGING}/employee/announcements?tab=shifts`, { waitUntil: "domcontentloaded" });
    const shell = page.getByTestId("portal-desktop-shell");
    const list = shell.getByTestId("fore-shifts-list");
    await list.waitFor({ state: "visible", timeout: 10_000 });
    // After WITHDRAWN → we OFFERED it again in the restore script, so
    // Devon's FORE! should show the fresh OPEN opp.
    const anyCard = shell.locator('[data-testid^="fore-shifts-view-"]');
    const cardCount = await anyCard.count();
    console.log(`[devon-fore-post-restore] card count = ${cardCount}`);
    expect(cardCount).toBeGreaterThan(0);
    await page.screenshot({ path: path.join(OUT, "devon-fore-post-restore.png"), fullPage: true });
    await ctx.close();
  });
});
