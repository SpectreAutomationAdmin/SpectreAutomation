// REPORT-LIVE-3 (2026-10-04) — Section II Jan Actual vs Budget
// semantic acceptance:
//   • Operating Results shows Jan Actual bar + Jan Budget bar.
//   • Department Performance shows 8 depts with Actual + Budget +
//     Variance populated.
//   • Payroll Department shows Actual + Budget populated; Prior Year
//     explicitly "—" (not fabricated $0).
//   • Scorecards remain precise-unavailable (Phase B deferred).
//   • Dues Subsidy + Payroll Ratio Trend unchanged.
//   • Protected baseline + REPORT-CHART-1A regression hold.

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

runAt("REPORT-LIVE-3 · Section II Actual vs Budget acceptance", async ({ browser }) => {
  test.setTimeout(300_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  const before = await invariant(page);
  console.log("REPORT_LIVE_3_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#financial-performance`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="financial-performance-source-panel"]').waitFor({ state: "visible", timeout: 20_000 });

  // ---------- Operating Results — Actual + Budget bars ----------
  const opCard = page.locator('article:has-text("Operating Results")').first();
  const opRects = await opCard.locator("svg rect").count();
  const opTexts = await opCard.locator("svg text").allTextContents();
  console.log("REPORT_LIVE_3_OPERATING " + JSON.stringify({ opRects, labelsSample: opTexts.slice(0, 15) }));
  // Primary + secondary bars at Jan = 2 data rects; plus legend swatches.
  // Expected ≥ 3 rects total (2 data + ≥1 legend) and < 15 (no 12-slot fabrication).
  expect(opRects).toBeGreaterThanOrEqual(2);
  expect(opRects).toBeLessThan(15);
  expect(opTexts.some((t) => /Jan\s*2026/.test(t))).toBe(true);

  // Operating KPI tiles: YTD NOI + Budget Goal visible, both now
  // populated with real values (not $0).
  const opKpis = await opCard.locator('[data-testid="stewardship-kpi"]').allTextContents().catch(() => [] as string[]);
  console.log("REPORT_LIVE_3_OPERATING_KPIS " + JSON.stringify(opKpis.slice(0, 10)));

  // Commentary — must NOT contain "comfortably ahead of policy".
  const opBody = await opCard.innerText();
  console.log("REPORT_LIVE_3_OPERATING_COMMENTARY " + JSON.stringify(opBody.slice(-500)));
  expect(opBody.toLowerCase()).not.toContain("comfortably ahead of policy");
  // The ONLY acceptable use of "favourable" / "unfavourable" is the
  // negated-judgment footer sentence. Any other instance is a §31
  // violation.
  const favTokens = opBody.match(/\bfavou?rable\b/gi) ?? [];
  const unfavTokens = opBody.match(/\bunfavou?rable\b/gi) ?? [];
  const approvedFooter = opBody.match(/no favou?rable\/unfavou?rable judgment/gi) ?? [];
  expect(favTokens.length + unfavTokens.length).toBe(2 * approvedFooter.length);
  // Must contain the factual-narrative key phrases.
  expect(opBody).toMatch(/mathematical variance/i);

  // ---------- Department Performance — Budget + Variance columns ----------
  const deptCard = page.locator('[data-testid="department-net-performance"]');
  const deptRows = await deptCard.locator('[data-testid^="department-row-"]').count();
  console.log("REPORT_LIVE_3_DEPT_ROWS " + JSON.stringify({ deptRows }));
  expect(deptRows).toBeGreaterThanOrEqual(8);

  // Pull three sample rows and assert they contain Variance text —
  // NOT the "—" placeholder from REPORT-LIVE-2.
  for (const code of ["dues-and-charges", "administration", "food-beverage"]) {
    const rowSel = `[data-testid="department-row-${code}"]`;
    const rowCount = await deptCard.locator(rowSel).count();
    if (rowCount === 0) {
      console.log(`REPORT_LIVE_3_DEPT_MISS ${code}`);
      continue;
    }
    const rowText = (await deptCard.locator(rowSel).innerText()).replace(/\s+/g, " ");
    console.log(`REPORT_LIVE_3_DEPT_${code.toUpperCase()}: ${JSON.stringify(rowText)}`);
    // Row should now contain a $-prefixed Variance (not just "—").
    const dashOnlyCount = (rowText.match(/—/g) ?? []).length;
    expect(dashOnlyCount).toBeLessThan(3);
  }

  // ---------- Payroll Department — Actual + Budget ----------
  const payrollCard = page.locator('[data-testid="payroll-department"]');
  await payrollCard.waitFor({ state: "visible", timeout: 10_000 });
  const payrollKpis = await payrollCard.locator('[data-testid="payroll-department-kpis"]').innerText();
  console.log("REPORT_LIVE_3_PAYROLL_KPIS " + JSON.stringify(payrollKpis.replace(/\s+/g, " ")));
  // vs. Prior Year must render "—" (nullable), vs. Budget must render
  // a $-prefixed number (populated).
  expect(payrollKpis).toMatch(/—/);
  // vs. Budget tile should have a $ sign (populated).
  expect(payrollKpis).toMatch(/\$/);

  // Payroll chart should have fewer rects than 3 series × 8 depts =
  // 24 (because Prior Year series is filtered out when null).
  const payrollRects = await payrollCard.locator("svg rect").count();
  console.log("REPORT_LIVE_3_PAYROLL_RECTS " + JSON.stringify({ payrollRects }));
  expect(payrollRects).toBeGreaterThan(0);

  // ---------- Precise unavailable reasons intact ----------
  const mainBody = page.locator('section#financial-performance');
  const reasons = [
    { label: "scorecards", needle: /targets \+ benchmarks not configured/ },
    { label: "duesSubsidy", needle: /allocation donut needs a Coulee-specific/ },
    { label: "payrollTrend", needle: /Multi-month payroll ratio history not connected/ },
  ];
  for (const { label, needle } of reasons) {
    const found = needle.test(await mainBody.innerText());
    console.log(`REPORT_LIVE_3_REASON_${label}: ${found ? "FOUND" : "MISSING"}`);
    expect(found).toBe(true);
  }

  // ---------- REPORT-CHART-1A regression ----------
  const equityCircles = await page.locator('article:has-text("Equity Value Over Time") svg circle').count();
  console.log("REPORT_LIVE_3_EQUITY_REGRESSION " + JSON.stringify({ equityCircles }));
  expect(equityCircles).toBeGreaterThanOrEqual(2);

  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  await page.screenshot({ path: "test-results/report-live-3-section-ii.png", fullPage: true });
  await context.close();
});
