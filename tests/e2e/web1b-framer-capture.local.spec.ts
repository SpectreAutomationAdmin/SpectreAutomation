// WEB-1B §3 — capture the Framer reference before writing any code.

import { test } from "@playwright/test";

const FRAMER = "https://passionate-mindset-017743.framer.app/";

test.describe("WEB-1B · Framer reference capture", () => {
  test.setTimeout(300_000);

  test("Framer @ 1440×900 — full page shot", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    console.log("[web1b] navigating to Framer…");
    await page.goto(FRAMER, { waitUntil: "domcontentloaded", timeout: 90_000 });
    console.log("[web1b] loaded, settling…");
    await page.waitForTimeout(3000);
    // Walk down the page to trigger scroll animations.
    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    console.log(`[web1b] scrollHeight=${scrollHeight}`);
    await page.screenshot({ path: "test-results/framer-desktop-1440-hero.png", fullPage: false });
    console.log("[web1b] hero shot captured");
    for (let i = 0, y = 900; y < scrollHeight; i++, y += 900) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `test-results/framer-desktop-1440-section-${String(i + 1).padStart(2, "0")}.png`, fullPage: false });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);
    await page.screenshot({ path: "test-results/framer-desktop-1440-fullpage.png", fullPage: true });
    console.log("[web1b] fullpage shot captured");
    await ctx.close();
  });

  test("Framer @ 390×844 — full page shot", async ({ browser }) => {
    const ctx = await browser.newContext({
      viewport: { width: 390, height: 844 },
      userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      deviceScaleFactor: 3,
    });
    const page = await ctx.newPage();
    await page.goto(FRAMER, { waitUntil: "domcontentloaded", timeout: 90_000 });
    await page.waitForTimeout(3000);
    const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
    await page.screenshot({ path: "test-results/framer-mobile-390-hero.png", fullPage: false });
    for (let i = 0, y = 844; y < scrollHeight; i++, y += 844) {
      await page.evaluate((yy) => window.scrollTo(0, yy), y);
      await page.waitForTimeout(1000);
      await page.screenshot({ path: `test-results/framer-mobile-390-section-${String(i + 1).padStart(2, "0")}.png`, fullPage: false });
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(600);
    await page.screenshot({ path: "test-results/framer-mobile-390-fullpage.png", fullPage: true });
    await ctx.close();
  });
});
