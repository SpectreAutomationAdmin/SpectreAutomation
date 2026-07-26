import { test, expect, type Page } from "@playwright/test";

// Plot Utilization Standard regression spec — §9 of
// docs/monthly-reporting-chart-governance.md (2026-06-21).
//
// One of the hardest-fought wins in Financial Performance was getting
// charts to use the full horizontal plotting space inside their card.
// Later sections kept regressing — charts shrunk back into the centre
// of oversized cards, especially at 1920 / 2560 widths. And, worse,
// some charts had a full-width SVG but the BARS themselves clustered
// in the centre of their slots, leaving large empty padding either
// side. A spec that only measured the container missed that case.
//
// This spec is the permanent guard. For every chart card listed in
// CHART_CARDS, at every viewport listed in VIEWPORTS, we measure:
//   (a) container utilization — svgWidth / cardInnerWidth
//   (b) data-span utilization — (lastBarRight - firstBarLeft) /
//       plotAreaWidth, AND the same span vs the card inner width.
//   (c) bar-width proportionality — medianBarWidth / medianStep
//       must NOT exceed the FP standard ratio (0.55, with +0.05
//       tolerance). Charts MUST achieve plot utilization through
//       layout / scale / margins — NEVER by inflating bar widths.
//
// (a) catches "chart shrank into the centre of an oversized card."
// (b) catches "SVG is full-width but the bars cluster in the centre
//     with large empty plot padding on either side" — the regression
//     the original SVG-width-only check missed.
// (c) catches "bars were widened beyond FP standard to fake plot
//     utilization" — the regression the original data-span-only
//     check would have allowed.
//
// For donut + legend cards we measure the combined donut + legend
// bounding box vs the card inner width (a donut alone is a 200 px
// square and will not pass 85 %).
//
// When a new chapter migrates, add its chart cards to CHART_CARDS.
// New charts cannot be declared complete until they pass this spec
// at all five viewport sizes.

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
  { label: "1366x768",  width: 1366, height: 768  },
  { label: "1440x900",  width: 1440, height: 900  },
  { label: "1600x900",  width: 1600, height: 900  },
  { label: "1920x1080", width: 1920, height: 1080 },
  { label: "2560x1440", width: 2560, height: 1440 },
] as const;

// Thresholds — see §9 of the chart governance doc. The bar chart
// thresholds are lower than the container threshold because some
// breathing-room inside the plot is intentional (a 100 % data-span
// chart would have bars touching the y-axis). 0.75 / 0.65 are
// calibrated to the Financial Performance reference and to the
// rule "bars must visually fill the plot, not float in the centre."
const MIN_CONTAINER_RATIO = 0.85; // svgWidth / cardInnerWidth
const MIN_DATA_VS_PLOT_RATIO = 0.75; // dataSpan / plotAreaWidth
const MIN_DATA_VS_CARD_RATIO = 0.65; // dataSpan / cardInnerWidth
// Donut + legend group min ratio. Aligned with §13 Large-Monitor
// Responsive Validation: a donut + legend group covering less than
// ~80% of available visual width is an automatic fail. 0.80 is the
// founder-set threshold; 0.78 here gives a 2-pt rounding tolerance
// (the responsive cap puts the group at 80.6% at 1920+, which is
// within rounding of 80%).
const MIN_DONUT_GROUP_RATIO = 0.78;

// Bar-width proportionality (§9 / §13). The FP-canonical bar-width
// ratio is `BAR_GEOMETRY.primaryWidthRatio = 0.55`. If a chart
// widens its bars beyond this ratio to fake plot utilization, the
// chart fails — plot utilization MUST be achieved through layout,
// scale, or margins, never through oversized bars. The tolerance
// (+0.05) absorbs sub-pixel rounding; anything materially above
// 0.60 is an inflated bar.
const FP_BAR_WIDTH_RATIO = 0.55;
const MAX_BAR_WIDTH_RATIO = 0.60;

