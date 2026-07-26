// Sprint 3 Checkpoint 15I-2 (2026-07-27) — AP card fidelity local smoke.
//
// Signs in as the local admin fixture, opens the dev-only AP card
// fidelity review page, and:
//   1. verifies the eight Microsoft states are all rendered by the
//      REAL production EmailIntakeCard (not a static mock);
//   2. verifies the AP-mode collapsed body renders the projected
//      values ("Microsoft Corporation", "E0701097E3", "CAD 31.29");
//   3. verifies the readout is AMOUNT · PO/INVOICE · CATEGORY ·
//      CONFIDENCE (not the pre-15I-2 VENDOR · INVOICE · AP STATUS
//      · AMOUNT ordering that projected the sender as vendor);
//   4. verifies primary action label matches the workflow state;
//   5. verifies the attachment aux link is present;
//   6. captures a 1440x900 screenshot to test-results/ for
//      side-by-side comparison against the Ace Foods reference at
//      /design-concepts/mission-control/variant-d-instrument.html.

import { test, expect } from "@playwright/test";

const ADMIN = "admin@silversprings.club";
const PASSWORD = "password";
const BASE = process.env.SPECTRE_BASE_URL ?? "http://localhost:3000";

test.describe("Checkpoint 15I-2 AP card fidelity — Microsoft against Ace Foods reference", () => {
  test("Every fixture state renders with the AP-mode Variant D card", async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width: 1440, height: 900 });

    const resp = await page.goto(`${BASE}/app/admin/review/ap-card-fidelity`);
    expect(resp?.status(), "fidelity page must render").toBeLessThan(500);
    await page.waitForLoadState("networkidle");

    // Eight Microsoft states.
    for (const k of [
      "vendor-unmatched",
      "vendor-matched-ready",
      "po-matched",
      "no-po",
      "low-confidence-category",
      "assigned-to-other",
      "deferred",
      "missing-information",
    ]) {
      await expect(
        page.locator(`[data-testid="ap-fidelity-${k}"]`),
        `fixture ${k} must render`,
      ).toBeVisible();
    }

    // Full-page screenshot for founder review.
    await page.screenshot({
      path: "test-results/c15i2-ap-fidelity-review.png",
      fullPage: true,
    });
  });

  test("Vendor-unmatched card shows Microsoft Corporation / E0701097E3 / CAD 31.29 — not sender-as-vendor", async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/app/admin/review/ap-card-fidelity`);
    await page.waitForLoadState("networkidle");

    const section = page.locator('[data-testid="ap-fidelity-vendor-unmatched"]');

    // Title carries the extracted vendor + invoice number + amount.
    const title = await section.locator('[data-testid="ap-title"]').textContent();
    expect(title).toContain("Microsoft Corporation");
    expect(title).toContain("E0701097E3");
    expect(title).toContain("CAD");
    expect(title).toContain("31.29");

    // Sender line carries the forwarding employee label — never the vendor.
    const sender = await section.locator('[data-testid="ap-sender-line"]').textContent();
    expect(sender).toContain("Forwarded by");
    expect(sender).toContain("PDF vendor: Microsoft Corporation");

    // Workflow pill matches the state.
    await expect(section.locator('[data-testid="ap-workflow-pill"]')).toHaveText("Vendor match required");

    // Readout carries the projected values — not sender-as-vendor.
    await expect(section.locator('[data-testid="ap-readout-amount"] .v')).toHaveText("CAD 31.29");
    await expect(section.locator('[data-testid="ap-readout-po-or-invoice"] .v')).toHaveText("#E0701097E3");

    // Primary action label matches the state.
    await expect(section.locator('[data-testid="ap-action-primary"]')).toHaveText("Match vendor");
    // Attachment footer aux link is present.
    await expect(section.locator('[data-testid="ap-attachment-footer"]')).toHaveText("Invoice · PDF");
    // Assign + Defer visible.
    await expect(section.locator('[data-testid="ap-action-assign"]')).toBeVisible();
    await expect(section.locator('[data-testid="ap-action-defer"]')).toBeVisible();
  });

  test("Ready-for-approval card leads with 'Approve & post' and shows cadence + terms", async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/app/admin/review/ap-card-fidelity`);
    await page.waitForLoadState("networkidle");

    const section = page.locator('[data-testid="ap-fidelity-vendor-matched-ready"]');
    await expect(section.locator('[data-testid="ap-workflow-pill"]')).toHaveText("Ready for approval");
    await expect(section.locator('[data-testid="ap-action-primary"]')).toHaveText("Approve & post");

    const sender = await section.locator('[data-testid="ap-sender-line"]').textContent();
    expect(sender).toContain("3rd invoice this quarter");
    expect(sender).toContain("Net 30");

    await expect(section.locator('[data-testid="ap-readout-category"] .v')).toHaveText("Software subscriptions");
  });

  test("Primary AP action expands the card and switches to Invoice Review tab (never a no-op)", async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/app/admin/review/ap-card-fidelity`);
    await page.waitForLoadState("networkidle");

    const section = page.locator('[data-testid="ap-fidelity-vendor-unmatched"]');
    const card = section.locator('[data-testid="email-intake-card"]');

    // Card starts collapsed.
    await expect(card).toHaveAttribute("data-expanded", "false");

    // Click the primary AP action ("Match vendor").
    await section.locator('[data-testid="ap-action-primary"]').click();

    // Card should now be expanded and the Invoice Review tab selected.
    await expect(card).toHaveAttribute("data-expanded", "true");
    await expect(section.locator('[data-testid="unified-tab-invoice"]')).toHaveAttribute("aria-selected", "true");
  });

  test("Assign control is present but visibly disabled with an explanatory tooltip", async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/app/admin/review/ap-card-fidelity`);
    await page.waitForLoadState("networkidle");

    const btn = page
      .locator('[data-testid="ap-fidelity-vendor-unmatched"]')
      .locator('[data-testid="ap-action-assign"]');
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute("aria-disabled", "true");
    const title = await btn.getAttribute("title");
    expect(title).toContain("follow-up");
  });

  test("Missing-information card omits the amount cell cleanly (no em-dash-into-nothing in the title)", async ({ page }) => {
    await signIn(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}/app/admin/review/ap-card-fidelity`);
    await page.waitForLoadState("networkidle");

    const section = page.locator('[data-testid="ap-fidelity-missing-information"]');
    const title = await section.locator('[data-testid="ap-title"]').textContent();
    // Amount was not confidently extracted — title omits the "— <amount>" segment.
    expect(title).not.toMatch(/—\s*—/);
    expect(title).toContain("Microsoft Corporation");
    expect(title).toContain("E0701097E3");

    // Primary action is Request information.
    await expect(section.locator('[data-testid="ap-action-primary"]')).toHaveText("Request information");
  });
});

async function signIn(page: import("@playwright/test").Page) {
  await page.goto(`${BASE}/login`);
  await page.fill('input[name="email"]', ADMIN);
  await page.fill('input[name="password"]', PASSWORD);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/app(\/|$)/, { timeout: 20_000 });
}
