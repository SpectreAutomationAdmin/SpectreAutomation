import { test, type Page } from "@playwright/test";

// 2026-06-19 — side-by-side capture for the chart-system pilot
// review. Renders the Financial Performance chapter (chapter II)
// donut + bar chart card alongside the migrated Chapter XI Weather
// donut + bar chart card at the same viewport so the founder can
// eye-test visual parity.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("side-by-side: FP DuesSubsidy donut vs Chapter XI Pattern donut", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  // FP donut.
  await page.getByTestId("reporting-chapter-financial-performance").click();
  await page.waitForTimeout(500);
  const fpDonut = page.getByTestId("dues-subsidy-donut");
  await fpDonut.waitFor({ timeout: 20_000 });
  await fpDonut.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  // Capture the FP card explicitly via its testid.
  const fpCard = page.getByTestId("dues-subsidy-analysis");
  await fpCard.screenshot({ path: "test-results/side-by-side-FP-donut-card.png" });

  // Chapter XI donut.
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.waitForTimeout(500);
  await page.getByTestId("mws-pattern-card").waitFor({ timeout: 20_000 });
  const weatherCard = page.getByTestId("mws-pattern-card");
  await weatherCard.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await weatherCard.screenshot({ path: "test-results/side-by-side-XI-donut-card.png" });
});

test("side-by-side: FP OperatingResults bars vs Chapter XI Rounds bars", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  // FP bars — direct testid.
  await page.getByTestId("reporting-chapter-financial-performance").click();
  await page.waitForTimeout(500);
  const fpBars = page.getByTestId("stewardship-operating");
  await fpBars.waitFor({ timeout: 20_000 });
  await fpBars.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await fpBars.screenshot({ path: "test-results/side-by-side-FP-bars-card.png" });

  // Chapter XI bars.
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.waitForTimeout(500);
  await page.getByTestId("mws-rounds-card").waitFor({ timeout: 20_000 });
  const weatherBars = page.getByTestId("mws-rounds-card");
  await weatherBars.scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await weatherBars.screenshot({ path: "test-results/side-by-side-XI-bars-card.png" });
});
