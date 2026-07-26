import { test, expect, type Page } from "@playwright/test";

// Theme-scope verification.
//
// The Executive Reporting Theme should apply ONLY to routes under
// /app/admin/reporting/**. Operational screens (admin home, ops hub,
// member screens) must continue to use their original operational
// palette unchanged.
//
// This spec captures the operational admin home for visual diff and
// asserts that the reporting-mode shell does NOT render on operational
// routes.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test.describe("Executive Reporting Theme — scope", () => {
  test("operational admin home does NOT render the reporting-mode shell or theme attribute", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/app/admin");
    await page.waitForLoadState("networkidle");

    // The reporting-mode wrapper, reporting shell, and theme attribute
    // must all be absent on operational routes.
    await expect(page.locator('[data-testid="reporting-mode-shell"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="reporting-shell"]')).toHaveCount(0);
    await expect(page.locator('[data-report-theme="executive"]')).toHaveCount(0);

    // The operational admin sidebar must still be present (plain
    // <aside> + admin nav links; reporting routes strip this).
    await expect(page.locator("aside").first()).toBeVisible();

    await page.screenshot({
      path: "test-results/theme-scope-operational-admin.png",
      fullPage: false,
    });
  });

  test("reporting route DOES render the executive theme attribute", async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");

    // The reporting shell + theme attribute must be present.
    await expect(page.locator('[data-testid="reporting-shell"]')).toBeVisible();
    await expect(page.locator('[data-report-theme="executive"]')).toBeVisible();
    // And the operational sidebar must NOT be rendered here.
    await expect(page.locator("aside[aria-label='Primary navigation']")).toHaveCount(0);
  });
});
