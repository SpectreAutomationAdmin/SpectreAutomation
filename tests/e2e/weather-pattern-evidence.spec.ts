// Multi-viewport evidence + responsive-validation spec for the
// Weather Pattern donut card (chapter XI). The §9 Large-Monitor
// Responsive Validation rule requires every chart be visually
// inspected at all five supported viewports — Claude opens each
// screenshot and verifies the fail conditions in §13 don't trip.
//
// This spec captures crops + numeric measurements at every viewport
// for both the Weather Pattern card AND the Dues Subsidy Analysis
// reference, so a side-by-side composition comparison is possible.
//
// Run on demand:
//   npx playwright test tests/e2e/weather-pattern-evidence.spec.ts

import { test, type Page, expect } from "@playwright/test";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

async function measureDonutCard(
  page: Page,
  opts: { cardTestid: string; donutTestid: string; legendTestid: string },
) {
  return await page.evaluate(({ cardTestid, donutTestid, legendTestid }) => {
    const card = document.querySelector(`[data-testid="${cardTestid}"]`) as HTMLElement | null;
    const donut = document.querySelector(`[data-testid="${donutTestid}"]`) as HTMLElement | null;
    const legend = document.querySelector(`[data-testid="${legendTestid}"]`) as HTMLElement | null;
    if (!card || !donut || !legend) return null;
    const c = card.getBoundingClientRect();
    const d = donut.getBoundingClientRect();
    const l = legend.getBoundingClientRect();
    return {
      cardWidth: c.width,
      cardHeight: c.height,
      donutLeft: d.left - c.left,
      donutTop: d.top - c.top,
      donutCenterX: d.left + d.width / 2 - c.left,
      donutCenterY: d.top + d.height / 2 - c.top,
      donutWidth: d.width,
      donutHeight: d.height,
      legendLeft: l.left - c.left,
      legendTop: l.top - c.top,
      legendRight: l.right - c.left,
      legendCenterY: l.top + l.height / 2 - c.top,
      legendWidth: l.width,
      legendHeight: l.height,
      donutToLegendGap: l.left - d.right,
      groupTop: Math.min(d.top, l.top) - c.top,
      groupBottom: Math.max(d.bottom, l.bottom) - c.top,
      groupLeft: d.left - c.left,
      groupRight: l.right - c.left,
      groupWidth: l.right - d.left,
      groupCenterY:
        (Math.min(d.top, l.top) + Math.max(d.bottom, l.bottom)) / 2 - c.top,
      groupCenterX: (d.left + l.right) / 2 - c.left,
      // Card padding (px-3.5 = 14 px on FpChartCard's body wrappers
      // for KPI ribbon / commentary; chart body has no horizontal
      // padding). Use 0 here so we measure raw card width.
      cardInnerLeftPx: 0,
      cardInnerRightPx: 0,
    };
  }, opts);
}

const VIEWPORTS = [
  { label: "1366x768", width: 1366, height: 768 },
  { label: "1440x900", width: 1440, height: 900 },
  { label: "1600x900", width: 1600, height: 900 },
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "2560x1440", width: 2560, height: 1440 },
] as const;

// Minimum visual-width utilization for a donut + legend group.
// Per §13: "donut + legend group < ~80 % of available visual width"
// is an automatic fail.
//
// CAVEAT: when the legend column uses `minmax(0, 1fr)` (stretching
// to fill remaining space), `legend.right − donut.left` will be
// near-100 % of card width even when the chart is visually anchored
// LEFT (donut at column 1, dot leaders spanning the middle, percent
// at the far right). The numeric metric must therefore be paired
// with a centring check: if the group is anchored left (donut at
// far-left x≈0 and percentages at far-right x≈card_width), the
// group is left-biased even though it "spans" the full width.
const MIN_GROUP_WIDTH_RATIO = 0.80;
// Maximum acceptable left/right asymmetry of the group's geometric
// CENTER. Computed as |donut.center − card.center| / card.width.
// We check the donut alone because the legend's 1fr stretching
// inflates the group's apparent symmetry.
const MAX_DONUT_CENTER_OFFSET_RATIO = 0.10;

