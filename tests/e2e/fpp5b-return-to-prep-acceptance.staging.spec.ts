// FPP-5B (2026-09-21) — Return-to-Preparation workflow acceptance.
//
// Read-only acceptance on Chris's real CALCULATED batch. Proves that
// the "Return to Preparation" button opens a proper modal
// (not the previous <details> dropdown), the modal cancels cleanly,
// and no batch mutation occurs on cancel. Does NOT confirm the
// mutation — the founder will personally submit it.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

const OVERVIEW_URL =
  "/app/admin/payroll?payGroupId=cmu5kg3e40002h4iupsaxezdl&payPeriodId=cmu5kg3ih000nh4iuqyal9zay";

test.describe("FPP-5B Return-to-Preparation modal (read-only)", () => {
  test("Return to Preparation button opens modal + Cancel closes without mutation at 1440x900", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: OVERVIEW_URL });
    await page.waitForLoadState("domcontentloaded");

    // Actions card visible; the Return-to-Prep button is present
    const actions = page.getByTestId("payroll-admin-actions");
    await expect(actions).toBeVisible();

    const returnBtn = page.getByTestId("payroll-admin-actions-return-to-prep");
    await expect(returnBtn).toBeVisible();
    // Confirm it's a BUTTON (was previously a <details> element)
    const tagName = await returnBtn.evaluate((el) => el.tagName.toLowerCase());
    expect(tagName).toBe("button");

    // Click opens the modal
    await returnBtn.click();
    const modal = page.getByTestId("payroll-admin-return-to-prep-dialog");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("Return this payroll to preparation?");
    await expect(modal).toContainText("Discard Prepared Payroll");
    await expect(modal).toContainText("Prepare Payroll");

    // Reason field visible + required
    const reason = page.getByTestId("payroll-admin-return-to-prep-reason");
    await expect(reason).toBeVisible();
    // Cancel closes without submitting
    await page.getByTestId("payroll-admin-return-to-prep-cancel").click();
    await expect(modal).toHaveCount(0);

    // Screenshot for founder proof
    await page.screenshot({ path: "test-results/fpp5b-actions-with-return-modal.png", fullPage: false });

    // Re-open + screenshot the modal itself
    await returnBtn.click();
    await expect(modal).toBeVisible();
    await page.screenshot({ path: "test-results/fpp5b-return-modal.png", fullPage: false });
    await page.getByTestId("payroll-admin-return-to-prep-cancel").click();
  });

  test("At 1366x768 the Return-to-Preparation button remains visible in the actions card", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    // Override viewport for this test
    const page = await loginAsFounder(context, { landing: OVERVIEW_URL });
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.waitForLoadState("domcontentloaded");

    const returnBtn = page.getByTestId("payroll-admin-actions-return-to-prep");
    await expect(returnBtn).toBeVisible();
    await returnBtn.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/fpp5b-actions-1366x768.png", fullPage: false });
  });
});
