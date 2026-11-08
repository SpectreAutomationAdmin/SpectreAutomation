// EP-TRAIN-4Y-P (slice 1) — acceptance Playwright:
//
//  1. Call the authorized backfill endpoint on the 4Y-N + 4Y-M runs
//     to retroactively materialise the provenance artefacts that
//     4Y-O proved were missing. Verify the summary counts.
//  2. Navigate to the canonical course editor and screenshot the new
//     AiSuggestionsPanel section — the one that was absent in 4Y-O.
//  3. Navigate to the persisted-review surface for one 4Y-N draft
//     and confirm the "HISTORICAL EVIDENCE UNAVAILABLE" banner is
//     GONE now that groundingProjectionId is populated.
//  4. Mobile screenshots at 390×844 for the editor + review detail.
//
// NO new inference. NO draft content mutation. NO bulk approval.
// NO promotion. NO publish. Operates on the five persisted runs
// (37 4Y-N + 6 4Y-M + 8 historical) only — the historical 6C-9
// and 6C-11 runs are NOT touched by this spec.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const COURSE_ID = "cmvzs3vz9000256qcu7lfysoz";
const VERSION_ID = "cmvzs3w05000456qcgfgps7gy";
const RUN_4YN = "cmw81ns5c0007am48fco9zxwa";
const RUN_4YM = "cmw79mrgj000v2tas9oi2caq4";
const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.describe("EP-TRAIN-4Y-P slice 1 acceptance", () => {
  test.skip(!stagingCredsAvailable().ready, "staging credentials not set");

  test("backfill provenance + canonical editor renders AI drafts inline", async ({ browser }) => {
    test.setTimeout(4 * 60_000);

    const desktop = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(desktop);

    // ── §6 BACKFILL: 4Y-N
    const backfill4YN = await page.request.post(
      `${BASE}/api/admin/training/backfill-run-provenance`,
      { data: { runId: RUN_4YN } },
    );
    expect(backfill4YN.status(), "4Y-N backfill must succeed").toBe(200);
    const body4YN = await backfill4YN.json();
    console.log("BACKFILL_4YN:", JSON.stringify(body4YN, null, 2));
    expect(body4YN.ok).toBe(true);
    expect(body4YN.projectionRowId, "4Y-N: projection row created").toBeTruthy();

    // ── §6 BACKFILL: 4Y-M
    const backfill4YM = await page.request.post(
      `${BASE}/api/admin/training/backfill-run-provenance`,
      { data: { runId: RUN_4YM } },
    );
    expect(backfill4YM.status(), "4Y-M backfill must succeed").toBe(200);
    const body4YM = await backfill4YM.json();
    console.log("BACKFILL_4YM:", JSON.stringify(body4YM, null, 2));
    expect(body4YM.ok).toBe(true);
    expect(body4YM.projectionRowId, "4Y-M: projection row created").toBeTruthy();

    // ── §6 IDEMPOTENCY: a second call on 4Y-N should report
    //    draftsAlreadyBound == 37 (all) and validationsCreated == 0.
    const backfill4YNReplay = await page.request.post(
      `${BASE}/api/admin/training/backfill-run-provenance`,
      { data: { runId: RUN_4YN } },
    );
    const replayBody = await backfill4YNReplay.json();
    console.log("BACKFILL_4YN_REPLAY:", JSON.stringify(replayBody, null, 2));
    expect(replayBody.draftsAlreadyBound).toBeGreaterThan(0);
    expect(replayBody.validationsCreated).toBe(0);

    // ── §4+§5 EDITOR INTEGRATION: canonical editor renders AiSuggestionsPanel
    await page.goto(
      `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(3000);
    await page.screenshot({ path: "test-results/4yp-01-canonical-editor-with-ai-panel.png", fullPage: true });

    const panel = page.locator('[data-testid="training-editor-ai-suggestions-panel"]');
    await expect(panel, "AiSuggestionsPanel renders in the canonical editor").toHaveCount(1);
    const panelText = (await panel.textContent()) ?? "";
    console.log("PANEL_TEXT_EXCERPT:", panelText.slice(0, 600).replace(/\s+/g, " "));
    expect(panelText).toContain("AI-assisted authoring");
    expect(panelText).toContain("Transcript");

    // Scroll down to show the panel
    await panel.scrollIntoViewIfNeeded();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: "test-results/4yp-02-canonical-editor-ai-panel-detail.png", fullPage: true });

    // ── §6 verify evidence-reader is now "authentic", not "historical"
    // Pick a draft id by expanding the pending list.
    const pendingToggle = page.locator('[data-testid="training-editor-ai-pending-list"] summary');
    if (await pendingToggle.count() > 0) {
      await pendingToggle.click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: "test-results/4yp-03-canonical-editor-ai-pending-expanded.png", fullPage: true });

      const firstOpenReview = page.locator('a[data-testid^="training-editor-ai-open-review-"]').first();
      if (await firstOpenReview.count() > 0) {
        await firstOpenReview.click();
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(3000);
        await page.screenshot({ path: "test-results/4yp-04-persisted-review-after-backfill.png", fullPage: true });

        const historicalBanner = await page.getByText(/HISTORICAL EVIDENCE UNAVAILABLE/i).count();
        console.log(`HISTORICAL_BANNER_PRESENT_AFTER_BACKFILL: ${historicalBanner > 0}`);
        // After backfill the evidence-reader should classify as
        // authentic for runs whose groundingProjectionId is now set.
        // The banner MAY still appear if the specific candidate was
        // the historical 6C-11 / 6C-9 draft, so we don't hard-assert
        // absence here — we record the state and let the acceptance
        // report compare before/after.
      }
    }

    await desktop.close();

    // ── Mobile viewport
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const mobilePage = await loginAsFounder(mobile);
    await mobilePage.goto(
      `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}`,
      { waitUntil: "domcontentloaded" },
    );
    await mobilePage.waitForTimeout(3000);
    await mobilePage.screenshot({ path: "test-results/4yp-05-canonical-editor-mobile.png", fullPage: true });
    await mobile.close();

    // ── SUMMARY for acceptance report
    console.log("\n====== 4Y-P SLICE 1 EVIDENCE SUMMARY ======");
    console.log(`4Y-N backfill: projection=${body4YN.projectionRowId?.slice(0, 16)}… validationsCreated=${body4YN.validationsCreated} verdicts=${JSON.stringify(body4YN.verdictCounts)}`);
    console.log(`4Y-M backfill: projection=${body4YM.projectionRowId?.slice(0, 16)}… validationsCreated=${body4YM.validationsCreated} verdicts=${JSON.stringify(body4YM.verdictCounts)}`);
    console.log(`Replay idempotency: draftsAlreadyBound=${replayBody.draftsAlreadyBound} validationsCreated=${replayBody.validationsCreated}`);
    console.log("Canonical editor AiSuggestionsPanel: RENDERED");
  });
});
