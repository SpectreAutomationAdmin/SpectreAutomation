import { test, type Page } from "@playwright/test";
import { writeFileSync } from "fs";

// Measures plot utilization for BOTH the Saguaro Equity panel and the
// Spectre Equity card, using the same definition the founder gave:
//
//   Plot Utilization Width  = (last plotted point X − first plotted point X)
//                             / card content width
//   Vertical Plot Util.     = (highest plotted value Y − lowest plotted value Y)
//                             / plot height
//
// Spectre's data points come from circle.getBBox() + getScreenCTM().
// Saguaro's data points come from Chart.js's `chart.getDatasetMeta()`
// (which gives the rendered px-position of every plotted point), mapped
// to viewport via the canvas's rendered rect.
//
// Card content width is the panel's getBoundingClientRect().width
// — the visible outer bounds of the card the user sees on screen,
// NOT the SVG container, NOT a KPI sub-row.

const VIEWPORT = { width: 1440, height: 900 };
const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function loginSpectre(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

test("plot utilization — Saguaro Equity", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("https://sample-club.netlify.app/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  // Scroll to the Equity panel
  const eqInfo = await page.evaluate(() => {
    const panels = Array.from(document.querySelectorAll(".panel"));
    let target: Element | null = null;
    for (const p of panels) {
      const txt = p.querySelector(".panel-header")?.textContent ?? "";
      if (txt.includes("Equity Value Over Time")) { target = p; break; }
    }
    if (!target) return null;
    const r = (target as HTMLElement).getBoundingClientRect();
    return { docY: r.top + window.scrollY };
  });
  if (eqInfo) {
    await page.evaluate((y) => window.scrollTo({ top: y - 80, behavior: "instant" as ScrollBehavior }), eqInfo.docY);
    await page.waitForTimeout(500);
  }

  const data = await page.evaluate(() => {
    function r(n: number) { return Math.round(n * 100) / 100; }

    const panels = Array.from(document.querySelectorAll(".panel"));
    let target: Element | null = null;
    for (const p of panels) {
      const txt = p.querySelector(".panel-header")?.textContent ?? "";
      if (txt.includes("Equity Value Over Time")) { target = p; break; }
    }
    if (!target) return { error: "Equity panel not found" } as const;
    const panel = target as HTMLElement;
    const panelR = panel.getBoundingClientRect();

    const canvas = panel.querySelector("canvas") as HTMLCanvasElement | null;
    if (!canvas) return { error: "canvas not found" } as const;
    const canvasR = canvas.getBoundingClientRect();
    const Chart = (window as any).Chart;
    if (!Chart || typeof Chart.getChart !== "function") {
      return { error: "Chart.js global not available" } as const;
    }
    const chart = Chart.getChart(canvas);
    if (!chart) return { error: "Chart.getChart returned null" } as const;

    // Chart.js dataset[0] is the Actual Club Equity line. Each point
    // has .x, .y in canvas-internal pixel coords. We need to map
    // those to viewport via the canvas-rendered vs canvas-intrinsic
    // ratio.
    const scaleX = canvasR.width / canvas.width;
    const scaleY = canvasR.height / canvas.height;

    // Try every dataset — pick the one with the most points + treat
    // its [0] as the actual line.
    const datasets = chart.data?.datasets ?? [];
    const allMetaXs: number[] = [];
    const allMetaYs: number[] = [];
    let actualYs: number[] = [];
    for (let i = 0; i < datasets.length; i++) {
      const meta = chart.getDatasetMeta(i);
      if (!meta?.data?.length) continue;
      for (const pt of meta.data) {
        if (typeof pt.x === "number") allMetaXs.push(pt.x);
        if (typeof pt.y === "number") allMetaYs.push(pt.y);
      }
      if (i === 0) {
        actualYs = meta.data.map((p: any) => p.y).filter((v: number) => typeof v === "number");
      }
    }
    if (!allMetaXs.length) return { error: "no plotted points" } as const;

    const firstXCanvas = Math.min(...allMetaXs);
    const lastXCanvas = Math.max(...allMetaXs);
    const highYCanvas = Math.min(...allMetaYs); // Chart.js y increases downward
    const lowYCanvas = Math.max(...allMetaYs);

    // Viewport mapping
    const firstX = canvasR.x + firstXCanvas * scaleX;
    const lastX = canvasR.x + lastXCanvas * scaleX;
    const highY = canvasR.y + highYCanvas * scaleY;
    const lowY = canvasR.y + lowYCanvas * scaleY;

    // Plot height = chart.chartArea.bottom - chart.chartArea.top
    const ca = chart.chartArea;
    const plotHeight = (ca.bottom - ca.top) * scaleY;
    const plotHeightCanvas = ca.bottom - ca.top;

    return {
      cardWidth: r(panelR.width),
      cardLeft: r(panelR.x),
      cardRight: r(panelR.x + panelR.width),
      canvasWidth: r(canvasR.width),
      firstPointX: r(firstX),
      lastPointX: r(lastX),
      dataSpanX: r(lastX - firstX),
      plotUtilizationWidth: r(((lastX - firstX) / panelR.width) * 100),
      highestPointY: r(highY),
      lowestPointY: r(lowY),
      dataSpanY: r(lowY - highY),
      plotHeight: r(plotHeight),
      plotUtilizationHeight: r(((lowY - highY) / plotHeight) * 100),
      // For provenance — show Chart.js's actual chartArea so we can
      // see the data-vs-chartArea relationship too.
      chartAreaCanvas: { left: r(ca.left), right: r(ca.right), top: r(ca.top), bottom: r(ca.bottom) },
      plotHeightCanvas: r(plotHeightCanvas),
    };
  });

  writeFileSync("test-results/plot-util-saguaro.json", JSON.stringify(data, null, 2), "utf8");
  await page.screenshot({ path: "test-results/plot-util-saguaro.png", fullPage: false });
});

test("plot utilization — Spectre Equity", async ({ page }) => {
  await loginSpectre(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-financial-performance").click();
  await page.waitForTimeout(600);

  await page.locator("[data-testid='stewardship-equity']").scrollIntoViewIfNeeded();
  await page.waitForTimeout(400);

  const data = await page.evaluate(() => {
    function r(n: number) { return Math.round(n * 100) / 100; }

    const card = document.querySelector("[data-testid='stewardship-equity']");
    if (!card) return { error: "Equity card not found" } as const;
    const cardR = (card as HTMLElement).getBoundingClientRect();
    const svg = card.querySelector("svg") as SVGSVGElement | null;
    if (!svg) return { error: "svg not found" } as const;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { error: "ctm null" } as const;

    function map(xSVG: number, ySVG: number) {
      const p = svg!.createSVGPoint();
      p.x = xSVG; p.y = ySVG;
      const s = p.matrixTransform(ctm!);
      return { x: s.x, y: s.y };
    }

    const circles = Array.from(svg.querySelectorAll("circle"));
    const points: Array<{ xV: number; yV: number }> = [];
    for (const c of circles) {
      try {
        const bb = (c as SVGCircleElement).getBBox();
        const xSVG = bb.x + bb.width / 2;
        const ySVG = bb.y + bb.height / 2;
        const s = map(xSVG, ySVG);
        points.push({ xV: s.x, yV: s.y });
      } catch {}
    }
    if (!points.length) return { error: "no circles" } as const;

    const xs = points.map((p) => p.xV);
    const actualYs = points.map((p) => p.yV);
    const firstX = Math.min(...xs);
    const lastX = Math.max(...xs);
    const actualHighY = Math.min(...actualYs);
    const actualLowY = Math.max(...actualYs);

    // ALL plotted Y values across ALL series — Spectre's circles only
    // cover the actual line, but the benchmark lines (no markers) also
    // contribute Y values. Sample each LINE <path> via getPointAtLength
    // to capture endpoints + intermediates. SKIP the area-fill path
    // (its class begins with "fill-"); the area is a closed polygon
    // that dives to the plot floor and would contaminate the Y range.
    const allPaths = Array.from(svg.querySelectorAll("path"));
    const allYs: number[] = [...actualYs];
    for (const pathEl of allPaths) {
      const cls = pathEl.getAttribute("class") ?? "";
      // Line paths use "stroke-*" classes (no fill); area paths use
      // "fill-club-green-500/10" or similar. Skip filled paths.
      if (cls.startsWith("fill-") || cls.includes(" fill-")) continue;
      try {
        const p = pathEl as SVGPathElement;
        const total = p.getTotalLength();
        if (!total || !isFinite(total)) continue;
        const samples = 24;
        for (let i = 0; i <= samples; i++) {
          const t = (total * i) / samples;
          const pt = p.getPointAtLength(t);
          const mapped = map(pt.x, pt.y);
          allYs.push(mapped.y);
        }
      } catch {}
    }
    const allHighY = Math.min(...allYs);
    const allLowY = Math.max(...allYs);

    const highY = allHighY;
    const lowY = allLowY;

    // Plot height = SVG plot region inner height in rendered px.
    // viewBox is 600x200, padT=6, padB=36 (with legend). innerH=158
    // viewBox units. Scale ≈ 0.92. innerH rendered = 158 * 0.92.
    // Compute from CTM:
    const ttl = map(0, 6);          // plot top (in viewBox: y=padT)
    const tbl = map(0, 200 - 36);   // plot bottom (in viewBox: y=vbH-padB)
    const plotHeight = tbl.y - ttl.y;

    return {
      cardWidth: r(cardR.width),
      cardLeft: r(cardR.x),
      cardRight: r(cardR.x + cardR.width),
      svgWidth: r(svg.getBoundingClientRect().width),
      firstPointX: r(firstX),
      lastPointX: r(lastX),
      dataSpanX: r(lastX - firstX),
      plotUtilizationWidth: r(((lastX - firstX) / cardR.width) * 100),
      actualLineHighY: r(actualHighY),
      actualLineLowY: r(actualLowY),
      actualLineSpanY: r(actualLowY - actualHighY),
      actualLineUtilizationHeight: r(((actualLowY - actualHighY) / plotHeight) * 100),
      highestPointY: r(highY),
      lowestPointY: r(lowY),
      dataSpanY: r(lowY - highY),
      plotHeight: r(plotHeight),
      plotUtilizationHeight: r(((lowY - highY) / plotHeight) * 100),
    };
  });

  writeFileSync("test-results/plot-util-spectre.json", JSON.stringify(data, null, 2), "utf8");
  await page.screenshot({ path: "test-results/plot-util-spectre.png", fullPage: false });
});
