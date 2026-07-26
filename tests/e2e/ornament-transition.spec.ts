import { test, type Page } from "@playwright/test";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("capture chapter ornament between briefing and at-a-glance", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  // Scroll to the first chapter ornament — it sits between
  // briefing (II) and at-a-glance (III). The first ornament's
  // approximate Y position is after the briefing ends.
  const firstOrnament = page.locator('[data-testid="chapter-ornament"]').first();
  await firstOrnament.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({
    path: "test-results/ornament-transition-briefing-to-at-a-glance.png",
    fullPage: false,
  });

  // Also capture between stewardship and financial-statements (4th ornament).
  const fourthOrnament = page.locator('[data-testid="chapter-ornament"]').nth(2);
  await fourthOrnament.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({
    path: "test-results/ornament-transition-stewardship-to-financial.png",
    fullPage: false,
  });
});
