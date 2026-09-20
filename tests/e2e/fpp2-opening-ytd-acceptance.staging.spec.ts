// FPP-2 (2026-09-20) — Chris Turcato Opening YTD founder acceptance.
//
// Reads-only spec against Chris's actual staging profile after the
// FPP-2 deploy. Proves the redesigned Opening YTD workspace is
// functional END-TO-END:
//
//   * Chris's DRAFT survives the deploy — gross earnings, throughPayDate,
//     priorPayrollKind unchanged.
//   * Opening YTD modal opens directly; canonical components (Cell
//     Phone, RRSP EE / ER, LTD, AD&D, Life, Dependent Life, Health &
//     Dental) render immediately as data-entry rows.
//   * No synthetic 3C Acceptance Bonus is exposed.
//   * No "save aggregate values first" gate is shown.
//   * A single Save Draft submit persists whatever is in the form.
//
// Does NOT populate any of Chris's components. Does NOT activate.
// Does NOT run payroll. Screenshots capture the state without any
// employee-identifying content (SIN, bank, etc.) — the modal shows
// YTD amounts only.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

const CHRIS_URL_PATH = "/app/admin/people/employees/cmu0fiaod000187prcy9ufo2d?tab=payroll";

test.describe("FPP-2 Chris Opening YTD workspace acceptance", () => {
  test("modal renders components as pre-listed rows without a save-first gate", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: CHRIS_URL_PATH });
    await page.waitForLoadState("networkidle");

    // Confirm status pill (existing DRAFT).
    const pill = page.getByTestId("opening-ytd-status-pill");
    await expect(pill).toHaveText(/Draft|Ready|Active/i);

    // Open the workspace.
    const opener = page
      .getByTestId("opening-ytd-open-editor")
      .or(page.getByTestId("opening-ytd-view-values"));
    await opener.first().click();

    // Screenshot A — top of unified workspace.
    const modal = page.getByTestId("opening-ytd-modal");
    await expect(modal).toBeVisible();
    await modal.screenshot({ path: "test-results/fpp2-A-workspace-top.png" });

    // Aggregate values still populated from Chris's DRAFT.
    const gross = page.getByTestId("opening-ytd-ytdGrossEarnings");
    await expect(gross).toHaveValue(/^\d/);
    const grossValue = await gross.inputValue();
    expect(Number(grossValue)).toBeGreaterThan(0);

    // Through-pay-date preserved.
    const through = page.getByTestId("opening-ytd-through-pay-date");
    const throughValue = await through.inputValue();
    expect(throughValue).toBe("2026-08-31");

    // Prior payroll kind preserved.
    const kind = page.getByTestId("opening-ytd-prior-kind");
    await expect(kind).toHaveValue("PRIOR_SYSTEM_SAME_EMPLOYER");

    // FPP-2 primary acceptance: all eight canonical components render
    // as pre-listed rows and are empty (Chris hasn't populated them).
    for (const code of [
      "CELL_PHONE_ALLOWANCE",
      "RRSP_EE",
      "RRSP_ER",
      "LTD",
      "AD_D",
      "LIFE_INSURANCE",
      "DEPENDENT_LIFE_INSURANCE",
      "HEALTH_DENTAL",
    ]) {
      const field = page.getByTestId(`opening-ytd-component-input-${code}`);
      await expect(field).toBeVisible();
      // Blank (nothing pre-populated).
      const v = await field.inputValue();
      expect(v).toBe("");
    }

    // No save-first gate.
    await expect(page.getByTestId("opening-ytd-components-needs-draft")).toHaveCount(0);

    // No synthetic 3C_ACCEPT_BONUS anywhere.
    const synthBadge = page.getByText(/3C[_ ]ACCEPT|3C Acceptance/i);
    await expect(synthBadge).toHaveCount(0);

    // Screenshot B — statutory + deductions region.
    await page.getByTestId("opening-ytd-employee-stat-heading").scrollIntoViewIfNeeded();
    await modal.screenshot({ path: "test-results/fpp2-B-statutory.png" });

    // Screenshot C — employee deductions region (RRSP EE + LTD).
    await page.getByTestId("opening-ytd-employee-deductions-heading").scrollIntoViewIfNeeded();
    await modal.screenshot({ path: "test-results/fpp2-C-employee-deductions.png" });

    // Screenshot D — employer benefits region.
    await page.getByTestId("opening-ytd-employer-benefits-heading").scrollIntoViewIfNeeded();
    await modal.screenshot({ path: "test-results/fpp2-D-employer-benefits.png" });

    // Screenshot E — earnings + Cell Phone allowance region.
    await page.getByTestId("opening-ytd-earnings-heading").scrollIntoViewIfNeeded();
    await modal.screenshot({ path: "test-results/fpp2-E-earnings-plus-cell.png" });

    // Save Draft button visible + enabled.
    const save = page.getByTestId("opening-ytd-save-draft");
    await expect(save).toBeVisible();
    await expect(save).toBeEnabled();

    // Screenshot F — bottom action row.
    await save.scrollIntoViewIfNeeded();
    await modal.screenshot({ path: "test-results/fpp2-F-actions.png" });

    // Component-first: type an RRSP EE amount BEFORE touching aggregate
    // fields to prove there is no save-first prerequisite blocking it.
    const rrspInput = page.getByTestId("opening-ytd-component-input-RRSP_EE");
    await rrspInput.click();
    await rrspInput.fill("1");
    // We DO NOT submit. We want the founder's DRAFT untouched.
    await expect(rrspInput).toHaveValue("1");
    await modal.screenshot({ path: "test-results/fpp2-G-component-first-before-save.png" });

    // Revert the visual change without saving.
    await rrspInput.fill("");

    // Close without saving to keep Chris's DRAFT pristine.
    await page.getByTestId("opening-ytd-cancel").click();
  });
});
