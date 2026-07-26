import { test, type Page } from "@playwright/test";
import { writeFileSync } from "fs";

// Diagnostic overlay: draws visible vertical guide lines on the
// rendered Equity card for each anchor we're trying to align. The
// screenshot proves the measurement is reading the RIGHT elements
// before any layout change is attempted.
//
// Anchors measured (each via the most reliable API for that element):
//   1. Actual CAGR card LEFT  (KPI tile #1 .left)            — getBoundingClientRect on tile
//   2. Current Equity card RIGHT (KPI tile #4 .right)        — getBoundingClientRect on tile
//   3. Y-axis label column LEFT                              — SVGGraphicsElement.getBBox()
//                                                             + getScreenCTM() over the
//                                                             leftmost y-tick text
//   4. First plotted data point X                            — getBBox() + getScreenCTM()
//                                                             over the leftmost circle marker
//   5. Last plotted data point X                             — same on rightmost circle
//   6. SVG container LEFT                                    — getBoundingClientRect on svg
//   7. SVG container RIGHT                                   — getBoundingClientRect on svg

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

test("equity-alignment overlay", async ({ page }) => {
  await login(page);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-financial-performance").click();
  await page.waitForTimeout(600);

  // Scroll equity card into view so the overlay screenshot frames it.
  await page.locator("[data-testid='stewardship-equity']").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  const result = await page.evaluate(() => {
    type Anchor = { id: string; label: string; x: number; color: string; source: string };
    function r(n: number) { return Math.round(n * 100) / 100; }

    const out: { anchors: Anchor[]; debug: any; error?: string } = {
      anchors: [],
      debug: {},
    };

    const card = document.querySelector("[data-testid='stewardship-equity']");
    if (!card) { out.error = "equity card not found"; return out; }
    const cardR = (card as HTMLElement).getBoundingClientRect();
    out.debug.card = { x: r(cardR.x), w: r(cardR.width), right: r(cardR.x + cardR.width) };

    // ── KPI tiles ──────────────────────────────────────────────────
    const ribbon = card.querySelector(".grid.grid-cols-4");
    const tiles = Array.from(ribbon?.children ?? []) as HTMLElement[];
    if (tiles.length < 4) {
      out.error = `expected 4 KPI tiles, got ${tiles.length}`;
      return out;
    }
    const actualCagrTile = tiles[0];
    const currentEquityTile = tiles[3];
    const acR = actualCagrTile.getBoundingClientRect();
    const ceR = currentEquityTile.getBoundingClientRect();
    out.debug.actualCagrTile = { x: r(acR.x), w: r(acR.width), right: r(acR.x + acR.width) };
    out.debug.currentEquityTile = { x: r(ceR.x), w: r(ceR.width), right: r(ceR.x + ceR.width) };

    out.anchors.push({
      id: "actualCagrLeft",
      label: `1. Actual CAGR card LEFT @ x=${r(acR.x)}`,
      x: r(acR.x),
      color: "rgb(220, 38, 38)",      // red
      source: "getBoundingClientRect on tiles[0]",
    });
    out.anchors.push({
      id: "currentEquityRight",
      label: `2. Current Equity card RIGHT @ x=${r(ceR.x + ceR.width)}`,
      x: r(ceR.x + ceR.width),
      color: "rgb(220, 38, 38)",      // red
      source: "getBoundingClientRect on tiles[3]",
    });

    // ── SVG container ──────────────────────────────────────────────
    const svg = card.querySelector("svg") as SVGSVGElement | null;
    if (!svg) { out.error = "svg not found"; return out; }
    const svgR = svg.getBoundingClientRect();
    out.debug.svg = { x: r(svgR.x), w: r(svgR.width), right: r(svgR.x + svgR.width) };
    out.anchors.push({
      id: "svgLeft",
      label: `6. SVG LEFT @ x=${r(svgR.x)}`,
      x: r(svgR.x),
      color: "rgb(156, 163, 175)",    // gray
      source: "svg.getBoundingClientRect",
    });
    out.anchors.push({
      id: "svgRight",
      label: `7. SVG RIGHT @ x=${r(svgR.x + svgR.width)}`,
      x: r(svgR.x + svgR.width),
      color: "rgb(156, 163, 175)",    // gray
      source: "svg.getBoundingClientRect",
    });

    // ── Y-axis label column LEFT via SVG BBox + screen CTM ────────
    // The y-axis tick labels use textAnchor="end" + the class
    // "fill-club-green-800/70". The leftmost rendered pixel of those
    // text glyphs is the start of the y-axis-label column. We use
    // SVGGraphicsElement.getBBox() to get the text's intrinsic
    // bounding box in SVG user space, then getScreenCTM() to map
    // the box's left-x to viewport coordinates.
    const ctm = svg.getScreenCTM();
    if (!ctm) { out.error = "svg.getScreenCTM() returned null"; return out; }
    out.debug.ctm = { a: r(ctm.a), b: r(ctm.b), c: r(ctm.c), d: r(ctm.d), e: r(ctm.e), f: r(ctm.f) };

    // Convert an (x, y) in SVG user space to viewport coords.
    function svgToViewport(x: number, y: number) {
      const pt = svg!.createSVGPoint();
      pt.x = x;
      pt.y = y;
      const screen = pt.matrixTransform(ctm!);
      return { x: r(screen.x), y: r(screen.y) };
    }

    const yTexts = Array.from(svg.querySelectorAll("text")).filter((t) => {
      const cls = t.getAttribute("class") ?? "";
      return cls.includes("club-green-800/70") && t.getAttribute("text-anchor") === "end";
    });
    out.debug.yTexts = yTexts.length;
    let yLabelLeftMin = Infinity;
    let yLabelLeftBBoxSample: any = null;
    for (const t of yTexts) {
      try {
        const bb = (t as SVGTextElement).getBBox();
        // bb.x is in SVG user space (viewBox units, after any transforms
        // on parents). Map to viewport.
        const screen = svgToViewport(bb.x, bb.y);
        if (screen.x < yLabelLeftMin) {
          yLabelLeftMin = screen.x;
          yLabelLeftBBoxSample = {
            text: t.textContent,
            bbox: { x: r(bb.x), y: r(bb.y), w: r(bb.width), h: r(bb.height) },
            screenLeft: screen.x,
          };
        }
      } catch {
        // getBBox can throw if the element isn't rendered
      }
    }
    out.debug.yLabelLeftMin_via_getBBox = isFinite(yLabelLeftMin) ? yLabelLeftMin : null;
    out.debug.yLabelLeftSample = yLabelLeftBBoxSample;
    if (isFinite(yLabelLeftMin)) {
      out.anchors.push({
        id: "yLabelLeft",
        label: `3. Y-axis label column LEFT @ x=${r(yLabelLeftMin)}`,
        x: r(yLabelLeftMin),
        color: "rgb(34, 197, 94)",    // green
        source: "SVGTextElement.getBBox() + getScreenCTM()",
      });
    }

    // ── Circle markers (first + last data points) ──────────────────
    const circles = Array.from(svg.querySelectorAll("circle"));
    out.debug.circleCount = circles.length;
    // Use getBBox + CTM on each circle to get its viewport center;
    // sort by x to find leftmost (first data point) and rightmost
    // (last data point).
    const points: Array<{ idx: number; cxViewport: number; bbox: any }> = [];
    for (let i = 0; i < circles.length; i++) {
      const c = circles[i] as SVGCircleElement;
      try {
        const bb = c.getBBox();
        const cxSVG = bb.x + bb.width / 2;
        const cySVG = bb.y + bb.height / 2;
        const screen = svgToViewport(cxSVG, cySVG);
        points.push({ idx: i, cxViewport: r(screen.x), bbox: { x: r(bb.x), w: r(bb.width) } });
      } catch {}
    }
    points.sort((a, b) => a.cxViewport - b.cxViewport);
    out.debug.firstCircle = points[0];
    out.debug.lastCircle = points[points.length - 1];

    if (points.length) {
      const first = points[0];
      const last = points[points.length - 1];
      out.anchors.push({
        id: "firstDataPoint",
        label: `4. First data point @ x=${first.cxViewport}`,
        x: first.cxViewport,
        color: "rgb(59, 130, 246)",   // blue
        source: "leftmost circle.getBBox() + getScreenCTM()",
      });
      out.anchors.push({
        id: "lastDataPoint",
        label: `5. Last data point @ x=${last.cxViewport}`,
        x: last.cxViewport,
        color: "rgb(59, 130, 246)",   // blue
        source: "rightmost circle.getBBox() + getScreenCTM()",
      });
    }

    // ── Inject visible guide lines + labels ────────────────────────
    // Each line: a fixed-position 2 px vertical bar that spans the
    // full viewport height, at the measured x, in the anchor's
    // colour. Each label: a small box stacked at staggered y so
    // the labels don't all overlap on top of each other.
    const yBase = Math.max(0, cardR.y - 120);
    out.anchors.forEach((a, i) => {
      const line = document.createElement("div");
      Object.assign(line.style, {
        position: "fixed",
        top: "0px",
        left: `${a.x}px`,
        width: "2px",
        height: "100vh",
        backgroundColor: a.color,
        zIndex: "99999",
        opacity: "0.85",
        pointerEvents: "none",
      });
      line.setAttribute("data-overlay-anchor", a.id);
      document.body.appendChild(line);

      const label = document.createElement("div");
      label.textContent = a.label;
      Object.assign(label.style, {
        position: "fixed",
        top: `${yBase + i * 22}px`,
        left: `${a.x + 6}px`,
        padding: "2px 6px",
        backgroundColor: a.color,
        color: "white",
        font: "11px/14px ui-monospace, monospace",
        zIndex: "99999",
        whiteSpace: "nowrap",
        pointerEvents: "none",
      });
      label.setAttribute("data-overlay-label", a.id);
      document.body.appendChild(label);
    });

    return out;
  });

  writeFileSync("test-results/equity-alignment-overlay.json", JSON.stringify(result, null, 2), "utf8");

  await page.waitForTimeout(200);
  await page.screenshot({ path: "test-results/equity-alignment-overlay.png", fullPage: false });
});
