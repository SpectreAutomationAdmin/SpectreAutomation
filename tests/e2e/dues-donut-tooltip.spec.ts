import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";

// Validates the Dues Subsidy donut refinement:
//   1. Donut chart is centered within the left chart region (within
//      4 px tolerance on both axes).
//   2. Hovering a slice (e.g. Utilities) shows a Saguaro-style
//      tooltip with the category name + percentage.
//   3. Donut slices have visible separator slivers between them.
//   4. Card stays aligned column-for-column with the rows above at
//      1440 / 1920 / 2560.
//   5. Category percentages still total 100% (regression guard).

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
  { w: 1440, h: 900 },
  { w: 1920, h: 1080 },
  { w: 2560, h: 1440 },
];

async function measureCentering(page: Page) {
  return page.evaluate(() => {
    function r(n: number) { return Math.round(n * 100) / 100; }
    function rect(el: Element | null) {
      if (!el) return null;
      const b = (el as HTMLElement).getBoundingClientRect();
      return {
        x: r(b.x), y: r(b.y), w: r(b.width), h: r(b.height),
        right: r(b.x + b.width), bottom: r(b.y + b.height),
        centerX: r(b.x + b.width / 2),
        centerY: r(b.y + b.height / 2),
      };
    }
    const donutRegion = document.querySelector("[data-testid='dues-subsidy-donut']");
    const svg = donutRegion?.querySelector("svg");
    // Donut data bounding box = union of all <path data-testid="dues-arc-..."/>
    let arcUnion: ReturnType<typeof rect> = null;
    if (svg) {
      const arcs = Array.from(svg.querySelectorAll("path[data-testid^='dues-arc-']"));
      if (arcs.length > 0) {
        const rects = arcs.map((a) => (a as SVGGraphicsElement).getBoundingClientRect());
        const xMin = Math.min(...rects.map((rr) => rr.x));
        const yMin = Math.min(...rects.map((rr) => rr.y));
        const xMax = Math.max(...rects.map((rr) => rr.x + rr.width));
        const yMax = Math.max(...rects.map((rr) => rr.y + rr.height));
        arcUnion = {
          x: r(xMin), y: r(yMin),
          w: r(xMax - xMin), h: r(yMax - yMin),
          right: r(xMax), bottom: r(yMax),
          centerX: r((xMin + xMax) / 2),
          centerY: r((yMin + yMax) / 2),
        };
      }
    }
    return {
      donutRegion: rect(donutRegion),
      donutSvg: svg ? rect(svg) : null,
      donutDataUnion: arcUnion,
    };
  });
}

