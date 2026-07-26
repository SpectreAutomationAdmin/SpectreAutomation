import { test, expect, type Page } from "@playwright/test";

// 2026-06-19 — the standalone Experience Stewardship chapter was
// retired. Rounds YTD / Course Utilization / Spend per Member /
// Spend per Round were lifted into the Weather & Utilization chapter
// (XI) earlier the same day; F&B covers + F&B subsidy already live
// inside the F&B Statistics chapter and the Stewardship KPI Dashboard.
// The shared `pkg.experienceStewardship` and
// `pkg.commentary.experienceStewardship` service fields stay
// available — the 5-pillar Board Briefing rollup still consumes the
// experience pillar's board-headline, and the export path continues
// to read these fields from the same source of truth.
//
// This spec preserves the file as a regression guard: the chapter
// anchor, container testId, lead, reading paragraphs, metric grid,
// and sparklines must NOT come back. The chapter-specific screenshot
// tests that used to live here have been removed alongside the
// chapter.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("legacy Experience Stewardship surfaces do not render anywhere in the package", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("monthly-reporting-body").waitFor({ timeout: 20_000 });

  // Rail entry MUST be gone.
  await expect(
    page.getByTestId("reporting-chapter-experience-stewardship"),
    "rail entry 'experience-stewardship' must NOT render",
  ).toHaveCount(0);

  // Body anchor MUST be gone.
  await expect(
    page.locator("#experience-stewardship"),
    "body anchor '#experience-stewardship' must NOT render",
  ).toHaveCount(0);

  // All chapter-specific testIds MUST be gone.
  for (const tid of [
    "experience-stewardship",
    "experience-stewardship-lead",
    "experience-readings",
    "experience-golf-reading",
    "experience-hospitality-reading",
    "experience-metrics",
    "experience-headline",
    "experience-covers",
    "experience-fb-subsidy",
    "experience-utilization-trend",
    "experience-subsidy-trend",
  ]) {
    await expect(
      page.getByTestId(tid),
      `legacy testid '${tid}' must NOT render`,
    ).toHaveCount(0);
  }
});
