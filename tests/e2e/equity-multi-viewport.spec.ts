import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";

// Measures the Equity Value Over Time card at five viewport widths to
// expose any fixed-width caps on the chart. For each viewport,
// captures:
//   - Equity card inner width
//   - KPI row outer span (Actual CAGR LEFT → Current Equity RIGHT)
//   - SVG element rendered width
//   - First / last plotted data point X (via circle.getBBox + CTM)
//   - Plot utilization (data span / KPI row span)
//   - Left and right gutters relative to the KPI row
// Writes one report row per viewport to a JSON file the variance
// diagnosis reads back.

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

const VIEWPORTS = [
  { w: 1366, h: 768 },
  { w: 1440, h: 900 },
  { w: 1600, h: 900 },
  { w: 1920, h: 1080 },
  { w: 2560, h: 1440 },
];

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

async function measureEquity(page: Page) {
  return page.evaluate(() => {
    function r(n: number) { return Math.round(n * 100) / 100; }
    function rect(el: Element | null) {
      if (!el) return null;
      const b = (el as HTMLElement).getBoundingClientRect();
      return { x: r(b.x), w: r(b.width), right: r(b.x + b.width) };
    }
    const card = document.querySelector("[data-testid='stewardship-equity']");
    if (!card) return { error: "card not found" } as const;
    const cardR = rect(card);
    const ribbon = card.querySelector(".grid.grid-cols-4");
    const tiles = Array.from(ribbon?.children ?? []) as HTMLElement[];
    const acTile = tiles[0] ?? null;
    const ceTile = tiles[3] ?? null;
    const acR = rect(acTile);
    const ceR = rect(ceTile);
    const svg = card.querySelector("svg") as SVGSVGElement | null;
    const svgR = rect(svg);
    const ctm = svg?.getScreenCTM() ?? null;

    let firstX: number | null = null;
    let lastX: number | null = null;
    if (svg && ctm) {
      const circles = Array.from(svg.querySelectorAll("circle"));
      const xs: number[] = [];
      for (const c of circles) {
        try {
          const bb = (c as SVGCircleElement).getBBox();
          const p = svg.createSVGPoint();
          p.x = bb.x + bb.width / 2;
          p.y = bb.y + bb.height / 2;
          const s = p.matrixTransform(ctm);
          xs.push(s.x);
        } catch {}
      }
      if (xs.length) {
        firstX = r(Math.min(...xs));
        lastX = r(Math.max(...xs));
      }
    }

    const kpiRowLeft = acR?.x ?? 0;
    const kpiRowRight = ceR?.right ?? 0;
    const kpiRowWidth = kpiRowRight - kpiRowLeft;
    const dataSpan = firstX != null && lastX != null ? lastX - firstX : null;
    const leftGutter = firstX != null ? firstX - kpiRowLeft : null;
    const rightGutter = lastX != null ? kpiRowRight - lastX : null;
    const plotUtilRatio = dataSpan != null && kpiRowWidth > 0 ? r((dataSpan / kpiRowWidth) * 100) : null;

    return {
      cardWidth: cardR?.w ?? null,
      kpiRowLeft: r(kpiRowLeft),
      kpiRowRight: r(kpiRowRight),
      kpiRowWidth: r(kpiRowWidth),
      svgWidth: svgR?.w ?? null,
      firstX,
      lastX,
      dataSpan: dataSpan != null ? r(dataSpan) : null,
      leftGutter: leftGutter != null ? r(leftGutter) : null,
      rightGutter: rightGutter != null ? r(rightGutter) : null,
      plotUtilRatio,
    };
  });
}

