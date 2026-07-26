import { test, type Page } from "@playwright/test";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("final audit @ 1440x900", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(400);

  await page.screenshot({
    path: `test-results/final-audit-1440x900.png`,
    fullPage: false,
  });

  // Measurement bundle for each audit criterion.
  const measurements: Record<string, unknown> = {};

  // (2) Revenue, NOI, Capital Income, Reserve Coverage — visible above fold?
  for (const key of ["ytd-revenue", "noi", "capital-income", "reserve-coverage"]) {
    const visible = await page.getByTestId(`monthly-cover-at-a-glance-${key}`)
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return r.top >= 0 && r.bottom <= 900 + 4;
      });
    measurements[`atGlance.${key}`] = visible;
  }

  // (3) Three briefing cards above fold?
  for (const key of ["operations", "financial-health", "capital-program"]) {
    const visible = await page.getByTestId(`cover-briefing-${key}`)
      .evaluate((el) => {
        const r = el.getBoundingClientRect();
        return { top: r.top, bottom: r.bottom, visible: r.top >= 0 && r.bottom <= 900 + 4 };
      });
    measurements[`briefing.${key}`] = visible;
  }

  // (4) Nav: group headings present?
  for (const slug of ["member-overview", "financial-performance", "financial-statements", "operations-analytics", "stewardship"]) {
    const present = await page.getByTestId(`reporting-chapter-group-${slug}`).count();
    measurements[`navGroup.${slug}`] = present > 0;
  }

  // (5) Board of Directors wording — should NOT contain "Governors" anywhere.
  const bodyText = (await page.locator("body").textContent()) ?? "";
  measurements["wording.containsBoardOfDirectors"] = bodyText.includes("Board of Directors");
  measurements["wording.containsBoardOfGovernors"] = bodyText.includes("Board of Governors");

  // (7) Next-chapter tease — Chair's Dashboard eyebrow visible?
  const dashTop = await page.getByTestId("financial-performance")
    .evaluate((el) => el.getBoundingClientRect().top);
  measurements["tease.dashboardTopPx"] = dashTop;
  measurements["tease.teaseVisible"] = dashTop < 900;

  // (6) Width utilization at 1440 — what fraction of viewport does the cover use?
  const coverWidth = await page.getByTestId("monthly-cover")
    .evaluate((el) => el.getBoundingClientRect().width);
  const shellWidth = await page.getByTestId("reporting-shell-body")
    .evaluate((el) => el.getBoundingClientRect().width);
  measurements["width.coverPx"] = coverWidth;
  measurements["width.shellBodyPx"] = shellWidth;
  measurements["width.utilizationPct"] = Math.round((coverWidth / 1440) * 100);

  // eslint-disable-next-line no-console
  console.log("AUDIT:", JSON.stringify(measurements, null, 2));
  test.info().annotations.push({
    type: "final-audit",
    description: JSON.stringify(measurements, null, 2),
  });
});
