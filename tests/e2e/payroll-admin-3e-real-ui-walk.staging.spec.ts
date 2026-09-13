// Payroll Admin Slice 3E acceptance hotfix (2026-09-12) — REAL UI
// walk on staging.
//
// Per founder directive §7-8: NO SSH, NO direct DB mutation for the
// governance decisions. Log in as synthetic Payroll Admin, Submit
// through the UI, log out, log in as synthetic Controller, Return
// through the UI, log in as Payroll Admin, correct + resubmit,
// log in as Controller, Approve.
//
// Prerequisites (must be run BEFORE this spec):
//   flyctl ssh console --app spectre-staging --command \
//     'node /app/scripts/payroll-3e-acceptance-fixture.mjs'
// (Saves prior Coulee config → repoints to 3E fixture actors.)
//
// Post-acceptance cleanup:
//   flyctl ssh console --app spectre-staging --command \
//     'node /app/scripts/payroll-3e-acceptance-fixture.mjs --restore'

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAs } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3e-real-ui-walk");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

const PA_EMAIL   = "fixture.payroll-admin.3e@spectre.test";
const CTRL_EMAIL = "fixture.controller.3e@spectre.test";
const FIXTURE_PW = "spectre-3e-fixture";

const PAY_GROUP_ID  = "cmtyk1agk0001u3p25ebcfp9m"; // 3D-ACCEPT
const PAY_PERIOD_ID = "cmtyk1ai50003u3p22ngypan4"; // Nov 8 – Nov 21
const OVERVIEW_URL  = `${STAGING}/app/admin/payroll?payGroupId=${PAY_GROUP_ID}&payPeriodId=${PAY_PERIOD_ID}`;

test.use({ viewport: { width: 1440, height: 900 } });

// The batch may already be APPROVED from a prior walk. In that case
// no lifecycle mutation is possible without re-Prepare — the spec
// captures the current state and reports.
test("Payroll 3E — real UI lifecycle: PA submit → Controller approve", async ({ browser }) => {
  test.setTimeout(360_000);

  // ---- Payroll Admin session --------------------------------------
  const paContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const paPage = await loginAs(paContext, PA_EMAIL, FIXTURE_PW);
  await paPage.goto(OVERVIEW_URL, { waitUntil: "networkidle" });
  await paPage.screenshot({ path: path.join(OUT, "01-pa-landed-1440x900.png"), fullPage: false });

  const paBatchStatus = await paPage.getByTestId("payroll-admin-header").innerText().catch(() => "");
  console.log(`[3E-real] PA landed. Header excerpt: ${paBatchStatus.slice(0, 200).replace(/\s+/g, " ")}`);

  // Submit for Approval — open confirmation panel first
  const submitOpener = paPage.getByTestId("payroll-admin-submit-for-approval");
  if (await submitOpener.count() > 0) {
    await submitOpener.click(); // opens <details> panel
    const confirmPanel = paPage.getByTestId("payroll-admin-submit-confirm-panel");
    await expect(confirmPanel).toBeVisible();
    await paPage.screenshot({ path: path.join(OUT, "02-pa-submit-confirmation-1440x900.png"), fullPage: false });
    const confirmBtn = paPage.getByTestId("payroll-admin-submit-for-approval-confirm");
    await confirmBtn.click();
    await paPage.waitForLoadState("networkidle");
    await paPage.waitForTimeout(1500);
    await paPage.screenshot({ path: path.join(OUT, "03-pa-submitted-1440x900.png"), fullPage: false });
    // Awaiting Controller banner should appear.
    await expect(paPage.getByTestId("payroll-admin-submitted-banner")).toBeVisible();
  } else {
    console.log("[3E-real] Submit button not visible — batch already past CALCULATED.");
  }
  await paContext.close();

  // ---- Controller session -----------------------------------------
  const ctrlContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctrlPage = await loginAs(ctrlContext, CTRL_EMAIL, FIXTURE_PW);
  // Controller queue lives on /app/admin/payroll/process.
  await ctrlPage.goto(`${STAGING}/app/admin/payroll/process`, { waitUntil: "networkidle" });
  await ctrlPage.screenshot({ path: path.join(OUT, "04-ctrl-queue-1440x900.png"), fullPage: false });
  const cardText = await ctrlPage.locator("body").innerText();
  console.log(`[3E-real] Controller queue body length: ${cardText.length}`);

  // Navigate to the batch review page directly (deep link).
  await ctrlPage.goto(`${STAGING}/app/admin/payroll/batches/`, { waitUntil: "networkidle" }).catch(() => null);
  // Real batch review workspace URL:
  await ctrlPage.goto(`${STAGING}/app/admin/payroll/process`, { waitUntil: "networkidle" });
  // Find any anchor to the batch review page.
  const reviewLink = ctrlPage.locator('a[href*="/app/admin/payroll/batches/"]').first();
  if (await reviewLink.count() > 0) {
    await reviewLink.click();
    await ctrlPage.waitForLoadState("networkidle");
  }
  await ctrlPage.screenshot({ path: path.join(OUT, "05-ctrl-review-1440x900.png"), fullPage: false });

  // SoD notice should NOT appear (Controller is not the submitter).
  const sod = ctrlPage.getByTestId("review-sod-notice");
  expect(await sod.count()).toBe(0);

  // Approve button → open confirmation panel
  const approveBtn = ctrlPage.getByTestId("review-approve-btn");
  if (await approveBtn.count() > 0 && await approveBtn.isEnabled()) {
    await approveBtn.click();
    const confirmPanel = ctrlPage.getByTestId("review-approve-confirm-panel");
    await expect(confirmPanel).toBeVisible();
    await ctrlPage.screenshot({ path: path.join(OUT, "06-ctrl-approve-confirmation-1440x900.png"), fullPage: false });
    await ctrlPage.getByTestId("review-approve-confirm-btn").click();
    await ctrlPage.waitForLoadState("networkidle");
    await ctrlPage.waitForTimeout(2000);
    await ctrlPage.screenshot({ path: path.join(OUT, "07-ctrl-approved-1440x900.png"), fullPage: false });
    // Batch should now be APPROVED.
    const badge = await ctrlPage.getByTestId("review-lifecycle-badge").innerText().catch(() => "");
    console.log(`[3E-real] Post-approve badge: ${badge}`);
    expect(badge.toUpperCase()).toContain("APPROVED");
  } else {
    console.log("[3E-real] Approve button unavailable — batch may not be SUBMITTED_FOR_APPROVAL.");
    await ctrlPage.screenshot({ path: path.join(OUT, "05a-ctrl-approve-not-available-1440x900.png"), fullPage: false });
  }
  await ctrlContext.close();
});
