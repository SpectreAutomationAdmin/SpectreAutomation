import { test, expect, type Page } from "@playwright/test";

// First-scroll audit — measures whether the four Club-health questions
// (revenue / operating / balance-sheet / capital) are answerable from
// the first viewport at three reference viewports:
//
//   1440 x 900  — board-room laptop (primary)
//   1920 x 1080 — finance-chair desktop
//   1280 x 800  — narrowest supported laptop
//
// Implements the visual-QA contract from
// docs/spectre-first-scroll-reporting-standard.md §8.

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
  test(`first-scroll audit @ ${vp.name} — all three briefing cards above the fold`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);

    // Capture the first viewport for visual review.
    await page.screenshot({
      path: `test-results/first-scroll-audit-${vp.name}.png`,
      fullPage: false,
    });

    // Every briefing card's bottom edge must be at or above the
    // viewport bottom (with a small sub-pixel tolerance).
    const measurements: Record<string, { top: number; bottom: number; height: number }> = {};
    for (const key of ["operations", "financial-health", "capital-program"]) {
      const m = await page
        .getByTestId(`cover-briefing-${key}`)
        .evaluate((el) => {
          const r = el.getBoundingClientRect();
          return { top: r.top, bottom: r.bottom, height: r.height };
        });
      measurements[key] = m;
    }

    // Log measurements via testInfo annotations so the report carries
    // the per-viewport numbers regardless of pass/fail.
    test.info().annotations.push({
      type: "card-measurements",
      description: `${vp.name}: ${JSON.stringify(measurements)}`,
    });

    for (const [key, m] of Object.entries(measurements)) {
      expect(
        m.bottom,
        `${vp.name} — cover-briefing-${key} bottom (${m.bottom.toFixed(2)}px) must fit in ${vp.height}px viewport`,
      ).toBeLessThanOrEqual(vp.height + 4);
    }
  });

  test(`first-scroll audit @ ${vp.name} — four Club-health questions are answerable above the fold`, async ({ page }) => {
    await login(page);
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(200);

    // Helper — true iff the testid is in-bounds of the viewport.
    async function inViewport(testId: string): Promise<boolean> {
      const r = await page
        .getByTestId(testId)
        .evaluate((el) => el.getBoundingClientRect());
      return r.top >= 0 && r.bottom <= vp.height + 4;
    }

    // 1. REVENUE HEALTH — answered by the Revenue KPI tile on the
    //    Operations card.
    expect(
      await inViewport("cover-briefing-operations-kpi-revenue"),
      `${vp.name}: REVENUE HEALTH not above the fold`,
    ).toBe(true);

    // 2. OPERATING HEALTH — answered by the Operations card headline
    //    + NOI + Dues-to-Revenue.
    expect(
      await inViewport("cover-briefing-operations-status"),
      `${vp.name}: OPERATING status verdict not above the fold`,
    ).toBe(true);
    expect(
      await inViewport("cover-briefing-operations-kpi-noi"),
      `${vp.name}: OPERATING NOI metric not above the fold`,
    ).toBe(true);
    expect(
      await inViewport("cover-briefing-operations-kpi-dues-rev"),
      `${vp.name}: OPERATING Dues-to-Revenue metric not above the fold`,
    ).toBe(true);

    // 3. BALANCE SHEET HEALTH — answered by the Financial Health card.
    expect(
      await inViewport("cover-briefing-financial-health-status"),
      `${vp.name}: BALANCE SHEET status verdict not above the fold`,
    ).toBe(true);
    for (const key of ["working-capital", "reserve-coverage", "current-ratio", "ar-current"]) {
      expect(
        await inViewport(`cover-briefing-financial-health-kpi-${key}`),
        `${vp.name}: BALANCE SHEET metric ${key} not above the fold`,
      ).toBe(true);
    }

    // 4. CAPITAL HEALTH — answered by the Capital Program card.
    expect(
      await inViewport("cover-briefing-capital-program-status"),
      `${vp.name}: CAPITAL status verdict not above the fold`,
    ).toBe(true);
    for (const key of ["active-projects", "capital-spend-ytd", "reserve-contributions", "reserve-funded"]) {
      expect(
        await inViewport(`cover-briefing-capital-program-kpi-${key}`),
        `${vp.name}: CAPITAL metric ${key} not above the fold`,
      ).toBe(true);
    }

    // BONUS — required actions visible above the fold. Scope the
    // query to the cover briefing column so we don't catch the chips
    // rendered on downstream chapters (which are below the fold).
    const cover = page.getByTestId("monthly-cover-briefing");
    const chips = await cover.getByTestId("board-consideration-chip").all();
    expect(chips.length, `${vp.name}: cover should render three Board Consideration chips`).toBe(3);
    for (let i = 0; i < chips.length; i++) {
      const r = await chips[i].evaluate((el) => el.getBoundingClientRect());
      expect(
        r.bottom,
        `${vp.name}: Board Consideration chip #${i} (bottom ${r.bottom.toFixed(2)}px) not above the fold`,
      ).toBeLessThanOrEqual(vp.height + 4);
    }
  });
}
