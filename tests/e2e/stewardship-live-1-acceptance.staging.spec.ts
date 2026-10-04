// STEWARDSHIP-LIVE-1 (2026-10-04) — staging acceptance.
//
// Confirms Section III "Operating vs. Capital Stewardship" renders
// LIVE data (not a blanket "Data not available for this reporting
// period." placeholder) for Coulee's January 2026 report.
//
// Headline cards:
//   • TOTAL OPERATING REVENUE   ~ $3.124M  (canonical operating-fund)
//   • NOI BEFORE DEPRECIATION   ~ $2.813M  (REPORT-WIRING-1B canonical)
//   • CAPITAL FUND INCOME YTD   ~ $0.967M  (canonical capital-fund)
//   • RESERVE COVERAGE RATIO    precise unavailable (Reserve Study
//                                not connected)
//
// Operating / Capital stewardship panels:
//   • live financial-derivable KPI cards render (dues-rev, payroll-
//     ratio, noi-margin for operating; capital-income-vs-plan,
//     debt-equity, ppe-reinvestment, working-capital for capital).
//   • auxiliary cards (fb-subsidy, rounds, covers, ar-current,
//     init-fee-subsidy, reserve-coverage, capital-spend, reserve-
//     sufficiency, project-completion) render precise unavailable
//     cards — NEVER Silver Springs demo numerics.

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

runAt("STEWARDSHIP-LIVE-1 · Section III live headline + KPI cards + precise unavailable Reserve Coverage", async ({ browser }) => {
  test.setTimeout(240_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  const before = await invariant(page);
  console.log("STEWARDSHIP_LIVE_1_BEFORE " + JSON.stringify({ club: before.club }));
  expect(before.club.account).toBe(562);
  expect(before.club.journalEntry).toBe(0);
  expect(before.club.reportingLedgerBatch).toBe(2);
  expect(before.club.reportingLedgerSnapshot).toBe(2);

  await page.goto(`${BASE}/app/admin/reporting/monthly?period=2026-01#stewardship-dashboard`, { waitUntil: "domcontentloaded" });
  await page.locator('[data-testid="stewardship-kpi-dashboard"]').waitFor({ state: "visible", timeout: 20_000 });

  // ---- Section-level: "Operating vs. Capital Stewardship" sub-header
  //      still renders ----
  await expect(page.locator('[data-testid="stewardship-kpi-dashboard-op-vs-cap-heading"]'))
    .toContainText("Operating vs. Capital Stewardship");

  // ---- Headline summary cards — live numerics ----
  const revenue = await page.locator('[data-testid="stewardship-summary-revenue-value"]').innerText().catch(() => "");
  const noi     = await page.locator('[data-testid="stewardship-summary-noi-value"]').innerText().catch(() => "");
  const capFund = await page.locator('[data-testid="stewardship-summary-capital-fund-income-value"]').innerText().catch(() => "");
  const reserve = await page.locator('[data-testid="stewardship-summary-reserve-coverage-value"]').innerText().catch(() => "");
  console.log("STEWARDSHIP_LIVE_1_HEADLINE " + JSON.stringify({ revenue, noi, capFund, reserve }));

  // Revenue — canonical operating-fund (~$3.124M).
  expect(revenue).toMatch(/\$3\.1[0-9]{2}M/);
  // NOI — canonical NOI before dep (~$2.813M).
  expect(noi).toMatch(/\$2\.8[0-9]{2}M/);
  // Capital Fund Income YTD (~$0.967M).
  expect(capFund).toMatch(/\$0\.9[0-9]{2}M|\$9[0-9]{2}K/);
  // Reserve Coverage — precise unavailable, NEVER "61%" (Silver Springs demo).
  expect(reserve).not.toMatch(/61%|60%/);

  // No section-level "Data not available for this reporting period."
  // when at least one card is live.
  const introText = await page.locator('[data-testid="stewardship-kpi-dashboard-intro"]').innerText().catch(() => "");
  console.log("STEWARDSHIP_LIVE_1_INTRO " + JSON.stringify(introText));
  expect(introText).not.toMatch(/Data not available for this reporting period/i);

  // ---- Operating panel — live financial-derivable cards render ----
  const duesRevRow     = await page.locator('[data-testid="stewardship-dues-rev-actual"]').innerText().catch(() => "");
  const payrollRatRow  = await page.locator('[data-testid="stewardship-payroll-ratio-actual"]').innerText().catch(() => "");
  const noiMarginRow   = await page.locator('[data-testid="stewardship-noi-margin-actual"]').innerText().catch(() => "");
  console.log("STEWARDSHIP_LIVE_1_OPERATING " + JSON.stringify({ duesRev: duesRevRow, payrollRatio: payrollRatRow, noiMargin: noiMarginRow }));
  expect(duesRevRow).toMatch(/\d+\.\d+%/);
  expect(payrollRatRow).toMatch(/\d+\.\d+%/);
  expect(noiMarginRow).toMatch(/\d+\.\d+%/);

  // ---- Capital panel — live BS/IS-derivable cards render ----
  const capIncomeVs    = await page.locator('[data-testid="stewardship-capital-income-vs-plan-actual"]').innerText().catch(() => "");
  const debtEquity     = await page.locator('[data-testid="stewardship-debt-equity-actual"]').innerText().catch(() => "");
  const workingCap     = await page.locator('[data-testid="stewardship-working-capital-actual"]').innerText().catch(() => "");
  console.log("STEWARDSHIP_LIVE_1_CAPITAL " + JSON.stringify({ capitalIncomeVsPlan: capIncomeVs, debtEquity, workingCapital: workingCap }));
  // At least one of the derivable cards shows a non-"—" value.
  const anyCapitalRendered = [capIncomeVs, debtEquity, workingCap].some((v) => v && v !== "—" && !/^Source not/i.test(v));
  expect(anyCapitalRendered).toBe(true);

  // ---- No Silver Springs demo values leak ----
  //   fb-subsidy "5.1%", rounds "+6.0%", covers "-1.4%", ar-current "78.4%",
  //   init-fee-subsidy "6.4%", capital reserve-coverage "1.42x",
  //   capital-spend "-16.5%", reserve-sufficiency "2.49x",
  //   project-completion "6 of 7"
  const dashboardText = await page.locator('[data-testid="stewardship-kpi-dashboard"]').innerText();
  for (const demoNeedle of ["5.1%", "+6.0%", "-1.4%", "78.4%", "6.4%", "1.42x", "-16.5%", "2.49x", "6 of 7"]) {
    expect(dashboardText).not.toContain(demoNeedle);
  }

  const after = await invariant(page);
  expect(after.club).toEqual(before.club);
  await page.screenshot({ path: "test-results/stewardship-live-1-section-iii.png", fullPage: true });
  await ctx.close();
});
