// FPP-3 (2026-09-20) — + Add Component hotfix — Chris read-only acceptance.
//
// Proves the previously-dead "+ Add Component" control on the Employee →
// Payroll grid card now:
//   * renders as a button (not a fragment anchor)
//   * opens a modal on click
//   * loads the legitimate Coulee Ridge component catalogue
//   * exposes amount/percentage UI adapted to the selected component's
//     calculationMethod
//   * closes on Cancel without saving
//
// Does NOT save any recurring assignment for Chris. Does NOT alter his
// activated Opening YTD, base compensation, membership, or benefits.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

const CHRIS_PAYROLL = "/app/admin/people/employees/cmu0fiaod000187prcy9ufo2d?tab=payroll";

test.describe("FPP-3 recurring + Add Component hotfix (Chris read-only)", () => {
  test("+ Add Component button opens the modal and loads the catalogue", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: CHRIS_PAYROLL });
    await page.waitForLoadState("networkidle");

    // Recurring card visible + shows empty state
    const card = page.getByTestId("grid-recurring");
    await expect(card).toBeVisible();
    await expect(card).toContainText("No active recurring components");

    // Add button visible + is a BUTTON not a link
    const addBtn = page.getByTestId("grid-recurring-add");
    await expect(addBtn).toBeVisible();
    const tagName = await addBtn.evaluate((el) => el.tagName.toLowerCase());
    expect(tagName).toBe("button");

    // Click opens the modal
    await addBtn.click();
    const modal = page.getByTestId("recurring-add-modal");
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("Add Recurring Component");

    // Component picker present + populated with real catalogue
    const picker = page.getByTestId("recurring-add-component");
    await expect(picker).toBeVisible();
    const options = await picker.locator("option").allTextContents();
    // First option is "— Select —" placeholder; expect real components below
    expect(options.length).toBeGreaterThan(1);
    const optionText = options.join("|");
    expect(optionText).toContain("Cell Phone Allowance");
    expect(optionText).toContain("Long Term Disability");
    // No synthetic contamination
    expect(optionText).not.toContain("3C Acceptance Bonus");
    expect(optionText).not.toContain("3C_ACCEPT_BONUS");

    // Screenshot: opened modal with catalogue
    await page.screenshot({ path: "test-results/fpp3-add-modal-opened.png", fullPage: false });

    // Select Cell Phone Allowance — FIXED_AMOUNT — confirm amount field appears
    const cellOption = options.find((o) => o.startsWith("Cell Phone Allowance"));
    expect(cellOption).toBeTruthy();
    await picker.selectOption({ label: cellOption! });
    const amountInput = page.getByTestId("recurring-add-amount");
    await expect(amountInput).toBeVisible();
    // Percent input NOT visible for FIXED_AMOUNT
    await expect(page.getByTestId("recurring-add-percent")).toHaveCount(0);
    const context1 = page.getByTestId("recurring-add-context");
    await expect(context1).toBeVisible();
    await expect(context1).toContainText("fixed amount");

    // Screenshot: FIXED_AMOUNT surface
    await page.screenshot({ path: "test-results/fpp3-add-modal-fixed-amount.png", fullPage: false });

    // Effective date + save button visible
    await expect(page.getByTestId("recurring-add-effective")).toBeVisible();
    await expect(page.getByTestId("recurring-add-submit")).toBeVisible();

    // Cancel without saving
    await page.getByTestId("recurring-add-cancel").click();
    await expect(modal).toHaveCount(0);

    // Confirm nothing was written
    await expect(card).toContainText("No active recurring components");
  });

  test("Chris core payroll state is unchanged post-deploy (read-only)", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: CHRIS_PAYROLL });
    await page.waitForLoadState("networkidle");

    // Base compensation
    await expect(page.getByTestId("grid-comp-rate")).toContainText("$110,000");
    await expect(page.getByTestId("grid-comp-effective")).toContainText("Feb 2, 2026");

    // Opening YTD Active
    await expect(page.getByTestId("opening-ytd-status-pill")).toContainText(/ACTIVE|Active/i);

    // Recurring empty, Benefits empty
    await expect(page.getByTestId("grid-recurring")).toContainText("No active recurring components");
    await expect(page.getByTestId("grid-benefits")).toContainText(/No active benefits|No enrolments|No benefit enrolments/i);
  });
});
