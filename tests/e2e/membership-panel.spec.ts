import { test, expect, type Page } from "@playwright/test";

// Membership Health panel — Pillar 4 deep-dive (chapter VI). Large
// KPI presentation of Member Count, Waitlist, New Members, and
// Attrition. Mirrors the Operations / Financial Health / Capital
// visual language exactly.

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
  test(`Membership Health panel renders the four KPI tiles @ ${vp.name}`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");

    await page.getByTestId("reporting-chapter-membership-panel").click();
    await page.waitForTimeout(400);

    for (const key of ["member-count", "waitlist", "new-members", "attrition"]) {
      await expect(page.getByTestId(`membership-panel-tile-${key}`)).toBeVisible();
    }

    await page.screenshot({
      path: `test-results/membership-panel-${vp.name}.png`,
      fullPage: false,
    });
  });
}

test("Membership Health panel tile anatomy — hero + status badge + comparator + variance", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  for (const { key, label, expectedStatus } of [
    { key: "member-count", label: /Member Count/i, expectedStatus: /^(Healthy|Watch|At Risk|Declining)$/ },
    { key: "waitlist",     label: /Waitlist/i,     expectedStatus: /^(Healthy|Watch|At Risk|Declining)$/ },
    { key: "new-members",  label: /New Members/i,  expectedStatus: /^(Healthy|Watch|At Risk|Declining)$/ },
    { key: "attrition",    label: /Attrition/i,    expectedStatus: /^(Healthy|Watch|At Risk|Declining)$/ },
  ]) {
    const tile = page.getByTestId(`membership-panel-tile-${key}`);
    await expect(tile.getByTestId(`membership-panel-tile-${key}-label`)).toContainText(label);
    await expect(tile.getByTestId(`membership-panel-tile-${key}-value`)).toBeVisible();
    const statusText = await tile.getByTestId(`membership-panel-tile-${key}-status`).textContent();
    expect(statusText?.trim()).toMatch(expectedStatus);
    await expect(tile.getByTestId(`membership-panel-tile-${key}-comparator`)).toBeVisible();
    await expect(tile.getByTestId(`membership-panel-tile-${key}-variance`)).toBeVisible();
  }
});

test("Membership Health hero number matches the Operations + Financial Health + Capital panel hero tier (text-6xl)", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  const mFontPx = await page
    .locator('[data-testid="membership-panel-tile-member-count-value"]')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(mFontPx).toBeGreaterThanOrEqual(58);

  // Equality with the Capital panel hero confirms the four pillar
  // panels share visual priority.
  const cFontPx = await page
    .locator('[data-testid="capital-panel-tile-capital-spend-value"]')
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(
    mFontPx,
    `Membership hero (${mFontPx}px) must equal Capital hero (${cFontPx}px) — Membership reads as a peer`,
  ).toBe(cFontPx);
});

test("Membership Health panel — Waitlist is amber (the LRP buffer shortfall is the chapter's watch item)", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  // Demo data ships Waitlist at 47 vs LRP target 60 → Watch (amber).
  // The other three tiles ship green (Healthy).
  await expect(page.getByTestId("membership-panel-tile-waitlist")).toHaveAttribute("data-tone", "amber");
  const waitlistStatus = await page
    .getByTestId("membership-panel-tile-waitlist-status")
    .textContent();
  expect(waitlistStatus?.trim()).toBe("Watch");

  for (const key of ["member-count", "new-members", "attrition"]) {
    await expect(page.getByTestId(`membership-panel-tile-${key}`)).toHaveAttribute("data-tone", "green");
  }
});

test("Membership Health panel renders no tables and no commentary", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  await page.getByTestId("reporting-chapter-membership-panel").click();
  await page.waitForTimeout(400);

  const panel = page.getByTestId("membership-panel");
  expect(await panel.locator("table").count()).toBe(0);
  expect(await panel.locator('[data-testid$="-commentary"]').count()).toBe(0);
});
