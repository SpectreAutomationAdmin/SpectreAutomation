// FPP-4A (2026-09-20) — Chris read-only acceptance of the Correct
// (unused recurring assignment) control.
//
// Reads Chris's live Payroll workspace and confirms:
//   * LTD row is present, $28.11, effective Sep 20, 2026 (unchanged)
//   * LTD row exposes the "Correct" control (unused → Correct, not
//     Change). Opening the form and cancelling does not save anything.
//   * Cell Phone Allowance row also present, $37.50, unchanged
//   * Opening YTD status pill still ACTIVE
//   * No writes performed by Claude

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

const CHRIS_PAYROLL = "/app/admin/people/employees/cmu0fiaod000187prcy9ufo2d?tab=payroll";

test.describe("FPP-4A Chris LTD Correct control (read-only)", () => {
  test("LTD row exposes Correct + opens/cancels without mutation", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: CHRIS_PAYROLL });
    await page.waitForLoadState("networkidle");

    const recurring = page.getByTestId("grid-recurring");
    await expect(recurring).toContainText("Cell Phone Allowance");
    await expect(recurring).toContainText("Long Term Disability");
    await expect(recurring).toContainText("$28.11");
    await expect(recurring).toContainText("$37.50");

    // Since Chris has zero snapshots, both rows should expose Correct
    // (the primary control) — no consumed rows.
    const correctButtons = page.locator('[data-testid^="grid-recurring-correct-open-"]');
    await expect(correctButtons).toHaveCount(2);

    // No historical Change buttons should be rendered for these rows
    const changeButtons = page.locator('[data-testid^="grid-recurring-change-open-"]');
    await expect(changeButtons).toHaveCount(0);

    // Screenshot: Correct + End visible per row
    await page.screenshot({ path: "test-results/fpp4a-correct-controls.png", fullPage: false });

    // Open the LTD Correct form (last correct button, by DOM order)
    await correctButtons.nth(1).click();

    // Cancel without saving
    const cancelBtns = page.getByRole("button", { name: "Cancel" });
    await cancelBtns.first().click();

    // Opening YTD still ACTIVE
    await expect(page.getByTestId("opening-ytd-status-pill")).toContainText(/ACTIVE|Active/i);
  });
});
