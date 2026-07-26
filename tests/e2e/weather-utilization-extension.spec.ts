import { test, expect, type Page } from "@playwright/test";

// 2026-06-19 — Rounds YTD, Course Utilization, Spend per Member, and
// Spend per Round were lifted from Experience Stewardship into the
// Weather & Utilization chapter. Weather drives rounds → rounds drive
// utilization → utilization drives spend per round → spend per round
// drives spend per member. This spec verifies:
//   - the 4 new cards render inside the Weather chapter
//   - they sit immediately after the correlation summary
//   - the legacy Experience-side testIds are gone
//   - no duplicate rendering anywhere

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("Weather & Utilization chapter hosts the 4 lifted utilization cards exactly once", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });

  for (const tid of [
    "mws-utilization-extension",
    "mws-utilization-extension-grid",
    "weather-rounds-ytd",
    "weather-course-utilization",
    "weather-spend-per-member",
    "weather-spend-per-round",
  ]) {
    await expect(
      page.getByTestId(tid),
      `${tid} must render exactly once`,
    ).toHaveCount(1);
  }

  // All four cards live inside the Weather chapter — proves the move stuck.
  const weather = page.getByTestId("weather-and-utilization");
  for (const tid of [
    "mws-utilization-extension",
    "weather-rounds-ytd",
    "weather-course-utilization",
    "weather-spend-per-member",
    "weather-spend-per-round",
  ]) {
    await expect(
      weather.getByTestId(tid),
      `${tid} must live inside the Weather chapter`,
    ).toHaveCount(1);
  }

  // Legacy Experience-side testIds for the moved cards must be gone.
  // (experience-covers and experience-fb-subsidy are NOT in this list —
  // they intentionally survive in the Experience chapter.)
  await expect(page.getByTestId("experience-rounds")).toHaveCount(0);
  await expect(page.getByTestId("experience-spend-per-member")).toHaveCount(0);
  await expect(page.getByTestId("experience-spend-per-round")).toHaveCount(0);
  // experience-utilization tile is gone, but experience-utilization-trend
  // (the closing sparkline) survives. Disambiguate with an exact selector.
  await expect(
    page.locator('[data-testid="experience-utilization"]'),
  ).toHaveCount(0);
});

test("Weather chapter order: correlation summary → utilization-extension → bottom spacer", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });

  const offsets = await page.evaluate((ids) => {
    return ids.map((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      return el ? el.getBoundingClientRect().top + window.scrollY : -1;
    });
  }, [
    "mws-correlation",
    "mws-utilization-extension-eyebrow",
    "mws-utilization-extension-grid",
  ]);

  for (let i = 1; i < offsets.length; i++) {
    expect(
      offsets[i],
      `landmark[${i}] must render after landmark[${i - 1}]`,
    ).toBeGreaterThan(offsets[i - 1]);
  }
});

test("Weather chapter renders cleanly — utilization-extension screenshot", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("weather-and-utilization").waitFor({ timeout: 20_000 });

  await page.getByTestId("mws-utilization-extension").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/weather-utilization-extension.png", fullPage: false });
});
