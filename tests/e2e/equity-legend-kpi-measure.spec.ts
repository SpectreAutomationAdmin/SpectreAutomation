import { test, expect, type Page } from "@playwright/test";
import { writeFileSync } from "fs";

// Measures the Equity Value Over Time card's legend grouping and the
// KPI ribbon / chart band proportions for the legend-and-hierarchy
// refinement task. Records:
//   - card outer rect
//   - KPI row rect
//   - chart band SVG rect
//   - plot region (from chart constants + getScreenCTM)
//   - legend group bounding box (union of three <text> elements
//     "Club Equity" / "Best-in-Class" / "Min. Required")
//   - chart center X vs legend center X (delta should be ~0)

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

test("equity legend + KPI measurement", async ({ page }) => {
  await page.setViewportSize(VIEWPORT);
  await login(page);
  await page.goto("/app/admin/reporting/monthly");
  await page.waitForLoadState("networkidle");
  await page.getByTestId("reporting-chapter-financial-performance").click();
  await page.waitForTimeout(500);
  await page.locator("[data-testid='stewardship-equity']").scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);

  const m = await page.evaluate(() => {
    function r(n: number) { return Math.round(n * 100) / 100; }
    function rect(el: Element | null) {
      if (!el) return null;
      const b = (el as HTMLElement).getBoundingClientRect();
      return { x: r(b.x), y: r(b.y), w: r(b.width), h: r(b.height),
               right: r(b.x + b.width), bottom: r(b.y + b.height),
               centerX: r(b.x + b.width / 2) };
    }

    const card = document.querySelector("[data-testid='stewardship-equity']");
    if (!card) return { error: "card not found" } as const;
    const cardR = rect(card);
    const ribbon = card.querySelector(".grid.grid-cols-4");
    const ribbonR = rect(ribbon);
    const svg = card.querySelector("svg") as SVGSVGElement | null;
    const svgR = svg ? rect(svg) : null;

    // Actual CAGR KPI tile — first child of the 4-col KPI grid.
    // Current Equity KPI tile — fourth (last) child.
    // Their outer LEFT/RIGHT edges are the alignment anchors the
    // founder set for the chart's plot region.
    const kpiTiles = ribbon ? Array.from(ribbon.querySelectorAll(":scope > div")) : [];
    const actualCagrR = kpiTiles[0] ? rect(kpiTiles[0]) : null;
    const currentEquityR = kpiTiles[3] ? rect(kpiTiles[3]) : null;

    // Y-axis label column — every <text> whose content starts with
    // "$" (the dollars-millions formatter). LEFT edge of this column
    // = leftmost x across all those <text> rects.
    const allTextEls = svg ? Array.from(svg.querySelectorAll("text")) : [];
    const yAxisLabels = allTextEls.filter((t) => (t.textContent ?? "").trim().startsWith("$"));
    const yAxisRects = yAxisLabels.map((t) => rect(t as unknown as Element));
    const yAxisLeft = yAxisRects.length ? Math.min(...yAxisRects.map((rr) => rr!.x)) : null;
    const yAxisRight = yAxisRects.length ? Math.max(...yAxisRects.map((rr) => rr!.right)) : null;
    const yLabelToKpiDelta =
      yAxisLeft != null && actualCagrR ? r(yAxisLeft - actualCagrR.x) : null;

    // Rightmost plotted point — find the data marker (<circle>) with
    // the largest cx attribute, then transform via getScreenCTM into
    // viewport coords. This is the actual data anchor for FY2025, NOT
    // the SVG container edge. (The legend marker is also a <circle>,
    // but it sits mid-card; the FY2025 marker is always the rightmost.)
    let rightmostMarkerX: number | null = null;
    if (svg) {
      const ctm = svg.getScreenCTM();
      const markers = Array.from(svg.querySelectorAll("circle"));
      let maxCx = -Infinity;
      let maxMarker: SVGCircleElement | null = null;
      for (const m of markers) {
        const cx = parseFloat(m.getAttribute("cx") ?? "0");
        if (cx > maxCx) { maxCx = cx; maxMarker = m as SVGCircleElement; }
      }
      if (ctm && maxMarker) {
        const p = svg.createSVGPoint();
        p.x = maxCx; p.y = 0;
        const s = p.matrixTransform(ctm);
        rightmostMarkerX = r(s.x);
      }
    }
    const rightmostMarkerToKpiDelta =
      rightmostMarkerX != null && currentEquityR
        ? r(rightmostMarkerX - currentEquityR.right)
        : null;

    // Rightmost x-axis label "2025" (or whichever year is the last
    // plotted) — text-anchor=end, so its right edge sits at the same
    // x as the rightmost data marker.
    const xAxisYearLabels = allTextEls.filter((t) => /^\d{4}$/.test((t.textContent ?? "").trim()));
    const lastYearLabel = xAxisYearLabels.length
      ? xAxisYearLabels.reduce((acc, t) => {
          const ar = rect(acc as unknown as Element);
          const tr = rect(t as unknown as Element);
          return ar && tr && tr.right > ar.right ? t : acc;
        })
      : null;
    const lastYearLabelR = lastYearLabel ? rect(lastYearLabel as unknown as Element) : null;

    // Commentary block — the italic <p> with the green-tinted bg.
    // After the inset change there will be a wrapper div around it;
    // measure whichever element actually carries the background tint
    // (the inset block, not the outer wrapper) by querying
    // [data-testid='stewardship-equity-commentary'].
    const commentaryTinted = card.querySelector(
      "[data-testid='stewardship-equity-commentary']",
    ) ?? card.querySelector("p.italic");
    const commentaryR = commentaryTinted ? rect(commentaryTinted) : null;
    const commentaryLeftInset =
      commentaryR && cardR ? r(commentaryR.x - cardR.x) : null;
    const commentaryRightInset =
      commentaryR && cardR ? r(cardR.right - commentaryR.right) : null;

    // Inner commentary box — when insetCommentary is enabled, the
    // measured testid-element is the green-tinted <p> itself, and its
    // wrapping <div> carries the fixed band height. Capture both so
    // we can report inner-vs-outer height (whether the shading still
    // fills the band or now hugs the text).
    const commentaryWrapper = commentaryTinted?.parentElement ?? null;
    const commentaryWrapperR = commentaryWrapper ? rect(commentaryWrapper) : null;
    const commentaryBottomGap =
      commentaryR && commentaryWrapperR
        ? r(commentaryWrapperR.bottom - commentaryR.bottom)
        : null;
    const commentaryToCardBottomGap =
      commentaryR && cardR ? r(cardR.bottom - commentaryR.bottom) : null;

    // Subtitle styling — the squinty "IS THE CLUB'S FINANCIAL HEALTH …"
    // line. Capture computed font-size, color, letter-spacing so we
    // can produce a before/after table for the readability bump.
    const subtitle = card.querySelector("header p");
    const subtitleStyle = subtitle ? window.getComputedStyle(subtitle) : null;
    const subtitleMetrics = subtitleStyle
      ? {
          fontSize: subtitleStyle.fontSize,
          color: subtitleStyle.color,
          letterSpacing: subtitleStyle.letterSpacing,
          opacity: subtitleStyle.opacity,
        }
      : null;

    // Compute plot region from getScreenCTM + observed padding.
    // padL is configurable per chart instance (the Equity card now
    // passes padLeft=44 to align the y-axis label column with the
    // Actual CAGR KPI tile), so we read it from the first y-grid line
    // element instead of hardcoding. The first <line> with class
    // "stroke-club-sand" is the topmost y-tick, drawn from x=padL to
    // x=(width − padR).
    let plotR: ReturnType<typeof rect> = null;
    if (svg) {
      const ctm = svg.getScreenCTM();
      if (ctm) {
        const vbAttr = svg.getAttribute("viewBox");
        const parts = vbAttr?.split(/\s+/).map(Number) ?? [];
        if (parts.length === 4) {
          const [, , vbW, vbH] = parts;
          const firstGrid = svg.querySelector("line.stroke-club-sand");
          const padL = firstGrid
            ? parseFloat(firstGrid.getAttribute("x1") ?? "66")
            : 66;
          const rightX = firstGrid
            ? parseFloat(firstGrid.getAttribute("x2") ?? String(vbW - 31))
            : vbW - 31;
          const padR = vbW - rightX;
          const padT = 6, padB = 36;
          // Plot corners in viewBox → viewport
          function vbToVp(x: number, y: number) {
            const p = svg!.createSVGPoint();
            p.x = x; p.y = y;
            const s = p.matrixTransform(ctm!);
            return { x: s.x, y: s.y };
          }
          const tl = vbToVp(padL, padT);
          const br = vbToVp(vbW - padR, vbH - padB);
          plotR = {
            x: r(tl.x), y: r(tl.y),
            w: r(br.x - tl.x), h: r(br.y - tl.y),
            right: r(br.x), bottom: r(br.y),
            centerX: r((tl.x + br.x) / 2),
          };
        }
      }
    }

    // Legend group bbox — union of the 3 legend text elements.
    const labels = ["Club Equity", "Best-in-Class", "Min. Required"];
    const legendNodes: { label: string; rect: ReturnType<typeof rect> }[] = [];
    if (svg) {
      const texts = Array.from(svg.querySelectorAll("text"));
      for (const t of texts) {
        const txt = (t.textContent ?? "").trim();
        if (labels.includes(txt)) {
          legendNodes.push({ label: txt, rect: rect(t as unknown as Element) });
        }
      }
    }
    let legendGroup: { x: number; right: number; w: number; centerX: number; y: number; h: number } | null = null;
    if (legendNodes.length === 3) {
      const xs = legendNodes.map((n) => n.rect!.x);
      const rights = legendNodes.map((n) => n.rect!.right);
      const ys = legendNodes.map((n) => n.rect!.y);
      const bottoms = legendNodes.map((n) => n.rect!.bottom);
      const x = Math.min(...xs), right = Math.max(...rights);
      const y = Math.min(...ys), bottom = Math.max(...bottoms);
      legendGroup = {
        x: r(x), right: r(right),
        w: r(right - x),
        centerX: r((x + right) / 2),
        y: r(y), h: r(bottom - y),
      };
    }

    // Item-to-item spacing in viewport px (right edge of item N → left edge of item N+1).
    const sortedNodes = [...legendNodes].sort((a, b) => a.rect!.x - b.rect!.x);
    const interItemSpacing: number[] = [];
    for (let i = 0; i + 1 < sortedNodes.length; i++) {
      interItemSpacing.push(r(sortedNodes[i + 1].rect!.x - sortedNodes[i].rect!.right));
    }

    const chartCenter = plotR?.centerX ?? null;
    const legendCenter = legendGroup?.centerX ?? null;
    const centerDelta = chartCenter != null && legendCenter != null ? r(legendCenter - chartCenter) : null;

    // True visual center of the legend group — text labels alone
    // don't represent the visual span; the line previews (~24 px each)
    // and previewToLabelGap (~5 px) sit to the LEFT of each label.
    // True visual span = leftmost preview start → rightmost label end.
    // For text-only measurement this only matters for the very first
    // item; the previews of items 2-N sit between two labels and don't
    // affect either extremum.
    const PREVIEW_LINE_W = 24, PREVIEW_TO_LABEL_GAP = 5;
    let trueVisualCenter: number | null = null;
    let trueVisualDelta: number | null = null;
    let trueVisualWidth: number | null = null;
    if (legendGroup && sortedNodes.length === 3) {
      const firstPreviewLeft = sortedNodes[0].rect!.x - PREVIEW_LINE_W - PREVIEW_TO_LABEL_GAP;
      const lastLabelRight = sortedNodes[2].rect!.right;
      trueVisualWidth = r(lastLabelRight - firstPreviewLeft);
      trueVisualCenter = r((firstPreviewLeft + lastLabelRight) / 2);
      if (chartCenter != null) trueVisualDelta = r(trueVisualCenter - chartCenter);
    }

    return {
      card: cardR,
      kpiRow: ribbonR,
      svg: svgR,
      plot: plotR,
      legendGroup,
      legendNodes,
      interItemSpacing,
      centerDelta,
      trueVisualWidth,
      trueVisualCenter,
      trueVisualDelta,
      chartBandHeight: svgR?.h,
      plotAreaHeight: plotR?.h,
      chartToCardHeightRatio: cardR && svgR ? r(svgR.h / cardR.h) : null,
      // Alignment checks for the founder's three issues:
      actualCagr: actualCagrR,
      currentEquity: currentEquityR,
      yAxisLeft: yAxisLeft != null ? r(yAxisLeft) : null,
      yAxisRight: yAxisRight != null ? r(yAxisRight) : null,
      yLabelToKpiDelta,
      rightmostMarkerX,
      rightmostMarkerToKpiDelta,
      lastYearLabel: lastYearLabelR,
      lastYearLabelToKpiDelta:
        lastYearLabelR && currentEquityR ? r(lastYearLabelR.right - currentEquityR.right) : null,
      commentary: commentaryR,
      commentaryLeftInset,
      commentaryRightInset,
      commentaryWrapper: commentaryWrapperR,
      commentaryBottomGap,
      commentaryToCardBottomGap,
      subtitleMetrics,
    };
  });

  writeFileSync("test-results/equity-legend-kpi.json", JSON.stringify(m, null, 2), "utf8");
  await page.locator("[data-testid='stewardship-equity']").screenshot({
    path: "test-results/equity-legend-kpi.png",
  });

  // ─────────────────────────────────────────────────────────────
  // LOCKED BASELINE — Equity card regression assertions.
  //
  // The JSON write above is a diagnostic; these expects fail the
  // CI gate if any locked invariant regresses. Each assertion cites
  // the corresponding rule from docs/equity-value-over-time-card-spec.md.
  // ─────────────────────────────────────────────────────────────

  if ("error" in m) throw new Error(`Equity card not located: ${m.error}`);

  // Rule 7 — y-axis label column left edge aligns with Actual CAGR
  // KPI tile left edge within 4 px tolerance.
  expect.soft(m.yLabelToKpiDelta, "Rule 7 — y-axis left → Actual CAGR left").not.toBeNull();
  expect.soft(Math.abs(m.yLabelToKpiDelta!), "Rule 7 — within ±4 px tolerance").toBeLessThanOrEqual(4);

  // Rule 8 — rightmost plotted point (FY2025 data marker) aligns
  // with Current Equity KPI tile right edge within 4 px tolerance.
  expect.soft(m.rightmostMarkerToKpiDelta, "Rule 8 — rightmost marker → Current Equity right").not.toBeNull();
  expect.soft(Math.abs(m.rightmostMarkerToKpiDelta!), "Rule 8 — marker delta within ±4 px tolerance").toBeLessThanOrEqual(4);
  // And the rightmost x-axis label (text-anchor=end) sits at the
  // same x — also within tolerance.
  expect.soft(m.lastYearLabelToKpiDelta, "Rule 8 — last x-label → Current Equity right").not.toBeNull();
  expect.soft(Math.abs(m.lastYearLabelToKpiDelta!), "Rule 8 — last x-label delta within ±4 px tolerance").toBeLessThanOrEqual(4);

  // Rule 11 — commentary shading is inset (≥ 10 px gutters) and
  // hugs the text (positive bottom gap inside band; positive gap
  // between bottom of shading and bottom of card).
  expect.soft(m.commentaryLeftInset, "Rule 11 — commentary left inset ≥ 10 px").toBeGreaterThanOrEqual(10);
  expect.soft(m.commentaryRightInset, "Rule 11 — commentary right inset ≥ 10 px").toBeGreaterThanOrEqual(10);
  expect.soft(m.commentaryBottomGap, "Rule 11 — commentary shading does NOT overflow band").toBeGreaterThan(0);
  expect.soft(m.commentaryToCardBottomGap, "Rule 11 — commentary shading does NOT touch card bottom").toBeGreaterThan(0);

  // Rule 12 — subtitle readability: bumped font / opacity / tighter
  // letter-spacing. Locked literal values come from the
  // source-contract test; here we just confirm the COMPUTED style
  // reflects them after the cascade resolves.
  expect.soft(m.subtitleMetrics, "Rule 12 — subtitle metrics captured").not.toBeNull();
  if (m.subtitleMetrics) {
    expect.soft(m.subtitleMetrics.fontSize, "Rule 12 — subtitle fontSize = 10.5 px").toBe("10.5px");
    expect.soft(m.subtitleMetrics.letterSpacing, "Rule 12 — subtitle letterSpacing = 0.7 px").toBe("0.7px");
    // Computed color: cream at 0.7 opacity. The literal string is
    // browser-stable for this token.
    expect.soft(m.subtitleMetrics.color, "Rule 12 — subtitle color = cream/70")
      .toMatch(/rgba\(248,\s*245,\s*239,\s*0\.7\)/);
  }

  // Sanity: legend visual center sits within 4 px of the plot
  // region's mid-X (Rule 9 / Saguaro convention).
  expect.soft(m.trueVisualDelta, "Rule 9 — legend visual center near plot center").not.toBeNull();
  expect.soft(Math.abs(m.trueVisualDelta!), "Rule 9 — legend center within ±4 px").toBeLessThanOrEqual(4);
});
