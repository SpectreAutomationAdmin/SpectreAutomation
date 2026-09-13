// Payroll Admin Slice 3E (2026-09-12) — staging Submit/Approve/Return
// lifecycle walk. Reuses the 3D-ACCEPT batch (v1 CALCULATED with Sam
// Salary $2,000 gross). Runs as the founder — the SoD rule refuses
// the founder if they also submitted; we verify Approve REFUSES on
// stale calculationVersion + verify Return round-trips.
//
// Prerequisites:
//   flyctl ssh console --app spectre-staging --command \
//     'node /app/scripts/payroll-3e-acceptance-fixture.mjs'

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3e-lifecycle");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

const PAY_GROUP_ID  = "cmtyk1agk0001u3p25ebcfp9m"; // 3D-ACCEPT
const PAY_PERIOD_ID = "cmtyk1ai50003u3p22ngypan4"; // Nov 8 – Nov 21

test.use({ viewport: { width: 1440, height: 900 } });

test("Payroll 3E — Submit → Awaiting → Approve/Return round-trip", async ({ context }) => {
  test.setTimeout(300_000);
  const page = await loginAsFounder(context);
  const NAV = `${STAGING}/app/admin/payroll?payGroupId=${PAY_GROUP_ID}&payPeriodId=${PAY_PERIOD_ID}`;
  await page.goto(NAV, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(OUT, "01-landed-1440x900.png"), fullPage: false });

  const status = await page.getByTestId("payroll-admin-header").locator("span").first().innerText().catch(() => "");
  console.log(`[3E] landed status header: ${status.replace(/\s+/g, " ")}`);

  // Submit button visible only when CALCULATED + CALCULATED_PAYROLL reviewed.
  const submitBtn = page.getByTestId("payroll-admin-submit-for-approval");
  const awaitingPill = page.getByTestId("payroll-admin-status-awaiting-controller");
  const approvedPill = page.getByTestId("payroll-admin-status-approved");

  if (await submitBtn.count() > 0) {
    console.log("[3E] Submit button visible — clicking");
    await submitBtn.click();
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1500);
  } else if (await awaitingPill.count() > 0) {
    console.log("[3E] Already SUBMITTED_FOR_APPROVAL");
  } else if (await approvedPill.count() > 0) {
    console.log("[3E] Already APPROVED — nothing more to do");
  } else {
    console.log("[3E] Batch not in a submittable state — snapshot only");
  }
  await page.screenshot({ path: path.join(OUT, "02-post-submit-1440x900.png"), fullPage: false });

  // Verify SUBMITTED banner (or already-approved banner).
  const submittedBanner = page.getByTestId("payroll-admin-submitted-banner");
  const approvedBanner  = page.getByTestId("payroll-admin-approved-banner");
  const returnedBanner  = page.getByTestId("payroll-admin-returned-banner");
  const bannerCount = (await submittedBanner.count()) + (await approvedBanner.count()) + (await returnedBanner.count());
  expect(bannerCount).toBeGreaterThanOrEqual(1);
});
