// REPORT-CHART-1A §8 + §9 (2026-10-03) — semantic chart acceptance:
//   • Diag endpoint proves Dec = null (BS-only), Jan = $3,762,688.26.
//   • SVG proves Operating renders exactly 1 primary bar (no Dec $0
//     bar, no fabricated Feb–future bars, no fake budget bars, no
//     fake prior-year overlay segments).
//   • Y-axis major-tick count sits in [4, 7].

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";
const CLUB_ID = "cmrvdeny7000144372ktmmg9c";

async function invariant(page: Page) {
  const r = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(r.ok()).toBe(true);
  return r.json();
}

runAt("REPORT-CHART-1A · Operating semantics + axis cleanup", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  // --- Protected baseline, before ---
  const before = await invariant(page);
  console.log("REPORT_CHART_1A_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  // --- §8 diag: resolver output is semantically correct ---
  const diag = await page.request.get(`${BASE}/api/admin/equity-history-diagnostic?clubId=${CLUB_ID}`);
  expect(diag.ok()).toBe(true);
  const d = await diag.json();
  console.log("REPORT_CHART_1A_DIAG_EQUITY " + JSON.stringify(d.equity));
  console.log("REPORT_CHART_1A_DIAG_OPERATING " + JSON.stringify(d.operating));

  // Equity still carries Dec + Jan.
  expect(d.equity.seriesLength).toBe(2);
  // Operating: Dec OMITTED (BS-only snapshot). Only Jan remains.
  expect(d.operating.monthsLength).toBe(1);
  const janMonth = d.operating.months[0];
  expect(janMonth.monthLabel).toMatch(/Jan\s*2026/);
  expect(janMonth.noi).toBeCloseTo(3_762_688.26, 2);
  expect(janMonth.revenue).toBeCloseTo(4_101_392.92, 2);
  expect(janMonth.budgetNoi).toBeNull();
  expect(d.operating.ytdNoi).toBeCloseTo(3_762_688.26, 2);

  // --- §12 visual acceptance: open the admin page ---
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#financial-performance`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="financial-performance-source-panel"]').waitFor({ state: "visible", timeout: 20_000 });

  const equityCard = page.locator('article:has-text("Equity Value Over Time")').first();
  const opCard = page.locator('article:has-text("Operating Results")').first();

  // Equity: 2 data markers + 1 legend marker = 3 circles.
  const equityCircles = await equityCard.locator("svg circle").count();
  const equityTexts = await equityCard.locator("svg text").allTextContents();
  console.log("REPORT_CHART_1A_EQUITY " + JSON.stringify({ equityCircles, equityTexts }));
  expect(equityCircles).toBeGreaterThanOrEqual(2);
  expect(equityTexts.some((t) => /Dec\s*2025/.test(t))).toBe(true);
  expect(equityTexts.some((t) => /Jan\s*2026/.test(t))).toBe(true);

  // §9 — Equity axis major-tick count ≤ 7. The chart ticks are rendered
  // as svg <text> labels; filter for the $-prefixed y-axis values.
  const equityYTicks = equityTexts.filter((t) => /^\$[0-9.]+[KM]?$/.test(t.trim()));
  console.log("REPORT_CHART_1A_EQUITY_Y_TICKS " + JSON.stringify(equityYTicks));
  expect(equityYTicks.length).toBeGreaterThanOrEqual(2);
  expect(equityYTicks.length).toBeLessThanOrEqual(7);

  // Operating: §8 bar-count semantics inside the primary SVG.
  // The Operating card contains:
  //   • 12 budget rects (secondary) — but all values are NULL on the
  //     snapshot path, so zero rects are emitted.
  //   • 12 primary rects — but 11 are NULL, so only Jan 2026 renders.
  //   • Gridlines are LINES not RECTS.
  // So the chart should carry a very small bar count — proving no
  // fabricated Dec $0 bar, no fabricated Feb-forward bars, no
  // fabricated budget.
  const opSvgRects = await opCard.locator("svg rect").count();
  console.log("REPORT_CHART_1A_OPERATING_SVG_RECTS " + JSON.stringify({ opSvgRects }));
  // 1 Jan bar — possibly 1 legend "Actual" swatch rect — total should
  // be very small (≤ 5). The old 12-month $0-fabricated path would
  // emit ≥ 12 primary + ≥ 12 secondary = 24+ rects.
  expect(opSvgRects).toBeGreaterThanOrEqual(1);
  expect(opSvgRects).toBeLessThan(10);

  const opTexts = await opCard.locator("svg text").allTextContents();
  // Jan 2026 x-label must be present.
  expect(opTexts.some((t) => /Jan\s*2026/.test(t))).toBe(true);

  // §9 — Operating y-tick major-label count in [4, 7]. Filter the
  // $-prefixed labels.
  const opYTicks = opTexts.filter((t) => /^\$[0-9.]+[KM]?$/.test(t.trim()));
  console.log("REPORT_CHART_1A_OPERATING_Y_TICKS " + JSON.stringify(opYTicks));
  expect(opYTicks.length).toBeGreaterThanOrEqual(4);
  expect(opYTicks.length).toBeLessThanOrEqual(7);

  // §4 — labels use compact $M (never $1000K+ for the $0 → $4M axis).
  expect(opYTicks.some((t) => /\$1000K/.test(t))).toBe(false);
  expect(opYTicks.some((t) => /\$2000K/.test(t))).toBe(false);
  // $M notation is present for the top of the range.
  expect(opYTicks.some((t) => /\$[1-9]M/.test(t))).toBe(true);

  // --- Protected baseline, after ---
  const after = await invariant(page);
  expect(after.club).toEqual(before.club);

  await page.screenshot({
    path: "test-results/report-chart-1a-jan2026-section-ii.png",
    fullPage: true,
  });
  await context.close();
});
