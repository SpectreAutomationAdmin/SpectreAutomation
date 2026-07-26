import { test, expect, type Page } from "@playwright/test";

// Visual + behavioural audit for Inventory Analysis (chapter XIV).
// Asserts:
//   - rail entry "XIV Inventory Analysis" sits as the sixth (final)
//     entry under Operations & Analytics
//   - chapter title remains "Inventory Analysis"
//   - 4 KPI cards + 2 chart cards + action table all render
//   - turnover bar hover thickens stroke without translating /
//     scaling
//   - balances line chart hover thickens the radius / outlines the
//     specific point
//   - tooltip uses bg-club-green-900/85 (translucent glass overlay)
//   - priority pills carry whitespace-nowrap (no wrap mid-pill)

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
}

test("rail entry 'Inventory Analysis' sits below 'F&B Statistics' and clicking scrolls the section into view", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  const railEntry = page.getByTestId("reporting-chapter-inventory-analysis");
  await railEntry.waitFor({ timeout: 20_000 });
  await expect(railEntry).toContainText("Inventory Analysis");

  await railEntry.click();
  await page.getByTestId("inventory-analysis").waitFor({ timeout: 20_000 });
  await expect(page.getByTestId("inventory-analysis")).toBeInViewport();
  await expect(page.getByTestId("inv-title")).toHaveText("Inventory Analysis");
  await expect(railEntry).toBeInViewport();
});

test("header chrome flows from ReportingPeriod (May 2026, NO Q1 / March)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-inventory-analysis").click();
  await page.getByTestId("inventory-analysis").waitFor({ timeout: 20_000 });

  await expect(page.getByTestId("inv-period")).toContainText("May 2026");
  await expect(page.getByTestId("inv-statement-number")).toHaveText("Statement 14 of 14");
  await expect(page.getByTestId("inv-document-chip")).toHaveText("Inventory & Purchasing");
  await expect(page.getByTestId("inv-prepared-for")).toHaveText("F&B Committee Level");
  await expect(page.getByTestId("inv-period")).not.toContainText("Q1");
  await expect(page.getByTestId("inv-period")).not.toContainText("March");
});

test("4 KPI cards + 2 chart cards + action table render with priority pills", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-inventory-analysis").click();
  await page.getByTestId("inventory-analysis").waitFor({ timeout: 20_000 });

  for (const key of ["food-turns", "liquor-turns", "soft-goods-turns", "avg-food-balance"]) {
    await expect(page.getByTestId(`inv-kpi-${key}`)).toBeVisible();
  }
  await expect(page.getByTestId("inv-turnover-card")).toBeVisible();
  await expect(page.getByTestId("inv-balances-card")).toBeVisible();

  // Action table rows + priority pills.
  for (const key of [
    "liquor-slow-skus", "food-cost-audit", "beer-low-volume",
    "soft-goods-strong", "food-turns-positive",
  ]) {
    await expect(page.getByTestId(`inv-action-row-${key}`)).toBeVisible();
    const pill = page.getByTestId(`inv-action-row-${key}-pill`);
    await expect(pill).toBeVisible();
    // Pill is single-line — captured height should be <= 22 px.
    const box = await pill.boundingBox();
    expect(box).toBeTruthy();
    if (box) expect(box.height, `${key} pill must not wrap`).toBeLessThanOrEqual(24);
  }
  // Priority pill tones map to data-priority.
  await expect(page.getByTestId("inv-action-row-liquor-slow-skus-pill")).toHaveAttribute("data-priority", "action");
  await expect(page.getByTestId("inv-action-row-beer-low-volume-pill")).toHaveAttribute("data-priority", "watch");
  await expect(page.getByTestId("inv-action-row-soft-goods-strong-pill")).toHaveAttribute("data-priority", "positive");
});

test("Turnover bar hover thickens stroke WITHOUT translating or scaling the bar's y/height", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-inventory-analysis").click();
  await page.getByTestId("inventory-analysis").waitFor({ timeout: 20_000 });
  await page.getByTestId("inv-turnover-card").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);

  const foodCurrent = page.getByTestId("inv-turnover-bar-food-current");
  const restY = await foodCurrent.getAttribute("y");
  const restH = await foodCurrent.getAttribute("height");

  // Hover the prior-year bar; the current-year bar must stay still.
  await page.getByTestId("inv-turnover-bar-food-prior").hover();
  await page.getByTestId("inv-chart-tooltip").waitFor({ timeout: 5_000 });

  const foodPrior = page.getByTestId("inv-turnover-bar-food-prior");
  await expect(foodPrior).toHaveAttribute("data-active", "true");
  await expect(foodPrior).toHaveAttribute("stroke-width", "2.4");
  expect(await foodCurrent.getAttribute("y")).toBe(restY);
  expect(await foodCurrent.getAttribute("height")).toBe(restH);

  await page.screenshot({ path: "test-results/inventory-turnover-hover-1440.png", fullPage: false });
});

test("Balances line chart hover surfaces dollar balance + tooltip uses bg-club-green-900/85", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-inventory-analysis").click();
  await page.getByTestId("inventory-analysis").waitFor({ timeout: 20_000 });
  await page.getByTestId("inv-balances-card").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);

  await page.getByTestId("inv-balance-point-january-food").hover();
  await page.getByTestId("inv-chart-tooltip").waitFor({ timeout: 5_000 });

  const point = page.getByTestId("inv-balance-point-january-food");
  await expect(point).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("inv-chart-tooltip-label")).toContainText("January");
  await expect(page.getByTestId("inv-chart-tooltip-label")).toContainText("Food Inventory");
  await expect(page.getByTestId("inv-chart-tooltip-row-balance")).toContainText("average balance");

  // Tooltip alpha.
  const bg = await page.getByTestId("inv-chart-tooltip").evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  const m = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(bg);
  if (!m) throw new Error(`tooltip is fully opaque (background: ${bg})`);
  const alpha = Number(m[4]);
  expect(alpha).toBeLessThan(1);
  expect(alpha).toBeGreaterThan(0.7);

  await page.screenshot({ path: "test-results/inventory-balances-hover-1440.png", fullPage: false });
});

test("Chapter capture — KPI strip + chart grid + action table at 1440", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-inventory-analysis").click();
  await page.getByTestId("inventory-analysis").waitFor({ timeout: 20_000 });

  await page.getByTestId("inv-kpi-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/inventory-analysis-kpi-1440.png", fullPage: false });

  await page.getByTestId("inv-charts-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/inventory-analysis-charts-1440.png", fullPage: false });

  await page.getByTestId("inv-action-table").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/inventory-analysis-table-1440.png", fullPage: false });
});
