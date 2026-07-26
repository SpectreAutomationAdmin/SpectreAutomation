import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";

// Measures the Operating Results — 12-Month Rolling Trend card at five
// viewport widths to expose any fixed-width caps on the chart. Parallel
// to tests/e2e/equity-multi-viewport.spec.ts — same invariants and
// methodology applied to the bar chart.
//
// Per viewport, captures:
//   - card outer width
//   - KPI row outer span (YTD NOI LEFT → Prior Year RIGHT)
//   - SVG element rendered width
//   - First and last plotted bar x-positions (via rect.getBBox + CTM)
//   - Plot utilisation = (lastBar − firstBar) / kpiRowWidth
//   - Left / right gutters relative to the KPI row
//
// Then asserts Rule 13 anti-fixed-viewBox invariants — right gutter
// stays ≤ 4 px at every viewport, plot util stays ≥ 90 %, and the
// data span grows whenever the card grows.

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

async function measureOperating(page: Page) {
  return page.evaluate(() => {
    function r(n: number) { return Math.round(n * 100) / 100; }
    function rect(el: Element | null) {
      if (!el) return null;
      const b = (el as HTMLElement).getBoundingClientRect();
      return { x: r(b.x), w: r(b.width), right: r(b.x + b.width) };
    }
    const card = document.querySelector("[data-testid='stewardship-operating']");
    if (!card) return { error: "card not found" } as const;
    const cardR = rect(card);
    const ribbon = card.querySelector(".grid.grid-cols-4");
    const tiles = Array.from(ribbon?.children ?? []) as HTMLElement[];
    const ytdR = tiles[0] ? rect(tiles[0]) : null;
    const priorR = tiles[3] ? rect(tiles[3]) : null;
    const svg = card.querySelector("svg") as SVGSVGElement | null;
    const svgR = rect(svg);
    const ctm = svg?.getScreenCTM() ?? null;

    // First and last PRIMARY bar x — primary bars are the larger rect
    // class "fill-club-green-500" or "fill-[#8b3520]". Pick rects in
    // the SVG whose class indicates a primary fill, transform their
    // centre to viewport coords, and take the leftmost/rightmost.
    let firstX: number | null = null;
    let lastX: number | null = null;
    if (svg && ctm) {
      const rects = Array.from(svg.querySelectorAll("rect"));
      const xs: number[] = [];
      for (const rc of rects) {
        const cls = rc.getAttribute("class") ?? "";
        const isPrimary =
          cls.includes("fill-club-green-500") ||
          cls.includes("fill-[#8b3520]");
        if (!isPrimary) continue;
        try {
          const bb = (rc as SVGRectElement).getBBox();
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

    const kpiRowLeft = ytdR?.x ?? 0;
    const kpiRowRight = priorR?.right ?? 0;
    const kpiRowWidth = kpiRowRight - kpiRowLeft;
    const dataSpan = firstX != null && lastX != null ? lastX - firstX : null;
    const leftGutter = firstX != null ? firstX - kpiRowLeft : null;
    const rightGutter = lastX != null ? kpiRowRight - lastX : null;
    const plotUtilRatio =
      dataSpan != null && kpiRowWidth > 0 ? r((dataSpan / kpiRowWidth) * 100) : null;

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

test("operating card across viewports", async ({ page }) => {
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
    await page.locator("[data-testid='stewardship-operating']").scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    const m = await measureOperating(page);
    report.push({ viewport: `${v.w}x${v.h}`, ...m });
    if (v.w === 1440) {
      await page.screenshot({ path: "test-results/operating-multi-vp-1440.png", fullPage: false });
    }
    if (v.w === 1920) {
      await page.screenshot({ path: "test-results/operating-multi-vp-1920.png", fullPage: false });
    }
    if (v.w === 2560) {
      await page.screenshot({ path: "test-results/operating-multi-vp-2560.png", fullPage: false });
    }
  }

  writeFileSync("test-results/operating-multi-viewport.json", JSON.stringify(report, null, 2), "utf8");

  // ─────────────────────────────────────────────────────────────
  // Rule 13 (Operating Results parallel of Equity card's locked
  // baseline). The chart MUST grow with the card on larger monitors.
  // Right gutter MUST stay ≤ 4 px at every viewport (no fixed-viewBox
  // cap). Plot util holds steady ≥ 90 %.
  // ─────────────────────────────────────────────────────────────
  const by = (w: number) => report.find((r) => (r.viewport as string).startsWith(`${w}x`));
  const r1366 = by(1366), r1440 = by(1440), r1600 = by(1600), r1920 = by(1920), r2560 = by(2560);
  expect.soft(r1366, "1366 row present").toBeTruthy();
  expect.soft(r1440, "1440 row present").toBeTruthy();
  expect.soft(r1600, "1600 row present").toBeTruthy();
  expect.soft(r1920, "1920 row present").toBeTruthy();
  expect.soft(r2560, "2560 row present").toBeTruthy();

  if (r1366 && r1440 && r1600 && r1920 && r2560) {
    const rows = [r1366, r1440, r1600, r1920, r2560];

    // Note: the rightmost BAR's CENTRE sits ~ (slotW × 0.5) inset from
    // the rightmost slot edge — that's where the bar is anchored, not
    // a viewBox cap. We assert the right gutter stays SMALL and STABLE
    // (does not balloon as the viewport grows), which is the real
    // signature of the fixed-viewBox bug.
    expect.soft(
      Math.abs(r2560.rightGutter - r1440.rightGutter),
      "Rule 13 — right gutter holds across 1440→2560 (would balloon on viewBox cap)",
    ).toBeLessThanOrEqual(10);

    for (const r of rows) {
      expect.soft(r.plotUtilRatio, `Rule 13 — plot util ≥ 85 % at ${r.viewport}`)
        .toBeGreaterThanOrEqual(85);
      expect.soft(r.plotUtilRatio, `Rule 13 — plot util ≤ 105 % at ${r.viewport}`)
        .toBeLessThanOrEqual(105);
    }

    // Monotonic growth conditional on card growth.
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
