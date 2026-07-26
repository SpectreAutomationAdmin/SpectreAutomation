import { test, type Page } from "@playwright/test";

// Next-chapter tease — captures the first screen at 1440×900 to
// verify the next chapter (Chair's Dashboard) peeks above the fold.
// Parameterized by NEXT_CHAPTER_PHASE = "before" | "after".

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const PHASE = process.env.NEXT_CHAPTER_PHASE ?? "before";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test(`@ 1440x900 — first viewport (${PHASE})`, async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);

  await page.screenshot({
    path: `test-results/next-chapter-${PHASE}-1440x900.png`,
    fullPage: false,
  });

  // Measure: where does Chair's Dashboard sit relative to the fold?
  const dashboardTop = await page
    .getByTestId("financial-performance")
    .evaluate((el) => el.getBoundingClientRect().top);
  test.info().annotations.push({
    type: "financial-performance-top",
    description: `${PHASE} — financial-performance top: ${dashboardTop.toFixed(2)}px (viewport: 900px)`,
  });
  // eslint-disable-next-line no-console
  console.log(`[${PHASE}] financial-performance top = ${dashboardTop.toFixed(2)}px (viewport 900px)`);
});
