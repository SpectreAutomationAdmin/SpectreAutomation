import { test, expect, type Page } from "@playwright/test";

// Cover Executive Briefing spec — proves the redesigned two-column
// cover (Saguaro p01 pattern) shows three briefing cards + their
// status, narrative, KPI rows, and Board Consideration chips in the
// first viewport. Captures a screenshot for the founder test.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const VIEWPORT = { width: 1440, height: 900 };

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("cover Executive Briefing renders all three cards above the fold", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(200);

  const viewport = page.viewportSize();
  if (!viewport) throw new Error("viewport size unavailable");

  // All three briefing cards must be present.
  await expect(page.getByTestId("cover-briefing-operations")).toBeVisible();
  await expect(page.getByTestId("cover-briefing-financial-health")).toBeVisible();
  await expect(page.getByTestId("cover-briefing-capital-program")).toBeVisible();

  // Each card's bottom edge must be at or above the viewport bottom —
  // a director sees all three without scrolling.
  for (const key of ["operations", "financial-health", "capital-program"]) {
    const bottom = await page
      .getByTestId(`cover-briefing-${key}`)
      .evaluate((el) => el.getBoundingClientRect().bottom);
    expect(
      bottom,
      `cover-briefing-${key} bottom (${bottom}px) must be within the ${viewport.height}px viewport`,
    ).toBeLessThanOrEqual(viewport.height + 4);
  }

  // The anchor link to chapter II must be visible too.
  // "Read full memos →" anchor REMOVED — the briefing column now uses
  // the freed vertical space to distribute its three cards evenly so
  // the bottom edge of the stack tracks the bottom of the identity
  // column's at-a-glance block.
  await expect(page.getByTestId("monthly-cover-briefing-link")).toHaveCount(0);

  await page.screenshot({
    path: "test-results/cover-briefing-redesign.png",
    fullPage: false,
  });
});

test("Operations briefing card — headline-dominant anatomy with 3 Operating Health metrics", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  const ops = page.getByTestId("cover-briefing-operations");

  // 1. Title eyebrow — category label, smallcaps.
  await expect(ops.getByTestId("cover-briefing-operations-title")).toContainText(/operations/i);
  // 2. Question caption — the briefing question this card answers.
  await expect(ops.getByTestId("cover-briefing-operations-question"))
    .toContainText(/Are we operating successfully\?/);
  // 3. HEADLINE — status verdict, one of the three documented states.
  const statusText = await ops.getByTestId("cover-briefing-operations-status").textContent();
  expect(statusText).toMatch(/^(On Plan|Watch|Off Plan)$/);
  // 4. Narrative — sits between headline and metrics.
  await expect(ops.getByTestId("cover-briefing-operations-narrative")).toBeVisible();
  // 5. Three Operating Health metrics from the first-scroll standard.
  await expect(ops.getByTestId("cover-briefing-operations-kpi-revenue")).toBeVisible();
  await expect(ops.getByTestId("cover-briefing-operations-kpi-revenue")).toContainText(/Revenue/);
  await expect(ops.getByTestId("cover-briefing-operations-kpi-noi")).toBeVisible();
  await expect(ops.getByTestId("cover-briefing-operations-kpi-noi")).toContainText(/NOI/);
  await expect(ops.getByTestId("cover-briefing-operations-kpi-dues-rev")).toBeVisible();
  await expect(ops.getByTestId("cover-briefing-operations-kpi-dues-rev")).toContainText(/Dues-to-Revenue/);
  // 6. Board Consideration footer REMOVED from cover briefing cards —
  //    the footer was consuming vertical space and squeezing the
  //    narrative; the governance signal still renders in every
  //    long-form commentary block downstream via BoardConsiderationChip.
  await expect(ops.getByTestId("board-consideration-chip")).toHaveCount(0);

  // Visual hierarchy — the CONCLUSION must be visually dominant.
  // After the Saguaro-style redesign the conclusion bumped from
  // text-2xl (24 px) to text-[26px] base / text-[30px] at ≥880px
  // viewport heights so it out-weighs the narrative; metric values
  // stay at text-base (~16 px). Conclusion must be strictly larger
  // than metric values.
  const statusFontPx = await ops
    .getByTestId("cover-briefing-operations-status")
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const revenueValueFontPx = await page
    .locator('[data-testid="cover-briefing-operations-kpi-revenue"] dd')
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(
    statusFontPx,
    `status headline (${statusFontPx}px) must be larger than metric value (${revenueValueFontPx}px)`,
  ).toBeGreaterThan(revenueValueFontPx);
});

