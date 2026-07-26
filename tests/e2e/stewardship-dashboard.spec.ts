import { test } from "@playwright/test";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

test("stewardship dashboard at 1920x1080", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);

  // Scroll the chair's-dashboard section into view.
  await page.locator("#financial-performance").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  await page.screenshot({
    path: "test-results/stewardship-dashboard-1920x1080.png",
    fullPage: false,
  });
});
