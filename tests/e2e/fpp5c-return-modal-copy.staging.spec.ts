// FPP-5C (2026-09-21) — Return-to-Preparation modal wording acceptance.
//
// Read-only. Confirms the modal now describes the void semantic:
// "The current calculation will be withdrawn and the payroll will
//  need to be prepared again."
// Does NOT submit — founder batch is preserved.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

const OVERVIEW_URL =
  "/app/admin/payroll?payGroupId=cmu5kg3e40002h4iupsaxezdl&payPeriodId=cmu5kg3ih000nh4iuqyal9zay";

test.describe("FPP-5C Return-to-Preparation modal copy (read-only)", () => {
  test("Modal shows new void semantic wording; Cancel preserves batch", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: OVERVIEW_URL });
    await page.waitForLoadState("domcontentloaded");

    // Open the modal
    await page.getByTestId("payroll-admin-actions-return-to-prep").click();
    const modal = page.getByTestId("payroll-admin-return-to-prep-dialog");
    await expect(modal).toBeVisible();

    // Void-semantic wording
    await expect(modal).toContainText(/withdrawn/i);
    await expect(modal).toContainText(/prepared again/i);
    await expect(modal).toContainText(/audit history/i);

    // Old wording removed
    await expect(modal).not.toContainText(/Discard Prepared Payroll and then Prepare Payroll/i);
    await expect(modal).not.toContainText(/moves back to Prepared/i);

    // Reason required
    await expect(page.getByTestId("payroll-admin-return-to-prep-reason")).toBeVisible();

    // Screenshot for founder review
    await page.screenshot({ path: "test-results/fpp5c-return-modal.png", fullPage: false });

    // Cancel without submitting
    await page.getByTestId("payroll-admin-return-to-prep-cancel").click();
    await expect(modal).toHaveCount(0);

    // Batch remains CALCULATED (visible on the workspace)
    await expect(page.getByTestId("payroll-admin-header").locator("span").first()).toContainText(/CALCULATED/i);
  });
});
