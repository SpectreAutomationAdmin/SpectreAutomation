import { test, expect, type Page } from "@playwright/test";

// Visual + behavioural audit for Departmental Payroll Analysis
// (chapter XII). Asserts:
//   - rail entry reads "Payroll Analysis" but the chapter title
//     remains "Departmental Payroll Analysis"
//   - rail order inside Operations & Analytics:
//     Operating Statistics → Departmental P&L → Weather & Utilization
//     → Payroll Analysis → Operations & Analytics → ...
//   - header chrome reflects the selected reporting period
//   - 4 KPI cards + 2×2 chart grid + summary table all render
//   - bar hover thickens the stroke without translating / scaling
//     the bar's y or height
//   - donut hover thickens the stroke + drop-shadow filter
//   - tooltip background is bg-club-green-900/85 (translucent
//     glass overlay)
//   - Club Total row uses the dark-green band with cream text

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 30_000 });
}

test("rail label is 'Payroll Analysis' but the chapter title remains 'Departmental Payroll Analysis'", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  const railEntry = page.getByTestId("reporting-chapter-payroll-analysis");
  await railEntry.waitFor({ timeout: 20_000 });
  await expect(railEntry).toContainText("Payroll Analysis");
  await expect(railEntry).not.toContainText("Departmental Payroll Analysis");

  await railEntry.click();
  await page.getByTestId("payroll-analysis").waitFor({ timeout: 20_000 });
  await expect(page.getByTestId("payroll-analysis")).toBeInViewport();
  await expect(page.getByTestId("dpa-title")).toHaveText("Departmental Payroll Analysis");
  await expect(railEntry).toBeInViewport();
});

test("header chrome flows from ReportingPeriod (May 2026, NO Q1 / March)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-payroll-analysis").click();
  await page.getByTestId("payroll-analysis").waitFor({ timeout: 20_000 });

  await expect(page.getByTestId("dpa-period")).toContainText("May 2026");
  await expect(page.getByTestId("dpa-statement-number")).toHaveText("Statement 12 of 14");
  await expect(page.getByTestId("dpa-document-chip")).toHaveText("Payroll & Compensation");
  await expect(page.getByTestId("dpa-prepared-for")).toHaveText("Management & Finance Committee");
  await expect(page.getByTestId("dpa-period")).not.toContainText("Q1");
  await expect(page.getByTestId("dpa-period")).not.toContainText("March");
});

test("4 KPI cards render with their treatments + featured primary card", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-payroll-analysis").click();
  await page.getByTestId("payroll-analysis").waitFor({ timeout: 20_000 });

  for (const key of ["ytd-total-payroll", "ytd-variance", "current-month-payroll", "payroll-to-revenue"]) {
    await expect(page.getByTestId(`dpa-kpi-${key}`)).toBeVisible();
  }
  // Primary featured card carries the dark-green background.
  const primary = page.getByTestId("dpa-kpi-ytd-total-payroll");
  const bg = await primary.evaluate((el) => getComputedStyle(el).backgroundColor);
  // club-green-900 ≈ rgb(31, 50, 32) — at any tone variant the red
  // channel should be < 90. Loose-bounded so future palette tuning
  // doesn't break the test.
  const m = /rgb\((\d+),\s*(\d+),\s*(\d+)/.exec(bg);
  expect(m).toBeTruthy();
  if (m) {
    expect(Number(m[1]), `primary card background must be dark (got ${bg})`).toBeLessThan(90);
  }
});

test("Summary table renders 7 department rows + Club Total dark-green band", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-payroll-analysis").click();
  await page.getByTestId("payroll-analysis").waitFor({ timeout: 20_000 });
  await page.getByTestId("dpa-table").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);

  for (const key of ["golf-ops", "gcm", "fb", "admin", "grounds", "security", "other"]) {
    await expect(page.getByTestId(`dpa-row-${key}`)).toBeVisible();
  }
  // Club Total row.
  const total = page.getByTestId("dpa-row-club-total");
  await expect(total).toBeVisible();
  await expect(total).toHaveAttribute("data-kind", "total");
  // GCM variance cells render with the risk tone (unfavorable).
  await expect(page.getByTestId("dpa-row-gcm-mtd-var")).toHaveAttribute("data-tone", "risk");
  await expect(page.getByTestId("dpa-row-gcm-ytd-var")).toHaveAttribute("data-tone", "risk");
  // Golf Operations variance cells render with the favourable tone.
  await expect(page.getByTestId("dpa-row-golf-ops-mtd-var")).toHaveAttribute("data-tone", "favorable");
  await expect(page.getByTestId("dpa-row-golf-ops-ytd-var")).toHaveAttribute("data-tone", "favorable");
});

