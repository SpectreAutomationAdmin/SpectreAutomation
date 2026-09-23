// WEB-1B Cycle-N comparison — Spectre local vs Framer reference.

import { test } from "@playwright/test";

const BASE = "http://localhost:3000";

test.describe("WEB-1B · Spectre vs Framer comparison", () => {
  test.setTimeout(240_000);

  test("Spectre @ 1440×900 — full page + sectioned shots", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.evaluate(() =>
      document.querySelectorAll(".w1b-reveal").forEach((el) => el.classList.add("is-visible")),
    );
    await page.waitForTimeout(600);
    await page.screenshot({ path: "test-results/spectre-desktop-1440-hero.png", fullPage: false });
    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    for (let i = 0, y = 900; y < scrollHeight; i++, y += 900) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(500);
      await page.screenshot({ path: `test-results/spectre-desktop-1440-section-${String(i + 1).padStart(2, "0")}.png`, fullPage: false });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/spectre-desktop-1440-fullpage.png", fullPage: true });
    await ctx.close();
  });

  test("Spectre @ 390×844 — mobile shots", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      deviceScaleFactor: 3,
    });
    const page = await ctx.newPage();
    await page.goto(BASE, { waitUntil: "domcontentloaded" });
    await page.evaluate(() =>
      document.querySelectorAll(".w1b-reveal").forEach((el) => el.classList.add("is-visible")),
    );
    await page.waitForTimeout(600);
    await page.screenshot({ path: "test-results/spectre-mobile-390-hero.png", fullPage: false });
    await page.screenshot({ path: "test-results/spectre-mobile-390-fullpage.png", fullPage: true });
    await ctx.close();
  });
});
