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
  { w: 1366, h: 768 },
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
] as const) {
  test(`@ ${vp.w}x${vp.h} — at-a-glance horizontal border vs vertical divider x`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);

    const aag = await page.getByTestId("monthly-cover-at-a-glance")
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, width: r.width };
      });
    const briefing = await page.getByTestId("monthly-cover-briefing")
      .evaluate((el) => el.getBoundingClientRect());

    // eslint-disable-next-line no-console
    console.log(
      `[hbar ${vp.w}x${vp.h}]\n` +
      `  at-a-glance.right (horizontal border end) = ${aag.right.toFixed(1)}\n` +
      `  vertical divider x (briefing.left)         = ${briefing.left.toFixed(1)}\n` +
      `  Δ = ${(aag.right - briefing.left).toFixed(1)}px (positive = horizontal overshoots divider)`,
    );

    await page.screenshot({
      path: `test-results/hbar-${vp.w}x${vp.h}.png`,
      fullPage: false,
    });
  });
}
