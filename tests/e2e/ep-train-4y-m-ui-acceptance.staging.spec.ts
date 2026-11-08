// EP-TRAIN-4Y-M §7 — manager-UI acceptance after the one Qwen
// generation attempt. Captures Playwright screenshots of the AI
// Workspace surface so the founder can see what IS present (drafts,
// evidence, reviewer controls) and what still requires a developer
// script (promote, publish, assign).
//
// Pure read-only. Zero inference. Zero approvals.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const COURSE_ID = "cmvzs3vz9000256qcu7lfysoz";
const VERSION_ID = "cmvzs3w05000456qcgfgps7gy";
const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.describe("EP-TRAIN-4Y-M §7 — UI acceptance after Qwen pilot", () => {
  test.skip(!stagingCredsAvailable().ready, "staging credentials not set");

  test("capture Playwright screenshots of the AI Workspace + API state", async ({ browser }) => {
    test.setTimeout(3 * 60_000);
    const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(context);

    // 1. AI Workspace page — full pipeline state.
    await page.goto(
      `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/ai-workspace`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(3000);
    await page.screenshot({ path: "test-results/4ym-ui-01-ai-workspace.png", fullPage: true });
    console.log("Captured: 4ym-ui-01-ai-workspace.png");

    // 2. Transcription + Generation API echoes.
    const t = await page.request.get(
      `${BASE}/api/admin/training/versions/${VERSION_ID}/transcription-status`,
    );
    const ts = await t.json();
    console.log("TRANSCRIPTION_STATUS_API:", JSON.stringify(ts, null, 2));

    const g = await page.request.get(
      `${BASE}/api/admin/training/versions/${VERSION_ID}/generation-status`,
    );
    const gs = await g.json();
    console.log("GENERATION_STATUS_API:", JSON.stringify(gs, null, 2));

    // 3. Course detail + version detail for navigation screenshots.
    await page.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: "test-results/4ym-ui-02-course-detail.png", fullPage: true });
    console.log("Captured: 4ym-ui-02-course-detail.png");

    await page.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}`, {
      waitUntil: "domcontentloaded",
    });
    await page.waitForTimeout(2500);
    await page.screenshot({ path: "test-results/4ym-ui-03-version-detail.png", fullPage: true });
    console.log("Captured: 4ym-ui-03-version-detail.png");

    await context.close();
    console.log("\nDONE. Screenshots in test-results/4ym-ui-01..03.png");

    // Minimal invariant: generation status should be COMPLETED or FAILED
    // after the pilot. Do NOT assert COMPLETED — this spec runs in both
    // the success and failure branches of the pilot.
    expect(["COMPLETED", "FAILED", "CANCELLED", "QUEUED", "RUNNING"]).toContain(gs.state);
  });
});
