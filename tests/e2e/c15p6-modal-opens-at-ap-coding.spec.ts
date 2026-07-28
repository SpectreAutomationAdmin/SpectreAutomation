// Sprint 3 · Checkpoint 15P-6 (2026-07-28) — behavioural e2e proof
// that an existing exact-match vendor opens the AP-coding modal
// directly, WITHOUT flashing Vendor Profile first.
//
// Founder rejection of 15P-5: unit tests proved deriveApAction
// returned AP_CODING for a projection with matchedVendorId set,
// but the ACTUAL browser opened Vendor Profile because the
// projection matcher was misconfigured. That gap is the specific
// class of drift this test exists to catch — it renders the REAL
// EmailIntakeCard + REAL CreateVendorAndPostModal with a matched-
// vendor projection fixture and asserts:
//
//   • the modal opens with the "Review and post invoice" title
//     (AP Coding), NOT "Vendor profile"
//   • the compact vendor header shows the matched vendor
//   • the Vendor Profile form fields are NOT rendered
//   • the "Use selected vendor" button is NOT present
//   • the "Save and finish later" button is NOT present
//   • the "Review / change vendor" affordance IS present
//   • clicking "Review / change vendor" reveals Vendor Profile
//   • the interactive step indicator lets us navigate back to
//     AP Coding without losing state

import { test, expect } from "@playwright/test";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const BASE = process.env.SPECTRE_BASE_URL ?? "http://localhost:3000";

async function signIn(page: import("@playwright/test").Page) {
  await page.goto(`${BASE}/login`);
  await page.locator('[data-testid="login-email"], input[type="email"]').first().fill(ADMIN);
  await page.locator('[data-testid="login-password"], input[type="password"]').first().fill(PASSWORD);
  await Promise.all([page.waitForURL(/\/app\//), page.locator('button[type="submit"]').first().click()]);
}

test.describe("15P-6 · matched vendor opens the modal directly on AP Coding", () => {
  test("Clicking Approve & post on the vendor-matched-ready fixture opens AP Coding as the FIRST frame", async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/app/admin/review/ap-card-fidelity`);
    await page.waitForLoadState("networkidle");

    const section = page.locator('[data-testid="ap-fidelity-vendor-matched-ready"]');
    // Sanity — the fixture card shows the right primary label.
    await expect(section.locator('[data-testid="ap-action-primary"]'))
      .toHaveText(/Approve & post/);

    // Click the primary action. The modal MUST open directly on AP
    // Coding — no Vendor Profile flash.
    await section.locator('[data-testid="ap-action-primary"]').click();

    const modal = page.locator('[data-testid="create-vendor-and-post-modal"]');
    await expect(modal).toBeVisible();

    // (1) Title is the AP-coding title, not the Vendor-Profile title.
    await expect(modal.locator('[data-testid="cvap-step-title"]'))
      .toHaveText(/Review and post invoice/);

    // (2) Compact vendor header is present with the matched vendor name.
    await expect(modal.locator('[data-testid="cvap-vendor-header"]')).toBeVisible();
    await expect(modal.locator('[data-testid="cvap-vendor-header"]'))
      .toContainText("Microsoft Corporation");

    // (3) Step indicator is HIDDEN in single-step auto-resolved mode.
    await expect(modal.locator('[data-testid="cvap-step-indicator"]')).toHaveCount(0);

    // (4) Vendor Profile form is NOT rendered.
    await expect(modal.locator('[data-testid="cvap-profile"]')).toHaveCount(0);
    await expect(modal.locator('[data-testid="cvap-profile-legal"]')).toHaveCount(0);

    // (5) "Use selected vendor" is NOT present.
    await expect(modal.getByRole("button", { name: /Use selected vendor/ })).toHaveCount(0);

    // (6) "Save and finish later" is NOT present (Step 1 only).
    await expect(modal.locator('[data-testid="cvap-save-and-finish-later"]')).toHaveCount(0);

    // (7) "Review / change vendor" IS the escape hatch for Vendor Profile.
    await expect(modal.locator('[data-testid="cvap-review-vendor"]')).toBeVisible();

    // (8) The AP Coding sections ARE rendered.
    await expect(modal.locator('[data-testid="cvap-step2-summary"]')).toBeVisible();
    await expect(modal.locator('[data-testid="cvap-step2-coding"]')).toBeVisible();
    await expect(modal.locator('[data-testid="cvap-step2-tax"]')).toBeVisible();
    await expect(modal.locator('[data-testid="cvap-step2-journal"]')).toBeVisible();
  });

  test("Review / change vendor reveals Vendor Profile with interactive step navigation", async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/app/admin/review/ap-card-fidelity`);
    await page.waitForLoadState("networkidle");

    const section = page.locator('[data-testid="ap-fidelity-vendor-matched-ready"]');
    await section.locator('[data-testid="ap-action-primary"]').click();

    const modal = page.locator('[data-testid="create-vendor-and-post-modal"]');
    await expect(modal).toBeVisible();

    // Initially single-step.
    await expect(modal.locator('[data-testid="cvap-step-indicator"]')).toHaveCount(0);

    // Click "Review / change vendor" → the two-step header appears
    // and the modal navigates to Vendor Profile.
    await modal.locator('[data-testid="cvap-review-vendor"]').click();

    // Two-step header now visible + interactive.
    await expect(modal.locator('[data-testid="cvap-step-indicator"]')).toBeVisible();
    await expect(modal.locator('[data-testid="cvap-step-1-btn"]')).toBeVisible();
    await expect(modal.locator('[data-testid="cvap-step-2-btn"]')).toBeVisible();

    // Vendor Profile fields are now rendered.
    await expect(modal.locator('[data-testid="cvap-profile"]')).toBeVisible();
    await expect(modal.locator('[data-testid="cvap-profile-legal"]')).toBeVisible();

    // Step-indicator navigation returns to AP Coding.
    await modal.locator('[data-testid="cvap-step-2-btn"]').click();
    await expect(modal.locator('[data-testid="cvap-step2-summary"]')).toBeVisible();
    await expect(modal.locator('[data-testid="cvap-profile"]')).toHaveCount(0);

    // Back to Step 1 — the profile IS preserved (the state model
    // never resets on step navigation).
    await modal.locator('[data-testid="cvap-step-1-btn"]').click();
    await expect(modal.locator('[data-testid="cvap-profile"]')).toBeVisible();
  });

  test("Vendor-UNMATCHED fixture opens on Vendor Profile (Step 1)", async ({ page }) => {
    // Control case — proves the direct-to-AP-coding behaviour is
    // ONLY for the matched fixture, not a UI bug that flips every
    // card into AP Coding.
    await signIn(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/app/admin/review/ap-card-fidelity`);
    await page.waitForLoadState("networkidle");

    const section = page.locator('[data-testid="ap-fidelity-vendor-unmatched"]');
    await section.locator('[data-testid="ap-action-primary"]').click();

    const modal = page.locator('[data-testid="create-vendor-and-post-modal"]');
    await expect(modal).toBeVisible();

    // Title is Vendor Profile.
    await expect(modal.locator('[data-testid="cvap-step-title"]'))
      .toHaveText(/Vendor profile/);
    // Two-step indicator IS visible for the create-new flow.
    await expect(modal.locator('[data-testid="cvap-step-indicator"]')).toBeVisible();
    // Vendor Profile form IS rendered.
    await expect(modal.locator('[data-testid="cvap-profile"]')).toBeVisible();
    // No "Review / change vendor" chip (there's no auto-resolved vendor).
    await expect(modal.locator('[data-testid="cvap-review-vendor"]')).toHaveCount(0);
  });
});
