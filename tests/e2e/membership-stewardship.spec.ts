import { test, type Page } from "@playwright/test";

// Capture chapter XI (Membership Stewardship) — the four hero tiles,
// the category mix table, the waitlist depth + aging, the tenure
// distribution, and the 12-month resignations sparkline.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("Membership Stewardship — chapter XI is reachable and renders the hero tiles", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  // Click the rail link to navigate to the chapter.
  await page.getByTestId("reporting-chapter-membership-stewardship").click();
  await page.waitForTimeout(400);

  await page.screenshot({
    path: "test-results/membership-stewardship-hero.png",
    fullPage: false,
  });
});

test("Membership Stewardship — category mix + waitlist visible below the fold", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  await page.locator('[data-testid="membership-category-mix"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "test-results/membership-stewardship-mix.png",
    fullPage: false,
  });
});

test("Membership Stewardship — tenure distribution + attrition sparkline + commentary", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  await page.locator('[data-testid="membership-attrition-trend"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({
    path: "test-results/membership-stewardship-trend.png",
    fullPage: false,
  });
});
