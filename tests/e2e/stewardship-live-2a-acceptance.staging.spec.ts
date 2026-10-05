// STEWARDSHIP-LIVE-2A (2026-10-05) — Section III availability
// semantics staging acceptance.
//
// Verifies the three closeout fixes:
//   §1  AR Current % — live value from the canonical ratio-registry
//       (~99.3% per existing architecture).
//   §2  Capital Income vs Plan — SOURCE_NOT_CONNECTED (not +0.0%).
//       Live Actual still shown; vs-plan unavailable; tone neutral.
//   §3  Initiation Fee Operating Subsidy — N/A — Entrance fees
//       classified to Capital Fund.

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

runAt("STEWARDSHIP-LIVE-2A · Section III availability closeout", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("STEWARDSHIP_LIVE_2A_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#stewardship-dashboard`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="stewardship-kpi-dashboard"]').waitFor({ state: "visible", timeout: 20_000 });

  // ---- (A) AR Current % — canonical value from ratio-registry ----
  const arActual = await page.locator('[data-testid="stewardship-ar-current-actual"]').innerText();
  const arAssessment = await page.locator('[data-testid="stewardship-ar-current-assessment"]').innerText();
  console.log("STEWARDSHIP_LIVE_2A_AR_CURRENT " + JSON.stringify({ actual: arActual, assessment: arAssessment }));
  // Expected ~99.3% per the canonical ratio-registry source.
  // Allow 97-100% band (snapshot values can shift slightly month to month).
  expect(arActual).toMatch(/9[7-9]\.\d%|100\.0%/);
  // Not the "Source not connected" sentinel.
  expect(arAssessment).not.toMatch(/^Source not connected/i);

  // ---- (B) Capital Income vs Plan — SOURCE_NOT_CONNECTED (not +100%) ----
  const capActual = await page.locator('[data-testid="stewardship-capital-income-vs-plan-actual"]').innerText();
  const capAssessment = await page.locator('[data-testid="stewardship-capital-income-vs-plan-assessment"]').innerText();
  console.log("STEWARDSHIP_LIVE_2A_CAPITAL_INCOME_VS_PLAN " + JSON.stringify({ actual: capActual, assessment: capAssessment }));
  // Must NOT render as a bogus percentage against a zero plan.
  expect(capActual).not.toMatch(/^[+-]?\d+\.\d%$/);
  // Must render the live Actual dollar amount ($977K per canonical).
  expect(capActual).toMatch(/\$977K|\$0\.977M/);
  // Assessment is the capital-budget-not-connected sentinel.
  expect(capAssessment).toMatch(/Capital budget not connected/);

  // ---- (C) Initiation Fee Operating Subsidy — N/A (Capital-classified) ----
  const initFeeActual = await page.locator('[data-testid="stewardship-init-fee-subsidy-actual"]').innerText();
  const initFeeAssessment = await page.locator('[data-testid="stewardship-init-fee-subsidy-assessment"]').innerText();
  console.log("STEWARDSHIP_LIVE_2A_INIT_FEE_SUBSIDY " + JSON.stringify({ actual: initFeeActual, assessment: initFeeAssessment }));
  expect(initFeeActual).toBe("N/A");
  expect(initFeeAssessment).toMatch(/^N\/A — Entrance fees classified to Capital Fund/);

  // ---- (D) Previously-canonical cards still correct (regression gate) ----
  const dues = await page.locator('[data-testid="stewardship-dues-rev-actual"]').innerText();
  const payroll = await page.locator('[data-testid="stewardship-payroll-ratio-actual"]').innerText();
  const noi = await page.locator('[data-testid="stewardship-summary-noi-value"]').innerText();
  console.log("STEWARDSHIP_LIVE_2A_REGRESSION " + JSON.stringify({ dues, payroll, noi }));
  expect(dues).toMatch(/98\.9%/);
  expect(payroll).toMatch(/5\.2%/);
  expect(noi).toMatch(/\$2\.820M/);

  // ---- (E) Baseline unchanged + screenshot ----
  await page.screenshot({ path: "test-results/stewardship-live-2a-section-iii.png", fullPage: true });
  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  await ctx.close();
});
