import { test, type Page } from "@playwright/test";

// Typography accessibility pass — captures the first screen at the
// reference viewport (1440×900) so the founder can compare typography
// scale before vs after the readability bump.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const PHASE = process.env.READABILITY_PHASE ?? "before";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test(`@ 1440x900 — cover (${PHASE})`, async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);
  await page.screenshot({
    path: `test-results/readability-${PHASE}-1440x900.png`,
    fullPage: false,
  });

  // Cropped left rail for nav typography comparison.
  await page.screenshot({
    path: `test-results/readability-${PHASE}-rail-1440x900.png`,
    clip: { x: 0, y: 0, width: 260, height: 900 },
  });
});
