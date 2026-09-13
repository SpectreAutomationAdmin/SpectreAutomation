// Payroll Admin Slice 3E acceptance hotfix (2026-09-12) — FULL
// staging real-UI walk. Uses only the browser — no SSH, no DB
// mutation. Two synthetic actors:
//
//   Payroll Admin: fixture.payroll-admin.3e@spectre.test
//   Controller:    fixture.controller.3e@spectre.test
//   Password:      spectre-3e-fixture
//
// Requires: `node scripts/payroll-3e-acceptance-fixture.mjs` first.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAs } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3e-full-real-ui");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

const PA_EMAIL   = "fixture.payroll-admin.3e@spectre.test";
const CTRL_EMAIL = "fixture.controller.3e@spectre.test";
const FIXTURE_PW = "spectre-3e-fixture";

const PAY_GROUP_ID  = "cmtyk1agk0001u3p25ebcfp9m";
const PAY_PERIOD_ID = "cmtyk1ai50003u3p22ngypan4";
const OVERVIEW_URL  = `${STAGING}/app/admin/payroll?payGroupId=${PAY_GROUP_ID}&payPeriodId=${PAY_PERIOD_ID}`;

test.use({ viewport: { width: 1440, height: 900 } });

test("Payroll 3E — full real-UI walk", async ({ browser }) => {
  test.setTimeout(480_000);

  // ---- PA: Prepare + Employee Data attest + Calculate + Calc attest + Submit ----
  const paCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pa = await loginAs(paCtx, PA_EMAIL, FIXTURE_PW);
  await pa.goto(OVERVIEW_URL, { waitUntil: "networkidle" });
  await pa.screenshot({ path: path.join(OUT, "01-pa-landed-1440x900.png"), fullPage: false });

  // If no batch, click Prepare.
  const prepareBtn = pa.getByTestId("payroll-admin-prepare");
  if (await prepareBtn.count() > 0) {
    console.log("[3E-full] Prepare button visible — clicking");
    await prepareBtn.click();
    await pa.waitForLoadState("networkidle");
    await pa.waitForTimeout(2000);
  }

  // Employee Data attestation
  const empBanner = pa.getByTestId("payroll-admin-employee-data-review-banner");
  if (await empBanner.count() > 0) {
    const state = await empBanner.getAttribute("data-state");
    console.log(`[3E-full] Employee Data banner state: ${state}`);
    if (state === "review-required") {
      await pa.getByTestId("payroll-admin-review-mark-employee-data").click();
      await pa.waitForLoadState("networkidle");
      await pa.waitForTimeout(1500);
    }
  }

  // Calculate
  const calcBtn = pa.getByTestId("payroll-admin-calculate");
  if (await calcBtn.count() > 0) {
    console.log("[3E-full] Calculate button visible — clicking");
    await calcBtn.click();
    await pa.waitForLoadState("networkidle");
    await pa.waitForTimeout(3000);
  }
  await pa.screenshot({ path: path.join(OUT, "02-pa-calculated-1440x900.png"), fullPage: false });

  // Calculated Payroll attestation
  const calcBanner = pa.getByTestId("payroll-admin-calculated-payroll-review-banner");
  if (await calcBanner.count() > 0) {
    const state = await calcBanner.getAttribute("data-state");
    console.log(`[3E-full] Calc banner state: ${state}`);
    if (state === "review-required") {
      const markCalc = pa.getByTestId("payroll-admin-review-mark-calculated-payroll");
      if (await markCalc.count() > 0) {
        await markCalc.click();
        await pa.waitForLoadState("networkidle");
        await pa.waitForTimeout(1500);
      }
    }
  }

  // Submit for Approval — open confirmation panel
  const submitOpener = pa.getByTestId("payroll-admin-submit-for-approval");
  await submitOpener.waitFor({ state: "visible", timeout: 30_000 });
  await submitOpener.click();
  const confirmPanel = pa.getByTestId("payroll-admin-submit-confirm-panel");
  await expect(confirmPanel).toBeVisible();
  await pa.screenshot({ path: path.join(OUT, "03-pa-submit-confirmation-1440x900.png"), fullPage: false });

  await pa.getByTestId("payroll-admin-submit-for-approval-confirm").click();
  await pa.waitForLoadState("networkidle");
  await pa.waitForTimeout(2000);
  await pa.screenshot({ path: path.join(OUT, "04-pa-submitted-1440x900.png"), fullPage: false });
  await expect(pa.getByTestId("payroll-admin-submitted-banner")).toBeVisible();
  await paCtx.close();

  // ---- Controller: Review + Approve confirmation + Approve ----
  const ctrlCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctrl = await loginAs(ctrlCtx, CTRL_EMAIL, FIXTURE_PW);
  await ctrl.goto(`${STAGING}/app/admin/payroll/process`, { waitUntil: "networkidle" });
  await ctrl.screenshot({ path: path.join(OUT, "05-ctrl-queue-1440x900.png"), fullPage: false });

  const reviewLink = ctrl.locator('a[href*="/app/admin/payroll/batches/"]').first();
  await reviewLink.waitFor({ state: "visible", timeout: 30_000 });
  const href = await reviewLink.getAttribute("href");
  console.log(`[3E-full] Controller card deep-link: ${href}`);
  await reviewLink.click();
  await ctrl.waitForLoadState("networkidle");
  await ctrl.waitForTimeout(1500);
  await ctrl.screenshot({ path: path.join(OUT, "06-ctrl-review-1440x900.png"), fullPage: false });

  // SoD notice must NOT show — Controller ≠ submitter (PA).
  const sod = ctrl.getByTestId("review-sod-notice");
  expect(await sod.count()).toBe(0);

  const approveBtn = ctrl.getByTestId("review-approve-btn");
  await approveBtn.waitFor({ state: "visible", timeout: 15_000 });
  await approveBtn.click();
  const approveConfirm = ctrl.getByTestId("review-approve-confirm-panel");
  await expect(approveConfirm).toBeVisible();
  await ctrl.screenshot({ path: path.join(OUT, "07-ctrl-approve-confirmation-1440x900.png"), fullPage: false });

  await ctrl.getByTestId("review-approve-confirm-btn").click();
  await ctrl.waitForLoadState("networkidle");
  await ctrl.waitForTimeout(2500);
  await ctrl.screenshot({ path: path.join(OUT, "08-ctrl-approved-1440x900.png"), fullPage: false });

  const badge = await ctrl.getByTestId("review-lifecycle-badge").innerText().catch(() => "");
  console.log(`[3E-full] Final badge: ${badge}`);
  expect(badge.toUpperCase()).toContain("APPROVED");

  await ctrlCtx.close();
});
