// EP-TRAIN-4Y-L §4 — conditional live Qwen generation pilot.
//
// PRECONDITION (§4 of directive): §3 Whisper transcription COMPLETED.
// This spec drives the authenticated manager-facing POST to
// /api/admin/training/versions/[id]/generate, waits for the
// TrainingQuestionAiGenerationRun to transition COMPLETED, and
// returns the generationRunId + draft count for §5 UI acceptance
// and §6 quality assessment to work from.
//
// ONE invocation only. No retry. Per directive §7, if generation
// FAILS, the spec fails and we STOP — no further inference.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const VERSION_ID = "cmvzs3w05000456qcgfgps7gy";
const POLL_INTERVAL_MS = 15_000;
const MAX_WAIT_MS = 15 * 60_000;
const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.describe("EP-TRAIN-4Y-L §4 — live Qwen generation pilot", () => {
  test.skip(!stagingCredsAvailable().ready, "staging credentials not set");

  test("one Qwen generation COMPLETES against the just-produced transcript", async ({ browser }) => {
    test.setTimeout(20 * 60_000);
    const context = await browser.newContext();
    const page = await loginAsFounder(context);

    // Trigger generation. The server resolves the LATEST transcript
    // build for the version's video automatically.
    const post = await page.request.post(
      `${BASE}/api/admin/training/versions/${VERSION_ID}/generate`,
      { data: {} },
    );
    const postBody = await post.json();
    console.log("POST_GENERATE:", post.status(), JSON.stringify(postBody));
    expect(post.status(), "generate POST must succeed").toBe(200);
    expect(postBody.ok).toBe(true);
    expect(postBody.generationRunId, "generationRunId returned").toBeTruthy();
    const runId: string = postBody.generationRunId;

    // Poll generation-status until COMPLETED or terminal.
    const started = Date.now();
    let lastSeen = "";
    let final: Record<string, unknown> | null = null;
    while (Date.now() - started < MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      const s = await page.request.get(
        `${BASE}/api/admin/training/versions/${VERSION_ID}/generation-status`,
      );
      const body = await s.json();
      const snapshot = JSON.stringify(body);
      if (snapshot !== lastSeen) {
        console.log(`[${new Date().toISOString()}] STATUS:`, snapshot);
        lastSeen = snapshot;
      }
      const state = (body as { state?: string }).state;
      if (state === "COMPLETED" || state === "FAILED" || state === "CANCELLED") {
        final = body as Record<string, unknown>;
        break;
      }
    }

    expect(final, `generation did not reach a terminal state within ${MAX_WAIT_MS / 60000} min`).not.toBeNull();
    console.log("FINAL:", JSON.stringify(final, null, 2));
    console.log("RUN_ID:", runId);

    expect(final?.state, `generation must COMPLETE on this attempt`).toBe("COMPLETED");

    await context.close();
  });
});