test("equity card across viewports", async ({ page }) => {
  // Set a stable viewport before login so the chapter rail (hidden
  // below lg=1024) is visible and clickable on the first navigation.
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-financial-performance").waitFor({ timeout: 20_000 });
  await page.getByTestId("reporting-chapter-financial-performance").click();
  await page.waitForTimeout(600);

  const report: any[] = [];
  for (const v of VIEWPORTS) {
    await page.setViewportSize({ width: v.w, height: v.h });
    await page.waitForTimeout(300);
    await page.locator("[data-testid='stewardship-equity']").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const m = await measureEquity(page);
    report.push({ viewport: `${v.w}x${v.h}`, ...m });
    // Screenshot at the two endpoints the founder asked for.
    if (v.w === 1440) {
      await page.screenshot({ path: "test-results/equity-multi-vp-1440.png", fullPage: false });
    }
    if (v.w === 1920) {
      await page.screenshot({ path: "test-results/equity-multi-vp-1920.png", fullPage: false });
    }
    if (v.w === 2560) {
      await page.screenshot({ path: "test-results/equity-multi-vp-2560.png", fullPage: false });
    }
  }

  writeFileSync("test-results/equity-multi-viewport.json", JSON.stringify(report, null, 2), "utf8");

  // ─────────────────────────────────────────────────────────────
  // LOCKED BASELINE — Rule 13 / responsive behaviour.
  //
  // The fixed-viewBox bug shipped a chart that looked correct at
  // 1440 × 900 but capped its data span at the same ~500 px across
  // 1600 / 1920 / 2560 viewports — the gutter ballooned, the chart
  // stayed small. The ResizeObserver fix made the viewBox width
  // track the container width.
  //
  // Regression guard: the data span (first → last data marker)
  // MUST grow with the card. Specifically:
  //   - dataSpan(1920) > dataSpan(1440)
  //   - dataSpan(2560) > dataSpan(1920)
  // And the plot utilisation ratio MUST hold reasonably steady
  // across viewports (the chart fills the card; it doesn't pool
  // cream around a fixed-width SVG).
  // ─────────────────────────────────────────────────────────────
  const by = (w: number) => report.find((r) => (r.viewport as string).startsWith(`${w}x`));
  const r1440 = by(1440), r1600 = by(1600), r1920 = by(1920), r2560 = by(2560);
  expect.soft(r1440, "1440 row present").toBeTruthy();
  expect.soft(r1600, "1600 row present").toBeTruthy();
  expect.soft(r1920, "1920 row present").toBeTruthy();
  expect.soft(r2560, "2560 row present").toBeTruthy();

  const r1366 = by(1366);
  if (r1366 && r1440 && r1600 && r1920 && r2560) {
    // Rule 13 / no-fixed-viewBox guard. The historical bug was a
    // viewBox 600 × 200 + preserveAspectRatio="meet": the SVG's
    // data span CAPPED at ~503 px while the card widened to 800 +,
    // ballooning the right gutter to ~100 px. We assert the
    // INVERSE — both invariants below would fail if that bug
    // returned:
    //
    //   (a) right gutter ≤ 4 px at EVERY viewport (alignment with
    //       Current Equity tile holds at all sizes, not just 1440)
    //   (b) data span grows whenever the CARD grows. (The card may
    //       cap at the page-layout max-width; that's app-level
    //       composition, not a chart cap. So we only require growth
    //       when cardWidth itself grew.)
    //
    // Plot utilisation stays comfortably above 90 % across the
    // range — small viewports lose a little to the structural
    // y-axis band (~30 px), but the chart still fills the row.
    const rows = [r1366, r1440, r1600, r1920, r2560];

    for (const r of rows) {
      expect.soft(r.rightGutter, `Rule 13 — right gutter ≤ 4 px at ${r.viewport} (no viewBox cap)`)
        .toBeLessThanOrEqual(4);
      expect.soft(r.plotUtilRatio, `Rule 13 — plot util ≥ 90 % at ${r.viewport}`)
        .toBeGreaterThanOrEqual(90);
      expect.soft(r.plotUtilRatio, `Rule 13 — plot util ≤ 105 % at ${r.viewport}`)
        .toBeLessThanOrEqual(105);
    }

    // Data-span monotonicity, conditional on card growth. If the
    // viewBox were capped, dataSpan would stop growing well before
    // cardWidth did.
    for (let i = 1; i < rows.length; i++) {
      const prev = rows[i - 1], cur = rows[i];
      if (cur.cardWidth > prev.cardWidth + 1) {
        expect.soft(
          cur.dataSpan,
          `Rule 13 — dataSpan grows when card grows: ${prev.viewport} (card ${prev.cardWidth}) → ${cur.viewport} (card ${cur.cardWidth})`,
        ).toBeGreaterThan(prev.dataSpan);
      }
    }
  }
});