type ChartCardSpec =
  | {
      kind: "bar";
      chapterRailTestid: string;
      cardTestid: string;
      svgTestid: string;
      plotAreaTestid: string;
      barTestidPrefix: string; // selectors look up `${prefix}-${key}`
      label: string;
    }
  | {
      kind: "donut-group";
      chapterRailTestid: string;
      cardTestid: string;
      donutTestid: string;
      legendTestid: string;
      label: string;
    };

// As chapters migrate, add their chart cards here. Chapter XI
// (Weather & Utilization) is the only migrated chapter today.
const CHART_CARDS: ReadonlyArray<ChartCardSpec> = [
  {
    kind: "donut-group",
    chapterRailTestid: "reporting-chapter-weather-and-utilization",
    cardTestid: "mws-pattern-card",
    donutTestid: "mws-pattern-wrap",
    legendTestid: "mws-pattern-legend",
    label: "Chapter XI · Weather Pattern donut",
  },
  {
    kind: "bar",
    chapterRailTestid: "reporting-chapter-weather-and-utilization",
    cardTestid: "mws-rounds-card",
    svgTestid: "mws-rounds-svg",
    plotAreaTestid: "mws-rounds-plot-area",
    barTestidPrefix: "mws-rounds-bar-",
    label: "Chapter XI · Weather vs. Golf Rounds bars",
  },
];

async function measureCardInnerWidth(
  page: Page,
  cardTestid: string,
): Promise<number> {
  return await page.evaluate((testid) => {
    const card = document.querySelector(
      `[data-testid="${testid}"]`,
    ) as HTMLElement | null;
    if (!card) return -1;
    const rect = card.getBoundingClientRect();
    // Chart body applies its own px-4 (16 px each side). Subtract
    // that gutter so we measure the actual plotting region.
    return rect.width - 32;
  }, cardTestid);
}

async function measureElementWidth(
  page: Page,
  testid: string,
): Promise<number> {
  return await page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    if (!el) return -1;
    return el.getBoundingClientRect().width;
  }, testid);
}

async function measureBarChartGeometry(
  page: Page,
  spec: Extract<ChartCardSpec, { kind: "bar" }>,
): Promise<{
  svgWidth: number;
  plotWidth: number;
  dataSpan: number;
  medianBarWidth: number;
  medianStep: number;
}> {
  return await page.evaluate(
    ({ svgTid, plotTid, barPrefix }) => {
      const svg = document.querySelector(
        `[data-testid="${svgTid}"]`,
      ) as SVGSVGElement | null;
      const plotEl = document.querySelector(
        `[data-testid="${plotTid}"]`,
      ) as SVGElement | null;
      if (!svg || !plotEl) {
        return {
          svgWidth: -1,
          plotWidth: -1,
          dataSpan: -1,
          medianBarWidth: -1,
          medianStep: -1,
        };
      }

      const svgWidth = svg.getBoundingClientRect().width;
      const plotWidth = plotEl.getBoundingClientRect().width;

      // All bar group containers: <g data-testid="${barPrefix}xxx">
      // contain a <rect> (the bar) and a <text> (the label). Use the
      // rect for the bar bounding box; the text is centred under the
      // bar and would inflate the span otherwise.
      const groups = Array.from(
        document.querySelectorAll(`[data-testid^="${barPrefix}"]`),
      ) as Element[];
      const rects = groups
        .map((g) => g.querySelector("rect") as SVGRectElement | null)
        .filter((r): r is SVGRectElement => r !== null)
        .map((r) => r.getBoundingClientRect())
        .sort((a, b) => a.left - b.left);
      if (rects.length === 0) {
        return {
          svgWidth,
          plotWidth,
          dataSpan: -1,
          medianBarWidth: -1,
          medianStep: -1,
        };
      }

      const left = rects[0].left;
      const right = rects[rects.length - 1].right;

      const widths = rects.map((r) => r.width).sort((a, b) => a - b);
      const medianBarWidth = widths[Math.floor(widths.length / 2)];

      // Step = distance between adjacent bar LEFT edges (i.e. the
      // scaleBand step). Use the median across pairs to ignore
      // unusual edge effects.
      let medianStep = -1;
      if (rects.length >= 2) {
        const steps: number[] = [];
        for (let i = 1; i < rects.length; i++) {
          steps.push(rects[i].left - rects[i - 1].left);
        }
        steps.sort((a, b) => a - b);
        medianStep = steps[Math.floor(steps.length / 2)];
      }

      return {
        svgWidth,
        plotWidth,
        dataSpan: right - left,
        medianBarWidth,
        medianStep,
      };
    },
    {
      svgTid: spec.svgTestid,
      plotTid: spec.plotAreaTestid,
      barPrefix: spec.barTestidPrefix,
    },
  );
}

