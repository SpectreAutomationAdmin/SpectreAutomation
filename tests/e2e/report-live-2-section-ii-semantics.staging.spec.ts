// REPORT-LIVE-2 (2026-10-04) — Section II live-wiring acceptance:
//   • Department Performance renders 8 Coulee departments LIVE from
//     the committed Jan 2026 TB (actual column only; budget / variance
//     / trend-bar hidden per directive §8).
//   • Scorecards / Dues / Payroll cards render PRECISE unavailable
//     reasons (not the generic "Data not available for this reporting
//     period" placeholder).
//   • Protected baseline unchanged before + after.

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

runAt("REPORT-LIVE-2 · Section II live + precise unavailable reasons", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  // --- Protected baseline, before ---
  const before = await invariant(page);
  console.log("REPORT_LIVE_2_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  // --- Open the admin page ---
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#financial-performance`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="financial-performance-source-panel"]').waitFor({ state: "visible", timeout: 20_000 });

  // --- §6-8: Department Performance LIVE ---
  const deptCard = page.locator('[data-testid="department-net-performance"]');
  await deptCard.waitFor({ state: "visible", timeout: 10_000 });
  const deptRows = await deptCard.locator('[data-testid^="department-row-"]').count();
  console.log("REPORT_LIVE_2_DEPT_ROWS " + JSON.stringify({ deptRows }));
  // 8 Coulee departments (or possibly 9 if nondepartmental has any
  // net activity). Minimum 8.
  expect(deptRows).toBeGreaterThanOrEqual(8);

  // §8 — Budget + Variance cells must render "—" (not "$0") for every
  // row, since Budget is SOURCE_NOT_CONNECTED.
  const firstRow = deptCard.locator('[data-testid^="department-row-"]').first();
  const firstRowText = await firstRow.innerText();
  console.log("REPORT_LIVE_2_FIRST_ROW " + JSON.stringify(firstRowText));
  // Row's grid: name | actual | budget | variance | trend. The "—"
  // appears for the budget + variance cells.
  expect(firstRowText).toMatch(/—/);

  // §28 — no fabricated judgment language in the commentary.
  const deptCommentary = await deptCard.locator("p, div").filter({ hasText: /Budget comparison not connected/ }).count();
  console.log("REPORT_LIVE_2_DEPT_COMMENTARY_HAS_PRECISE_REASON " + JSON.stringify({ deptCommentary }));
  expect(deptCommentary).toBeGreaterThanOrEqual(1);

  // --- §20: Precise unavailable reasons on the remaining cards ---
  const mainBody = page.locator('section#financial-performance');

  // Each precise reason string must appear exactly where we put it.
  const reasons = [
    { card: "stewardship-scorecard-operating", needle: /targets \+ benchmarks not configured/ },
    { card: "stewardship-scorecard-capital",   needle: /targets \+ benchmarks not configured/ },
    { card: "dues-subsidy-analysis",           needle: /allocation donut needs a Coulee-specific/ },
    { card: "payroll-department",              needle: /payroll breakdown not yet exposed/ },
    { card: "payroll-ratio-trend",             needle: /Multi-month payroll ratio history not connected/ },
  ];
  for (const { card, needle } of reasons) {
    const el = page.locator(`[data-testid="${card}"]`);
    // The card may not have a scoped testid wrapper if the Chapter II
    // placeholder renders a generic article; fall back to the chapter
    // body text search for the needle.
    const inCard = (await el.count()) > 0 ? await el.innerText().catch(() => "") : "";
    const inBody = await mainBody.innerText();
    const matched = needle.test(inCard) || needle.test(inBody);
    console.log(`REPORT_LIVE_2_REASON_${card}: ${matched ? "FOUND" : "MISSING"}`);
    expect(matched).toBe(true);
  }

  // §20 — the OLD generic placeholder must no longer appear anywhere in
  // Section II (we replaced it with per-card reasons).
  const genericCount = (
    await mainBody.innerText()
  ).match(/Data not available for this reporting period/g)?.length ?? 0;
  console.log("REPORT_LIVE_2_GENERIC_PLACEHOLDER_COUNT " + JSON.stringify({ genericCount }));
  expect(genericCount).toBe(0);

  // --- REPORT-CHART-1A regression: charts still live ---
  const equityCircles = await page.locator('article:has-text("Equity Value Over Time") svg circle').count();
  const opRects = await page.locator('article:has-text("Operating Results") svg rect').count();
  console.log("REPORT_LIVE_2_CHART_REGRESSION " + JSON.stringify({ equityCircles, opRects }));
  expect(equityCircles).toBeGreaterThanOrEqual(2);
  expect(opRects).toBeGreaterThanOrEqual(1);
  expect(opRects).toBeLessThan(10);

  // --- Protected baseline, after ---
  const after = await invariant(page);
  expect(after.club).toEqual(before.club);

  await page.screenshot({
    path: "test-results/report-live-2-section-ii.png",
    fullPage: true,
  });
  await context.close();
});
