import { test, expect, type Page } from "@playwright/test";

// Capital panel — Pillar 2 deep-dive (chapter V). Large KPI
// presentation of Capital Spend, Projects Active, Projects Delayed,
// and Reserve Contributions. Mirrors the Operations and Financial
// Health panel visual priority exactly.

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
  test(`Capital panel renders the four KPI tiles @ ${vp.name}`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("reporting-chapter-capital-panel").click();
    await page.waitForTimeout(400);

    for (const key of ["capital-spend", "projects-active", "projects-delayed", "reserve-contributions"]) {
      await expect(page.getByTestId(`capital-panel-tile-${key}`)).toBeVisible();
    }

    await page.screenshot({
      path: `test-results/capital-panel-${vp.name}.png`,
      fullPage: false,
    });
  });
}

test("Capital panel tile anatomy — hero + status badge + comparator + variance", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  for (const { key, label, expectedStatus } of [
    { key: "capital-spend",         label: /Capital Spend YTD/i,    expectedStatus: /^(Executing|Monitor|Delayed|Critical)$/ },
    { key: "projects-active",       label: /Projects Active/i,      expectedStatus: /^(Executing|Monitor|Delayed|Critical)$/ },
    { key: "projects-delayed",      label: /Projects Delayed/i,     expectedStatus: /^(Executing|Monitor|Delayed|Critical)$/ },
    { key: "reserve-contributions", label: /Reserve Contributions/i, expectedStatus: /^(Executing|Monitor|Delayed|Critical)$/ },
  ]) {
    const tile = page.getByTestId(`capital-panel-tile-${key}`);
    await expect(tile.getByTestId(`capital-panel-tile-${key}-label`)).toContainText(label);
    await expect(tile.getByTestId(`capital-panel-tile-${key}-value`)).toBeVisible();
    const statusText = await tile.getByTestId(`capital-panel-tile-${key}-status`).textContent();
    expect(statusText?.trim()).toMatch(expectedStatus);
    await expect(tile.getByTestId(`capital-panel-tile-${key}-comparator`)).toBeVisible();
    await expect(tile.getByTestId(`capital-panel-tile-${key}-variance`)).toBeVisible();
  }
});

test("Capital panel hero number matches the Operations + Financial Health panel hero tier (text-6xl)", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  const csFontPx = await page
    .locator('[data-testid="capital-panel-tile-capital-spend-value"]')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(
    csFontPx,
    `Capital panel hero number (${csFontPx}px) must use text-6xl (60px) — same tier as Operations + Financial Health`,
  ).toBeGreaterThanOrEqual(58);

  // Cross-check parity with the Financial Health panel hero number.
  const fhFontPx = await page
    .locator('[data-testid="financial-health-panel-tile-working-capital-value"]')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(
    csFontPx,
    `Capital panel hero must equal Financial Health panel hero (${fhFontPx}px) — Capital must not feel like an afterthought`,
  ).toBe(fhFontPx);
});

test("Capital panel — visual status indicators distinguish on-track from at-risk metrics", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  // Demo data: Capital Spend is amber (under plan due to irrigation
  // deferral), Projects Active is green (executing), Projects Delayed
  // is amber (1 deferred), Reserve Contributions is green (favorable swing).
  await expect(page.getByTestId("capital-panel-tile-capital-spend")).toHaveAttribute("data-tone", "amber");
  await expect(page.getByTestId("capital-panel-tile-projects-active")).toHaveAttribute("data-tone", "green");
  await expect(page.getByTestId("capital-panel-tile-projects-delayed")).toHaveAttribute("data-tone", "amber");
  await expect(page.getByTestId("capital-panel-tile-reserve-contributions")).toHaveAttribute("data-tone", "green");
});

test("Capital panel renders no tables and no commentary", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  await page.getByTestId("reporting-chapter-capital-panel").click();
  await page.waitForTimeout(400);

  const panel = page.getByTestId("capital-panel");
  expect(await panel.locator("table").count()).toBe(0);
  expect(await panel.locator('[data-testid$="-commentary"]').count()).toBe(0);
});
