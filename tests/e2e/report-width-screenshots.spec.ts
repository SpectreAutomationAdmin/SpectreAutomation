import { test, type Page } from "@playwright/test";

// Report-width expansion screenshots — captures Monthly Reporting at
// the reference viewports so the founder can see the before/after.
// Parameterized by REPORT_WIDTH_PHASE = "before" | "after".

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const PHASE = process.env.REPORT_WIDTH_PHASE ?? "before";

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
  test(`@ ${vp.w}x${vp.h} — cover (${PHASE})`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: vp.w, height: vp.h });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(400);
    await page.screenshot({
      path: `test-results/report-width-${PHASE}-${vp.w}x${vp.h}.png`,
      fullPage: false,
    });
  });
}
