import { test, type Page } from "@playwright/test";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

for (const vp of [
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
  { w: 1024, h: 768 },   // tablet
] as const) {
  test(`@ ${vp.w}x${vp.h} — three-header + three-underline baseline`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);

    // Three header tops.
    const railTop = await page.getByTestId("reporting-shell-chapters").locator("div").first()
      .evaluate((el) => el.getBoundingClientRect().top);
    const mbrpTop = await page.getByTestId("monthly-cover-package-label")
      .evaluate((el) => el.getBoundingClientRect().top);
    const ebTop = await page.locator(":text('Executive briefing')").first()
      .evaluate((el) => el.getBoundingClientRect().top);

    // Three underline bottoms (the rail "In this package" div's bottom
    // edge IS its underline because border-bottom sits there; same is
    // now true for the masthead row).
    const railBottom = await page.getByTestId("reporting-shell-chapters").locator("div").first()
      .evaluate((el) => el.getBoundingClientRect().bottom);
    // Masthead row is the grid wrapper around the two label cells; it
    // carries the border-b.
    const mastheadRow = await page.getByTestId("monthly-cover-package-label")
      .evaluate((el) => el.parentElement!.getBoundingClientRect().bottom);

    // eslint-disable-next-line no-console
    console.log(
      `[baseline ${vp.w}x${vp.h}] tops: rail=${railTop.toFixed(2)} mbrp=${mbrpTop.toFixed(2)} eb=${ebTop.toFixed(2)} | bottoms: rail=${railBottom.toFixed(2)} mast=${mastheadRow.toFixed(2)}`,
    );

    await page.screenshot({
      path: `test-results/three-header-${vp.w}x${vp.h}.png`,
      fullPage: false,
    });
  });
}
