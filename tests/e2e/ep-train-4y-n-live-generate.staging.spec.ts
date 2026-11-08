// EP-TRAIN-4Y-N §7 — one controlled live Qwen validation run.
//
// After offline validation (tests/ep-train-4y-n-context-generation.test.ts)
// passed, authorize ONE new generation run against the existing
// Silver Springs transcript via the normal manager-facing endpoint
// (POST /api/admin/training/versions/[id]/generate).
//
// The 4Y-N worker-handler changes + the plan's new
// `generationPromptContract: "ctx-v1"` marker together produce a
// different planIdentity, so requestGeneration creates a NEW run
// id — the six 4Y-M drafts bound to cmw79mrgj000v2tas9oi2caq4 are
// NOT touched.
//
// ONE invocation. No retry. Per directive §7, if generation fails
// the spec fails and we STOP — no further inference.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const VERSION_ID = "cmvzs3w05000456qcgfgps7gy";
const EXISTING_4YM_RUN_ID = "cmw79mrgj000v2tas9oi2caq4";
const POLL_INTERVAL_MS = 15_000;
const MAX_WAIT_MS = 20 * 60_000;
const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.describe("EP-TRAIN-4Y-N §7 — live Qwen validation pilot", () => {
  test.skip(!stagingCredsAvailable().ready, "staging credentials not set");

  test("one ctx-v1 generation run completes with a NEW run id", async ({ browser }) => {
    test.setTimeout(25 * 60_000);
    const context = await browser.newContext();
    const page = await loginAsFounder(context);

    // Trigger generation. The route builds a new plan via the topic-
    // aware placement builder, stamps generationPromptContract="ctx-v1",
    // and requestGeneration creates a fresh run id (the 4Y-M run
    // cmw79mrgj has the OLD plan hash so it no longer collides).
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
    // CRITICAL: must be a NEW run id — the 4Y-M run's drafts must
    // NOT be mutated or overwritten.
    expect(runId, "4Y-N must create a NEW generation run id, not reuse the 4Y-M run").not.toBe(EXISTING_4YM_RUN_ID);
    console.log("NEW_RUN_ID:", runId);

    // Poll generation-status until terminal.
    const started = Date.now();
    let lastSeen = "";
    let final: Record<string, unknown> | null = null;
    while (Date.now() - started < MAX_WAIT_MS) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
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
    console.log("NEW_RUN_ID:", runId);
    expect(final?.state, "generation must COMPLETE").toBe("COMPLETED");

    await context.close();
  });
});
