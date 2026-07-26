import { test, type Page } from "@playwright/test";

// Shell-redesign visual diff spec.
//
// Captures the page chrome — the running header, chapter rail, body
// container — so a before/after comparison shows what the redesign
// actually moved. Each shot is named test-results/shell-{slot}.png;
// rename to shell-before-* before redesign and re-run for shell-after-*.
//
// The captures focus on the shell, not the report content:
//   01 · top: cover + full header band
//   02 · mid: header behavior while scrolled into chapter IV (sticky)
//   03 · rail: chapter rail close-up (left 240px)
//   04 · controls: top-right corner with period chip + close + print

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

test.describe("Shell redesign — visual diff", () => {
  test("01 · top: cover with full shell visible", async ({ page }) => {
    await setup(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    await page.screenshot({ path: "test-results/shell-01-cover-top.png", fullPage: false });
  });

  test("02 · mid: sticky header behavior into chapter IV", async ({ page }) => {
    await setup(page);
    await page.getByTestId("reporting-chapter-stewardship").click();
    await page.waitForTimeout(400);
    await page.screenshot({ path: "test-results/shell-02-mid-document.png", fullPage: false });
  });

  test("03 · rail: chapter rail close-up", async ({ page }) => {
    await setup(page);
    await page.getByTestId("reporting-chapter-board-briefing").click();
    await page.waitForTimeout(400);
    // Focus on left 320px so the chapter rail dominates the frame.
    await page.screenshot({
      path: "test-results/shell-03-chapter-rail.png",
      fullPage: false,
      clip: { x: 0, y: 0, width: 360, height: 900 },
    });
  });

  test("04 · controls: top-right close + period chip + print toggle", async ({ page }) => {
    await setup(page);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);
    // Top-right 720x140 — captures the running header's right-half +
    // any fixed top-right pill.
    await page.screenshot({
      path: "test-results/shell-04-controls.png",
      fullPage: false,
      clip: { x: 720, y: 0, width: 720, height: 140 },
    });
  });
});
