import { test, expect, type Page } from "@playwright/test";

// Financial Health panel — Pillar 3 deep-dive (chapter IV). Large
// KPI presentation of Working Capital, Current Ratio, Reserve
// Coverage, AR Current %. Each tile carries a tone-coloured status
// badge under the hero number — the visual status indicator.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

const VIEWPORTS = [
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "1280x800",  width: 1280, height: 800 },
] as const;

for (const vp of VIEWPORTS) {
  test(`Financial Health panel renders the four KPI tiles @ ${vp.name}`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("reporting-chapter-financial-health-panel").click();
    await page.waitForTimeout(400);

    for (const key of ["working-capital", "current-ratio", "reserve-coverage", "ar-current"]) {
      await expect(page.getByTestId(`financial-health-panel-tile-${key}`)).toBeVisible();
    }

    await page.screenshot({
      path: `test-results/financial-health-panel-${vp.name}.png`,
      fullPage: false,
    });
  });
}

test("Financial Health panel tile anatomy — hero + status badge + comparator + variance", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  for (const { key, label, expectedStatus } of [
    { key: "working-capital",  label: /Working Capital/i,  expectedStatus: /^(Strong Position|Stable|Watch|Concern)$/ },
    { key: "current-ratio",    label: /Current Ratio/i,    expectedStatus: /^(Strong Position|Stable|Healthy|Watch|Concern)$/ },
    { key: "reserve-coverage", label: /Reserve Coverage/i, expectedStatus: /^(Strong Position|Stable|Watch|Concern)$/ },
    { key: "ar-current",       label: /AR Current/i,       expectedStatus: /^(Strong Position|Stable|Watch|Concern)$/ },
  ]) {
    const tile = page.getByTestId(`financial-health-panel-tile-${key}`);
    await expect(tile.getByTestId(`financial-health-panel-tile-${key}-label`)).toContainText(label);
    await expect(tile.getByTestId(`financial-health-panel-tile-${key}-value`)).toBeVisible();
    const statusText = await tile.getByTestId(`financial-health-panel-tile-${key}-status`).textContent();
    expect(statusText?.trim()).toMatch(expectedStatus);
    await expect(tile.getByTestId(`financial-health-panel-tile-${key}-comparator`)).toBeVisible();
    await expect(tile.getByTestId(`financial-health-panel-tile-${key}-variance`)).toBeVisible();
  }
});

test("Financial Health panel hero number uses text-6xl (boardroom-scale)", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  const wcFontPx = await page
    .locator('[data-testid="financial-health-panel-tile-working-capital-value"]')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(
    wcFontPx,
    `Financial Health hero number (${wcFontPx}px) must use text-6xl (60px) at 1440x900`,
  ).toBeGreaterThanOrEqual(58);
});

test("Financial Health panel — AR Current is amber (the visual status indicator distinguishes it from the three green KPIs)", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  // The demo data ships AR Current at 78.4% — below the 80% target,
  // so the status badge must read "Watch" and the tile carries
  // data-tone="amber".
  const arTile = page.getByTestId("financial-health-panel-tile-ar-current");
  await expect(arTile).toHaveAttribute("data-tone", "amber");
  const status = await arTile.getByTestId("financial-health-panel-tile-ar-current-status").textContent();
  expect(status?.trim()).toBe("Watch");

  // The three green tiles must each carry data-tone="green".
  for (const key of ["working-capital", "current-ratio", "reserve-coverage"]) {
    await expect(page.getByTestId(`financial-health-panel-tile-${key}`)).toHaveAttribute("data-tone", "green");
  }
});

test("Financial Health panel renders no tables and no commentary", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  await page.getByTestId("reporting-chapter-financial-health-panel").click();
  await page.waitForTimeout(400);

  const panel = page.getByTestId("financial-health-panel");
  expect(await panel.locator("table").count()).toBe(0);
  expect(await panel.locator('[data-testid$="-commentary"]').count()).toBe(0);
});
