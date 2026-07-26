import { test, type Page } from "@playwright/test";

// Visual QA pass — capture screenshots of the Monthly Reporting
// Package at the six key surfaces a Finance Committee reads. The
// dev server must be running on http://localhost:3000.
//
// Each screenshot is sized at 1440x900 (modern board-room laptop
// viewport) and named test-results/qa-{section}.png so the
// reviewer can compare against the Executive Reporting Design
// Standard in .claude/skills/executive-reporting-design/SKILL.md.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

async function setup(page: Page) {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
}

test.describe("Monthly Reporting Package — visual QA", () => {
  test("01 · full page top (cover)", async ({ page }) => {
    await setup(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await page.screenshot({ path: "test-results/qa-01-cover-top.png", fullPage: false });
  });

  test("02 · board briefing (chapter II)", async ({ page }) => {
    await setup(page);
    await page.getByTestId("reporting-chapter-board-briefing").click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/qa-02-board-briefing.png", fullPage: false });
  });

  test("03 · at-a-glance KPIs (chapter III)", async ({ page }) => {
    await setup(page);
    await page.getByTestId("reporting-chapter-at-a-glance").click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/qa-03-at-a-glance.png", fullPage: false });
  });

  test("04 · stewardship dashboard (chapter IV)", async ({ page }) => {
    await setup(page);
    await page.getByTestId("reporting-chapter-stewardship").click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/qa-04-stewardship.png", fullPage: false });
  });

  test("05 · financial statements (chapter V)", async ({ page }) => {
    await setup(page);
    await page.getByTestId("reporting-chapter-financial-statements").click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/qa-05-financial-statements.png", fullPage: false });
  });

  test("06 · operations & analytics (chapter VI)", async ({ page }) => {
    await setup(page);
    await page.getByTestId("reporting-chapter-operations").click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/qa-06-operations.png", fullPage: false });
  });
});
