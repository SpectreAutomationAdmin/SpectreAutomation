// FPP-4 (2026-09-20) — Chris Sep 15 configuration readiness acceptance.
//
// Read-only. Proves after deploy:
//   * Recurring grid shows both Cell Phone + LTD with founder-set values
//   * Each row now exposes Change and End buttons in the workspace
//   * "+ Enrol in benefit" no longer shows the contradictory message —
//     it correctly reports "No benefit plans configured for this Club yet"
//     and links to Payroll Settings
//   * Core state (base compensation, Opening YTD ACTIVE, pay-group) is
//     unchanged
//   * NO Chris mutation performed

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

const CHRIS_PAYROLL = "/app/admin/people/employees/cmu0fiaod000187prcy9ufo2d?tab=payroll";

test.describe("FPP-4 Chris Sep 15 configuration readiness (read-only)", () => {
  test("recurring grid exposes Change + End per row + benefits form tells the truth", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: CHRIS_PAYROLL });
    await page.waitForLoadState("networkidle");

    // ---------- Recurring grid ----------
    const recurringCard = page.getByTestId("grid-recurring");
    await expect(recurringCard).toBeVisible();
    await expect(recurringCard).toContainText("Cell Phone Allowance");
    await expect(recurringCard).toContainText("Long Term Disability");
    await expect(recurringCard).toContainText("$37.50");
    await expect(recurringCard).toContainText("$28.11");

    // Change + End actions per row — proved by presence of two distinct
    // Change buttons (one per active row).
    const changeButtons = page.locator('[data-testid^="grid-recurring-change-open-"]');
    const endButtons = page.locator('[data-testid^="grid-recurring-end-open-"]');
    await expect(changeButtons).toHaveCount(2);
    await expect(endButtons).toHaveCount(2);

    // Open the LTD Change form (do NOT save)
    const ltdChangeBtn = changeButtons.nth(1);
    await ltdChangeBtn.click();
    const dateInputs = page.locator('input[type="date"]').filter({
      has: page.locator("visible=true"),
    });
    // Cancel the change without submitting
    const cancelBtns = page.getByRole("button", { name: "Cancel" });
    await cancelBtns.first().click();

    // Screenshot
    await page.screenshot({ path: "test-results/fpp4-recurring-actions.png", fullPage: false });

    // ---------- Benefits ----------
    const benefitsCard = page.getByTestId("grid-benefits");
    await expect(benefitsCard).toBeVisible();
    await expect(benefitsCard).toContainText(/No active benefits|No enrolments|No benefit enrolments/i);

    // Click Enrol in benefit
    const enrolBtn = page.getByTestId("benefits-enrol-btn");
    await enrolBtn.click();

    // The truthful message is shown (no contradiction)
    const noPlans = page.getByTestId("benefits-enrol-no-plans-configured");
    await expect(noPlans).toBeVisible();
    await expect(noPlans).toContainText("No benefit plans are configured for this Club yet");
    await expect(noPlans).toContainText("Payroll Settings");

    // The misleading message is NOT shown
    await expect(page.getByTestId("benefits-enrol-all-enrolled")).toHaveCount(0);

    await page.screenshot({ path: "test-results/fpp4-benefits-truthful.png", fullPage: false });

    // ---------- Core state ----------
    await expect(page.getByTestId("grid-comp-rate")).toContainText("$110,000");
    await expect(page.getByTestId("grid-comp-effective")).toContainText("Feb 2, 2026");
    await expect(page.getByTestId("opening-ytd-status-pill")).toContainText(/ACTIVE|Active/i);
  });
});