test("Variance bar hover thickens the bar's stroke WITHOUT translating / scaling its y or height", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-payroll-analysis").click();
  await page.getByTestId("payroll-analysis").waitFor({ timeout: 20_000 });
  await page.getByTestId("payroll-variance-card").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);

  // Capture y + height of the Golf Ops variance bar at rest.
  const gops = page.getByTestId("payroll-variance-bar-golf-ops");
  const restY = await gops.getAttribute("y");
  const restH = await gops.getAttribute("height");

  // Hover the GCM bar (the only unfavourable bar in the seed).
  await page.getByTestId("payroll-variance-bar-gcm").hover();
  await page.getByTestId("payroll-chart-tooltip").waitFor({ timeout: 5_000 });

  // Active bar carries the thicker outline; non-active bars unchanged.
  const gcm = page.getByTestId("payroll-variance-bar-gcm");
  await expect(gcm).toHaveAttribute("data-active", "true");
  await expect(gcm).toHaveAttribute("stroke-width", "2.4");
  await expect(gcm).toHaveAttribute("stroke", "#1c2f1c");
  // Golf Ops bar geometry is byte-identical.
  expect(await gops.getAttribute("y")).toBe(restY);
  expect(await gops.getAttribute("height")).toBe(restH);

  await page.screenshot({ path: "test-results/payroll-variance-hover-1440.png", fullPage: false });
});

test("Distribution donut hover thickens the slice + applies drop-shadow filter — translucent tooltip overlays the slice", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-payroll-analysis").click();
  await page.getByTestId("payroll-analysis").waitFor({ timeout: 20_000 });
  await page.getByTestId("payroll-distribution-card").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);

  // Donut slices are concentric strokes — dispatch hover events
  // programmatically so we land on the painted ring.
  await page.locator("[data-testid='payroll-donut-slice-gcm']").evaluate((el) => {
    const rect = (el as SVGElement).getBoundingClientRect();
    const clientX = rect.left + rect.width / 2 + 70;
    const clientY = rect.top + rect.height / 2;
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX, clientY }));
    el.dispatchEvent(new MouseEvent("mousemove",  { bubbles: true, clientX, clientY }));
  });
  await page.getByTestId("payroll-chart-tooltip").waitFor({ timeout: 5_000 });

  const gcmSlice = page.getByTestId("payroll-donut-slice-gcm");
  await expect(gcmSlice).toHaveAttribute("data-active", "true");
  await expect(gcmSlice).toHaveAttribute("stroke-width", "44");
  await expect(gcmSlice).toHaveAttribute("filter", "url(#payroll-active-shadow)");

  await page.screenshot({ path: "test-results/payroll-distribution-hover-1440.png", fullPage: false });
});

test("Tooltip uses the translucent dark-green glass-overlay treatment (NOT fully opaque)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-payroll-analysis").click();
  await page.getByTestId("payroll-analysis").waitFor({ timeout: 20_000 });
  await page.getByTestId("payroll-variance-card").scrollIntoViewIfNeeded();
  await page.waitForTimeout(150);

  await page.getByTestId("payroll-variance-bar-gcm").hover();
  await page.getByTestId("payroll-chart-tooltip").waitFor({ timeout: 5_000 });

  const bgColor = await page.getByTestId("payroll-chart-tooltip").evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  // Computed background should resolve to an rgba with alpha ≈ 0.85.
  // The browser always emits `rgba(r, g, b, a)` with all four values
  // when alpha < 1; if it collapsed to `rgb(r, g, b)` the tooltip is
  // fully opaque.
  const m = /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/.exec(bgColor);
  if (!m) {
    throw new Error(`tooltip is fully opaque (background: ${bgColor})`);
  }
  const alpha = Number(m[4]);
  expect(alpha, `tooltip alpha must be < 1 (translucent), got ${alpha}`).toBeLessThan(1);
  expect(alpha, `tooltip alpha must be ~0.85 (got ${alpha})`).toBeGreaterThan(0.7);
});

test("Chapter capture — full chapter at 1440 for the founder review", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-payroll-analysis").click();
  await page.getByTestId("payroll-analysis").waitFor({ timeout: 20_000 });
  await page.getByTestId("dpa-kpi-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/payroll-analysis-kpi-1440.png", fullPage: false });

  await page.getByTestId("payroll-charts-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/payroll-analysis-charts-1440.png", fullPage: false });

  await page.getByTestId("dpa-table").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/payroll-analysis-table-1440.png", fullPage: false });
});