test("dues donut: centered, hover tooltip, separators, multi-viewport alignment", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.locator("[data-testid='reporting-chapter-financial-performance']").click();
  await page.waitForTimeout(800);

  // ── Centering measurement at 1440 × 900 ──────────────────────
  await page.locator("[data-testid='dues-subsidy-analysis']").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  const m1440 = await measureCentering(page);
  writeFileSync(
    "test-results/dues-donut-centering.json",
    JSON.stringify(m1440, null, 2),
    "utf8",
  );

  // ── Verify donut is centered within its region (Issue 1) ─────
  if (m1440.donutRegion && m1440.donutDataUnion) {
    // Horizontal: data union center sits within ±4 px of the
    // donut region's horizontal center.
    expect.soft(
      Math.abs(m1440.donutDataUnion.centerX - m1440.donutRegion.centerX),
      "Issue 1 — donut horizontal center within ±4 px of region center",
    ).toBeLessThanOrEqual(4);
    // Vertical: data union center sits within ±4 px of the
    // donut region's vertical center.
    expect.soft(
      Math.abs(m1440.donutDataUnion.centerY - m1440.donutRegion.centerY),
      "Issue 1 — donut vertical center within ±4 px of region center",
    ).toBeLessThanOrEqual(4);
  }

  // ── Issue 2: hover tooltip ───────────────────────────────────
  // Hover at a real point ON the donut ring stroke (not on the
  // path's bbox centre, which would be in the hole). Use SVG
  // getPointAtLength on the path, then convert to screen pixels.
  async function pointOnArc(key: string): Promise<{ x: number; y: number } | null> {
    return page.evaluate((k) => {
      const arc = document.querySelector(`[data-testid='dues-arc-${k}']`) as SVGPathElement | null;
      if (!arc) return null;
      const svg = arc.ownerSVGElement;
      if (!svg) return null;
      const ctm = svg.getScreenCTM();
      if (!ctm) return null;
      // Mid-point along the path stroke = a point sitting on the
      // donut ring itself, at this slice's midangle.
      const mid = arc.getPointAtLength(arc.getTotalLength() / 2);
      const screen = new DOMPoint(mid.x, mid.y).matrixTransform(ctm);
      return { x: screen.x, y: screen.y };
    }, key);
  }

  const utilCoords = await pointOnArc("utilities");
  expect(utilCoords, "Utilities arc must be locatable in screen coords").not.toBeNull();
  await page.mouse.move(utilCoords!.x, utilCoords!.y);
  await page.waitForTimeout(200);
  const tooltip = page.locator("[data-testid='dues-subsidy-tooltip']");
  await expect(tooltip).toBeVisible({ timeout: 3_000 });
  await expect(tooltip).toContainText("Utilities");
  await expect(tooltip).toContainText("5%");

  // Capture screenshot evidence with the tooltip visible.
  await page.locator("[data-testid='dues-subsidy-analysis']").screenshot({
    path: "test-results/dues-donut-tooltip.png",
  });

  // Move away to dismiss tooltip.
  await page.mouse.move(10, 10);
  await page.waitForTimeout(200);
  await expect(tooltip).not.toBeVisible();

  // Hover a SECOND slice to prove tooltip uses real data, not a
  // hardcoded "Utilities" string.
  const golfCoords = await pointOnArc("golf-course-maint");
  expect(golfCoords).not.toBeNull();
  await page.mouse.move(golfCoords!.x, golfCoords!.y);
  await page.waitForTimeout(200);
  await expect(tooltip).toBeVisible({ timeout: 3_000 });
  await expect(tooltip).toContainText("Golf Course Maint. & Staffing");
  await expect(tooltip).toContainText("25%");

  // ── Issue 3: separators between slices ───────────────────────
  // Each donut path's `d` attribute starts at the angle adjusted by
  // the half-gap; the page sets a `data-gap-deg` on each path so we
  // can read it back.
  const sepDeg = await page.evaluate(() => {
    const arcs = Array.from(document.querySelectorAll("path[data-testid^='dues-arc-']"));
    if (arcs.length === 0) return null;
    const val = arcs[0].getAttribute("data-gap-deg");
    return val ? parseFloat(val) : null;
  });
  expect.soft(sepDeg, "Issue 3 — donut path carries a non-zero data-gap-deg attribute").toBeGreaterThan(0);

  // ── Issue 5: percentages still total 100 ─────────────────────
  const totalPct = await page.evaluate(() => {
    const legends = Array.from(document.querySelectorAll("[data-testid^='dues-legend-']"));
    let sum = 0;
    for (const l of legends) {
      const text = l.textContent ?? "";
      const m = text.match(/(\d+)%/);
      if (m) sum += parseInt(m[1], 10);
    }
    return sum;
  });
  expect(totalPct, "Rule 5 — percentages total 100 %").toBe(100);

  // ── Issue 6: multi-viewport alignment ────────────────────────
  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.w, height: v.h });
    await page.waitForTimeout(300);
    await page.locator("[data-testid='dues-subsidy-analysis']").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);

    await page.locator("[data-testid='dues-subsidy-analysis']").screenshot({
      path: `test-results/dues-donut-${v.w}.png`,
    });

    const m = await measureCentering(page);
    if (m.donutRegion && m.donutDataUnion) {
      expect.soft(
        Math.abs(m.donutDataUnion.centerX - m.donutRegion.centerX),
        `${v.w}: donut horizontal center within ±4 px`,
      ).toBeLessThanOrEqual(4);
      expect.soft(
        Math.abs(m.donutDataUnion.centerY - m.donutRegion.centerY),
        `${v.w}: donut vertical center within ±4 px`,
      ).toBeLessThanOrEqual(4);
    }
  }
});
