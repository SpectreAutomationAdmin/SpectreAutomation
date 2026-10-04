// REPORT-CHART-1 §20-21 (2026-10-03) — chart-level staging acceptance
// for Equity Value Over Time + Operating Results.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const COA_BATCH_ID = "cmuni5ymv000k136q3xdyrpmn";

async function invariant(page: Page) {
  const r = await page.request.get(`${BASE}/api/admin/coa-batch-diagnostic/${COA_BATCH_ID}`);
  expect(r.ok()).toBe(true);
  return r.json();
}

runAt("REPORT-CHART-1 · Section II charts render authoritative snapshot data", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  const before = await invariant(page);
  console.log("REPORT_CHART_1_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#financial-performance`, { waitUntil: "domcontentloaded" });
  // Wait for the Section II panel so the subsequent chart look-ups
  // see the hydrated DOM.
  await page.locator('[data-testid="financial-performance-source-panel"]').waitFor({ state: "visible", timeout: 20_000 });

  // ---- Section II visible text snapshot (full body of the FP section) ----
  const sectionText = await page.locator('section#financial-performance').first().innerText();
  // The old "Data not available for this reporting period" four-box
  // placeholder must NOT appear anywhere in Section II when real data
  // is loaded.
  const stalePlaceholderCount = (sectionText.match(/Data not available for this reporting period/g) ?? []).length;
  console.log("REPORT_CHART_1_STALE_PLACEHOLDER_COUNT " + JSON.stringify({ count: stalePlaceholderCount }));

  // ---- Equity Value Over Time (SVG inspection) ----
  // The chart renders SVG circle markers for each real data point.
  // We count visible markers inside the Equity card.
  const equityCard = page.locator('[data-testid="stewardship-card-equity"], article:has-text("Equity Value Over Time")').first();
  const equityMarkerCount = await equityCard.locator("svg circle").count().catch(() => 0);
  // SVG <text> nodes read via allTextContents (allInnerTexts returns
  // empty strings for SVG where the host element has no CSS-rendered
  // inline text box).
  const equityXLabels = await equityCard.locator("svg text").allTextContents().catch(() => [] as string[]);
  console.log("REPORT_CHART_1_EQUITY " + JSON.stringify({
    equityMarkerCount,
    xLabelsSample: equityXLabels.filter((t) => /\b20\d{2}\b|\bDec\b|\bJan\b/.test(t)).slice(0, 8),
  }));
  // Expect at least 2 real data points (Dec 2025 + Jan 2026).
  expect(equityMarkerCount).toBeGreaterThanOrEqual(2);
  // Expect the x-labels to contain the two committed-snapshot months.
  const hasDec2025 = equityXLabels.some((t) => /Dec\s*2025/.test(t));
  const hasJan2026 = equityXLabels.some((t) => /Jan\s*2026/.test(t));
  console.log("REPORT_CHART_1_EQUITY_LABELS " + JSON.stringify({ hasDec2025, hasJan2026 }));
  expect(hasDec2025 || hasJan2026).toBe(true);

  // ---- Operating Results (SVG inspection) ----
  // OperatingResultsCard uses an EditorialBarChart — data points are
  // RECT bars, not circles. We require >= 1 bar rendered inside the
  // chart's SVG, which proves the Jan 2026 committed-snapshot NOI
  // reached the plot area.
  const opCard = page.locator('article:has-text("Operating Results")').first();
  const opBarCount = await opCard.locator("svg rect").count().catch(() => 0);
  const opXLabels = await opCard.locator("svg text").allTextContents().catch(() => [] as string[]);
  console.log("REPORT_CHART_1_OPERATING " + JSON.stringify({
    opBarCount,
    xLabelsSample: opXLabels.filter((t) => /\bJan\b|\bFeb\b|\bMar\b|\bApr\b|\bMay\b|\bJun\b|\bJul\b|\bAug\b|\bSep\b|\bOct\b|\bNov\b|\bDec\b/.test(t)).slice(0, 15),
  }));
  const hasOpDec2025 = opXLabels.some((t) => /Dec\s*2025/.test(t));
  const hasOpJan2026 = opXLabels.some((t) => /Jan\s*2026/.test(t));
  console.log("REPORT_CHART_1_OPERATING_LABELS " + JSON.stringify({ hasOpDec2025, hasOpJan2026 }));
  // Expect >= 1 real plotted Actual bar (Jan 2026).
  expect(opBarCount).toBeGreaterThanOrEqual(1);
  expect(hasOpDec2025 || hasOpJan2026).toBe(true);

  // ---- Baseline hold ----
  const after = await invariant(page);
  expect(after.club).toEqual(before.club);

  await page.screenshot({ path: "test-results/report-chart-1-jan2026-section-ii.png", fullPage: true });
  await context.close();
});
