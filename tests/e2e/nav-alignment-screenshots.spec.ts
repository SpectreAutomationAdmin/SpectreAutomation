import { test, type Page } from "@playwright/test";

// One-shot screenshot capture for the left chapter navigation
// alignment task. Captures the rail crop at 1440x900 (before / after
// labelled via NAV_ALIGN_PHASE env var).

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const PHASE = process.env.NAV_ALIGN_PHASE ?? "before";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test(`@ 1440x900 — left nav rail (${PHASE})`, async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);

  // Full cover screenshot — shows the left rail in context.
  await page.screenshot({
    path: `test-results/nav-align-${PHASE}-1440x900.png`,
    fullPage: false,
  });

  // Cropped screenshot of just the rail at zoom — left 260px × visible
  // viewport. Uses a fixed clip rather than aside.screenshot() because
  // the sticky aside has a multi-thousand-pixel bounding box that
  // produces an unusable tall capture.
  await page.screenshot({
    path: `test-results/nav-align-${PHASE}-rail-crop.png`,
    clip: { x: 0, y: 0, width: 260, height: 900 },
  });
});
