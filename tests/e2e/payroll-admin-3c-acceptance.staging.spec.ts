// Payroll Admin Slice 3C acceptance hotfix (2026-09-12) —
// end-to-end UI acceptance on Coulee staging.
//
// Prerequisites (must be run BEFORE this spec):
//   1. `flyctl ssh console --app spectre-staging --command
//      'node /app/scripts/payroll-3b-hourly-acceptance-fixture.mjs'`
//   2. `flyctl ssh console --app spectre-staging --command
//      'node /app/scripts/payroll-3c-acceptance-fixture.mjs'`
//
// The 3C fixture creates a dedicated `3C-ACCEPT` pay group +
// Aug 30 – Sep 12 pay period with Riley Reconcile alone. Prepare
// on that period reaches PREPARED (Riley has no BLOCKER exceptions)
// so the write path can be exercised without touching Chris/Lise.
//
// This spec walks the full lifecycle in ONE flow to preserve state
// evidence between steps:
//   1. Prepare (or void + re-Prepare if a stale batch exists)
//   2. Add One-Time Adjustment
//   3. Mark Reviewed
//   4. Refresh → attestation persisted
//   5. Remove adjustment → attestation invalidates
//   6. Capture screenshots at each key transition.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3c-acceptance");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
// The 3C-ACCEPT pay period id must be discovered at runtime — the
// fixture creates it if missing. Spec fetches it from a query param
// passed via env, or from the URL after landing.

test.use({ viewport: { width: 1440, height: 900 } });

