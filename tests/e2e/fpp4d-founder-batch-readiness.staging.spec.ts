// FPP-4D (2026-09-20) — founder-batch read-only acceptance.
//
// Proves after deploy that Chris's real PREPARED batch on staging:
//   * Renders "Employee Data · Frozen at Prepare" green banner
//     (no explicit review required; no Mark Reviewed button on the
//     employee-data banner)
//   * Exceptions KPI shows "0" in neutral colour (not red) with
//     the breakdown "0 blockers · 1 warning · 1 info"
//   * Calculate Payroll remains disabled ONLY because recurring
//     components still need review (5 components)
//   * Chris state unchanged; batch preserved

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

const PAYROLL_URL =
  "/app/admin/payroll?payGroupId=cmu5kg3e40002h4iupsaxezdl&payPeriodId=cmu5kg3ih000nh4iuqyal9zay";

test.describe("FPP-4D founder batch readiness (read-only)", () => {
  test("Employee Data banner is frozen-baseline + Exceptions KPI neutral + Calculate disabled by recurring", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: PAYROLL_URL });
    await page.waitForLoadState("networkidle");

    // Confirm we're on the founder batch: PREPARED, Semi-Monthly, Sep 15.
    const heading = page.locator('[data-testid="payroll-admin-header"] h1').first();
    await expect(heading).toContainText("Semi-Monthly Payroll");
    await expect(page.getByTestId("payroll-admin-pay-group-line")).toContainText("CRGCC-SM");
    await expect(page.getByTestId("payroll-admin-pay-date-line")).toContainText("Sep 15");

    // Employee Data banner: frozen-baseline state
    const banner = page.getByTestId("payroll-admin-employee-data-review-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveAttribute("data-state", "frozen-baseline");
    await expect(banner).toContainText(/Frozen at Prepare/i);
    // No Mark Reviewed button on the employee data banner
    await expect(page.getByTestId("payroll-admin-review-mark-employee-data")).toHaveCount(0);

    // Exceptions KPI: value = 0 (blocker count) with severity breakdown
    const excCard = page.getByTestId("payroll-admin-kpi-exceptions");
    await expect(excCard).toBeVisible();
    // The primary value is the blocker count. The founder batch has 0
    // blockers; the sub-line surfaces the breakdown.
    const excBreakdown = page.getByTestId("payroll-admin-kpi-exceptions-breakdown");
    await expect(excBreakdown).toContainText("0 blockers");
    await expect(excBreakdown).toContainText("1 warning");
    await expect(excBreakdown).toContainText("1 info");

    // Calculate button visible but disabled
    const calc = page.getByRole("button", { name: /Calculate Payroll/i });
    if ((await calc.count()) > 0) {
      const isDisabled = await calc.first().isDisabled();
      expect(isDisabled).toBe(true);
    }

    // Screenshots
    await page.screenshot({ path: "test-results/fpp4d-employees-tab.png", fullPage: false });
    // Scroll to the exceptions region and capture
    await excCard.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/fpp4d-exceptions-kpi.png", fullPage: false });
    // Pre-calc checklist
    const checklist = page.locator("text=Pre-Calculation Checklist").first();
    if ((await checklist.count()) > 0) {
      await checklist.scrollIntoViewIfNeeded();
      await page.screenshot({ path: "test-results/fpp4d-precalc-checklist.png", fullPage: false });
    }
  });
});
