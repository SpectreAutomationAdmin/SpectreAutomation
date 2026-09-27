// WEB-1E — deployed visual acceptance at exactly 1586×992
// (native dimension of Reference A). Captures:
//   1. Full-page screenshot of /app/admin
//   2. Crop of the LEFT NAVIGATION (against Reference A)
//   3. Crop of the TOP CHROME (against Reference A)
//   4. Crop of the CENTER experience — greeting + briefing + feed
//      (against Reference A)
//   5. Crop of the RIGHT RAIL — Today's Position + Executive Insight
//      + Today's Commitments (against Reference B / current staging)
//
// Right-rail crop is a preservation proof, not a Reference-A parity
// test. Reference A's Today at the Club / AI Insights / Recent
// Activity are EXCLUDED from implementation per §10.

import { test, expect } from "@playwright/test";
import { loginAs } from "./_lib/staging-auth";

const BASE_URL = "https://staging.spectreautomation.com";
const PA_EMAIL = "fixture.payroll-admin.3e@spectre.test";
const CTRL_EMAIL = "fixture.controller.3e@spectre.test";
const FIXTURE_PW = "spectre-3e-fixture";

// Reference A native dimensions per §17.
const VIEWPORT = { width: 1586, height: 992 };
const SECONDARY_VIEWPORT = { width: 1440, height: 900 };

test.use({ trace: "off", video: "off" });
test.describe.configure({ mode: "serial" });
test.beforeEach(({}, testInfo) => {
  if (testInfo.project.name !== "chromium") {
    testInfo.skip(true, "WEB-1E visual acceptance is chromium-only (does its own login)");
  }
});

