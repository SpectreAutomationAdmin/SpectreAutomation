// FPP-4B (2026-09-20) — Read-only + create-plan-form-only acceptance.
//
// Proves after deploy that the founder can open the New Benefit Plan
// form for an RRSP percentage plan and see the corrected RRSP EE +
// RRSP ER components as valid choices (no incompatibility warning).
// Does NOT click Save — no plan is created for the founder.
//
// Also confirms Chris's core state is unchanged.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

test.describe("FPP-4B RRSP plan readiness (read-only)", () => {
  test("Payroll Settings → Benefits shows RRSP EE + ER as PERCENT-compatible", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: "/app/admin/payroll/setup/benefits" });
    await page.waitForLoadState("networkidle");

    // 0 active plans (nothing partial from the founder's failed save)
    const empty = page.getByTestId("benefits-empty");
    await expect(empty).toContainText("No benefit plans configured");

    // Open the add-plan form
    await page.getByTestId("benefits-add-plan-btn").click();

    // Choose RRSP, election kind auto-switches (or forced) to PERCENT
    // depending on the current UI. Explicitly pick PERCENT to match
    // the founder's flow.
    await page.locator("select[name='kind']").selectOption("RRSP");
    await page.locator("select[name='defaultElectionKind']").selectOption("PERCENT_OF_ELIGIBLE_EARNINGS");

    // Employee picker exposes RRSP - Employee
    const eePicker = page.getByTestId("benefits-form-employee-component");
    await expect(eePicker).toBeVisible();
    const eeOptions = await eePicker.locator("option").allTextContents();
    const eeOptionText = eeOptions.join("|");
    expect(eeOptionText).toContain("RRSP — Employee");
    // No incompatibility banner while at least one compatible option exists
    await expect(page.getByTestId("benefits-form-employee-incompat")).toHaveCount(0);

    // Employer picker exposes RRSP - Employer
    const erPicker = page.getByTestId("benefits-form-employer-component");
    const erOptions = await erPicker.locator("option").allTextContents();
    const erOptionText = erOptions.join("|");
    expect(erOptionText).toContain("RRSP — Employer");
    await expect(page.getByTestId("benefits-form-employer-incompat")).toHaveCount(0);

    // Screenshot for founder proof
    await page.screenshot({ path: "test-results/fpp4b-rrsp-form.png", fullPage: false });

    // Close/cancel without creating a plan
    await page.getByRole("button", { name: "Cancel" }).first().click();
  });

  test("Chris core state unchanged post-correction", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, {
      landing: "/app/admin/people/employees/cmu0fiaod000187prcy9ufo2d?tab=payroll",
    });
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("grid-comp-rate")).toContainText("$110,000");
    await expect(page.getByTestId("opening-ytd-status-pill")).toContainText(/ACTIVE|Active/i);
    const recurring = page.getByTestId("grid-recurring");
    await expect(recurring).toContainText("Cell Phone Allowance");
    await expect(recurring).toContainText("$37.50");
    await expect(recurring).toContainText("Long Term Disability");
    await expect(recurring).toContainText("$28.11");
    // Benefits card still empty (no enrolments)
    await expect(page.getByTestId("grid-benefits")).toContainText(/No active benefits|No enrolments/i);
  });
});
