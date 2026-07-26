import { test, expect, type Page } from "@playwright/test";

// First-screen authority test for the Monthly Reporting cover.
//
// A premium board package's cover must claim the entire first
// viewport — chapter II (Board Financial Briefing) should not be
// visible until the reader scrolls. This test asserts that bar on
// the standard board-room laptop viewport (1440 x 900).

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("cover claims the full first viewport (chapter II is below the fold)", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  // Scroll to top to guarantee first-paint behavior.
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(150);

  const viewport = page.viewportSize();
  if (!viewport) throw new Error("viewport size unavailable");

  // The Chair's Dashboard section (chapter II — the first section
  // below the cover after the Chair's Dashboard insertion) must NOT
  // be inside the viewport on first paint. We probe its bounding-box
  // top.
  const dashboardSectionTop = await page
    .locator('section[id="financial-performance"]')
    .evaluate((el) => el.getBoundingClientRect().top);

  // Chapter II's top edge must be at or below the viewport bottom.
  expect(
    dashboardSectionTop,
    `Chapter II should start below the viewport bottom (${viewport.height}px). Currently starts at ${dashboardSectionTop}px.`,
  ).toBeGreaterThanOrEqual(viewport.height);

  // Also assert the cover's bottom edge is at or below the viewport
  // bottom — the cover claims the whole visible area.
  const coverBottom = await page
    .getByTestId("monthly-cover")
    .evaluate((el) => el.getBoundingClientRect().bottom);
  expect(
    coverBottom,
    "Cover bottom should be at or below the viewport bottom",
  ).toBeGreaterThanOrEqual(viewport.height - 20);

  // Capture the first-screen view for visual review.
  await page.screenshot({
    path: "test-results/cover-first-screen.png",
    fullPage: false,
  });
});
