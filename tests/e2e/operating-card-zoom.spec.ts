import { test, type Page } from "@playwright/test";

// Zoomed screenshot of JUST the Operating Results — 12-Month Rolling
// Trend card so the founder can verify the parity rebuild (legend,
// chart-dominant layout, inset commentary, accounting-fed values) at
// full visual fidelity.

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

test("operating card zoom", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-financial-performance").click();
  await page.waitForTimeout(600);
  const op = page.locator("[data-testid='stewardship-operating']");
  await op.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await op.screenshot({ path: "test-results/operating-card-zoom.png" });
});
