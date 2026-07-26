// Evidence-capture spec — produces tight crops of the Weather
// rounds card, the FP Operating Results card, AND the Payroll
// Analysis chart at 1440 × 900 and 1920 × 1080, so the
// Weather-vs-FP-vs-Payroll visual parity can be reviewed
// (per §9 — approval is based on visual parity, not metrics).
//
// Not part of the standard regression suite — run on demand:
//   npx playwright test tests/e2e/plot-utilization-evidence.spec.ts
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
  { label: "1440x900", width: 1440, height: 900 },
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "2560x1440", width: 2560, height: 1440 },
]) {
  test(`evidence: Weather rounds card + FP Operating reference @ ${vp.label}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await login(page);
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");

    // Capture the FP Operating Results card (canonical single-series
    // reference for §9 visual parity).
    const fp = page.getByTestId("stewardship-operating");
    await fp.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await fp.screenshot({
      path: `test-results/evidence-fp-operating-${vp.label}.png`,
    });

    // Capture the Payroll Analysis · Department Breakdown card
    // (canonical grouped-bar reference for §9 visual parity).
    const payroll = page.getByTestId("payroll-department");
    await payroll.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await payroll.screenshot({
      path: `test-results/evidence-payroll-department-${vp.label}.png`,
    });

    // Then capture the Weather rounds bar card (the chart we just
    // refit to match the FP standard).
    await page
      .getByTestId("reporting-chapter-weather-and-utilization")
      .click();
    await page.getByTestId("mws-rounds-card").waitFor({ timeout: 20_000 });
    await page.getByTestId("mws-rounds-card").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.getByTestId("mws-rounds-card").screenshot({
      path: `test-results/evidence-rounds-${vp.label}.png`,
    });
  });
}