async function measureDonutGroupWidth(
  page: Page,
  donutTestid: string,
  legendTestid: string,
): Promise<number> {
  return await page.evaluate(
    ({ d, l }) => {
      const donut = document.querySelector(`[data-testid="${d}"]`) as HTMLElement | null;
      const legend = document.querySelector(`[data-testid="${l}"]`) as HTMLElement | null;
      if (!donut || !legend) return -1;
      const dRect = donut.getBoundingClientRect();
      const lRect = legend.getBoundingClientRect();
      return Math.max(dRect.right, lRect.right) - Math.min(dRect.left, lRect.left);
    },
    { d: donutTestid, l: legendTestid },
  );
}

type Measurement =
  | {
      kind: "bar";
      label: string;
      cardInnerWidth: number;
      svgWidth: number;
      plotWidth: number;
      dataSpan: number;
      medianBarWidth: number;
      medianStep: number;
      containerRatio: number;
      dataVsPlotRatio: number;
      dataVsCardRatio: number;
      barWidthRatio: number;
      failures: string[];
    }
  | {
      kind: "donut-group";
      label: string;
      cardInnerWidth: number;
      groupWidth: number;
      groupRatio: number;
      failures: string[];
    };

function formatMeasurement(m: Measurement): string {
  if (m.kind === "bar") {
    return (
      `  - ${m.label} (bar):\n` +
      `      cardInner=${m.cardInnerWidth.toFixed(0)} px · ` +
      `svg=${m.svgWidth.toFixed(0)} px · ` +
      `plot=${m.plotWidth.toFixed(0)} px · ` +
      `dataSpan=${m.dataSpan.toFixed(0)} px · ` +
      `barW=${m.medianBarWidth.toFixed(0)} px · ` +
      `step=${m.medianStep.toFixed(0)} px\n` +
      `      container=${(m.containerRatio * 100).toFixed(1)}% (≥ ${(MIN_CONTAINER_RATIO * 100).toFixed(0)}%) · ` +
      `dataVsPlot=${(m.dataVsPlotRatio * 100).toFixed(1)}% (≥ ${(MIN_DATA_VS_PLOT_RATIO * 100).toFixed(0)}%) · ` +
      `dataVsCard=${(m.dataVsCardRatio * 100).toFixed(1)}% (≥ ${(MIN_DATA_VS_CARD_RATIO * 100).toFixed(0)}%) · ` +
      `barW/step=${m.barWidthRatio.toFixed(2)} (≤ ${MAX_BAR_WIDTH_RATIO.toFixed(2)}, FP=${FP_BAR_WIDTH_RATIO.toFixed(2)})\n` +
      (m.failures.length ? `      FAILED: ${m.failures.join(", ")}` : "      OK")
    );
  }
  return (
    `  - ${m.label} (donut+legend group):\n` +
    `      cardInner=${m.cardInnerWidth.toFixed(0)} px · group=${m.groupWidth.toFixed(0)} px · ` +
    `groupRatio=${(m.groupRatio * 100).toFixed(1)}% (≥ ${(MIN_DONUT_GROUP_RATIO * 100).toFixed(0)}%)\n` +
    (m.failures.length ? `      FAILED: ${m.failures.join(", ")}` : "      OK")
  );
}

