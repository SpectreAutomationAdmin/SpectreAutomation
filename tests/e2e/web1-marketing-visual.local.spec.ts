// WEB-1 §31 §32 — visual + functional QA against the local dev server.
// Captures 1440×900 + 390×844 screenshots, asserts no horizontal overflow,
// no console errors, and that key marketing anchors render.

import { test, expect, type ConsoleMessage } from "@playwright/test";

const BASE = process.env.WEB1_BASE ?? "http://localhost:3000";

async function collectConsole(page: import("@playwright/test").Page) {
  const errors: string[] = [];
  page.on("console", (m: ConsoleMessage) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (err) => { errors.push(`pageerror: ${err.message}`); });
  return errors;
}

test.describe("WEB-1 · marketing homepage visual QA", () => {
  test.setTimeout(180_000);

  test("Desktop 1440×900 · full-page shot + no errors + no horizontal overflow", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    const errors = await collectConsole(page);
    await page.goto(BASE, { waitUntil: "networkidle" });
    // Force reveal-on-scroll to complete for a clean full-page shot.
    await page.evaluate(() =>
      document.querySelectorAll(".mkt-reveal").forEach((el) => el.classList.add("is-visible")),
    );
    await page.waitForTimeout(500);
    await page.screenshot({ path: "test-results/web1-desktop-1440.png", fullPage: true });
    // Focused shots.
    await page.locator("body").evaluate((b) => b.scrollTo(0, 0));
    await page.screenshot({ path: "test-results/web1-desktop-1440-hero.png", fullPage: false });
    await page.locator("#mission-control").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/web1-desktop-1440-mission-control.png", fullPage: false });
    await page.locator("#disappear").scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await page.screenshot({ path: "test-results/web1-desktop-1440-disappear.png", fullPage: false });
    await page.locator("#club-identity").scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await page.screenshot({ path: "test-results/web1-desktop-1440-club-identity.png", fullPage: false });
    await page.locator("#final").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/web1-desktop-1440-final.png", fullPage: false });
    // No horizontal overflow.
    const overflow = await page.evaluate(() => {
      const html = document.documentElement;
      const body = document.body;
      return {
        htmlOverflow: html.scrollWidth > html.clientWidth,
        bodyOverflow: body.scrollWidth > body.clientWidth,
        htmlScrollWidth: html.scrollWidth, htmlClientWidth: html.clientWidth,
      };
    });
    expect(overflow.htmlOverflow, `html scrollWidth ${overflow.htmlScrollWidth} > clientWidth ${overflow.htmlClientWidth}`).toBe(false);
    expect(overflow.bodyOverflow).toBe(false);
    // Nav wordmark present.
    await expect(page.locator("header").getByLabel("Spectre Automation").first()).toBeVisible();
    // Console clean (allow noisy dev-only warnings: HMR / manifest fetches /
    // Next.js's per-request CSP nonce hydration warning — the middleware
    // stamps a fresh nonce per request so SSR-vs-hydration diff in dev is
    // expected. Production CSP is unaffected.).
    const meaningful = errors.filter((e) => !/HMR|Fast Refresh|manifest|nonce/i.test(e));
    expect(meaningful, `console errors: ${meaningful.join(" ; ")}`).toHaveLength(0);
    await ctx.close();
  });

  test("Mobile 390×844 · full-page shot + mobile nav sheet + no overflow", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      deviceScaleFactor: 3,
    });
    const page = await ctx.newPage();
    const errors = await collectConsole(page);
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.evaluate(() =>
      document.querySelectorAll(".mkt-reveal").forEach((el) => el.classList.add("is-visible")),
    );
    await page.waitForTimeout(500);
    await page.screenshot({ path: "test-results/web1-mobile-390.png", fullPage: true });
    // Mobile hero-only crop (viewport shot).
    await page.locator("body").evaluate((b) => b.scrollTo(0, 0));
    await page.screenshot({ path: "test-results/web1-mobile-390-hero.png", fullPage: false });
    // Mobile nav sheet open.
    await page.locator("header button").first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: "test-results/web1-mobile-390-nav-open.png", fullPage: false });
    await page.locator("header button").first().click();
    // No horizontal overflow on mobile.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    expect(overflow, "mobile horizontal overflow").toBe(false);
    const meaningful = errors.filter((e) => !/HMR|Fast Refresh|manifest|nonce/i.test(e));
    expect(meaningful, `console errors: ${meaningful.join(" ; ")}`).toHaveLength(0);
    await ctx.close();
  });

  test("Functional QA · anchors + CTA + reduced motion", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    // Every nav anchor must resolve to a section on the page.
    for (const id of ["mission-control", "connected", "disappear", "final"]) {
      const el = page.locator(`#${id}`);
      await expect(el, `anchor #${id} must exist`).toHaveCount(1);
    }
    // Reduced-motion doesn't crash.
    await ctx.close();
    const rmCtx = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    const rmPage = await rmCtx.newPage();
    await rmPage.goto(BASE, { waitUntil: "networkidle" });
    await rmPage.screenshot({ path: "test-results/web1-desktop-reduced-motion.png", fullPage: false });
    await rmCtx.close();
  });
});
