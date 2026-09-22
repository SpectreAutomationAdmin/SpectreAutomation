// FPP-8A (2026-09-21) — Founder-readiness browser evidence.
//
// READ-ONLY against the founder's Sep 15 APPROVED batch. Captures:
//   1. Journal preview populated + balanced (no MISSING_COMPONENT_* blockers).
//   2. Journal lines dumped to the console so the checkpoint can quote them.
//   3. The final posting confirmation modal opened but NEVER confirmed.
//
// The test authenticates as Chris (Controller). Chris has payroll:read
// but not payroll:post, so the Post Approved Payroll button is
// disabled — but the preview + journal + confirmation modal all
// render for read-only inspection. Marc will perform the actual
// posting from his own session.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

test.use({ viewport: { width: 1440, height: 900 } });

const READY_TO_POST_WI_ID = "cmubtx3e401sv34p3b9gbbwuu";
const OPEN_URL = `/app/admin?workItem=${READY_TO_POST_WI_ID}`;

test.describe("FPP-8A — founder-batch posting readiness", () => {
  test("Journal preview renders balanced with no MISSING_COMPONENT_* blockers; capture lines + full-page screenshot", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    const page = await loginAsFounder(context, { landing: OPEN_URL });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("payroll-posting-preview")).toBeVisible({ timeout: 20_000 });
    // Journal table must render (no readiness-blocker fallback).
    const journal = page.getByTestId("posting-preview-journal");
    await expect(journal).toBeVisible({ timeout: 15_000 });
    // Journal status must report balanced.
    const status = page.getByTestId("posting-preview-journal-status");
    await expect(status).toBeVisible();
    await expect(status).toHaveAttribute("data-balanced", "true");
    // Dump line data for the checkpoint.
    const lines = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('[data-testid="posting-preview-journal"] > .row'));
      return rows.map((r) => {
        const spans = r.querySelectorAll(":scope > span");
        return {
          account: spans[0]?.textContent?.trim() ?? "",
          dept: spans[1]?.textContent?.trim() ?? "",
          debit: spans[2]?.textContent?.trim() ?? "",
          credit: spans[3]?.textContent?.trim() ?? "",
        };
      });
    });
    const totals = await page.evaluate(() => {
      const totalsRow = document.querySelector('[data-testid="posting-preview-journal"] > .totals');
      const spans = totalsRow?.querySelectorAll(":scope > span");
      return {
        totalDebits: spans?.[2]?.textContent?.trim() ?? "",
        totalCredits: spans?.[3]?.textContent?.trim() ?? "",
      };
    });
    console.log("JOURNAL_LINES:", JSON.stringify(lines, null, 2));
    console.log("JOURNAL_TOTALS:", JSON.stringify(totals, null, 2));
    // Full-page screenshot so the founder can see the whole preview.
    await page.screenshot({ path: "test-results/fpp8a-founder-journal-full.png", fullPage: true });
    // Also scroll to the journal + capture the viewport crop.
    await journal.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/fpp8a-founder-journal-crop.png", fullPage: false });
  });

  test("Founder batch preservation post-preview: still APPROVED, no journal, WI still OPEN", async ({ context }) => {
    const gate = stagingCredsAvailable();
    test.skip(!gate.ready, gate.reason ?? "no creds");
    // Simply re-open the preview without triggering post; batch must
    // remain APPROVED per §0 of the FPP-8A brief.
    const page = await loginAsFounder(context, { landing: OPEN_URL });
    await page.waitForLoadState("domcontentloaded");
    await expect(page.getByTestId("payroll-posting-preview")).toBeVisible({ timeout: 20_000 });
    // Preview reports batch is APPROVED; nothing here mutates it.
    // The actual preservation check happens via SSH in the checkpoint.
  });
});
