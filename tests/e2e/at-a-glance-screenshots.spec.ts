import { test, type Page } from "@playwright/test";

// At-a-Glance cover block — screenshot capture at both viewports
// to verify the block fills the dead space below the framework
// colophon without pushing other content below the fold.

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
  { w: 1280, h: 800 },
]) {
  test(`@ ${vp.w}x${vp.h} — cover with At-a-Glance`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    await page.screenshot({
      path: `test-results/at-a-glance-${vp.w}x${vp.h}.png`,
      fullPage: false,
    });
  });
}
