import { test, expect, type Page } from "@playwright/test";

// Visual + behavioural audit for Food & Beverage Statistics
// (chapter XIII). Asserts:
//   - rail entry reads "F&B Statistics" but the chapter title
//     remains "Food & Beverage Statistics"
//   - rail order: ...Payroll Analysis → F&B Statistics → Operations
//     & Analytics → ...
//   - 4 KPI cards + 4 chart cards render
//   - bar hover thickens the stroke without translating / scaling
//   - donut hover thickens its stroke + drop-shadow filter
//   - tooltip uses bg-club-green-900/85 (translucent glass overlay)
//   - cost-trend line chart hover surfaces the cost % + variance

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
}

test("rail label is 'F&B Statistics' but the chapter title remains 'Food & Beverage Statistics'", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  const railEntry = page.getByTestId("reporting-chapter-f-and-b-statistics");
  await railEntry.waitFor({ timeout: 20_000 });
  await expect(railEntry).toContainText("F&B Statistics");
  await expect(railEntry).not.toContainText("Food & Beverage Statistics");

  await railEntry.click();
  await page.getByTestId("f-and-b-statistics").waitFor({ timeout: 20_000 });
  await expect(page.getByTestId("f-and-b-statistics")).toBeInViewport();
  await expect(page.getByTestId("fbs-title")).toHaveText("Food & Beverage Statistics");
  await expect(railEntry).toBeInViewport();
});

test("header chrome flows from ReportingPeriod (May 2026, NO Q1 / March)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-f-and-b-statistics").click();
  await page.getByTestId("f-and-b-statistics").waitFor({ timeout: 20_000 });

  await expect(page.getByTestId("fbs-period")).toContainText("May 2026");
  await expect(page.getByTestId("fbs-statement-number")).toHaveText("Statement 13 of 14");
  await expect(page.getByTestId("fbs-document-chip")).toHaveText("F&B Performance");
  await expect(page.getByTestId("fbs-prepared-for")).toHaveText("F&B Committee Level");
  await expect(page.getByTestId("fbs-period")).not.toContainText("Q1");
  await expect(page.getByTestId("fbs-period")).not.toContainText("March");
});

test("Secondary KPI row renders below the primary row and column-aligns (Avg Check sits beneath Total Covers)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-f-and-b-statistics").click();
  await page.getByTestId("f-and-b-statistics").waitFor({ timeout: 20_000 });

  // Both KPI grids render.
  await expect(page.getByTestId("fbs-kpi-grid")).toBeVisible();
  await expect(page.getByTestId("fbs-kpi-grid-secondary")).toBeVisible();

  // All 4 new KPI cards.
  for (const key of ["revenue-per-server", "member-satisfaction", "average-check", "monthly-gratuities"]) {
    await expect(page.getByTestId(`fbs-kpi-${key}`)).toBeVisible();
  }

  // Scroll the primary KPI grid into view so both rows are present
  // in the viewport before measurement.
  await page.getByTestId("fbs-kpi-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);

  // Column alignment — at lg viewport (1440 px), each row is a 4-col
  // grid. The bottom of row 1 sits ABOVE the top of row 2, and each
  // bottom card's horizontal centre line is within 2 px of the top
  // card directly above it. Scope to the chapter section so the
  // testid lookup never accidentally matches a duplicate elsewhere
  // (e.g. in a mobile drawer copy of the rail).
  type Box = { x: number; y: number; w: number; h: number };
  async function boxOf(testId: string): Promise<Box> {
    const b = await page
      .locator(`[data-testid='f-and-b-statistics'] [data-testid='${testId}']`)
      .first()
      .boundingBox();
    if (!b) throw new Error(`no bbox for ${testId}`);
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }
  const pairs: Array<[string, string]> = [
    ["total-revenue", "revenue-per-server"],
    ["cost-pct",      "member-satisfaction"],
    ["total-covers",  "average-check"],
    ["gross-margin",  "monthly-gratuities"],
  ];
  for (const [topKey, bottomKey] of pairs) {
    const top = await boxOf(`fbs-kpi-${topKey}`);
    const bottom = await boxOf(`fbs-kpi-${bottomKey}`);
    // Bottom card sits below the top one.
    expect(bottom.y, `${bottomKey} must sit below ${topKey}`).toBeGreaterThan(top.y + top.h - 1);
    // Horizontal centres column-align (within 2 px).
    const topCx = top.x + top.w / 2;
    const bottomCx = bottom.x + bottom.w / 2;
    expect(
      Math.abs(bottomCx - topCx),
      `${bottomKey} centre must column-align with ${topKey} centre (top ${topCx}, bottom ${bottomCx})`,
    ).toBeLessThanOrEqual(2);
  }

  // Capture for the founder review.
  await page.getByTestId("fbs-kpi-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/fb-statistics-secondary-kpi-1440.png", fullPage: false });
});

