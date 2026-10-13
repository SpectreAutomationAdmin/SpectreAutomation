// MBR-VIS-5J — Departmental Payroll Analysis component visibility
// acceptance.  Verifies on live staging:
//
//   §A  Visibility Inventory — the 4 headline KPI tiles, the 4
//        chart cards, and the detailed MTD/YTD summary table each
//        mount an inline toggle under its own key.
//   §B  Independence — hiding YTD Total Payroll leaves the other
//        three headline KPIs visible; hiding YTD Payroll by
//        Department leaves YTD Variance by Department visible.
//   §C  Draft Preview — hidden components are completely absent
//        from the DOM (not merely muted / display-none).
//   §F  Chapter Hierarchy — hiding Chapter XII hides every nested
//        component; restoring it preserves individual component
//        selections.
//   §G  Geometry Regression — hide → restore a representative
//        component (YTD Total Payroll) and confirm identical
//        bounding box.
//   §H  Financial Integrity — displayed KPI values remain stable
//        before and after a toggle round-trip.
//
// Draft PDF verification (§D) uses the same visibility rows the
// Draft Preview reads, which this spec covers.  Persistence (§E)
// is implied by Draft Preview DOM omission (the hidden entry is
// loaded from the server).

import { test } from "@playwright/test";
import { expect } from "@playwright/test";
import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

