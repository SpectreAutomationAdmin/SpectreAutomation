import { test, type Page } from "@playwright/test";
import { writeFileSync, mkdirSync } from "fs";

// Per-card plot-region measurement. The "plot region" is the area
// BOUNDED BY the axes and first/last data points — NOT the SVG
// container, NOT the chart-wrap div, NOT padding/legend.
//
// For Saguaro (Chart.js canvas): read chart.chartArea from the
// Chart.js instance attached to each <canvas>.
// For Spectre (hand-rolled SVG): compute the rendered plot rect from
// the SVG bounding rect + the chart's known padding constants.

const VIEWPORT = { width: 1440, height: 900 };
const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";

async function login(page: Page) {
  await page.goto("/login");
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 15_000 });
}

function round(n: number) { return Math.round(n * 100) / 100; }

test("audit — Saguaro plot regions (Chart.js chartArea)", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await page.goto("https://sample-club.netlify.app/", { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);

  const data = await page.evaluate(() => {
    function round(n: number) { return Math.round(n * 100) / 100; }
    function nearestPanel(el: Element | null): Element | null {
      let cur = el;
      while (cur) {
        const cls = (cur as HTMLElement).className?.toString?.() ?? "";
        if (cls.split(/\s+/).includes("panel")) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    function rectOf(el: Element) {
      const r = (el as HTMLElement).getBoundingClientRect();
      return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
    }

    // Body content width — find .content / main / .body / first wide block
    const bodyContent = document.querySelector(".content, main, .body, .layout > *") ?? document.body;
    const bodyRect = rectOf(bodyContent);

    const all = Array.from(document.querySelectorAll(".panel"));
    const findByTitle = (needle: string) =>
      all.find((p) => (p.querySelector(".panel-header")?.textContent ?? "").trim().startsWith(needle));
    const equity = findByTitle("Equity Value Over Time");
    const operating = findByTitle("Operating Results");

    function measure(panel: Element | undefined, name: string) {
      if (!panel) return null;
      const panelR = rectOf(panel);
      const header = panel.querySelector(".panel-header");
      const headerR = header ? rectOf(header) : null;
      // Find the KPI ribbon — Saguaro uses .kpi-row or a flex/grid div
      // with multiple .kpi-cell children. Discover by looking for the
      // first sibling of the header that holds the cells.
      const kpiRow = panel.querySelector(".kpi-row, .kpis, .panel-kpis, .panel-body > div:nth-child(1)");
      const kpiR = kpiRow ? rectOf(kpiRow) : null;
      // Chart wrap + canvas
      const canvas = panel.querySelector("canvas") as HTMLCanvasElement | null;
      const canvasR = canvas ? rectOf(canvas) : null;
      // Try Chart.js v2/3/4 access patterns. v3/4 expose Chart on the
      // canvas via Chart.getChart(); v2 stored it on canvas[chartName].
      let chartArea: { left: number; top: number; right: number; bottom: number } | null = null;
      let chartW: number | null = null;
      let chartH: number | null = null;
      // Chart.js v3/4: Chart.getChart(canvas)
      const ChartGlobal = (window as any).Chart;
      if (canvas && ChartGlobal && typeof ChartGlobal.getChart === "function") {
        const inst = ChartGlobal.getChart(canvas);
        if (inst && inst.chartArea) {
          chartArea = {
            left: round(inst.chartArea.left),
            top: round(inst.chartArea.top),
            right: round(inst.chartArea.right),
            bottom: round(inst.chartArea.bottom),
          };
          chartW = round(inst.chartArea.right - inst.chartArea.left);
          chartH = round(inst.chartArea.bottom - inst.chartArea.top);
        }
      }
      // Fallback — read internal _chart / _chartInstance attached
      if (!chartArea && canvas) {
        const c = canvas as any;
        const inst = c.chart || c.chartInstance || c._chart;
        if (inst && inst.chartArea) {
          chartArea = {
            left: round(inst.chartArea.left),
            top: round(inst.chartArea.top),
            right: round(inst.chartArea.right),
            bottom: round(inst.chartArea.bottom),
          };
          chartW = round(inst.chartArea.right - inst.chartArea.left);
          chartH = round(inst.chartArea.bottom - inst.chartArea.top);
        }
      }
      // Legend — Chart.js renders legends as labels inside the canvas
      // by default, but sites sometimes use external <div class="legend">
      const legend = panel.querySelector(".legend, .chart-legend");
      const legendR = legend ? rectOf(legend) : null;
      // Commentary (trend-note in Saguaro)
      const trendNote = panel.querySelector(".trend-note, .commentary, footer");
      const trendR = trendNote ? rectOf(trendNote) : null;

      // Internal canvas resolution (intrinsic pixel buffer dims)
      const canvasInternal = canvas ? { w: canvas.width, h: canvas.height } : null;

      // Plot-region within the canvas — chartArea is in INTERNAL
      // canvas-pixel coordinates; to express it in PAGE pixels we need
      // to scale by the canvas-rendered : canvas-intrinsic ratio.
      let plotRectPage: { x: number; y: number; w: number; h: number } | null = null;
      if (chartArea && canvasR && canvasInternal) {
        const scaleX = canvasR.w / canvasInternal.w;
        const scaleY = canvasR.h / canvasInternal.h;
        plotRectPage = {
          x: round(canvasR.x + chartArea.left * scaleX),
          y: round(canvasR.y + chartArea.top * scaleY),
          w: round((chartArea.right - chartArea.left) * scaleX),
          h: round((chartArea.bottom - chartArea.top) * scaleY),
        };
      }

      return {
        name,
        panel: panelR,
        header: headerR,
        kpi: kpiR,
        canvasContainer: canvasR,
        canvasInternal,
        chartAreaInternalPx: chartArea,
        plotRegionPage: plotRectPage,
        legend: legendR,
        commentary: trendR,
        // Ratios
        plotToCardHeight: plotRectPage && panelR ? round(plotRectPage.h / panelR.h) : null,
        plotToCardWidth:  plotRectPage && panelR ? round(plotRectPage.w / panelR.w) : null,
        // Gap from header bottom to plot region top
        headerToPlotGap: plotRectPage && headerR ? round(plotRectPage.y - (headerR.y + headerR.h)) : null,
      };
    }

    const eq = measure(equity, "Saguaro Equity");
    const op = measure(operating, "Saguaro Operating");
    // Horizontal gap between the two cards
    let cardGap: number | null = null;
    if (equity && operating) {
      const a = rectOf(equity);
      const b = rectOf(operating);
      cardGap = round(Math.min(b.x, a.x) === a.x ? b.x - (a.x + a.w) : a.x - (b.x + b.w));
    }
    return { bodyContent: bodyRect, equity: eq, operating: op, cardGap };
  });

  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/plot-audit-saguaro.json", JSON.stringify(data, null, 2), "utf8");
});

test("audit — Spectre plot regions (SVG viewBox + padding)", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-financial-performance").click();
  await page.waitForTimeout(600);

  const data = await page.evaluate(() => {
    function round(n: number) { return Math.round(n * 100) / 100; }
    function rectOf(el: Element) {
      const r = (el as HTMLElement).getBoundingClientRect();
      return { x: round(r.x), y: round(r.y), w: round(r.width), h: round(r.height) };
    }

    // Body content width = the reading column. We can grab the parent
    // grid wrapping the two cards.
    const stewardship = document.querySelector("[data-testid='stewardship-dashboard']");
    const bodyRect = stewardship ? rectOf(stewardship) : { x: 0, y: 0, w: 0, h: 0 };

    function measureCard(testid: string, name: string, hasLegend: boolean, isBar: boolean) {
      const card = document.querySelector(`[data-testid='${testid}']`);
      if (!card) return null;
      const cardR = rectOf(card);
      const header = card.querySelector("header");
      const headerR = header ? rectOf(header) : null;
      // KPI ribbon = the grid grid-cols-4 child
      const kpiRow = card.querySelector(".grid.grid-cols-4");
      const kpiR = kpiRow ? rectOf(kpiRow) : null;
      // SVG
      const svg = card.querySelector("svg") as SVGSVGElement | null;
      const svgR = svg ? rectOf(svg) : null;
      const viewBox = svg?.getAttribute("viewBox") ?? null;
      const vbParts = viewBox?.split(/\s+/).map(Number) ?? null;
      // Spectre chart constants (matches EditorialLineChart /
      // EditorialBarChart): padL=48, padR=16, padT=10, padB depends on legend.
      const padL = 48;
      const padR = 16;
      const padT = 10;
      const padB = hasLegend ? 54 : 30;
      let plotRectPage: { x: number; y: number; w: number; h: number } | null = null;
      let plotViewBox: { x: number; y: number; w: number; h: number } | null = null;
      if (svgR && vbParts && vbParts.length === 4) {
        const [, , vbW, vbH] = vbParts;
        // Plot region in viewBox coords
        const plotVBx = padL;
        const plotVBy = padT;
        const plotVBw = vbW - padL - padR;
        const plotVBh = vbH - padT - padB;
        plotViewBox = { x: plotVBx, y: plotVBy, w: plotVBw, h: plotVBh };
        // SVG uses preserveAspectRatio="none" → viewBox stretches to fit
        // the container, so we scale uniformly along each axis.
        const scaleX = svgR.w / vbW;
        const scaleY = svgR.h / vbH;
        plotRectPage = {
          x: round(svgR.x + plotVBx * scaleX),
          y: round(svgR.y + plotVBy * scaleY),
          w: round(plotVBw * scaleX),
          h: round(plotVBh * scaleY),
        };
      }
      // Legend — the inline SVG legend in Spectre is part of the SVG.
      // We measure it as the bottom band of the SVG from y = (vbH - padB) to y = vbH.
      let legendRectPage: { x: number; y: number; w: number; h: number } | null = null;
      if (svgR && vbParts && hasLegend) {
        const [, , vbW, vbH] = vbParts;
        const scaleY = svgR.h / vbH;
        const legendBandTop = vbH - padB + 26; // legend rect starts at yLegend-8 where yLegend = vbH - padB + 34
        const legendBandH = 12;
        legendRectPage = {
          x: round(svgR.x),
          y: round(svgR.y + legendBandTop * scaleY),
          w: round(svgR.w),
          h: round(legendBandH * scaleY),
        };
      }
      // Commentary
      const commentary = card.querySelector("p");
      const commentaryR = commentary ? rectOf(commentary) : null;

      return {
        name,
        card: cardR,
        header: headerR,
        kpi: kpiR,
        svg: svgR,
        viewBox,
        viewBoxW: vbParts?.[2] ?? null,
        viewBoxH: vbParts?.[3] ?? null,
        plotRegionViewBox: plotViewBox,
        plotRegionPage: plotRectPage,
        legend: legendRectPage,
        commentary: commentaryR,
        plotToCardHeight: plotRectPage && cardR ? round(plotRectPage.h / cardR.h) : null,
        plotToCardWidth: plotRectPage && cardR ? round(plotRectPage.w / cardR.w) : null,
        headerToPlotGap: plotRectPage && headerR ? round(plotRectPage.y - (headerR.y + headerR.h)) : null,
      };
    }

    const eq = measureCard("stewardship-equity", "Spectre Equity", true, false);
    const op = measureCard("stewardship-operating", "Spectre Operating", true, true);
    let cardGap: number | null = null;
    if (eq && op) {
      cardGap = round(op.card.x - (eq.card.x + eq.card.w));
    }
    return { bodyContent: bodyRect, equity: eq, operating: op, cardGap };
  });

  mkdirSync("test-results", { recursive: true });
  writeFileSync("test-results/plot-audit-spectre.json", JSON.stringify(data, null, 2), "utf8");
});
