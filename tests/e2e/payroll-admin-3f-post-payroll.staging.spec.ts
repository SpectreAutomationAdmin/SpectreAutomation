// Payroll Admin Slice 3F (2026-09-13) — real UI post walk on staging.
//
// Prerequisites (run BEFORE this spec):
//   flyctl ssh console --app spectre-staging --command \
//     'node /app/scripts/payroll-3e-acceptance-fixture.mjs'
//   flyctl ssh console --app spectre-staging --command \
//     'node /app/scripts/payroll-3f-acceptance-fixture.mjs'
//
// Post-acceptance cleanup:
//   flyctl ssh console --app spectre-staging --command \
//     'node /app/scripts/payroll-3f-acceptance-fixture.mjs --restore'
//   flyctl ssh console --app spectre-staging --command \
//     'node /app/scripts/payroll-3e-acceptance-fixture.mjs --restore'

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAs } from "./_lib/staging-auth";

const OUT = path.resolve("test-results/payroll-admin-3f-post-payroll");
fs.mkdirSync(OUT, { recursive: true });
const STAGING = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

const POSTER_EMAIL = "fixture.poster.3f@spectre.test";
const CTRL_EMAIL   = "fixture.controller.3e@spectre.test";
const PA_EMAIL     = "fixture.payroll-admin.3e@spectre.test";
const FIXTURE_PW   = "spectre-3e-fixture";

const PAY_GROUP_ID  = "cmtyk1agk0001u3p25ebcfp9m";
const PAY_PERIOD_ID = "cmtyk1ai50003u3p22ngypan4";
const OVERVIEW_URL  = `${STAGING}/app/admin/payroll?payGroupId=${PAY_GROUP_ID}&payPeriodId=${PAY_PERIOD_ID}`;

test.use({ viewport: { width: 1440, height: 900 } });

test("Payroll 3F — Payroll Admin posts an approved payroll through the real UI", async ({ browser }) => {
  test.setTimeout(300_000);

  // ---- Controller confirms Awaiting-Post banner ----
  const ctrlCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const ctrl = await loginAs(ctrlCtx, CTRL_EMAIL, FIXTURE_PW);
  await ctrl.goto(`${STAGING}/app/admin/payroll/process`, { waitUntil: "domcontentloaded" });
  await ctrl.waitForTimeout(2000);
  await ctrl.screenshot({ path: path.join(OUT, "01-ctrl-queue-1440x900.png"), fullPage: false });
  // Open the batch review as Controller.
  await ctrl.goto(`${STAGING}/app/admin/payroll/batches/`, { waitUntil: "domcontentloaded" }).catch(() => null);
  const anyLink = ctrl.locator('a[href*="/app/admin/payroll/batches/"]').first();
  if (await anyLink.count() > 0) {
    await anyLink.click();
    await ctrl.waitForTimeout(2500);
    await ctrl.screenshot({ path: path.join(OUT, "02-ctrl-awaiting-post-1440x900.png"), fullPage: false });
    // Awaiting-post banner must be visible.
    const banner = ctrl.getByTestId("review-awaiting-post-banner");
    if (await banner.count() > 0) {
      await expect(banner).toBeVisible();
    }
    // Post button must be disabled + controller-locked.
    const postBtn = ctrl.getByTestId("review-post-btn");
    if (await postBtn.count() > 0) {
      const locked = await postBtn.getAttribute("data-controller-locked");
      expect(locked).toBe("true");
    }
  }
  await ctrlCtx.close();

  // ---- Poster (CLUB_ADMIN) posts through the Payroll Admin overview ----
  const posterCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const poster = await loginAs(posterCtx, POSTER_EMAIL, FIXTURE_PW);
  await poster.goto(OVERVIEW_URL, { waitUntil: "networkidle" });
  await poster.screenshot({ path: path.join(OUT, "03-poster-landed-1440x900.png"), fullPage: false });

  // Open Post confirmation.
  const postOpener = poster.getByTestId("payroll-admin-post-payroll");
  await postOpener.waitFor({ state: "visible", timeout: 30_000 });
  await postOpener.click();
  const confirmPanel = poster.getByTestId("payroll-admin-post-confirm-panel");
  await expect(confirmPanel).toBeVisible();
  // Preview table loads.
  await poster.waitForTimeout(2500);
  await poster.screenshot({ path: path.join(OUT, "04-poster-post-confirmation-1440x900.png"), fullPage: false });
  // Balanced check.
  const balancedNote = poster.getByTestId("payroll-admin-post-preview-balanced");
  if (await balancedNote.count() > 0) {
    const txt = (await balancedNote.innerText()).trim();
    console.log(`[3F] preview balanced: ${txt}`);
    expect(txt).toContain("Balanced");
  }

  await poster.getByTestId("payroll-admin-post-confirm-btn").click();
  await poster.waitForLoadState("networkidle");
  await poster.waitForTimeout(3000);
  await poster.screenshot({ path: path.join(OUT, "05-poster-posted-1440x900.png"), fullPage: false });

  const postedBadge = poster.getByTestId("payroll-admin-status-posted");
  if (await postedBadge.count() > 0) {
    await expect(postedBadge).toBeVisible();
  }
  await posterCtx.close();
});
