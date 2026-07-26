import { test, type Page } from "@playwright/test";

// Positive status green audit — captures the cover at 1440×900 and
// logs the computed colour of the three briefing card status verdicts.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const PHASE = process.env.POSITIVE_STATUS_PHASE ?? "before";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test(`@ 1440x900 — positive status green (${PHASE})`, async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(400);

  const samples: Record<string, { text: string; color: string }> = {};
  for (const k of ["operations", "financial-health", "capital-program"]) {
    const el = page.getByTestId(`cover-briefing-${k}-status`);
    const text = (await el.textContent())?.trim() ?? "";
    const color = await el.evaluate((node) => getComputedStyle(node).color);
    samples[k] = { text, color };
  }
  // eslint-disable-next-line no-console
  console.log(`[${PHASE}] positive statuses:`, JSON.stringify(samples));

  await page.screenshot({
    path: `test-results/positive-status-${PHASE}-1440x900.png`,
    fullPage: false,
  });
});
