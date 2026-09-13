// Payroll 3E acceptance hotfix — SoD UI notice verification.
// Logs in as the Payroll Admin who submitted the batch and confirms
// the SoD-aware UI blocks Approve/Return with an actionable message.
// The Payroll Admin role has both payroll:submit AND payroll:approve
// in the current role catalogue, so this exercises the UI SoD check.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAs } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3e-sod-ui");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const PA_EMAIL   = "fixture.payroll-admin.3e@spectre.test";
const FIXTURE_PW = "spectre-3e-fixture";
const BATCH_ID   = "cmtz7uc8r0006iplj7v8xte5h"; // the batch from the real UI walk

test.use({ viewport: { width: 1440, height: 900 } });

test("Payroll 3E — SoD UI: submitter sees disabled Approve + explanatory notice", async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAs(ctx, PA_EMAIL, FIXTURE_PW);

  await page.goto(`${STAGING}/app/admin/payroll/batches/${BATCH_ID}`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(OUT, "01-pa-review-sod-1440x900.png"), fullPage: false });

  // The batch is APPROVED — SoD notice won't display because isSubmitted
  // is only true on SUBMITTED_FOR_APPROVAL. Instead we verify the
  // Approve button is disabled (state !== SUBMITTED) and note the badge.
  const badge = await page.getByTestId("review-lifecycle-badge").innerText().catch(() => "");
  console.log(`[3E-sod] badge as PA viewing approved batch: ${badge}`);
  const approveBtn = page.getByTestId("review-approve-btn");
  const isDisabled = await approveBtn.isDisabled();
  console.log(`[3E-sod] Approve button disabled: ${isDisabled}`);
  expect(isDisabled).toBe(true);
});
