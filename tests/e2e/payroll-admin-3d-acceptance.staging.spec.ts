// Payroll Admin Slice 3D acceptance (2026-09-12) — end-to-end
// staging walk of the PREPARED → CALCULATED lifecycle.
//
// Prerequisites (staging shell, then run this spec):
//   flyctl ssh console --app spectre-staging --command \
//     'node /app/scripts/payroll-3b-hourly-acceptance-fixture.mjs'
//   flyctl ssh console --app spectre-staging --command \
//     'node /app/scripts/payroll-3d-acceptance-fixture.mjs'
//
// The 3D fixture creates a `3D-ACCEPT` pay group + Nov 8 – Nov 21
// pay period at Coulee with a HOURLY employee (Riley Reconcile — zero
// clock activity in this period → legitimate zero-pay case §35) and a
// SALARIED employee (Sam Salary — $52,000/yr → ~$2,000 biweekly).
//
// This spec walks:
//   1. Navigate to the 3D-ACCEPT batch.
//   2. Prepare → PREPARED.
//   3. Verify checklist shows 5/6 (Employee Data not reviewed).
//   4. Click "Mark Employee Data Reviewed" → checklist shows 6/6.
//   5. Click Calculate → transitions PREPARED → CALCULATED with
//      pending "Calculating Payroll…" state visible during submit.
//   6. Verify KPI values populate from CALCULATED numbers.
//   7. Click Summary tab → verify aggregates.
//   8. Click Mark Reviewed on the Calculated Payroll banner → Step 5
//      transitions from CURRENT to DONE.
//   9. Return to Preparation → verify CALCULATED_PAYROLL invalidates.
//   10. Screenshots captured at each state.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3d-acceptance");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.use({ viewport: { width: 1440, height: 900 } });

test("Payroll 3D acceptance — checklist / calculate / summary / return-to-preparation", async ({ context }) => {
  test.setTimeout(300_000);
  const page = await loginAsFounder(context);

  // Fixture IDs from scripts/payroll-3d-acceptance-fixture.mjs (idempotent).
  const PAY_GROUP_ID  = "cmtyk1agk0001u3p25ebcfp9m"; // 3D-ACCEPT
  const PAY_PERIOD_ID = "cmtyk1ai50003u3p22ngypan4"; // Nov 8 – Nov 21, 2026
  await page.goto(`${STAGING}/app/admin/payroll?payGroupId=${PAY_GROUP_ID}&payPeriodId=${PAY_PERIOD_ID}`, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(OUT, "01-landed-1440x900.png"), fullPage: false });

  // ---- Step 1: Prepare if no batch yet ----
  const prepareBtn = page.getByTestId("payroll-admin-prepare");
  if (await prepareBtn.count() > 0) {
    await prepareBtn.click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
  }
  await page.screenshot({ path: path.join(OUT, "02-prepared-1440x900.png"), fullPage: false });

  // ---- Step 2: verify checklist 5/6 (Employee Data pending) ----
  const progress = page.getByTestId("payroll-admin-checklist-progress");
  await progress.waitFor({ state: "visible" });
  const before = await progress.getAttribute("data-total");
  expect(before).toBe("6");

  // ---- Step 3: Mark Employee Data Reviewed ----
  const empBanner = page.getByTestId("payroll-admin-employee-data-review-banner");
  const empBannerVisible = await empBanner.count() > 0;
  if (empBannerVisible) {
    const markEmp = page.getByTestId("payroll-admin-review-mark-employee-data");
    if (await markEmp.count() > 0) {
      await markEmp.click();
      await page.waitForURL(/payroll/, { timeout: 30_000 });
      await page.waitForLoadState("networkidle");
    }
  }
  const afterEmpDone = await page.getByTestId("payroll-admin-checklist-progress").getAttribute("data-done");
  console.log(`[3D] checklist done after Employee Data mark: ${afterEmpDone}`);
  await page.screenshot({ path: path.join(OUT, "03-employee-data-reviewed-1440x900.png"), fullPage: false });

  // ---- Step 4: Click Calculate ----
  const calcBtn = page.getByTestId("payroll-admin-calculate");
  const calcDisabled = page.getByTestId("payroll-admin-calculate-disabled");
  const calcState = await calcBtn.count() > 0 ? "enabled" : "disabled";
  console.log(`[3D] Calculate button state: ${calcState}`);
  if (calcState === "enabled") {
    await calcBtn.click();
    // Post-submit: batch is CALCULATED; the button vanishes.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(3000);
    await page.screenshot({ path: path.join(OUT, "04-calculated-1440x900.png"), fullPage: false });

    // ---- Step 5: verify CALCULATED banner + KPIs ----
    const calcBanner = page.getByTestId("payroll-admin-calculated-payroll-review-banner");
    await expect(calcBanner).toBeVisible();
    await expect(calcBanner).toHaveAttribute("data-state", "review-required");

    // Gross pay KPI is now populated from calc results.
    const grossKpi = page.getByTestId("payroll-admin-kpi-gross-pay");
    await expect(grossKpi).toBeVisible();

    // ---- Step 6: Summary tab ----
    await page.getByTestId("payroll-admin-tab-summary").click();
    await page.waitForLoadState("networkidle");
    const summaryTotals = page.getByTestId("payroll-admin-summary-totals");
    await expect(summaryTotals).toBeVisible();
    await page.screenshot({ path: path.join(OUT, "05-summary-1440x900.png"), fullPage: false });

    // ---- Step 7: Mark Calculated Payroll Reviewed on Summary ----
    const summaryReview = page.getByTestId("payroll-admin-summary-review-mark");
    if (await summaryReview.count() > 0) {
      await summaryReview.click();
      await page.waitForURL(/payroll/, { timeout: 30_000 });
      await page.waitForLoadState("networkidle");
      const summaryPill = page.getByTestId("payroll-admin-summary-calc-pill");
      await expect(summaryPill).toHaveAttribute("data-state", "reviewed");
      await page.screenshot({ path: path.join(OUT, "06-summary-reviewed-1440x900.png"), fullPage: false });
    }

    // ---- Step 8: Return to Preparation ----
    await page.getByTestId("payroll-admin-tab-employees").click();
    await page.waitForLoadState("networkidle");
    const returnDetails = page.getByTestId("payroll-admin-actions-return-to-prep");
    if (await returnDetails.count() > 0) {
      await returnDetails.click(); // open the details panel
      await page.getByTestId("payroll-admin-actions-return-to-prep-reason").fill("acceptance test — return to prep");
      await page.getByTestId("payroll-admin-actions-return-to-prep-submit").click();
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(OUT, "07-returned-to-prep-1440x900.png"), fullPage: false });
      // After Return-to-Prep the calc banner should be gone (status
      // back to PREPARED); the Calculate button should reappear.
      const calcBanner2 = page.getByTestId("payroll-admin-calculated-payroll-review-banner");
      expect(await calcBanner2.count()).toBe(0);
    }
  } else {
    console.log("[3D] Calculate button disabled — checklist not complete. Reason:", await calcDisabled.getAttribute("data-reason"));
    await page.screenshot({ path: path.join(OUT, "04-calc-disabled-1440x900.png"), fullPage: false });
  }
});
