import { test, type Page } from "@playwright/test";
import { writeFileSync } from "fs";

// Measures the dues subsidy donut + legend for the visual-refinement
// pass (ring thickness, legend typography, overall balance). Reports
// donut outer diameter, ring thickness, legend font size, legend row
// spacing, and chart-region utilization. Also captures evidence
// screenshots at 1440 × 900 and 1920 × 1080 per the founder spec.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

async function measureRefinement(page: Page) {
  return page.evaluate(() => {
    function r(n: number) { return Math.round(n * 100) / 100; }
    function rect(el: Element | null) {
      if (!el) return null;
      const b = (el as HTMLElement).getBoundingClientRect();
      return { x: r(b.x), y: r(b.y), w: r(b.width), h: r(b.height) };
    }

    const card = document.querySelector("[data-testid='dues-subsidy-analysis']");
    if (!card) return { error: "card not found" } as const;
    const cardR = rect(card);

    const donutRegion = card.querySelector("[data-testid='dues-subsidy-donut']");
    const donutSvg = donutRegion?.querySelector("svg") as SVGSVGElement | null;
    const donutRegionR = donutRegion ? rect(donutRegion) : null;

    // Donut data extent = union of all arc bounding boxes.
    let donutOuterDiameter = 0;
    let ringThicknessPx = 0;
    if (donutSvg) {
      const arcs = Array.from(donutSvg.querySelectorAll("path[data-testid^='dues-arc-']"));
      if (arcs.length > 0) {
        const rects = arcs.map((a) => (a as SVGGraphicsElement).getBoundingClientRect());
        const xMin = Math.min(...rects.map((rr) => rr.x));
        const xMax = Math.max(...rects.map((rr) => rr.x + rr.width));
        donutOuterDiameter = r(xMax - xMin);
        // Ring thickness in viewport pixels — read directly from
        // computed stroke-width on any path. (Convert from SVG units
        // to viewport px via the SVG element's render width.)
        const path0 = arcs[0] as SVGPathElement;
        const strokeUnits = parseFloat(getComputedStyle(path0).strokeWidth);
        // The SVG has viewBox "0 0 200 200" and renders at donutSvg.width.
        const svgRenderWidth = donutSvg.getBoundingClientRect().width;
        ringThicknessPx = r(strokeUnits * (svgRenderWidth / 200));
      }
    }

    // Legend rows.
    const legend = card.querySelector("[data-testid='dues-subsidy-legend']");
    const legendR = legend ? rect(legend) : null;
    const firstRow = legend?.querySelector("[data-testid^='dues-legend-']");
    let legendFontSize = 0;
    let legendRowGap = 0;
    let legendRowHeight = 0;
    if (firstRow) {
      const span = firstRow.querySelector("span:nth-child(2)");
      if (span) legendFontSize = parseFloat(getComputedStyle(span).fontSize);
      const flexParent = legend as HTMLElement;
      legendRowGap = parseFloat(getComputedStyle(flexParent).rowGap || getComputedStyle(flexParent).gap);
      legendRowHeight = r(firstRow.getBoundingClientRect().height);
    }

    // Chart-region utilization: ratio of (legend height + donut height)
    // to card body height. Higher = denser; lower = more whitespace.
    let chartRegionUtilizationPct = 0;
    if (cardR && legendR && donutRegionR) {
      const cardBodyHeight = cardR.h;
      const contentHeight = Math.max(legendR.h, donutRegionR.h);
      chartRegionUtilizationPct = r((contentHeight / cardBodyHeight) * 100);
    }

    return {
      cardWidth: cardR?.w ?? 0,
      cardHeight: cardR?.h ?? 0,
      donutOuterDiameter,
      ringThicknessPx,
      legendFontSize,
      legendRowGap,
      legendRowHeight,
      chartRegionUtilizationPct,
    };
  });
}

const VIEWPORTS = [
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
];

test("dues donut: refinement measurements at 1440 + 1920", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.locator("[data-testid='reporting-chapter-financial-performance']").click();
  await page.waitForTimeout(800);

  const report: any[] = [];
  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.w, height: v.h });
    await page.waitForTimeout(300);
    await page.locator("[data-testid='dues-subsidy-analysis']").scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    const m = await measureRefinement(page);
    report.push({ viewport: `${v.w}x${v.h}`, ...m });
    await page.locator("[data-testid='dues-subsidy-analysis']").screenshot({
      path: `test-results/dues-donut-refinement-${v.w}.png`,
    });
  }

  writeFileSync(
    "test-results/dues-donut-refinement.json",
    JSON.stringify(report, null, 2),
    "utf8",
  );
});
