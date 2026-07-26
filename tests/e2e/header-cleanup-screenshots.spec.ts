import { test, type Page } from "@playwright/test";

// One-shot screenshot capture for the first-screen header-row
// compression task. Captures the cover at 1440x900 and 1280x800 to
// document the layout before and after the change. The phase is
// controlled by HEADER_CLEANUP_PHASE = "before" | "after".

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const PHASE = process.env.HEADER_CLEANUP_PHASE ?? "before";

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
  test(`@ ${vp.w}x${vp.h} — capture ${PHASE}`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    await page.screenshot({
      path: `test-results/header-cleanup-${PHASE}-${vp.w}x${vp.h}.png`,
      fullPage: false,
    });
  });
}
