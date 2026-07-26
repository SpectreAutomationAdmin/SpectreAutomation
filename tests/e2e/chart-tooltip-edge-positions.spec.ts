import { test, type Page } from "@playwright/test";

// 2026-06-20 — founder requested screenshots proving the tooltip
// renders correctly across 6 specific positions:
//   1. Cursor hovering Sunny / Clear slice (donut centred area)
//   2. Cursor hovering Rain / Storms slice (donut centred area)
//   3. Tooltip near left edge
//   4. Tooltip near right edge
//   5. Tooltip near top edge
//   6. Tooltip near bottom edge
//
// The tooltip is portal-rendered into document.body and flips its
// anchor position when near any viewport edge so it can never be
// clipped.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

async function hoverSlice(page: Page, sliceKey: string) {
  await page.locator(`[data-testid='mws-pattern-slice-${sliceKey}']`).evaluate((el) => {
    const rect = (el as SVGElement).getBoundingClientRect();
    const clientX = rect.left + rect.width / 2 + 70;
    const clientY = rect.top + rect.height / 2;
    el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX, clientY }));
    el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX, clientY }));
  });
  await page.getByTestId("mws-pattern-tooltip").waitFor({ timeout: 5_000 });
}

async function hoverAtViewportPoint(page: Page, clientX: number, clientY: number) {
  // Dispatch a synthetic mousemove on the slice element with the
  // given client coordinates so the tooltip's portal renders at
  // that viewport position.
  await page.locator("[data-testid='mws-pattern-slice-sunny-clear']").evaluate(
    (el, [x, y]) => {
      el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true, clientX: x, clientY: y }));
      el.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
    },
    [clientX, clientY],
  );
  await page.getByTestId("mws-pattern-tooltip").waitFor({ timeout: 5_000 });
  await page.waitForTimeout(50);
}

test("tooltip — cursor hovering Sunny / Clear slice", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("mws-charts-grid").waitFor({ timeout: 20_000 });
  await page.getByTestId("mws-charts-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await hoverSlice(page, "sunny-clear");
  await page.screenshot({
    path: "test-results/tooltip-edge-1-sunny-hover.png",
    fullPage: false,
  });
});

test("tooltip — cursor hovering Rain / Storms slice", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("mws-charts-grid").waitFor({ timeout: 20_000 });
  await page.getByTestId("mws-charts-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await hoverSlice(page, "rain-storms");
  await page.screenshot({
    path: "test-results/tooltip-edge-2-rain-hover.png",
    fullPage: false,
  });
});

test("tooltip — near LEFT edge (flips right)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("mws-charts-grid").waitFor({ timeout: 20_000 });
  await page.getByTestId("mws-charts-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await hoverAtViewportPoint(page, 30, 450);
  await page.screenshot({
    path: "test-results/tooltip-edge-3-left.png",
    fullPage: false,
  });
});

test("tooltip — near RIGHT edge (flips left)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("mws-charts-grid").waitFor({ timeout: 20_000 });
  await page.getByTestId("mws-charts-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await hoverAtViewportPoint(page, 1410, 450);
  await page.screenshot({
    path: "test-results/tooltip-edge-4-right.png",
    fullPage: false,
  });
});

test("tooltip — near TOP edge (flips below)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("mws-charts-grid").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(300);
  await hoverAtViewportPoint(page, 720, 12);
  await page.screenshot({
    path: "test-results/tooltip-edge-5-top.png",
    fullPage: false,
  });
});

test("tooltip — near BOTTOM edge (clamps upward)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("mws-charts-grid").waitFor({ timeout: 20_000 });
  await page.waitForTimeout(300);
  await hoverAtViewportPoint(page, 720, 880);
  await page.screenshot({
    path: "test-results/tooltip-edge-6-bottom.png",
    fullPage: false,
  });
});

test("tooltip — verify it lives in document.body (portal-rendered, not card-scoped)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-weather-and-utilization").click();
  await page.getByTestId("mws-charts-grid").waitFor({ timeout: 20_000 });
  await page.getByTestId("mws-charts-grid").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await hoverSlice(page, "sunny-clear");

  const portalCheck = await page.evaluate(() => {
    const tip = document.querySelector('[data-testid="mws-pattern-tooltip"]');
    if (!tip) return { mounted: false };
    // Walk up: confirm the tooltip's parent chain leads to <body>
    // and DOES NOT pass through the mws-pattern-card element.
    let walker: Element | null = tip;
    let parents: string[] = [];
    while (walker && walker !== document.body) {
      parents.push(
        walker.tagName.toLowerCase() +
          (walker.getAttribute("data-testid") ? `[${walker.getAttribute("data-testid")}]` : ""),
      );
      walker = walker.parentElement;
    }
    const insideCard = parents.some((p) => p.includes("mws-pattern-card"));
    return { mounted: true, insideCard, parents };
  });
  if (!portalCheck.mounted) throw new Error("tooltip did not mount");
  if (portalCheck.insideCard) {
    throw new Error(
      `tooltip is NOT portal-rendered — parent chain includes card: ${portalCheck.parents.join(" > ")}`,
    );
  }
});
