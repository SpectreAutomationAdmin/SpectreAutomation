// EP-TRAIN-4Y-L §5 — manager-UI acceptance after one live Whisper +
// failed Qwen boot. Captures Playwright screenshots of the AI
// Workspace surface so the founder can see, without logging in,
// what IS present (transcript artifacts) and what IS NOT present
// (Qwen drafts, because the Qwen GPU container failed to boot in
// this slice due to an autoawq/transformers version drift).
//
// Pure read-only. Zero inference.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const COURSE_ID = "cmvzs3vz9000256qcu7lfysoz";
const VERSION_ID = "cmvzs3w05000456qcgfgps7gy";
const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.describe("EP-TRAIN-4Y-L §5 — UI acceptance evidence", () => {
  test.skip(!stagingCredsAvailable().ready, "staging credentials not set");

  test("capture Playwright screenshots of the AI Workspace + API state", async ({ browser }) => {
    test.setTimeout(3 * 60_000);
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(context);

    // 1. AI Workspace page
    await page.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/ai-workspace`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: "test-results/4yl-ui-01-ai-workspace.png", fullPage: true });
    console.log("Captured: 4yl-ui-01-ai-workspace.png");

    // 2. Transcription-status API echo (visible JSON evidence).
    const transcribeStatus = await page.request.get(
      `${BASE}/api/admin/training/versions/${VERSION_ID}/transcription-status`,
    );
    const ts = await transcribeStatus.json();
    console.log("TRANSCRIPTION_STATUS_API:", JSON.stringify(ts, null, 2));
    expect(ts.state).toBe("COMPLETED");
    expect(ts.transcript?.buildId).toBeTruthy();

    // 3. Generation-status API echo.
    const genStatus = await page.request.get(
      `${BASE}/api/admin/training/versions/${VERSION_ID}/generation-status`,
    );
    const gs = await genStatus.json();
    console.log("GENERATION_STATUS_API:", JSON.stringify(gs, null, 2));

    // 4. Course-detail page (sidebar context).
    await page.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: "test-results/4yl-ui-02-course-detail.png", fullPage: true });
    console.log("Captured: 4yl-ui-02-course-detail.png");

    // 5. Version detail (where the transcribe + generate buttons live).
    await page.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: "test-results/4yl-ui-03-version-detail.png", fullPage: true });
    console.log("Captured: 4yl-ui-03-version-detail.png");

    await context.close();
    console.log("\nDONE. Screenshots in test-results/4yl-ui-01..03.png");
  });
});
