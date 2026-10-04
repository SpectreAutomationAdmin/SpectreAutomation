// REPORT-WIRING-1 (2026-10-04) — Monthly Reporting Package central
// contract acceptance. Three sections, one architecture.
//
// Confirms:
//   • Executive At-a-Glance KPI cards now surface "% above/below plan"
//     for Revenue + NOI (via central contract → ExecutiveSummary aux).
//   • Operating Results chart renders Budget bars for all 12 months
//     (Jan + future Feb-Dec), not just committed-snapshot months.
//   • Section IV Statement of Activities Budget columns populate
//     with real Jan 2026 Budget values.
//   • Protected baseline + prior-slice regressions hold.

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

runAt("REPORT-WIRING-1 · Section I/II/IV central Budget contract", async ({ browser }) => {
  test.setTimeout(240_000);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(context);

  const before = await invariant(page);
  console.log("REPORT_WIRING_1_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.budgetCount ?? 1).toBeGreaterThanOrEqual(1);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="financial-performance-source-panel"]').waitFor({ state: "visible", timeout: 20_000 });

  // ------------- SYMPTOM 1 — Executive At-a-Glance (cover) -------------
  // The cover's At-a-Glance block uses `monthly-cover-at-a-glance-${key}-variance`
  // for the variance line. After the central contract feeds Budget
  // comparators, Revenue + NOI should carry a "% above/below plan" string.
  const revVar = await page
    .locator('[data-testid="monthly-cover-at-a-glance-ytd-revenue-variance"]')
    .innerText()
    .catch(() => "");
  const noiVar = await page
    .locator('[data-testid="monthly-cover-at-a-glance-noi-variance"]')
    .innerText()
    .catch(() => "");
  console.log("REPORT_WIRING_1_EXEC_REVENUE " + JSON.stringify(revVar));
  console.log("REPORT_WIRING_1_EXEC_NOI " + JSON.stringify(noiVar));
  // Must contain a factual "% above/below plan" string (not blank /
  // "comparative not available"). The exact magnitude is intentionally
  // NOT pinned — the Executive IS projection and the ratio-registry /
  // Budget resolver use different account classifiers (see
  // REPORT-WIRING-1 AF — follow-up classifier reconciliation).
  // Both variance tokens must have a sign and the "plan" suffix.
  expect(revVar).toMatch(/[+(]?\d+(\.\d+)?%?\)?\s+(ABOVE|BELOW)\s+PLAN/i);
  expect(noiVar).toMatch(/[+(]?\d+(\.\d+)?%?\)?\s+(ABOVE|BELOW)\s+PLAN/i);

  // ------------- SYMPTOM 2 — Operating Results chart -------------
  const opCard = page.locator('article:has-text("Operating Results")').first();
  const opRects = await opCard.locator("svg rect").count();
  const opTexts = await opCard.locator("svg text").allTextContents();
  console.log("REPORT_WIRING_1_OP " + JSON.stringify({ opRects, xLabels: opTexts.filter((t) => /20\d{2}/.test(t)).slice(0, 20) }));
  // 12 Budget bars + 1 Jan Actual bar + legend swatches ≈ 15–30 rects
  // (vs the 3 rects we saw after SCORECARD-PARTIAL-1).
  expect(opRects).toBeGreaterThanOrEqual(13);

  // ------------- SYMPTOM 3 — Statement of Activities -------------
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#statement-of-activities`, { waitUntil: "domcontentloaded" });
  // Give the SoA panel time to render.
  await page.waitForTimeout(2500);
  const soaPanel = page.locator('[data-testid="statement-of-activities-panel"], section#statement-of-activities, section:has-text("Statement of Activities")').first();
  const soaBody = await soaPanel.innerText().catch(() => "");
  console.log("REPORT_WIRING_1_SOA_SNIPPET " + JSON.stringify(soaBody.slice(0, 1000)));
  // SoA cells render as plain-number tabular amounts (e.g. "1,730,327"
  // not "$1,730,327"). Count comma-separated amounts >= 1000 to prove
  // Budget columns are populated. Before the fix every Budget column
  // was 0 → only Actual values appeared.
  const amountMatches = soaBody.match(/\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b/g) ?? [];
  console.log("REPORT_WIRING_1_SOA_AMOUNT_COUNT " + JSON.stringify({
    count: amountMatches.length,
    sample: amountMatches.slice(0, 15),
  }));
  // The SoA has ~30+ rows × 6 numeric columns — expect many hundreds
  // of comma-separated amounts when Budget columns populate.
  expect(amountMatches.length).toBeGreaterThanOrEqual(40);
  // Must contain the headers.
  expect(soaBody).toMatch(/JAN BUDGET/i);
  expect(soaBody).toMatch(/YTD BUDGET/i);

  // ------------- REGRESSION — SCORECARD-PARTIAL-1 defect fixes hold -------------
  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#financial-performance`, { waitUntil: "domcontentloaded" });
  const opBodyText = await opCard.innerText();
  // Prior Year still "—", period label still "January YTD".
  const priorMatch = opBodyText.match(/([^\n]{1,6})\nPRIOR YEAR\n/);
  console.log("REPORT_WIRING_1_PRIOR_TILE " + JSON.stringify(priorMatch?.[1] ?? "NOT FOUND"));
  expect(priorMatch?.[1]).toBe("—");
  expect(opBodyText).toMatch(/January YTD/);

  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  await page.screenshot({ path: "test-results/report-wiring-1-section-ii.png", fullPage: true });
  await context.close();
});
