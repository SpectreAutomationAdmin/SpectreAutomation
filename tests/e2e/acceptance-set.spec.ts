import { test, type Page } from "@playwright/test";

// Acceptance evidence set — captures the remaining chapters not
// already photographed by the prior comparison/membership/experience
// specs, so a single review can lay out the full 12-chapter package.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const VIEWPORT = { width: 1440, height: 900 };

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("acceptance — board briefing (II)", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-board-briefing").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/accept-board-briefing.png", fullPage: false });
});

test("acceptance — financial statements (V)", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-financial-statements").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/accept-financial-statements.png", fullPage: false });
});

test("acceptance — F&B / hospitality (VIII)", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-fb-hospitality").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/accept-fb-hospitality.png", fullPage: false });
});

test("acceptance — payroll (VII)", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-payroll").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/accept-payroll.png", fullPage: false });
});

test("acceptance — capital projects (IX) with new pillar chip + editorial serif", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-capital-projects").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/accept-capital-projects.png", fullPage: false });
});

test("acceptance — ar collections (X) with new pillar chip + editorial serif", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-ar-collections").click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/accept-ar-collections.png", fullPage: false });
});
