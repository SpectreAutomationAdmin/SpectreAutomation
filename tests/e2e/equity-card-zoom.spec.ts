import { test, type Page } from "@playwright/test";

// Zoomed screenshot of JUST the Equity Value Over Time card so the
// founder can verify the four Equity-card changes (legend, area fill,
// KPI tiles, x-axis labels) at full visual fidelity.

const VIEWPORT = { width: 1440, height: 900 };
const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("equity card zoom", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-financial-performance").click();
  await page.waitForTimeout(600);
  const eq = page.locator("[data-testid='stewardship-equity']");
  await eq.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await eq.screenshot({ path: "test-results/equity-card-zoom.png" });
});
