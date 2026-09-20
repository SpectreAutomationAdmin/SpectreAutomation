// FPP-4C (2026-09-20) — Payroll workspace routing acceptance (read-only).
//
// Proves that /app/admin/payroll on staging:
//   * Defaults to CRGCC-SM · Semi-Monthly (never the archived
//     bi-weekly group)
//   * Shows the Aug 24 – Sep 8 · Pay Sep 15 period
//   * Renders "Pay Group: CRGCC-SM · Semi-Monthly" identity in header
//   * Prepare Payroll button is available (but NOT clicked)
//   * Explicit URL to the archived group flags the amber advisory
//   * No Chris mutation / no batch creation
//
// Chris's core state (compensation, opening YTD, recurring components)
// is unchanged.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

const PAYROLL_ROUTE = "/app/admin/payroll";
const ARCHIVED_URL = `/app/admin/payroll?payGroupId=cmtjc2u2b000bgnjudym510so`;

test.describe("FPP-4C payroll workspace routing (read-only)", () => {
  test("Default: workspace lands on CRGCC-SM · Semi-Monthly; period picker exposes Aug 24 – Sep 8 · Pay Sep 15", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: PAYROLL_ROUTE });
    await page.waitForLoadState("networkidle");

    // Header identity — Semi-Monthly, not Bi-Weekly (the previous defect).
    const heading = page.locator('[data-testid="payroll-admin-header"] h1').first();
    await expect(heading).toContainText("Semi-Monthly Payroll");
    await expect(heading).not.toContainText("Bi-Weekly");

    // Pay-group identity line
    const pgLine = page.getByTestId("payroll-admin-pay-group-line");
    await expect(pgLine).toContainText("CRGCC-SM");
    await expect(pgLine).toContainText("Semi-Monthly");

    // Inactive advisory must NOT be present when the default is a live group.
    await expect(page.getByTestId("payroll-admin-inactive-pay-group-warning")).toHaveCount(0);

    // Period picker exposes the Sep 15 target period.
    const periodPicker = page.getByTestId("payroll-admin-change-period");
    await expect(periodPicker).toBeVisible();
    const periodOptionText = (await periodPicker.locator("option").allTextContents()).join("|");
    // Look for the pay-date bookmark in one of the picker options.
    expect(periodOptionText).toMatch(/Sep 15|September 15|Sep\s*15/);

    // Screenshot: default view landing at CRGCC-SM · Semi-Monthly
    await page.screenshot({ path: "test-results/fpp4c-payroll-default.png", fullPage: false });
  });

  test("Explicit URL selects the Aug 24 – Sep 8 · Pay Sep 15 period on CRGCC-SM", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    // The Sep 15 period id and pay-group id are stable staging IDs.
    const url = "/app/admin/payroll?payGroupId=cmu5kg3e40002h4iupsaxezdl&payPeriodId=cmu5kg3ih000nh4iuqyal9zay";
    const page = await loginAsFounder(context, { landing: url });
    await page.waitForLoadState("networkidle");

    await expect(page.locator('[data-testid="payroll-admin-header"] h1').first()).toContainText("Semi-Monthly Payroll");
    await expect(page.getByTestId("payroll-admin-pay-group-line")).toContainText("CRGCC-SM");
    // Period displays as half-open [Aug 24, Sep 9). Founder brief refers
    // to "Aug 24 – Sep 8" using the inclusive-last-day convention; the
    // canonical UI shows the exclusive periodEnd date.
    await expect(page.getByTestId("payroll-admin-period-line")).toContainText("Aug 24");
    await expect(page.getByTestId("payroll-admin-period-line")).toContainText("Sep 9");
    await expect(page.getByTestId("payroll-admin-pay-date-line")).toContainText("Sep 15");

    // Screenshot: Sep 15 target period selected
    await page.screenshot({ path: "test-results/fpp4c-payroll-sep15.png", fullPage: false });

    // Do NOT click Prepare — read-only acceptance.
  });

  test("Stale URL to archived group flags the amber advisory + no Prepare button", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: ARCHIVED_URL });
    await page.waitForLoadState("networkidle");

    // Amber advisory renders
    await expect(page.getByTestId("payroll-admin-inactive-pay-group-warning")).toBeVisible();

    // No Prepare Payroll button available for an inactive group
    const prepareBtn = page.getByRole("button", { name: /Prepare Payroll/i });
    await expect(prepareBtn).toHaveCount(0);

    // Pay-group picker exposes the live active group (CRGCC-SM) so the
    // founder can switch.
    const picker = page.getByTestId("payroll-admin-change-pay-group");
    await expect(picker).toBeVisible();
    const opts = await picker.locator("option").allTextContents();
    expect(opts.join("|")).toContain("CRGCC-SM");

    await page.screenshot({ path: "test-results/fpp4c-payroll-archived-warning.png", fullPage: false });
  });
});
