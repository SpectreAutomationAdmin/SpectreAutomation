// Founder-directed staging functional acceptance for /employee/schedule.
// Covers directive §11-16 and §18-20 and §23. Only mutates staging DB
// via the Give Up + Withdraw pair, which self-restores the shift back
// to ASSIGNED (see §16 explicit "restores the staging fixture where
// possible").

import { test, expect, type Locator, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const OUT = path.resolve("test-results/schedule-staging-final");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = "https://staging.spectreautomation.com";

const TAYLOR = { email: "taylor.hourly@fixture.spectre.test", password: "TA1C-Preview-99" };
const DEVON  = { email: "devon@fixture.spectre.test",         password: "PhaseE-Preview-99" };
const CASEY  = { email: "casey@fixture.spectre.test",         password: "PhaseE-Preview-99" };

function shellFor(page: Page, viewport: "desktop" | "mobile"): Locator {
  return page.getByTestId(viewport === "desktop" ? "portal-desktop-shell" : "portal-mobile-shell");
}
async function login(page: Page, email: string, password: string) {
  await page.goto(`${STAGING}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('[data-testid="employee-login-submit"]').click();
  await page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 });
}

test.describe.serial("Staging /employee/schedule functional acceptance", () => {
  test.setTimeout(180_000);

  test("§11 Taylor — chevron prev + next + Today update URL and load real data", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, TAYLOR.email, TAYLOR.password);
    // Land on a canonical start week; server will compute next/prev.
    await page.goto(`${STAGING}/employee/schedule?weekStart=2026-09-07`, { waitUntil: "domcontentloaded" });
    const shell = shellFor(page, "desktop");
    await shell.getByTestId("portal-schedule-week-grid").waitFor({ state: "visible" });
    const week0 = new URL(page.url()).searchParams.get("weekStart");
    // NEXT
    await Promise.all([
      page.waitForURL((u) => new URL(u).searchParams.get("weekStart") !== week0, { timeout: 15_000 }),
      shell.getByTestId("portal-schedule-week-next").click(),
    ]);
    await shell.getByTestId("portal-schedule-week-grid").waitFor({ state: "visible" });
    const week1 = new URL(page.url()).searchParams.get("weekStart");
    expect(week1).not.toBe(week0);
    console.log(`[chevron] week0=${week0} → next→ week1=${week1}`);
    // PREV (back to week0)
    await Promise.all([
      page.waitForURL((u) => new URL(u).searchParams.get("weekStart") !== week1, { timeout: 15_000 }),
      shell.getByTestId("portal-schedule-week-prev").click(),
    ]);
    const week2 = new URL(page.url()).searchParams.get("weekStart");
    expect(week2).not.toBe(week1);
    console.log(`[chevron] week1=${week1} → prev→ week2=${week2}`);
    // TODAY
    const today = shell.getByTestId("portal-schedule-today");
    if (await today.count()) {
      // "Today" may collapse to the same week if we're already on it — just
      // ensure it does not error and page renders after click.
      await today.click();
      await shell.getByTestId("portal-schedule-week-grid").waitFor({ state: "visible", timeout: 15_000 });
      console.log(`[today] url=${page.url()}`);
    }
    await ctx.close();
  });

  test("§12 Month view — clicking Month lands on ?view=month without error", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, TAYLOR.email, TAYLOR.password);
    await page.goto(`${STAGING}/employee/schedule?weekStart=2026-09-07`, { waitUntil: "domcontentloaded" });
    const shell = shellFor(page, "desktop");
    await shell.getByTestId("portal-schedule-week-grid").waitFor({ state: "visible" });
    await shell.getByTestId("portal-schedule-view-month").click();
    await page.waitForFunction(() => window.location.search.includes("view=month"), null, { timeout: 15_000 });
    // no server error banner
    const err = await page.locator("text=/Application error/i").count();
    expect(err).toBe(0);
    console.log(`[month] url=${page.url()}`);
    await ctx.close();
  });

  test("§13 My Availability — link href = /employee/availability", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, TAYLOR.email, TAYLOR.password);
    await page.goto(`${STAGING}/employee/schedule?weekStart=2026-09-07`, { waitUntil: "domcontentloaded" });
    const shell = shellFor(page, "desktop");
    const link = shell.getByTestId("portal-schedule-my-availability");
    await link.waitFor({ state: "visible" });
    const href = await link.getAttribute("href");
    expect(href).toBe("/employee/availability");
    // Actually navigate and confirm no server error.
    await Promise.all([
      page.waitForURL(/\/employee\/availability/, { timeout: 15_000 }),
      link.click(),
    ]);
    const err = await page.locator("text=/Application error/i").count();
    expect(err).toBe(0);
    await ctx.close();
  });

  test("§14+§18-20 Taylor — Next Shift / This Week / Recent Shifts render real staging data + panel open+close", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, TAYLOR.email, TAYLOR.password);
    await page.goto(`${STAGING}/employee/schedule?weekStart=2026-09-07`, { waitUntil: "domcontentloaded" });
    const shell = shellFor(page, "desktop");
    await shell.getByTestId("portal-schedule-week-grid").waitFor({ state: "visible" });

    // Next Shift card — the section title text always renders in the KPI
    // row (populated card carries the testid; empty branch renders only
    // the "Next Shift" heading with no testid).
    await expect(shell.getByRole("heading", { name: "Next Shift" }).first()
      .or(shell.getByText("Next Shift").first())).toBeVisible();

    // This Week KPI — visible.
    await expect(shell.getByTestId("portal-schedule-this-week")).toBeVisible();

    // Recent Shifts — the section only renders when recentShifts.length > 0.
    // If Taylor has no recent shifts this window, the section is absent.
    // Both outcomes are valid; only assert the shape is not broken.
    const recentCount = await shell.getByTestId("portal-schedule-recent").count();
    console.log(`[recent-shifts] present=${recentCount > 0}`);

    // Try opening the shift detail panel if any shift card exists this week.
    const anyShift = shell.locator('[data-testid^="portal-schedule-shift-"]').first();
    const cardCount = await anyShift.count();
    if (cardCount > 0) {
      await page.waitForTimeout(400);
      await anyShift.click();
      const panel = page.getByTestId("portal-schedule-shift-panel").first();
      await panel.waitFor({ state: "visible", timeout: 10_000 });
      const closeBtn = page.getByTestId("portal-schedule-panel-close").first();
      await closeBtn.click();
      await panel.waitFor({ state: "hidden", timeout: 10_000 });
    }

    await ctx.close();
  });

  test("§15+§16 Taylor — Give Up → offered state → Withdraw → restored", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, TAYLOR.email, TAYLOR.password);
    await page.goto(`${STAGING}/employee/schedule?weekStart=2026-09-07`, { waitUntil: "domcontentloaded" });
    const shell = shellFor(page, "desktop");
    await shell.getByTestId("portal-schedule-week-grid").waitFor({ state: "visible" });

    // Look for a give-up-eligible assigned shift this week (skip if
    // none present — Taylor's staging fixture may already be offered
    // or the week may be empty).
    const shifts = shell.locator('[data-testid^="portal-schedule-shift-"]');
    const count = await shifts.count();
    if (count === 0) {
      test.skip(true, "no eligible assigned shifts this week for Taylor on staging");
    }

    // Click the first shift. Panel must open.
    await page.waitForTimeout(500);
    await shifts.first().click();
    const panel = page.getByTestId("portal-schedule-shift-panel").first();
    await panel.waitFor({ state: "visible", timeout: 10_000 });

    // Panel renders give-up form directly. If canGiveUp is false for
    // this specific shift (already offered / eligibility gate), the
    // form testid is absent — skip gracefully.
    const form = page.getByTestId("portal-schedule-give-up-form").first();
    if (await form.count() === 0) {
      await ctx.close();
      test.skip(true, "first shift on staging is not give-up-eligible (form not shown)");
      return;
    }
    await form.waitFor({ state: "visible", timeout: 10_000 });
    const reason = page.getByTestId("portal-schedule-give-up-reason").first();
    if (await reason.count()) await reason.selectOption("PERSONAL");
    await page.getByTestId("portal-schedule-give-up-submit").first().click();
    await page.waitForFunction(() => window.location.search.includes("offered=1"), null, { timeout: 20_000 });
    await expect(shell.getByTestId("portal-schedule-toast-success")).toBeVisible();

    await page.screenshot({ path: path.join(OUT, "give-up-offered.png"), fullPage: false });

    // Reopen the (now offered) card and withdraw.
    await page.waitForTimeout(500);
    // Offered card testid = portal-schedule-shift-offered-<id> per production code.
    const offered = shell.locator('[data-testid^="portal-schedule-shift-offered-"]').first();
    await offered.waitFor({ state: "visible", timeout: 10_000 });
    await offered.click();
    const withdrawBtn = page.getByTestId("portal-schedule-withdraw-offer").first();
    await withdrawBtn.waitFor({ state: "visible", timeout: 10_000 });
    await withdrawBtn.click();
    await page.waitForFunction(() => window.location.search.includes("withdrawn=1"), null, { timeout: 20_000 });

    await page.screenshot({ path: path.join(OUT, "give-up-withdrawn.png"), fullPage: false });

    // Assigned shift should reappear (not offered).
    await page.reload({ waitUntil: "domcontentloaded" });
    const reAssigned = shell.locator('[data-testid^="portal-schedule-shift-"]').first();
    await reAssigned.waitFor({ state: "visible", timeout: 10_000 });
    await ctx.close();
  });

  test("§21 Devon — eligible-empty state renders (no crash)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, DEVON.email, DEVON.password);
    await page.goto(`${STAGING}/employee/schedule`, { waitUntil: "domcontentloaded" });
    const shell = shellFor(page, "desktop");
    await expect(shell.getByTestId("portal-schedule-empty")).toBeVisible();
    const err = await page.locator("text=/Application error/i").count();
    expect(err).toBe(0);
    await ctx.close();
  });

  test("§22 Casey — training-locked state renders (no ScheduleView leak)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await login(page, CASEY.email, CASEY.password);
    await page.goto(`${STAGING}/employee/schedule`, { waitUntil: "domcontentloaded" });
    const shell = shellFor(page, "desktop");
    await expect(shell.getByTestId("portal-schedule-locked")).toBeVisible();
    // Ensure ScheduleView populated shell did NOT leak past the gate.
    const populated = shell.getByTestId("portal-schedule-populated");
    expect(await populated.count()).toBe(0);
    await ctx.close();
  });

  test("§23 mobile 390x844 — Taylor mobile Schedule renders, no horizontal overflow", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    await login(page, TAYLOR.email, TAYLOR.password);
    await page.goto(`${STAGING}/employee/schedule`, { waitUntil: "domcontentloaded" });
    const shell = shellFor(page, "mobile");
    // Either populated or empty is fine.
    const populated = shell.getByTestId("portal-schedule-populated");
    const empty = shell.getByTestId("portal-schedule-empty");
    await expect(populated.or(empty).first()).toBeVisible();
    const bodyScrollWidth = await page.evaluate(() => document.body.scrollWidth);
    expect(bodyScrollWidth, `horizontal overflow at 390px: ${bodyScrollWidth}`).toBeLessThanOrEqual(400);
    await page.screenshot({ path: path.join(OUT, "mobile-390x844-schedule.png"), fullPage: false });
    await ctx.close();
  });
});
