import { test, type Page } from "@playwright/test";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const PHASE = process.env.RAIL_EDGE_PHASE ?? "before";

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
]) {
  test(`@ ${vp.w}x${vp.h} — rail edge margin (${PHASE})`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);

    const railLeft = await page
      .getByTestId("reporting-shell-chapters")
      .evaluate((el) => el.getBoundingClientRect().left);
    // eslint-disable-next-line no-console
    console.log(`[${PHASE}] ${vp.w}x${vp.h} rail left=${railLeft.toFixed(2)}px`);

    await page.screenshot({
      path: `test-results/rail-edge-${PHASE}-${vp.w}x${vp.h}.png`,
      fullPage: false,
    });
  });
}
