// EP-TRAIN-4Y-J §7 — resume the live Whisper pilot on staging.
//
// Drives the authentic manager-facing workflow: an authenticated
// founder POSTs /api/admin/training/versions/[id]/transcribe
// against the Silver Springs orientation video. The server hits
// requestTranscription → markQueued → enqueue → the Fly worker
// claims the BackgroundJob → the worker handler invokes Modal
// transcribe v8 → Whisper runs on A10G → segments persisted →
// recordJobCompleted. This spec watches the transcription-status
// endpoint until state === "COMPLETED" or a terminal failure fires.
//
// §9 cost controls: ONE transcription attempt only. If Whisper
// fails we do NOT automatically retry — the spec fails, we STOP.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const VERSION_ID = "cmvzs3w05000456qcgfgps7gy"; // Coulee Ridge · Silver Springs video
const EXPECTED_SHA = "d1ddb823437c78478c5f2388b5daa42c957a8706afcce871bd6a522801efee29";
const POLL_INTERVAL_MS = 15_000;
const MAX_WAIT_MS = 20 * 60_000; // 20 min upper bound; the 642s video needs ~2-5 min
const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

test.describe("EP-TRAIN-4Y-J §7 — live Whisper pilot", () => {
  test.skip(!stagingCredsAvailable().ready, "staging credentials not set");

  test("one transcription completes via Modal v8", async ({ browser }) => {
    test.setTimeout(25 * 60_000); // enough for the whole flow + buffer

    const context = await browser.newContext();
    const page = await loginAsFounder(context);

    // 1. Pre-state check: no active jobs; last job was the 4Y-J recovery FAILED.
    const pre = await page.request.get(
      `${BASE}/api/admin/training/versions/${VERSION_ID}/transcription-status`,
    );
    expect(pre.status(), "pre-state transcription-status must be 200").toBe(200);
    const preBody = await pre.json();
    console.log("PRE_STATUS:", JSON.stringify(preBody));

    // 2. Trigger: manager-facing POST /transcribe.
    const post = await page.request.post(
      `${BASE}/api/admin/training/versions/${VERSION_ID}/transcribe`,
      { data: {} },
    );
    const postBody = await post.json();
    console.log("POST_TRANSCRIBE:", post.status(), JSON.stringify(postBody));
    expect(post.status(), "transcribe POST must succeed").toBe(200);
    expect(postBody.ok).toBe(true);
    expect(postBody.jobId, "jobId returned").toBeTruthy();
    const newJobId: string = postBody.jobId;

    // 3. Poll status until COMPLETED or terminal.
    const started = Date.now();
    let lastSeen: unknown = null;
    let final: { state?: string; [k: string]: unknown } | null = null;
    while (Date.now() - started < MAX_WAIT_MS) {
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
      const s = await page.request.get(
        `${BASE}/api/admin/training/versions/${VERSION_ID}/transcription-status`,
      );
      const body = await s.json();
      if (JSON.stringify(body) !== JSON.stringify(lastSeen)) {
        console.log(`[${new Date().toISOString()}] STATUS:`, JSON.stringify(body));
        lastSeen = body;
      }
      if (body.state === "COMPLETED") {
        final = body;
        break;
      }
      if (body.state === "FAILED" || body.state === "CANCELLED") {
        final = body;
        break;
      }
    }

    expect(final, `transcription did not reach a terminal state within ${MAX_WAIT_MS / 60000} min`).not.toBeNull();
    expect(final?.state, `transcription must COMPLETE on this attempt (v8 fix)`).toBe("COMPLETED");
    expect((final as { transcript?: { transcriberModelName?: string } } | null)?.transcript?.transcriberModelName).toBeTruthy();

    console.log("NEW_JOB_ID:", newJobId);
    console.log("FINAL:", JSON.stringify(final, null, 2));

    await context.close();
  });
});
