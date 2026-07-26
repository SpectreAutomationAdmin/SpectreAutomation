import { test, type Page } from "@playwright/test";
import { writeFileSync } from "fs";

// Precise alignment measurement. Compares the Equity chart's horizontal
// anchors (y-axis label left edge + plot region right edge) against
// the KPI ribbon's outer anchors (Actual CAGR card left + Current
// Equity card right). The chart should sit on the same vertical
// columns as the KPI tiles per the Saguaro reference.

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

test("equity KPI ↔ chart horizontal alignment", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-financial-performance").click();
  await page.waitForTimeout(600);

  const data = await page.evaluate(() => {
    function r(n: number) { return Math.round(n * 100) / 100; }
    function rect(el: Element | null) {
      if (!el) return null;
      const b = (el as HTMLElement).getBoundingClientRect();
      return { x: r(b.x), w: r(b.width), right: r(b.x + b.width) };
    }
    const card = document.querySelector("[data-testid='stewardship-equity']");
    if (!card) return { error: "card not found" } as const;
    // KPI tiles are the 4 children of the grid container inside the card.
    const ribbon = card.querySelector(".grid.grid-cols-4");
    const tiles = Array.from(ribbon?.children ?? []) as HTMLElement[];
    const actualCagrTile = tiles[0] ?? null;
    const currentEquityTile = tiles[3] ?? null;

    // SVG bounding rect.
    const svg = card.querySelector("svg") as SVGSVGElement | null;
    const svgRect = svg ? rect(svg) : null;

    // First y-axis label text — the topmost one (e.g. "$35M"). All y-tick
    // texts share a className with "fill-club-green-800/70" and use
    // text-anchor="end". The leftmost rendered pixel of those text
    // elements is the start of the y-axis-label column.
    let yLabelLeftMin = Infinity;
    if (svg) {
      const yTexts = Array.from(svg.querySelectorAll("text")).filter((t) => {
        const cls = t.getAttribute("class") ?? "";
        return cls.includes("club-green-800/70") && t.getAttribute("text-anchor") === "end";
      });
      for (const t of yTexts) {
        const b = (t as SVGTextElement).getBoundingClientRect();
        if (b.x < yLabelLeftMin) yLabelLeftMin = b.x;
      }
    }
    const yLabelLeft = isFinite(yLabelLeftMin) ? r(yLabelLeftMin) : null;

    // Right edge of the plot region — the last data point on the
    // primary line. Find every <circle> marker; the rightmost is the
    // final FY data point.
    let markerRightMax = -Infinity;
    if (svg) {
      for (const c of Array.from(svg.querySelectorAll("circle"))) {
        const b = (c as SVGCircleElement).getBoundingClientRect();
        const right = b.x + b.width;
        if (right > markerRightMax) markerRightMax = right;
      }
    }
    const finalMarkerRight = isFinite(markerRightMax) ? r(markerRightMax) : null;

    return {
      card: rect(card),
      actualCagrTile: rect(actualCagrTile),
      currentEquityTile: rect(currentEquityTile),
      svg: svgRect,
      yLabelLeft,
      finalMarkerRight,
      // Compute the deltas the rule cares about.
      deltas: actualCagrTile && currentEquityTile && yLabelLeft != null && finalMarkerRight != null
        ? {
            yLabelLeft_vs_actualCagrLeft: r(yLabelLeft - rect(actualCagrTile)!.x),
            plotRight_vs_currentEquityRight: r(finalMarkerRight - rect(currentEquityTile)!.right),
          }
        : null,
    };
  });

  writeFileSync("test-results/equity-kpi-alignment.json", JSON.stringify(data, null, 2), "utf8");
});
