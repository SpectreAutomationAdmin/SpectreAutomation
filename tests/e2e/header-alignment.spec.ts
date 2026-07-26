import { test, type Page } from "@playwright/test";

// Header alignment audit — measures y-positions of the rail
// "In this package" header and the cover "Monthly Board Reporting
// Package" header at 1440×900. Captures a labelled screenshot.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const PHASE = process.env.HEADER_ALIGN_PHASE ?? "before";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test(`@ 1440x900 — header alignment (${PHASE})`, async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);

  // y-position of the rail "In this package" header (first text node in the aside).
  const railHeader = await page
    .getByTestId("reporting-shell-chapters")
    .locator("div")
    .first()
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });

  // y-position of the cover "Monthly Board Reporting Package" label.
  const coverHeader = await page
    .getByTestId("monthly-cover-package-label")
    .evaluate((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });

  const delta = coverHeader.top - railHeader.top;
  // eslint-disable-next-line no-console
  console.log(`[${PHASE}] rail header top = ${railHeader.top.toFixed(2)}px, cover header top = ${coverHeader.top.toFixed(2)}px, delta = ${delta.toFixed(2)}px`);

  await page.screenshot({
    path: `test-results/header-align-${PHASE}-1440x900.png`,
    fullPage: false,
  });

  // Cropped strip showing both headers side by side.
  await page.screenshot({
    path: `test-results/header-align-${PHASE}-crop.png`,
    clip: { x: 0, y: 0, width: 700, height: 120 },
  });
});
