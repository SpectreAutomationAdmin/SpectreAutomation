import { test, type Page } from "@playwright/test";

// Briefing card title color audit — captures the cover at 1440×900 to
// verify the OPERATIONS / FINANCIAL HEALTH / CAPITAL PROGRAM titles
// are visibly darker after the change.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const PHASE = process.env.CARD_TITLE_PHASE ?? "before";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test(`@ 1440x900 — card title color (${PHASE})`, async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);

  // Capture computed color for each card title.
  const samples: Record<string, string> = {};
  for (const k of ["operations", "financial-health", "capital-program"]) {
    const c = await page.getByTestId(`cover-briefing-${k}-title`)
      .evaluate((el) => getComputedStyle(el).color);
    samples[k] = c;
  }
  // eslint-disable-next-line no-console
  console.log(`[${PHASE}] card title colors:`, JSON.stringify(samples));

  await page.screenshot({
    path: `test-results/card-title-${PHASE}-1440x900.png`,
    fullPage: false,
  });
});
