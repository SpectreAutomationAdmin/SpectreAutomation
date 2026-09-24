// WEB-1D — capture homepage hero + admin login + employee login at
// desktop 1440×900 and mobile 390×844.

import { test } from "@playwright/test";

const BASE = "http://localhost:3000";

async function shootAt(browser: any, url: string, tag: string, w: number, h: number, mobile = false) {
  const ctx = await browser.newContext({
    viewport: { width: w, height: h },
    deviceScaleFactor: mobile ? 3 : 1,
    isMobile: mobile,
  });
  const page = await ctx.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await page.evaluate(() => (document as any).fonts?.ready).catch(() => {});
  await page.evaluate(() =>
    document.querySelectorAll(".w1b-reveal").forEach((el) => el.classList.add("is-visible")),
  );
  await page.waitForTimeout(700);
  await page.screenshot({ path: `test-results/${tag}-${w}x${h}.png`, fullPage: false });
  await ctx.close();
}

test.describe("WEB-1D captures", () => {
  test.setTimeout(240_000);

  test("homepage + admin + employee at 1440 and 390", async ({ browser }) => {
    await shootAt(browser, `${BASE}/`,               "w1d-homepage-hero", 1440, 900);
    await shootAt(browser, `${BASE}/`,               "w1d-homepage-hero",  390, 844, true);
    await shootAt(browser, `${BASE}/login`,          "w1d-admin",         1440, 900);
    await shootAt(browser, `${BASE}/login`,          "w1d-admin",          390, 844, true);
    await shootAt(browser, `${BASE}/employee/login`, "w1d-employee",      1440, 900);
    await shootAt(browser, `${BASE}/employee/login`, "w1d-employee",       390, 844, true);
  });
});
