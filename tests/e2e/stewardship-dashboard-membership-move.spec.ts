import { test, expect, type Page } from "@playwright/test";

// 2026-06-19 — the Membership Stewardship headline tiles + Category Mix +
// Waitlist Depth & Aging + Tenure Distribution sub-blocks were lifted into
// the Stewardship Dashboard (chapter III) so the Board reads the
// membership-health dimension alongside the operating + capital KPI cards
// without leaving the dashboard. Later the same day, the standalone
// Membership Stewardship chapter was retired entirely — the residual L4
// lead + attrition trend did not justify a chapter on their own.
//
// This spec verifies:
//   - the moved blocks render inside chapter III (Stewardship Dashboard)
//   - they sit immediately after the dashboard header, above the
//     Operating vs. Capital Stewardship sub-header
//   - the legacy Membership Stewardship chapter no longer renders
//   - no duplicate rendering exists

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("Membership sub-blocks render inside the Stewardship Dashboard exactly once", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("stewardship-kpi-dashboard").waitFor({ timeout: 20_000 });

  // Each lifted block renders exactly once across the whole page —
  // no duplicate render anywhere.
  for (const tid of [
    "stewardship-kpi-dashboard-membership-headline",
    "membership-category-mix",
    "membership-waitlist",
    "membership-waitlist-summary",
    "membership-waitlist-aging",
    "membership-tenure-distribution",
    "membership-active",
    "membership-attrition",
    "membership-entrance-fee",
    // The membership-tenure testId is shared by the hero tile only
    // now (the distribution wrapper testid was disambiguated to
    // membership-tenure-distribution to remove the legacy collision).
    "membership-tenure",
  ]) {
    await expect(
      page.getByTestId(tid),
      `${tid} must render exactly once`,
    ).toHaveCount(1);
  }

  // Each lifted block is a descendant of the chapter III dashboard
  // — proves the move stuck.
  const dashboard = page.getByTestId("stewardship-kpi-dashboard");
  for (const tid of [
    "stewardship-kpi-dashboard-membership-headline",
    "membership-category-mix",
    "membership-waitlist",
    "membership-tenure-distribution",
  ]) {
    await expect(
      dashboard.getByTestId(tid),
      `${tid} must live inside the Stewardship Dashboard`,
    ).toHaveCount(1);
  }

  // The legacy Membership Stewardship chapter no longer renders.
  // Its anchor, container testid, residual lead, and attrition trend
  // sparkline must all be gone — only the dashboard hosts the
  // membership content.
  await expect(page.getByTestId("membership-stewardship")).toHaveCount(0);
  await expect(page.getByTestId("membership-stewardship-lead")).toHaveCount(0);
  await expect(page.getByTestId("membership-attrition-trend")).toHaveCount(0);
  await expect(page.locator("#membership-stewardship")).toHaveCount(0);
});

test("Stewardship Dashboard order: header → membership blocks → original dashboard content (intro → summary → paired grid → notes)", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("stewardship-kpi-dashboard").waitFor({ timeout: 20_000 });

  // Resolve each landmark's vertical position in the document and
  // assert monotonic ordering.
  const offsets = await page.evaluate((ids) => {
    return ids.map((id) => {
      const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
      return el ? el.getBoundingClientRect().top + window.scrollY : -1;
    });
  }, [
    "stewardship-kpi-dashboard-meta",
    "stewardship-kpi-dashboard-membership-headline",
    "membership-category-mix",
    "membership-waitlist",
    "membership-tenure-distribution",
    "stewardship-kpi-dashboard-op-vs-cap-heading",
    "stewardship-kpi-dashboard-intro",
    "stewardship-kpi-dashboard-summary",
    "stewardship-kpi-dashboard-panels",
    "stewardship-kpi-dashboard-notes",
  ]);

  for (let i = 1; i < offsets.length; i++) {
    expect(
      offsets[i],
      `landmark[${i}] must render after landmark[${i - 1}]`,
    ).toBeGreaterThan(offsets[i - 1]);
  }
});

test("Stewardship Dashboard renders cleanly — chapter III screenshot", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1600 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("stewardship-kpi-dashboard").waitFor({ timeout: 20_000 });

  // Scroll the dashboard into view and capture it.
  await page.getByTestId("stewardship-kpi-dashboard").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);
  await page.screenshot({ path: "test-results/stewardship-dashboard-with-membership.png", fullPage: true });
});