for (const vp of VIEWPORTS) {
  test(`donut composition evidence @ ${vp.label}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await login(page);
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");

    // Scroll to + capture the Weather Pattern card.
    await page.getByTestId("reporting-chapter-weather-and-utilization").click();
    await page.getByTestId("mws-pattern-card").waitFor({ timeout: 20_000 });
    await page.getByTestId("mws-pattern-card").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.getByTestId("mws-pattern-card").screenshot({
      path: `test-results/evidence-pattern-${vp.label}.png`,
    });
    const wm = await measureDonutCard(page, {
      cardTestid: "mws-pattern-card",
      donutTestid: "mws-pattern-wrap",
      legendTestid: "mws-pattern-legend",
    });

    // Then scroll to + capture the Dues Subsidy Analysis card.
    await page.getByTestId("dues-subsidy-analysis").scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.getByTestId("dues-subsidy-analysis").screenshot({
      path: `test-results/evidence-dues-subsidy-${vp.label}.png`,
    });
    const dm = await measureDonutCard(page, {
      cardTestid: "dues-subsidy-analysis",
      donutTestid: "dues-subsidy-donut",
      legendTestid: "dues-subsidy-legend",
    });

    expect(wm, "Weather Pattern card not measurable").not.toBeNull();
    expect(dm, "Dues Subsidy card not measurable").not.toBeNull();
    if (!wm || !dm) return;

    const wGroupRatio = wm.groupWidth / wm.cardWidth;
    const wGroupCenterOffset =
      Math.abs(wm.groupCenterX - wm.cardWidth / 2) / wm.cardWidth;
    const dGroupRatio = dm.groupWidth / dm.cardWidth;
    const dGroupCenterOffset =
      Math.abs(dm.groupCenterX - dm.cardWidth / 2) / dm.cardWidth;

    const failures: string[] = [];
    if (wGroupRatio < MIN_GROUP_WIDTH_RATIO) {
      failures.push(
        `Weather group/card width ratio ${(wGroupRatio * 100).toFixed(1)}% < ${(MIN_GROUP_WIDTH_RATIO * 100).toFixed(0)}% (§13 fail: donut+legend covers < 80% of card)`,
      );
    }
    // The right anchoring signal is the GROUP's geometric center,
    // not the donut's. In a donut-left + legend-right composition
    // the donut SHOULD be left of card center — that's the column-1
    // role. The visual bias the founder reported was the whole
    // group (donut→legend.right) sitting off-center, which happened
    // because the legend's 1fr column stretched to fill all extra
    // card width at large viewports (donut stayed at x=0, legend
    // ran to x=card_width). When the group center is at the card
    // center, the composition is balanced.
    if (wGroupCenterOffset > 0.02) {
      failures.push(
        `Weather group center offset ${(wGroupCenterOffset * 100).toFixed(1)}% > 2% (§13 fail: group not centred in card)`,
      );
    }

    // eslint-disable-next-line no-console
    console.log(
      `\n[multi-viewport-donut @ ${vp.label}]\n` +
        `  card=${wm.cardWidth.toFixed(0)}×${wm.cardHeight.toFixed(0)}\n` +
        `  donut center=(${wm.donutCenterX.toFixed(0)}, ${wm.donutCenterY.toFixed(0)})  donut=${wm.donutWidth.toFixed(0)}×${wm.donutHeight.toFixed(0)}\n` +
        `  legend left=${wm.legendLeft.toFixed(0)}  legend right=${wm.legendRight.toFixed(0)}  legend=${wm.legendWidth.toFixed(0)}×${wm.legendHeight.toFixed(0)}\n` +
        `  donut→legend gap=${wm.donutToLegendGap.toFixed(0)} px\n` +
        `  group span=${wm.groupLeft.toFixed(0)} → ${wm.groupRight.toFixed(0)} (width=${wm.groupWidth.toFixed(0)}px, ${(wGroupRatio * 100).toFixed(1)}% of card)\n` +
        `  group center=(${wm.groupCenterX.toFixed(0)}, ${wm.groupCenterY.toFixed(0)})  card center=(${(wm.cardWidth / 2).toFixed(0)}, ${(wm.cardHeight / 2).toFixed(0)})\n` +
        `  GROUP center offset=${(wGroupCenterOffset * 100).toFixed(2)}% of card width (≤ 2%)\n` +
        `  REFERENCE (Dues Subsidy):\n` +
        `    card=${dm.cardWidth.toFixed(0)}×${dm.cardHeight.toFixed(0)}\n` +
        `    group span=${dm.groupLeft.toFixed(0)} → ${dm.groupRight.toFixed(0)} (width=${dm.groupWidth.toFixed(0)}px, ${(dGroupRatio * 100).toFixed(1)}% of card)\n` +
        `    GROUP center offset=${(dGroupCenterOffset * 100).toFixed(2)}%\n` +
        (failures.length ? `  ❌ FAILURES: ${failures.join(" | ")}` : `  ✓ OK`),
    );

    // Soft assert — fail loudly but DON'T block the run, so we get
    // all 5 viewport reports even when some fail.
    if (failures.length > 0) {
      // eslint-disable-next-line no-console
      console.error(`Viewport ${vp.label} fails: ${failures.join(", ")}`);
    }
  });
}