for (const vp of VIEWPORTS) {
  test(`plot utilization standard at ${vp.label}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await login(page);
    await page.goto("/app/admin/reporting/monthly");
    await page.waitForLoadState("networkidle");

    const measurements: Measurement[] = [];

    for (const spec of CHART_CARDS) {
      await page.getByTestId(spec.chapterRailTestid).click();
      await page.getByTestId(spec.cardTestid).waitFor({ timeout: 20_000 });
      await page.getByTestId(spec.cardTestid).scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);

      const cardInner = await measureCardInnerWidth(page, spec.cardTestid);

      if (spec.kind === "bar") {
        const {
          svgWidth,
          plotWidth,
          dataSpan,
          medianBarWidth,
          medianStep,
        } = await measureBarChartGeometry(page, spec);
        const containerRatio = cardInner > 0 ? svgWidth / cardInner : 0;
        const dataVsPlotRatio = plotWidth > 0 ? dataSpan / plotWidth : 0;
        const dataVsCardRatio = cardInner > 0 ? dataSpan / cardInner : 0;
        const barWidthRatio =
          medianStep > 0 ? medianBarWidth / medianStep : 0;
        const failures: string[] = [];
        if (containerRatio < MIN_CONTAINER_RATIO) {
          failures.push(
            `container ratio ${(containerRatio * 100).toFixed(1)}% < ${(MIN_CONTAINER_RATIO * 100).toFixed(0)}%`,
          );
        }
        if (dataVsPlotRatio < MIN_DATA_VS_PLOT_RATIO) {
          failures.push(
            `data-span vs plot ${(dataVsPlotRatio * 100).toFixed(1)}% < ${(MIN_DATA_VS_PLOT_RATIO * 100).toFixed(0)}% (bars cluster in the centre of the plot)`,
          );
        }
        if (dataVsCardRatio < MIN_DATA_VS_CARD_RATIO) {
          failures.push(
            `data-span vs card ${(dataVsCardRatio * 100).toFixed(1)}% < ${(MIN_DATA_VS_CARD_RATIO * 100).toFixed(0)}%`,
          );
        }
        if (barWidthRatio > MAX_BAR_WIDTH_RATIO) {
          failures.push(
            `bar width / step = ${barWidthRatio.toFixed(2)} > ${MAX_BAR_WIDTH_RATIO.toFixed(2)} ` +
              `(FP standard is ${FP_BAR_WIDTH_RATIO.toFixed(2)}; bars MUST NOT be widened beyond FP to inflate plot utilization — ` +
              `use \`outerPaddingRatio\` to push bars toward plot edges instead)`,
          );
        }
        measurements.push({
          kind: "bar",
          label: spec.label,
          cardInnerWidth: cardInner,
          svgWidth,
          plotWidth,
          dataSpan,
          medianBarWidth,
          medianStep,
          containerRatio,
          dataVsPlotRatio,
          dataVsCardRatio,
          barWidthRatio,
          failures,
        });
      } else {
        const groupWidth = await measureDonutGroupWidth(
          page,
          spec.donutTestid,
          spec.legendTestid,
        );
        const groupRatio = cardInner > 0 ? groupWidth / cardInner : 0;
        const failures: string[] = [];
        if (groupRatio < MIN_DONUT_GROUP_RATIO) {
          failures.push(
            `donut+legend group ratio ${(groupRatio * 100).toFixed(1)}% < ${(MIN_DONUT_GROUP_RATIO * 100).toFixed(0)}%`,
          );
        }
        measurements.push({
          kind: "donut-group",
          label: spec.label,
          cardInnerWidth: cardInner,
          groupWidth,
          groupRatio,
          failures,
        });
      }

      await page.screenshot({
        path: `test-results/plot-utilization-${vp.label}-${spec.cardTestid}.png`,
        fullPage: false,
      });
    }

    // Emit the full measurement table for every viewport so future
    // reviewers can read the data-span numbers without re-running
    // the spec. Goes through console so it shows under -reporter=list.
    // eslint-disable-next-line no-console
    console.log(
      `\n[plot-utilization @ ${vp.label}]\n` +
        measurements.map(formatMeasurement).join("\n"),
    );

    const failures = measurements.filter((m) => m.failures.length > 0);
    expect(
      failures,
      `at ${vp.label}, the following charts FAILED the plot-utilization standard (§9):\n` +
        measurements.map(formatMeasurement).join("\n"),
    ).toEqual([]);
  });
}
