import { test, type Page } from "@playwright/test";

// Aldus leaf divider audit — captures the cover at 1440×900 with a
// crop centred on the identity column so the founder can see the
// divider's proportions before/after.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const PHASE = process.env.ALDUS_PHASE ?? "before";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test(`@ 1440x900 — Aldus divider (${PHASE})`, async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);

  await page.screenshot({
    path: `test-results/aldus-${PHASE}-1440x900.png`,
    fullPage: false,
  });

  // Cropped identity column showing the divider region (left 720 × full).
  await page.screenshot({
    path: `test-results/aldus-${PHASE}-crop.png`,
    clip: { x: 240, y: 300, width: 520, height: 260 },
  });
});