test("4 KPI cards + 4 chart cards render with the featured primary KPI", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-f-and-b-statistics").click();
  await page.getByTestId("f-and-b-statistics").waitFor({ timeout: 20_000 });

  for (const key of ["total-revenue", "cost-pct", "total-covers", "gross-margin"]) {
    await expect(page.getByTestId(`fbs-kpi-${key}`)).toBeVisible();
  }
  for (const card of ["fb-monthly-card", "fb-category-card", "fb-covers-card", "fb-food-cost-card"]) {
    await expect(page.getByTestId(card)).toBeVisible();
  }
  // Primary featured card has the dark-green background.
  const primary = page.getByTestId("fbs-kpi-total-revenue");
  const bg = await primary.evaluate((el) => getComputedStyle(el).backgroundColor);
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
  expect(m).toBeTruthy();
  if (m) expect(Number(m[1]), `primary card bg must be dark (got ${bg})`).toBeLessThan(90);
});

test("Monthly Revenue bar hover thickens the stroke WITHOUT translating / scaling its y or height", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-f-and-b-statistics").click();
  await page.getByTestId("f-and-b-statistics").waitFor({ timeout: 20_000 });
  await page.getByTestId("fb-monthly-card").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);

  // Capture March cost bar's y + height at rest.
  const marchCost = page.getByTestId("fb-monthly-bar-march-cost");
  const restY = await marchCost.getAttribute("y");
  const restH = await marchCost.getAttribute("height");

  // Hover March revenue bar.
  await page.getByTestId("fb-monthly-bar-march-revenue").hover();
  await page.getByTestId("fb-chart-tooltip").waitFor({ timeout: 5_000 });

  const marchRev = page.getByTestId("fb-monthly-bar-march-revenue");
  await expect(marchRev).toHaveAttribute("data-active", "true");
  await expect(marchRev).toHaveAttribute("stroke-width", "2.4");
  await expect(marchRev).toHaveAttribute("stroke", "#1c2f1c");
  // March cost bar (sibling) unchanged.
  expect(await marchCost.getAttribute("y")).toBe(restY);
  expect(await marchCost.getAttribute("height")).toBe(restH);

  await page.screenshot({ path: "test-results/fb-statistics-monthly-hover-1440.png", fullPage: false });
});

test("Donut hover thickens the slice + applies drop-shadow filter — translucent tooltip", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-f-and-b-statistics").click();
  await page.getByTestId("f-and-b-statistics").waitFor({ timeout: 20_000 });
  await page.getByTestId("fb-category-card").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);

  // Dispatch hover programmatically (concentric stroke-only slices).
  await page.locator("[data-testid='fb-donut-slice-food']").evaluate((el) => {
    const rect = (el as SVGElement).getBoundingClientRect();
    const clientX = rect.left + rect.width / 2 + 70;
    const clientY = rect.top + rect.height / 2;
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX, clientY }));
    el.dispatchEvent(new MouseEvent("mousemove",  { bubbles: true, clientX, clientY }));
  });
  await page.getByTestId("fb-chart-tooltip").waitFor({ timeout: 5_000 });

  const foodSlice = page.getByTestId("fb-donut-slice-food");
  await expect(foodSlice).toHaveAttribute("data-active", "true");
  await expect(foodSlice).toHaveAttribute("stroke-width", "44");
  await expect(foodSlice).toHaveAttribute("filter", "url(#fb-active-shadow)");

  await page.screenshot({ path: "test-results/fb-statistics-donut-hover-1440.png", fullPage: false });
});

test("Food Cost line chart hover surfaces cost % + variance vs. budget; bar tooltip uses bg-club-green-900/85", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-f-and-b-statistics").click();
  await page.getByTestId("f-and-b-statistics").waitFor({ timeout: 20_000 });
  await page.getByTestId("fb-food-cost-card").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);

  await page.getByTestId("fb-food-cost-point-january").hover();
  await page.getByTestId("fb-chart-tooltip").waitFor({ timeout: 5_000 });

  const janPoint = page.getByTestId("fb-food-cost-point-january");
  await expect(janPoint).toHaveAttribute("data-active", "true");
  await expect(page.getByTestId("fb-chart-tooltip-label")).toHaveText("January");
  await expect(page.getByTestId("fb-chart-tooltip-row-cost")).toContainText("% cost");
  await expect(page.getByTestId("fb-chart-tooltip-row-variance")).toContainText("vs. budget");

  // Tooltip uses the translucent dark-green glass overlay.
  const bg = await page.getByTestId("fb-chart-tooltip").evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  const m = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(bg);
  if (!m) throw new Error(`tooltip is fully opaque (background: ${bg})`);
  const alpha = Number(m[4]);
  expect(alpha).toBeLessThan(1);
  expect(alpha).toBeGreaterThan(0.7);

  await page.screenshot({ path: "test-results/fb-statistics-cost-hover-1440.png", fullPage: false });
});

test("Chapter capture — full chapter for the founder review", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-f-and-b-statistics").click();
  await page.getByTestId("f-and-b-statistics").waitFor({ timeout: 20_000 });

  await page.getByTestId("fbs-kpi-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/fb-statistics-kpi-1440.png", fullPage: false });

  await page.getByTestId("fb-charts-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/fb-statistics-charts-1440.png", fullPage: false });
});