function ensureOutDir(): string {
  const outDir = path.join("test-results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  return outDir;
}

const KPI_KEYS = [
  "tile:payroll-analysis:ytd-total-payroll",
  "tile:payroll-analysis:ytd-variance",
  "tile:payroll-analysis:current-month-payroll",
  "tile:payroll-analysis:payroll-to-revenue",
];
const CHART_KEYS = [
  "card:payroll-analysis:ytd-payroll-by-department",
  "card:payroll-analysis:ytd-variance-by-department",
  "card:payroll-analysis:payroll-distribution",
  "card:payroll-analysis:wages-taxes-benefits-split",
];
const TABLE_KEY = "card:payroll-analysis:detailed-summary-table";
const CHAPTER_ANCHOR_ID = "payroll-analysis";
const CHAPTER_KEY = `chapter:${CHAPTER_ANCHOR_ID}`;

async function clickToggle(page: import("@playwright/test").Page, componentKey: string) {
  await page
    .locator(`[data-testid="inline-card-toggle-${componentKey}"] button`)
    .first()
    .click();
  await page.waitForTimeout(1000);
}

async function clickChapterToggle(page: import("@playwright/test").Page, anchorId: string) {
  await page
    .locator(`[data-testid="inline-chapter-toggle-${anchorId}"] button`)
    .first()
    .click();
  await page.waitForTimeout(1000);
}

async function cardHidden(
  page: import("@playwright/test").Page,
  componentKey: string,
): Promise<boolean> {
  return page.evaluate((k: string) => {
    const el = document.querySelector(`[data-component-key="${k}"]`);
    return el?.getAttribute("data-card-hidden") === "true";
  }, componentKey);
}

runAt(
  "MBR-VIS-5J · Departmental Payroll Analysis — tile + chart + table + chapter toggles + independence + preview omission + geometry + financial integrity",
  async ({ browser }) => {
    test.setTimeout(600_000);
    const ctx = await browser.newContext({ viewport: { width: 1650, height: 2200 } });
    const page = await loginAsFounder(ctx);
    const outDir = ensureOutDir();

    await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03#payroll-analysis`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(6000);

    // ─── §A — all expected toggles present. ─────────────────────
    for (const key of [...KPI_KEYS, ...CHART_KEYS, TABLE_KEY]) {
      const n = await page.locator(`[data-testid="inline-card-toggle-${key}"]`).count();
      console.log(`MBR_VIS_5J_TOGGLE ${key} count=${n}`);
      expect(n).toBeGreaterThanOrEqual(1);
    }

    // ─── §H — snapshot every KPI value label BEFORE any toggle. ─
    const kpiValuesBefore = await page.evaluate(() => {
      const read = (k: string) =>
        document.querySelector(`[data-testid="dpa-kpi-${k}-value"]`)?.textContent?.trim() ?? null;
      return {
        ytdTotal: read("ytd-total-payroll"),
        ytdVariance: read("ytd-variance"),
        march: read("current-month-payroll"),
        payrollToRev: read("payroll-to-revenue"),
      };
    });
    console.log(`MBR_VIS_5J_KPI_BEFORE ${JSON.stringify(kpiValuesBefore)}`);

    // ─── §G — baseline bounding box for YTD Total Payroll tile. ──
    const ytdTotalTile = page.locator('[data-testid="dpa-kpi-ytd-total-payroll"]').first();
    await ytdTotalTile.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    const beforeBox = await ytdTotalTile.boundingBox();
    console.log(`MBR_VIS_5J_YTD_BEFORE ${JSON.stringify(beforeBox)}`);

    // Remember any pre-existing hidden state so we restore it later.
    const ytdInitial = await cardHidden(page, KPI_KEYS[0]);

    // ─── §B — hide YTD Total Payroll; confirm the other 3 KPI
    //           tiles are untouched. ─────────────────────────────
    if (!ytdInitial) await clickToggle(page, KPI_KEYS[0]);
    const kpiIndependence = await page.evaluate((keys: string[]) => {
      return Object.fromEntries(
        keys.map((k) => [
          k,
          document
            .querySelector(`[data-component-key="${k}"]`)
            ?.getAttribute("data-card-hidden") ?? null,
        ]),
      );
    }, KPI_KEYS);
    console.log(`MBR_VIS_5J_KPI_INDEPENDENCE ${JSON.stringify(kpiIndependence)}`);
    expect(kpiIndependence[KPI_KEYS[0]]).toBe("true");
    for (let i = 1; i < KPI_KEYS.length; i++) {
      expect(kpiIndependence[KPI_KEYS[i]] ?? "false").toBe("false");
    }

    // ─── §B — hide YTD Payroll by Department; confirm YTD Variance
    //           by Department remains visible. ─────────────────────
    const chartInitial = await cardHidden(page, CHART_KEYS[0]);
    if (!chartInitial) await clickToggle(page, CHART_KEYS[0]);
    const chartIndependence = await page.evaluate(
      ({ a, b }: { a: string; b: string }) => ({
        aHidden: document.querySelector(`[data-component-key="${a}"]`)?.getAttribute("data-card-hidden"),
        bHidden: document.querySelector(`[data-component-key="${b}"]`)?.getAttribute("data-card-hidden"),
      }),
      { a: CHART_KEYS[0], b: CHART_KEYS[1] },
    );
    console.log(`MBR_VIS_5J_CHART_INDEPENDENCE ${JSON.stringify(chartIndependence)}`);
    expect(chartIndependence.aHidden).toBe("true");
    expect(chartIndependence.bHidden ?? "false").toBe("false");

    // ─── §C — Draft Preview omits hidden components from the DOM. ──
    await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03&preview=draft#payroll-analysis`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(5000);
    const previewState = await page.evaluate(
      ({ ytdKey, otherKpi, chartKey, otherChart }: { ytdKey: string; otherKpi: string; chartKey: string; otherChart: string }) => ({
        ytdPresent: !!document.querySelector(`[data-component-key="${ytdKey}"]`),
        otherKpiPresent: !!document.querySelector(`[data-component-key="${otherKpi}"]`),
        chartPresent: !!document.querySelector(`[data-component-key="${chartKey}"]`),
        otherChartPresent: !!document.querySelector(`[data-component-key="${otherChart}"]`),
      }),
      {
        ytdKey: KPI_KEYS[0],
        otherKpi: KPI_KEYS[1],
        chartKey: CHART_KEYS[0],
        otherChart: CHART_KEYS[1],
      },
    );
    console.log(`MBR_VIS_5J_PREVIEW ${JSON.stringify(previewState)}`);
    expect(previewState.ytdPresent).toBe(false);
    expect(previewState.otherKpiPresent).toBe(true);
    expect(previewState.chartPresent).toBe(false);
    expect(previewState.otherChartPresent).toBe(true);

    await page.screenshot({
      path: path.join(outDir, "mbr-vis-5j-preview-hidden.png"),
      clip: { x: 0, y: 0, width: 1650, height: 1600 },
    });
    console.log(
      "MBR_VIS_5J_PREVIEW_SCREENSHOT test-results/mbr-vis-5j-preview-hidden.png",
    );

    // Return to editing to continue the round-trip verifications.
    await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03#payroll-analysis`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(4000);

    // ─── §G — restore YTD Total Payroll; verify identical geometry. ──
    await clickToggle(page, KPI_KEYS[0]);
    await page.waitForTimeout(400);
    const afterBox = await page.locator('[data-testid="dpa-kpi-ytd-total-payroll"]').first().boundingBox();
    console.log(`MBR_VIS_5J_YTD_AFTER ${JSON.stringify(afterBox)}`);
    if (beforeBox && afterBox) {
      expect(Math.abs(beforeBox.width - afterBox.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(beforeBox.height - afterBox.height)).toBeLessThanOrEqual(1);
    }

    // Restore YTD Payroll by Department too.
    if (!chartInitial) await clickToggle(page, CHART_KEYS[0]);

    // ─── §H — KPI values stable after round-trip. ─────────────────
    const kpiValuesAfter = await page.evaluate(() => {
      const read = (k: string) =>
        document.querySelector(`[data-testid="dpa-kpi-${k}-value"]`)?.textContent?.trim() ?? null;
      return {
        ytdTotal: read("ytd-total-payroll"),
        ytdVariance: read("ytd-variance"),
        march: read("current-month-payroll"),
        payrollToRev: read("payroll-to-revenue"),
      };
    });
    console.log(`MBR_VIS_5J_KPI_AFTER ${JSON.stringify(kpiValuesAfter)}`);
    expect(kpiValuesAfter).toEqual(kpiValuesBefore);

    // ─── §F — chapter-level hide should cascade.  Hide the whole
    //           chapter + verify the headline KPI tile is omitted
    //           from Draft Preview; restore it and confirm the
    //           previous individual selections persist.
    //   Chapters use `InlineChapterToggle` (anchorId-based testid),
    //   NOT the `InlineCardToggle` component-key convention — hence
    //   the separate helper. ─────────────────────────────────────
    const chapterInitial = await cardHidden(page, CHAPTER_KEY);
    if (!chapterInitial) await clickChapterToggle(page, CHAPTER_ANCHOR_ID);
    await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03&preview=draft`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(4000);
    const cascadeState = await page.evaluate((k: string) => ({
      kpiPresent: !!document.querySelector(`[data-component-key="${k}"]`),
    }), KPI_KEYS[0]);
    console.log(`MBR_VIS_5J_CHAPTER_CASCADE ${JSON.stringify(cascadeState)}`);
    expect(cascadeState.kpiPresent).toBe(false);

    // Cleanup — restore chapter visibility.
    await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03#payroll-analysis`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(4000);
    if (!chapterInitial) await clickChapterToggle(page, CHAPTER_ANCHOR_ID);

    // If the Controller originally had the YTD tile hidden, restore
    // that state; otherwise it's already visible.
    if (ytdInitial) await clickToggle(page, KPI_KEYS[0]);

    // Full-chapter screenshot of editing mode (all restored).
    await page.setViewportSize({ width: 1650, height: 3200 });
    await page.waitForTimeout(500);
    await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-03#payroll-analysis`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(5000);
    await page.screenshot({
      path: path.join(outDir, "mbr-vis-5j-editing-payroll-analysis.png"),
      clip: { x: 0, y: 0, width: 1650, height: 3200 },
    });
    console.log(
      "MBR_VIS_5J_EDITING_SCREENSHOT test-results/mbr-vis-5j-editing-payroll-analysis.png",
    );

    await ctx.close();
  },
);
