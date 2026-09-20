// FPP-2 (2026-09-20) — Workspace visual acceptance at 1440x900.
//
// Captures the redesigned dedicated Opening YTD workspace page as
// rendered against Chris's staging DRAFT so the founder can compare
// side-by-side with the approved reference PNG.
//
// Read-only: does NOT populate component values, does NOT change
// Chris's DRAFT, does NOT activate, does NOT submit any form.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

const CHRIS_WORKSPACE = "/app/admin/people/employees/cmu0fiaod000187prcy9ufo2d/opening-ytd";

test.describe("FPP-2 workspace visual acceptance", () => {
  test("Chris workspace renders full reference layout at 1440x900", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");

    const page = await loginAsFounder(context, { landing: CHRIS_WORKSPACE });
    await page.waitForLoadState("networkidle");

    // Breadcrumb visible + ending in "Opening YTD"
    const breadcrumb = page.locator(".fpp2-breadcrumb");
    await expect(breadcrumb).toContainText("People");
    await expect(breadcrumb).toContainText("Employee Directory");
    await expect(breadcrumb).toContainText("Payroll");
    await expect(breadcrumb).toContainText("Opening YTD");

    // Employee header (name + ACTIVE pill + hire date + club)
    await expect(page.locator(".fpp2-employee-name")).toContainText("Chris Turcato");
    await expect(page.getByTestId("fpp2-employee-status-pill")).toContainText("ACTIVE");
    await expect(page.locator(".fpp2-employee-meta")).toContainText("E-00002");
    await expect(page.locator(".fpp2-employee-meta")).toContainText("Coulee Ridge");

    // Payroll tab active
    await expect(page.locator(".fpp2-tab--active")).toContainText("Payroll");

    // Title + DRAFT status + Last saved
    await expect(page.locator(".fpp2-ytd-title h2")).toContainText("Opening YTD");
    await expect(page.getByTestId("opening-ytd-status-pill")).toContainText("DRAFT");
    await expect(page.getByTestId("opening-ytd-last-saved")).toContainText("Last saved");

    // Meta row values loaded from Chris's DRAFT
    await expect(page.getByTestId("opening-ytd-through-pay-date")).toHaveValue("2026-08-31");
    await expect(page.getByTestId("opening-ytd-prior-kind")).toHaveValue("PRIOR_SYSTEM_SAME_EMPLOYER");

    // Six cards present
    for (let i = 1; i <= 6; i++) {
      await expect(page.getByTestId(`opening-ytd-card-${i}`)).toBeVisible();
    }

    // Chris's aggregate values loaded
    await expect(page.getByTestId("opening-ytd-ytdGrossEarnings")).toHaveValue("62381.21");
    await expect(page.getByTestId("opening-ytd-ytdCppEE")).toHaveValue("3761.56");
    await expect(page.getByTestId("opening-ytd-ytdEiEE")).toHaveValue("1008.58");

    // 8 canonical components pre-listed as data-entry rows. Chris's
    // DRAFT was populated by the founder in the previous FPP-2 modal
    // for 7 of 8 (HEALTH_DENTAL remains blank). Assert visibility only
    // and NEVER touch the values — the DRAFT is founder-owned data.
    for (const code of [
      "CELL_PHONE_ALLOWANCE", "RRSP_EE", "RRSP_ER", "LTD",
      "AD_D", "LIFE_INSURANCE", "DEPENDENT_LIFE_INSURANCE", "HEALTH_DENTAL",
    ]) {
      const input = page.getByTestId(`opening-ytd-component-input-${code}`);
      await expect(input).toBeVisible();
    }
    // Verify the founder-entered component amounts still round-trip
    // through the redesigned workspace (proves DRAFT compat).
    await expect(page.getByTestId("opening-ytd-component-input-RRSP_EE")).toHaveValue("3093.79");
    await expect(page.getByTestId("opening-ytd-component-input-CELL_PHONE_ALLOWANCE")).toHaveValue("506.25");
    await expect(page.getByTestId("opening-ytd-component-input-LTD")).toHaveValue("351.42");

    // Right rail visible with about + callout + tips
    await expect(page.locator(".fpp2-ytd-rail")).toBeVisible();
    await expect(page.getByTestId("opening-ytd-any-section-callout")).toBeVisible();

    // Action bar
    await expect(page.getByTestId("opening-ytd-save-draft")).toBeVisible();
    await expect(page.getByTestId("opening-ytd-validate")).toBeVisible();
    await expect(page.getByTestId("opening-ytd-activate")).toBeVisible();

    // Screenshot 1: full page
    await page.screenshot({
      path: "test-results/fpp2-workspace-full.png",
      fullPage: true,
    });

    // Screenshot 2: 1440x900 viewport only (comparable to reference)
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({
      path: "test-results/fpp2-workspace-viewport-1440x900.png",
      fullPage: false,
    });

    // Screenshot 3: card grid
    await page.locator(".fpp2-ytd-grid").screenshot({
      path: "test-results/fpp2-workspace-grid.png",
    });

    // Screenshot 4: right rail
    await page.locator(".fpp2-ytd-rail").screenshot({
      path: "test-results/fpp2-workspace-rail.png",
    });

    // Screenshot 5: action bar
    await page.locator(".fpp2-ytd-actions").scrollIntoViewIfNeeded();
    await page.locator(".fpp2-ytd-actions").screenshot({
      path: "test-results/fpp2-workspace-actions.png",
    });

    // Read-only — no writes performed. Founder-entered DRAFT preserved.
  });
});
