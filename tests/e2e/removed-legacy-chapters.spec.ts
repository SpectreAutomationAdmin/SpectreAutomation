import { test, expect, type Page } from "@playwright/test";

// 2026-06-16 — nine legacy chapters (Operations through AR / Collections)
// were superseded by the five Saguaro Financial Performance chapters.
// This spec verifies the removal stuck: the rail shows the 14 new
// chapters in order, the removed rail entries are gone, and the removed
// `<section id="…">` bodies no longer render.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

const REMOVED_RAIL_IDS = [
  "operations-panel",
  "financial-health-panel",
  "capital-panel",
  "membership-panel",
  "experience-panel",
  "board-briefing",
  "at-a-glance",
  "ar-collections",
  // 2026-06-19 naming-convention refactor:
  //   - The "financial-statements" id used to be a legacy composite
  //     chapter (retired 2026-06-16). It is now the GROUP heading
  //     for chapters IV-VIII, not a chapter id — so it doesn't
  //     appear as a `reporting-chapter-financial-statements` rail
  //     entry, which is what this guard checks.
  //   - The "capital-projects" id WAS a legacy duplicate chapter
  //     (retired 2026-06-17), then the canonical chapter VI was
  //     renamed FROM "capital-project-tracker" TO "capital-projects"
  //     (2026-06-19 label-as-source-of-truth rename). So
  //     "capital-projects" is now a LEGITIMATE rail entry, no longer
  //     a "must not render" guard. Same applies to "ar-aging" (was
  //     "accounts-receivable-aging"), etc.
  // Legacy "Payroll" chapter was removed 2026-06-19 because it
  // duplicated the canonical chapter XII "Payroll Analysis"
  // (id: payroll-analysis).
  "payroll",
  // Legacy "F&B / Hospitality" chapter was removed 2026-06-19 because
  // it duplicated the canonical chapter XIII "F&B Statistics"
  // (id: f-and-b-statistics). The shared `pkg.fb` / `pkg.fbStats`
  // service data was preserved on the reporting service for the
  // canonical chapter and the export path.
  "fb-hospitality",
  // Legacy "Membership Stewardship" chapter was removed 2026-06-19
  // after its load-bearing surfaces (Active / Attrition / Entrance
  // Fees / Average Tenure tiles + Membership Category Mix + Waitlist
  // Depth & Aging + Tenure Distribution) migrated into the
  // Stewardship KPI Dashboard at chapter III. The `pkg.membershipStewardship`
  // and `pkg.commentary.membershipStewardship` service fields are
  // preserved for the dashboard's membership sub-blocks and the
  // export path.
  "membership-stewardship",
  // Legacy "Experience Stewardship" chapter was removed 2026-06-19
  // after its load-bearing utilization surfaces (Rounds YTD / Course
  // Utilization / Spend per Member / Spend per Round) migrated into
  // the Weather & Utilization chapter (XI) earlier the same day; the
  // F&B covers + F&B subsidy readings already live inside the F&B
  // Statistics chapter and the Stewardship KPI Dashboard. The
  // `pkg.experienceStewardship` and `pkg.commentary.experienceStewardship`
  // service fields are preserved for the 5-pillar Board Briefing
  // rollup and the export path.
  "experience-stewardship",
  // Legacy "Operations & Analytics" chapter was removed 2026-06-19
  // after its load-bearing readings dispersed into the six dedicated
  // operational chapters above (Operating Statistics → Inventory
  // Analysis). The `pkg.operatingStats` + `pkg.weatherUtilization` +
  // `pkg.fbStats` + `pkg.commentary.operations` service fields stay
  // available for the Weather chapter's utilization-extension tiles
  // and the 5-pillar Board Briefing rollup. The "Operations &
  // Analytics" group label persists ONLY as the rail heading above
  // the six surviving operational chapters.
  "operations",
];

const NEW_RAIL_ORDER = [
  "executive-opening",
  "financial-performance",
  "stewardship-dashboard",
  "statement-of-activities",
  "capital-fund",
  "capital-projects",
  "financial-position",
  "ar-aging",
  "operating-statistics",
  "departmental-p-and-l",
  "weather-and-utilization",
  "payroll-analysis",
  "f-and-b-statistics",
  "inventory-analysis",
];

test("rail shows the new 14 chapters in board-reading order — no legacy entries remain", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-ar-aging").waitFor({ timeout: 20_000 });

  for (const id of REMOVED_RAIL_IDS) {
    await expect(
      page.getByTestId(`reporting-chapter-${id}`),
      `rail entry "${id}" must NOT render`,
    ).toHaveCount(0);
  }

  for (const id of NEW_RAIL_ORDER) {
    await expect(
      page.getByTestId(`reporting-chapter-${id}`),
      `rail entry "${id}" must render`,
    ).toHaveCount(1);
  }

  const railIds = await page.evaluate((ids) => {
    const out: string[] = [];
    for (const id of ids) {
      if (document.querySelector(`[data-testid="reporting-chapter-${id}"]`)) {
        out.push(id);
      }
    }
    return out;
  }, NEW_RAIL_ORDER);

  expect(railIds).toEqual(NEW_RAIL_ORDER);
});

test("removed sections no longer render in the body", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  for (const id of REMOVED_RAIL_IDS) {
    await expect(
      page.locator(`#${id}`),
      `body section "#${id}" must NOT render`,
    ).toHaveCount(0);
  }

  // Removed testids the legacy sections used to expose.
  // ("ar-aging" was once a legacy panel testid retired 2026-06-16;
  //  it has since been reclaimed 2026-06-19 as the canonical chapter
  //  VIII container testid in the naming-convention refactor, so it
  //  is NO LONGER a "must not render" — it's legitimately present.)
  for (const tid of [
    "executive-summary",
    "executive-headline",
    "executive-kpis",
    "executive-consideration",
    "ar-collections-lead",
  ]) {
    await expect(
      page.getByTestId(tid),
      `testid "${tid}" must NOT render`,
    ).toHaveCount(0);
  }
});

test("sticky rail still works — AR Aging link scrolls and activates after the removal", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  const railEntry = page.getByTestId("reporting-chapter-ar-aging");
  await railEntry.waitFor({ timeout: 20_000 });
  await railEntry.click();
  await page.waitForTimeout(600);
  await expect(page.getByTestId("ar-aging")).toBeInViewport();
  await expect(page.getByTestId("ara-title")).toHaveText("Accounts Receivable Aging");
});
