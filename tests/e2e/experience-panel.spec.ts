import { test, expect, type Page } from "@playwright/test";

// Experience Health panel — Pillar 5 deep-dive (chapter VII). Large
// KPI presentation of Rounds, Covers, Average Check, and F&B Subsidy.
// Closes the five-pillar deep-dive set — Experience reads as the
// fifth peer of Operations / Financial Health / Capital / Membership.

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
  test(`Experience Health panel renders the four KPI tiles @ ${vp.name}`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("reporting-chapter-experience-panel").click();
    await page.waitForTimeout(400);

    for (const key of ["rounds", "covers", "average-check", "fb-subsidy"]) {
      await expect(page.getByTestId(`experience-panel-tile-${key}`)).toBeVisible();
    }

    await page.screenshot({
      path: `test-results/experience-panel-${vp.name}.png`,
      fullPage: false,
    });
  });
}

test("Experience Health panel tile anatomy — hero + status badge + comparator + variance", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  for (const { key, label, expectedStatus } of [
    { key: "rounds",        label: /Rounds YTD/i,     expectedStatus: /^(Thriving|Healthy|Watch|Concern)$/ },
    { key: "covers",        label: /F&B Covers/i,     expectedStatus: /^(Thriving|Healthy|Watch|Concern)$/ },
    { key: "average-check", label: /Average Check/i,  expectedStatus: /^(Thriving|Healthy|Watch|Concern)$/ },
    { key: "fb-subsidy",    label: /F&B Subsidy/i,    expectedStatus: /^(Thriving|Healthy|Watch|Concern)$/ },
  ]) {
    const tile = page.getByTestId(`experience-panel-tile-${key}`);
    await expect(tile.getByTestId(`experience-panel-tile-${key}-label`)).toContainText(label);
    await expect(tile.getByTestId(`experience-panel-tile-${key}-value`)).toBeVisible();
    const statusText = await tile.getByTestId(`experience-panel-tile-${key}-status`).textContent();
    expect(statusText?.trim()).toMatch(expectedStatus);
    await expect(tile.getByTestId(`experience-panel-tile-${key}-comparator`)).toBeVisible();
    await expect(tile.getByTestId(`experience-panel-tile-${key}-variance`)).toBeVisible();
  }
});

test("Experience hero number matches every other pillar panel hero tier (text-6xl)", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  const eFontPx = await page
    .locator('[data-testid="experience-panel-tile-rounds-value"]')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(eFontPx).toBeGreaterThanOrEqual(58);

  // Equality with the Membership hero confirms the five pillar panels
  // share visual priority (closes the visual quintet).
  const mFontPx = await page
    .locator('[data-testid="membership-panel-tile-member-count-value"]')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(
    eFontPx,
    `Experience hero (${eFontPx}px) must equal Membership hero (${mFontPx}px) — Experience reads as the fifth peer`,
  ).toBe(mFontPx);
});

test("Experience Health panel — Covers is amber (the cover softness is the chapter's watch item)", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  // Demo data: Covers run -1.4% to plan → Watch (amber). Rounds +6.0%
  // → Thriving (green). Average Check +4.1% YoY → Thriving (green).
  // F&B Subsidy 5.1% (below 6% target) → Healthy (green).
  await expect(page.getByTestId("experience-panel-tile-covers")).toHaveAttribute("data-tone", "amber");
  const coversStatus = await page
    .getByTestId("experience-panel-tile-covers-status")
    .textContent();
  expect(coversStatus?.trim()).toBe("Watch");

  for (const key of ["rounds", "average-check", "fb-subsidy"]) {
    await expect(page.getByTestId(`experience-panel-tile-${key}`)).toHaveAttribute("data-tone", "green");
  }
});

test("Experience Health panel answers 'are members actively using the Club?' via the four numbers + status badges", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  // The four metrics together answer the question: Rounds + Covers
  // measure activity; Average Check measures engagement depth; F&B
  // Subsidy measures whether engagement is sustained at sustainable
  // economics.
  for (const key of ["rounds", "covers", "average-check", "fb-subsidy"]) {
    const value = await page
      .getByTestId(`experience-panel-tile-${key}-value`)
      .textContent();
    expect(value?.trim(), `${key} hero number must render a non-empty value`).toBeTruthy();
    expect(value?.trim()).not.toBe("—");
  }
});

test("Experience Health panel renders no tables and no commentary", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  await page.getByTestId("reporting-chapter-experience-panel").click();
  await page.waitForTimeout(400);

  const panel = page.getByTestId("experience-panel");
  expect(await panel.locator("table").count()).toBe(0);
  expect(await panel.locator('[data-testid$="-commentary"]').count()).toBe(0);
});
