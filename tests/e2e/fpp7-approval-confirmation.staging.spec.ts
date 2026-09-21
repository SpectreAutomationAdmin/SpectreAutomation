// FPP-7 (2026-09-21) — Controller approval confirmation UX acceptance.
//
// Read-only against the founder's Sep 15 SUBMITTED batch. Explicitly
// verifies that opening the approval confirmation is safe (nothing
// mutates until the founder clicks the inner Confirm button). The
// test itself NEVER clicks Confirm — that action is reserved for
// the founder's own hands per §24 of the FPP-7 brief.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

const OPEN_URL = "/app/admin?workItem=cmual5x0x00087hkl20vowupf";

test.describe("FPP-7 — Controller approval confirmation UX (read-only)", () => {
  test("Clicking Approve Payroll opens a confirmation modal (no mutation)", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OPEN_URL });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("payroll-approval-preview")).toBeVisible({ timeout: 15_000 });
    // Approve button is present. It is only ENABLED while the batch
    // is SUBMITTED_FOR_APPROVAL — post-FPP-8 the batch has moved to
    // APPROVED and the button is correctly disabled. Skip when the
    // state has advanced past the FPP-7 acceptance window.
    const approve = page.getByTestId("preview-approve");
    await expect(approve).toBeVisible();
    if (await approve.isDisabled()) {
      test.skip(true, "Batch is no longer SUBMITTED_FOR_APPROVAL — FPP-7 confirmation UX has moved on to FPP-8.");
    }
    await expect(approve).toBeEnabled();
    // Clicking it opens the confirmation dialog — NOT an immediate
    // approval request.
    await approve.click();
    const dialog = page.getByTestId("preview-approve-confirm-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText(/Approve Payroll/);
    await expect(dialog).toContainText(/Aug 24 – Sep 8, 2026/);
    await expect(dialog).toContainText(/Sep 15, 2026/);
    // Founder-frozen totals present in confirmation.
    const summary = page.getByTestId("preview-approve-confirm-summary");
    await expect(summary).toContainText("$4,620.83");
    await expect(summary).toContainText("$3,037.33");
    await expect(summary).toContainText("v1");
    // Language matches §6 acceptance: handoff to Payroll Admin,
    // no payment transmission.
    await expect(dialog).toContainText(/handed back to Payroll Administration for posting/i);
    await expect(dialog).toContainText(/does not transmit employee payments/i);
    await expect(dialog).not.toContainText(/Approve & Post/);
    await expect(dialog).not.toContainText(/Pay Employees/);
    await expect(dialog).not.toContainText(/Send Payments/);
    // Cancel dismisses cleanly, no mutation.
    await page.getByTestId("preview-approve-confirm-cancel").click();
    await expect(dialog).toHaveCount(0);
    // Preview remains open — cancel does not close it.
    await expect(page.getByTestId("payroll-approval-preview")).toBeVisible();
    await page.screenshot({
      path: "test-results/fpp7-approve-confirmation-cancelled.png",
      fullPage: false,
    });
  });

  test("Confirmation dialog can be reopened without side effects", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OPEN_URL });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("payroll-approval-preview")).toBeVisible({ timeout: 15_000 });
    // Skip when the batch has moved past SUBMITTED_FOR_APPROVAL.
    if (await page.getByTestId("preview-approve").isDisabled()) {
      test.skip(true, "Batch is no longer SUBMITTED_FOR_APPROVAL — FPP-7 confirmation UX no longer available.");
    }
    for (let i = 0; i < 3; i++) {
      await page.getByTestId("preview-approve").click();
      await expect(page.getByTestId("preview-approve-confirm-dialog")).toBeVisible();
      await page.getByTestId("preview-approve-confirm-cancel").click();
      await expect(page.getByTestId("preview-approve-confirm-dialog")).toHaveCount(0);
    }
    // Confirm button in the dialog was never clicked; capture the
    // reopened dialog once more for evidence.
    await page.getByTestId("preview-approve").click();
    await expect(page.getByTestId("preview-approve-confirm-dialog")).toBeVisible();
    await page.screenshot({
      path: "test-results/fpp7-approve-confirmation-open.png",
      fullPage: false,
    });
    await page.getByTestId("preview-approve-confirm-cancel").click();
  });
});
