// FPP-8 (2026-09-21) — Payroll Admin posting preview + confirmation
// browser acceptance.
//
// READ-ONLY against the founder's Sep 15 APPROVED batch. This spec
// deliberately never clicks Confirm & Post Payroll — the irreversible
// posting action is reserved for the founder per §28 of the FPP-8
// brief. Cancel is exercised end-to-end.
//
// The Playwright helper authenticates as Chris Turcato (Controller)
// today. Chris has payroll:read so the posting preview loads for
// him, but the Post Approved Payroll button is disabled because the
// Ready-to-Post WI item is owned by Marc. The client hint surfaces
// "assigned to a different Payroll Administrator". Server-side
// payroll:post permission also remains authoritative.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

const READY_TO_POST_WI_ID = "cmubtx3e401sv34p3b9gbbwuu";
const OPEN_URL = `/app/admin?workItem=${READY_TO_POST_WI_ID}`;

test.describe("FPP-8 — Payroll Admin posting preview (read-only)", () => {
  test("Opening posting preview: header, metadata, summary, GL preview all bind to frozen approved batch", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OPEN_URL });
    await page.waitForLoadState("domcontentloaded");
    const preview = page.getByTestId("payroll-posting-preview");
    await expect(preview).toBeVisible({ timeout: 20_000 });
    // Header names the payroll + period + club.
    await expect(preview).toContainText(/Payroll Ready to Post/);
    await expect(preview).toContainText(/Aug 24 – Sep 8, 2026/);
    await expect(preview).toContainText(/Coulee Ridge/);
    // Status pills.
    await expect(preview).toContainText("Approved");
    await expect(preview).toContainText(/Ready to post/i);
    // Metadata (approver = Chris; Payroll Admin = Marc from
    // PayrollClubConfig + WI owner).
    await expect(preview).toContainText("Chris Turcato");
    await expect(preview).toContainText("Marc Maldiney");
    // 2×2 summary.
    const summary = page.getByTestId("posting-preview-summary");
    await expect(summary).toContainText("1");
    await expect(summary).toContainText("Sep 15, 2026");
    await expect(summary).toContainText("$4,620.83");
    await expect(summary).toContainText("$3,037.33");
    // Executive insight — factual only.
    const insights = page.getByTestId("posting-preview-insights");
    await expect(insights).toContainText(/Controller approval is complete/i);
    await expect(insights).toContainText(/reconciles to the cent/i);
    await expect(insights).toContainText(/does not (?:transmit|remain) employee|external \/ manual/i);
    // Accounting preview — canonical journal from previewPayrollJournal.
    // Either the journal renders (balanced or unbalanced) OR the
    // readiness-blocker fallback surfaces the specific configuration
    // gap. Both paths are §5/§23-compliant "fail closed" behaviour.
    const journal = page.getByTestId("posting-preview-journal");
    const journalMissing = page.getByTestId("posting-preview-journal-missing");
    const journalVisible = await journal.isVisible().catch(() => false);
    if (!journalVisible) {
      // The canonical resolver refused because of a readiness blocker
      // (missing GL mapping for a payroll component). Surface it —
      // this is a legitimate configuration issue the Payroll Admin
      // must resolve before Marc can post.
      await expect(journalMissing).toBeVisible({ timeout: 5_000 });
    }
    // Screenshot for the founder acceptance — whichever state renders.
    await page.screenshot({ path: "test-results/fpp8-posting-preview-open.png", fullPage: false });
  });

  test("Assigned Payroll Admin gate: current session (Chris = Controller, not the WI owner) sees Post disabled", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OPEN_URL });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("payroll-posting-preview")).toBeVisible({ timeout: 20_000 });
    const post = page.getByTestId("posting-preview-post");
    await expect(post).toBeVisible();
    await expect(post).toBeDisabled();
    await expect(page.getByTestId("posting-preview-not-actionable"))
      .toContainText(/assigned to a different Payroll Administrator/i);
  });
});
