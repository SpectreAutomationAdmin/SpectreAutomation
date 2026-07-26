import { test, type Page } from "@playwright/test";

// EXECUTIVE BRIEFING header horizontal alignment audit — captures
// + measures the x-positions of the masthead label and the OPERATIONS
// briefing card at 1440×900.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const PHASE = process.env.EB_HEADER_PHASE ?? "before";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test(`@ 1440x900 — EB header alignment (${PHASE})`, async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);

  // x-position of the "Executive briefing" header. Locator: the masthead
  // contains a span/div whose text starts with "Executive briefing".
  const ebRect = await page
    .locator(":text('Executive briefing')")
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });

  // x-position of the OPERATIONS briefing card.
  const opsRect = await page
    .getByTestId("cover-briefing-operations")
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    });

  const deltaX = ebRect.left - opsRect.left;
  // eslint-disable-next-line no-console
  console.log(`[${PHASE}] EB header left=${ebRect.left.toFixed(2)}, OPS card left=${opsRect.left.toFixed(2)}, deltaX=${deltaX.toFixed(2)}, EB top=${ebRect.top.toFixed(2)}, OPS card top=${opsRect.top.toFixed(2)}`);

  await page.screenshot({
    path: `test-results/eb-header-${PHASE}-1440x900.png`,
    fullPage: false,
  });
});