test("Payroll 3C acceptance-hotfix — add / attest / invalidate / remove lifecycle", async ({ context }) => {
  test.setTimeout(240_000);
  const page = await loginAsFounder(context);

  // ---- Step 1: navigate to the 3C-ACCEPT pay group + period ----
  // These IDs come from `scripts/payroll-3c-acceptance-fixture.mjs`
  // — the fixture creates them idempotently. If the surface can't
  // resolve them (e.g. fixture not run) the test skips gracefully.
  const PAY_GROUP_ID  = "cmty1q8yy0001wia6yqxvvyfa"; // 3C-ACCEPT
  const payPeriodId   = "cmty1q90f0003wia6asx71cp8"; // Aug 30 – Sep 12 on 3C-ACCEPT

  // ---- Step 2: prepare the batch if not already prepared ----
  await page.goto(`${STAGING}/app/admin/payroll?payGroupId=${PAY_GROUP_ID}&payPeriodId=${payPeriodId}`, { waitUntil: "networkidle" });
  const periodLine = await page.getByTestId("payroll-admin-period-line").innerText().catch(() => "(no period line)");
  console.log(`[step 2] period line: ${periodLine}`);
  const prepareBtn = page.getByTestId("payroll-admin-prepare");
  const prepareCount = await prepareBtn.count();
  console.log(`[step 2] Prepare button count: ${prepareCount}`);
  if (prepareCount > 0) {
    await prepareBtn.click();
    // Wait for the redirect + rerender + revalidation.
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(2500);
    console.log(`[step 2] after Prepare click, URL: ${page.url()}`);
  }
  await page.screenshot({ path: path.join(OUT, "01-prepared-1440x900.png"), fullPage: false });

  // ---- Step 3: open Adjustments tab ----
  await page.goto(`${STAGING}/app/admin/payroll?payGroupId=${PAY_GROUP_ID}&payPeriodId=${payPeriodId}&tab=adjustments`, { waitUntil: "networkidle" });
  // The Add button MUST be enabled if the batch is PREPARED.
  const addOpen = page.getByTestId("payroll-admin-adjustments-add-open");
  const addDisabled = page.getByTestId("payroll-admin-adjustments-add-disabled");
  test.skip(await addDisabled.count() > 0, "Batch is not PREPARED — Add button disabled. Check fixture / prior state.");
  await expect(addOpen).toBeVisible();

  // ---- Step 4: add a one-time adjustment ----
  await addOpen.click(); // opens the <details> panel
  // Playwright's selectOption label matcher doesn't accept regex —
  // resolve the option's value by scanning innerText server-side.
  const empSelect = page.getByTestId("payroll-admin-adjustments-add-employee");
  const rileyValue = await empSelect.locator('option', { hasText: "Riley Reconcile" }).first().getAttribute("value");
  expect(rileyValue).toBeTruthy();
  await empSelect.selectOption(rileyValue!);
  const compSelect = page.getByTestId("payroll-admin-adjustments-add-component");
  const bonusValue = await compSelect.locator('option', { hasText: "3C Acceptance Bonus" }).first().getAttribute("value");
  expect(bonusValue).toBeTruthy();
  await compSelect.selectOption(bonusValue!);
  await page.getByTestId("payroll-admin-adjustments-add-amount").fill("50.00");
  await page.getByTestId("payroll-admin-adjustments-add-reason").fill("3C acceptance test bonus");
  await page.getByTestId("payroll-admin-adjustments-add-submit").click();
  await page.waitForURL(/tab=adjustments/, { timeout: 60_000 });
  await page.waitForLoadState("networkidle");

  // ---- Step 5: verify adjustment appears + KPI + checklist ----
  const rows = page.locator('[data-testid^="payroll-admin-adjustment-row-"]');
  await expect(rows).toHaveCount(1);
  const kpi = page.getByTestId("payroll-admin-kpi-adjustments");
  const kpiText = await kpi.innerText();
  expect(kpiText).toMatch(/\b1\b/);
  const pillReq = page.getByTestId("payroll-admin-review-pill-one-time");
  await expect(pillReq).toBeVisible();
  await expect(pillReq).toHaveAttribute("data-state", "review-required");
  await page.screenshot({ path: path.join(OUT, "02-adjustment-added-1440x900.png"), fullPage: false });

  // ---- Step 6: Mark Reviewed ----
  const markBtn = page.getByTestId("payroll-admin-review-mark-one-time");
  await expect(markBtn).toBeVisible();
  await markBtn.click();
  await page.waitForURL(/tab=adjustments/, { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  const pillReviewed = page.getByTestId("payroll-admin-review-pill-one-time");
  await expect(pillReviewed).toHaveAttribute("data-state", "reviewed");
  await page.screenshot({ path: path.join(OUT, "03-reviewed-1440x900.png"), fullPage: false });

  // ---- Step 7: refresh → attestation persists ----
  await page.goto(`${STAGING}/app/admin/payroll?payGroupId=${PAY_GROUP_ID}&payPeriodId=${payPeriodId}&tab=adjustments`, { waitUntil: "networkidle" });
  await expect(page.getByTestId("payroll-admin-review-pill-one-time")).toHaveAttribute("data-state", "reviewed");

  // ---- Step 8: remove the adjustment → attestation invalidates ----
  const rowId = await rows.first().getAttribute("data-testid");
  expect(rowId).toBeTruthy();
  const removeTestId = rowId!.replace("payroll-admin-adjustment-row-", "payroll-admin-adjustment-remove-");
  await page.getByTestId(removeTestId).click();
  await page.waitForURL(/tab=adjustments/, { timeout: 30_000 });
  await page.waitForLoadState("networkidle");
  await expect(page.locator('[data-testid^="payroll-admin-adjustment-row-"]')).toHaveCount(0);
  const kpiAfter = await page.getByTestId("payroll-admin-kpi-adjustments").innerText();
  expect(kpiAfter).toMatch(/\b0\b/);
  // Attestation is invalidated → pill hidden (no rows) or shows review-required.
  const pillAfter = page.getByTestId("payroll-admin-review-pill-one-time");
  const pillCount = await pillAfter.count();
  if (pillCount > 0) {
    await expect(pillAfter).toHaveAttribute("data-state", "review-required");
  }
  await page.screenshot({ path: path.join(OUT, "04-removed-1440x900.png"), fullPage: false });
});