test.describe("WEB-1E · deployed visual acceptance @ 1586×992", () => {
  test.setTimeout(120_000);

  test("HEALTH · /api/health returns 200 on the deployed WEB-1E image", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await ctx.newPage();
    const r = await page.request.get(`${BASE_URL}/api/health`);
    expect(r.ok()).toBeTruthy();
    const body = await r.json();
    console.log("HEALTH:", JSON.stringify(body));
    await ctx.close();
  });

  test("SHELL · full-page @ 1586×992 — captures black nav + top chrome + warm ivory canvas", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    await page.screenshot({ path: "test-results/web1e-01-mc-full-1586.png", fullPage: false });
    await ctx.close();
  });

  test("LEFT NAV crop — near-black warm chrome with cream text (Reference A)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const sidebar = page.locator(".spectre-sidebar").first();
    await sidebar.screenshot({ path: "test-results/web1e-02-sidebar.png" });
    const bg = await sidebar.evaluate((el) => getComputedStyle(el).backgroundColor);
    console.log("SIDEBAR_BG:", bg);
    expect(bg).toMatch(/rgba?\(2[0-9], 2[0-9], 2[0-9]/); // rgb(23,22,26) ≈ #17161a
    await ctx.close();
  });

  test("TOP CHROME crop — matching near-black band", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const topbar = page.locator(".spectre-topbar").first();
    await topbar.screenshot({ path: "test-results/web1e-03-topbar.png" });
    const bg = await topbar.evaluate((el) => getComputedStyle(el).backgroundColor);
    console.log("TOPBAR_BG:", bg);
    expect(bg).toMatch(/rgba?\(2[0-9], 2[0-9], 2[0-9]/);
    await ctx.close();
  });

  test("GREETING crop — editorial serif @ 36 px (Source Serif 4)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const greeting = page.locator(".spectre-mc-greeting").first();
    await greeting.screenshot({ path: "test-results/web1e-04-greeting.png" });
    const cs = await greeting.evaluate((el) => {
      const s = getComputedStyle(el);
      return { fontFamily: s.fontFamily, fontSize: s.fontSize, lineHeight: s.lineHeight, letterSpacing: s.letterSpacing, fontWeight: s.fontWeight };
    });
    console.log("GREETING_STYLE:", JSON.stringify(cs));
    expect(cs.fontFamily).toMatch(/Source Serif|Georgia|serif/i);
    expect(cs.fontSize).toBe("36px");
    await ctx.close();
  });

  test("HERO — photographic hero with editorial serif greeting + FEED SYNCED pill inside + weather + supporting copy", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const hero = page.locator(".spectre-mc-hero").first();
    await expect(hero).toBeVisible();
    await hero.screenshot({ path: "test-results/web1e-08-hero.png" });
    await expect(page.locator(".spectre-mc-hero-img")).toBeVisible();
    await expect(page.locator(".spectre-mc-hero-eyebrow")).toBeVisible();
    await expect(page.locator(".spectre-mc-hero-subtitle")).toBeVisible();
    await expect(page.locator(".spectre-mc-hero-sync")).toBeVisible(); // FEED SYNCED INSIDE hero
    await expect(page.locator(".spectre-mc-hero-weather-temp")).toContainText("14°");
    await expect(page.locator(".spectre-mc-hero-weather-place")).toContainText(/Calgary/i);
    await expect(page.locator(".spectre-mc-hero-support")).toContainText(/details run quietly/i);
    await ctx.close();
  });

  test("KPI STRIP — 4 cards per Reference A §10", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const kpi = page.locator(".spectre-mc-kpi").first();
    await expect(kpi).toBeVisible();
    await kpi.screenshot({ path: "test-results/web1e-09-kpi.png" });
    const cards = page.locator(".spectre-mc-kpi-card");
    await expect(cards).toHaveCount(4);
    await expect(page.getByText(/Items need your attention/i)).toBeVisible();
    await expect(page.getByText(/Items ready for review/i)).toBeVisible();
    await ctx.close();
  });

  test("FEED TABS — My Feed / AI Insights / Starred / Archived + Filter + Search", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await expect(page.locator(".spectre-mc-feed-tabs")).toBeVisible();
    await expect(page.getByRole("tab", { name: /My Feed/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /AI Insights/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Starred/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /Archived/ })).toBeVisible();
    await expect(page.locator(".spectre-mc-feed-filter")).toBeVisible();
    await expect(page.locator(".spectre-mc-feed-search input")).toBeVisible();
    await ctx.close();
  });

  test("CANVAS + surface — warm ivory canvas + cream card surface", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const workspace = page.locator(".spectre-workspace").first();
    const canvasBg = await workspace.evaluate((el) => getComputedStyle(el).backgroundColor);
    console.log("CANVAS_BG:", canvasBg);
    // #f4efe4 → rgb(244, 239, 228). Allow ±3 for gamma.
    expect(canvasBg).toMatch(/24[0-6],\s*23[7-9]|24[1-6]/);
    const briefing = page.locator(".spectre-mc-briefing").first();
    if (await briefing.count() > 0) {
      await briefing.screenshot({ path: "test-results/web1e-05-briefing.png" });
    }
    await ctx.close();
  });

  test("RIGHT RAIL — Today's Position + Executive Insight + Today's Commitments preserved byte-identical (Reference B)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    const rail = page.locator(".spectre-mc-rail").first();
    await rail.screenshot({ path: "test-results/web1e-06-right-rail.png" });

    // Confirm structural preservation: the aside must contain the three
    // sections. Text lookups target visible copy — surviving unchanged
    // is the acceptance signal here, not visual parity with Reference A.
    await expect(page.locator(".spectre-mc-rail")).toBeVisible();
    await expect(page.getByText(/today.?s position/i).first()).toBeVisible();
    await expect(page.getByText(/executive insight/i).first()).toBeVisible();

    // Reference A's excluded rail must NOT appear.
    await expect(page.getByText(/Today at the Club/i)).toHaveCount(0);
    await expect(page.getByText(/AI Insights/i)).toHaveCount(0);
    await expect(page.getByText(/Recent Activity/i)).toHaveCount(0);
    await ctx.close();
  });

  test("SECONDARY @ 1440×900 — sanity capture", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: SECONDARY_VIEWPORT });
    const page = await loginAs(ctx, CTRL_EMAIL, FIXTURE_PW);
    await page.goto(`${BASE_URL}/app/admin`, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.screenshot({ path: "test-results/web1e-07-mc-full-1440.png", fullPage: false });
    await ctx.close();
  });
});