test("Financial Health briefing card — headline-dominant anatomy with 4 Financial Health metrics", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  const fh = page.getByTestId("cover-briefing-financial-health");

  // 1. Title eyebrow.
  await expect(fh.getByTestId("cover-briefing-financial-health-title")).toContainText(/Financial Health/i);
  // 2. Question caption.
  await expect(fh.getByTestId("cover-briefing-financial-health-question"))
    .toContainText(/Is the Club financially healthy\?/);
  // 3. HEADLINE — status verdict, one of the four documented states.
  const statusText = await fh.getByTestId("cover-briefing-financial-health-status").textContent();
  expect(statusText).toMatch(/^(Strong Position|Stable|Watch|Concern)$/);
  // 4. Narrative.
  await expect(fh.getByTestId("cover-briefing-financial-health-narrative")).toBeVisible();
  // 5. Four Financial Health metrics from the first-scroll standard.
  await expect(fh.getByTestId("cover-briefing-financial-health-kpi-working-capital")).toBeVisible();
  await expect(fh.getByTestId("cover-briefing-financial-health-kpi-working-capital"))
    .toContainText(/Working Capital/i);
  await expect(fh.getByTestId("cover-briefing-financial-health-kpi-reserve-coverage")).toBeVisible();
  await expect(fh.getByTestId("cover-briefing-financial-health-kpi-reserve-coverage"))
    .toContainText(/Reserve Coverage/i);
  await expect(fh.getByTestId("cover-briefing-financial-health-kpi-current-ratio")).toBeVisible();
  await expect(fh.getByTestId("cover-briefing-financial-health-kpi-current-ratio"))
    .toContainText(/Current Ratio/i);
  await expect(fh.getByTestId("cover-briefing-financial-health-kpi-ar-current")).toBeVisible();
  await expect(fh.getByTestId("cover-briefing-financial-health-kpi-ar-current"))
    .toContainText(/AR Current/i);
  // 6. Board Consideration footer REMOVED — see Operations card.
  await expect(fh.getByTestId("board-consideration-chip")).toHaveCount(0);

  // Visual hierarchy — headline must be visually dominant. Status
  // font-size must exceed metric value font-size, mirroring the
  // Operations card's hierarchy guarantee.
  const statusFontPx = await fh
    .getByTestId("cover-briefing-financial-health-status")
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const wcValueFontPx = await page
    .locator('[data-testid="cover-briefing-financial-health-kpi-working-capital"] dd')
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(
    statusFontPx,
    `status headline (${statusFontPx}px) must be larger than metric value (${wcValueFontPx}px)`,
  ).toBeGreaterThan(wcValueFontPx);
});

test("Capital Program briefing card — headline-dominant anatomy with 4 Capital Health metrics", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  const cp = page.getByTestId("cover-briefing-capital-program");

  // 1. Title eyebrow.
  await expect(cp.getByTestId("cover-briefing-capital-program-title")).toContainText(/Capital Program/i);
  // 2. Question caption.
  await expect(cp.getByTestId("cover-briefing-capital-program-question"))
    .toContainText(/Are capital projects and reserve investments being executed properly\?/);
  // 3. HEADLINE — status verdict, one of the four documented states.
  // Capital cascade: Executing / Monitor / Delayed / Critical.
  const statusText = await cp.getByTestId("cover-briefing-capital-program-status").textContent();
  expect(statusText).toMatch(/^(Executing|Monitor|Delayed|Critical)$/);
  // 4. Narrative.
  await expect(cp.getByTestId("cover-briefing-capital-program-narrative")).toBeVisible();
  // 5. Four Capital Health metrics from the first-scroll standard.
  await expect(cp.getByTestId("cover-briefing-capital-program-kpi-active-projects")).toBeVisible();
  await expect(cp.getByTestId("cover-briefing-capital-program-kpi-active-projects"))
    .toContainText(/Active Projects/i);
  await expect(cp.getByTestId("cover-briefing-capital-program-kpi-capital-spend-ytd")).toBeVisible();
  await expect(cp.getByTestId("cover-briefing-capital-program-kpi-capital-spend-ytd"))
    .toContainText(/Capital Spend YTD/i);
  await expect(cp.getByTestId("cover-briefing-capital-program-kpi-reserve-contributions")).toBeVisible();
  await expect(cp.getByTestId("cover-briefing-capital-program-kpi-reserve-contributions"))
    .toContainText(/Reserve Contributions/i);
  await expect(cp.getByTestId("cover-briefing-capital-program-kpi-reserve-funded")).toBeVisible();
  await expect(cp.getByTestId("cover-briefing-capital-program-kpi-reserve-funded"))
    .toContainText(/Reserve Funded/i);
  // 6. Board Consideration footer REMOVED — see Operations card.
  await expect(cp.getByTestId("board-consideration-chip")).toHaveCount(0);

  // Visual hierarchy — headline must be visually dominant. Status
  // font-size must exceed metric value font-size, mirroring the
  // Operations + Financial Health cards' hierarchy guarantee.
  const statusFontPx = await cp
    .getByTestId("cover-briefing-capital-program-status")
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const apValueFontPx = await page
    .locator('[data-testid="cover-briefing-capital-program-kpi-active-projects"] dd')
    .first()
    .evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(
    statusFontPx,
    `status headline (${statusFontPx}px) must be larger than metric value (${apValueFontPx}px)`,
  ).toBeGreaterThan(apValueFontPx);
});

test("cover identity column carries club name + period + committee + framework colophon", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");

  // Identity stack present.
  await expect(page.getByTestId("monthly-cover-identity")).toBeVisible();
  await expect(page.getByTestId("monthly-cover-club-name")).toContainText(/Silver Springs/i);
  await expect(page.getByTestId("monthly-cover-period")).toContainText(/For the period ended May 31, 2026/);
  await expect(page.getByTestId("monthly-cover-prepared-for")).toContainText(/Finance Committee/);
  // "Prepared on …" line REMOVED from the cover — the period-ended
  // subtitle carries the reporting date now.
  await expect(page.getByTestId("monthly-cover-meta")).toHaveCount(0);
  await expect(page.getByTestId("monthly-cover-framework")).toContainText(/Spectre Framework/);
});
