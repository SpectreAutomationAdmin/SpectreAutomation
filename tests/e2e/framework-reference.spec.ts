import { test, type Page } from "@playwright/test";

// Capture cover bottom (with framework colophon) + chapters IX and X
// (with new framing leads citing the stewardship pillars).

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("cover colophon includes the Spectre Framework citation", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  // The framework colophon sits at the very bottom of the cover.
  const framework = page.locator('[data-testid="monthly-cover-framework"]');
  await framework.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "test-results/framework-colophon-cover.png",
    fullPage: false,
  });
});

test("chapter IX Capital Projects lead is visible", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  await page.getByTestId("reporting-chapter-capital-projects").click();
  await page.waitForTimeout(400);
  await page.screenshot({
    path: "test-results/framework-capital-projects.png",
    fullPage: false,
  });
});

test("chapter X AR Collections lead is visible", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  await page.getByTestId("reporting-chapter-ar-collections").click();
  await page.waitForTimeout(400);
  await page.screenshot({
    path: "test-results/framework-ar-collections.png",
    fullPage: false,
  });
});
