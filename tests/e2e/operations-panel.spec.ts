import { test, expect, type Page } from "@playwright/test";

// Operations panel — Pillar 1 deep-dive (chapter III). Large-KPI
// presentation of the four numbers that define operating performance:
// Revenue, NOI before depreciation, Payroll Ratio, Dues-to-Revenue.

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
  test(`Operations panel renders the four KPI tiles in a single row @ ${vp.name}`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("reporting-chapter-operations-panel").click();
    await page.waitForTimeout(400);

    // All four KPI tiles visible.
    for (const key of ["revenue", "noi", "payroll-ratio", "dues-to-revenue"]) {
      await expect(page.getByTestId(`operations-panel-tile-${key}`)).toBeVisible();
    }

    await page.screenshot({
      path: `test-results/operations-panel-${vp.name}.png`,
      fullPage: false,
    });
  });
}

test("Operations panel KPI tile anatomy — large hero number + comparator + variance verdict", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  for (const { key, label } of [
    { key: "revenue",         label: /Revenue/i },
    { key: "noi",             label: /NOI before depreciation/i },
    { key: "payroll-ratio",   label: /Payroll ratio/i },
    { key: "dues-to-revenue", label: /Dues-to-Revenue/i },
  ]) {
    const tile = page.getByTestId(`operations-panel-tile-${key}`);
    await expect(tile.getByTestId(`operations-panel-tile-${key}-label`)).toContainText(label);
    await expect(tile.getByTestId(`operations-panel-tile-${key}-value`)).toBeVisible();
    await expect(tile.getByTestId(`operations-panel-tile-${key}-comparator`)).toBeVisible();
    await expect(tile.getByTestId(`operations-panel-tile-${key}-variance`)).toBeVisible();
  }
});

test("Operations panel hero number uses text-6xl typography (larger than at-a-glance L1c)", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  // Operations panel hero number is text-6xl serif at sm+ viewports.
  // text-6xl in Tailwind = 60 px font-size by default.
  const revenueFontPx = await page
    .locator('[data-testid="operations-panel-tile-revenue-value"]')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(
    revenueFontPx,
    `Operations panel hero number (${revenueFontPx}px) must use text-6xl (60px) at 1440x900`,
  ).toBeGreaterThanOrEqual(58);
});

test("Operations panel renders no tables and no commentary block", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  await page.getByTestId("reporting-chapter-operations-panel").click();
  await page.waitForTimeout(400);

  const panel = page.getByTestId("operations-panel");
  // Discipline: no tables anywhere in the panel.
  expect(await panel.locator("table").count()).toBe(0);
  // Discipline: no Executive Commentary block on this chapter.
  expect(await panel.locator('[data-testid$="-commentary"]').count()).toBe(0);
});
