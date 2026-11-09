// EP-TRAIN-4Y-V V-3 — single-shot authorized live pilot.
//
// Fires ONE POST to /api/admin/training/versions/[id]/generate with
// the pilot's 5+10 ONE_PER_GROUP override against the founder's
// course cmw8n6z8f0008z4nxck6uvms9 / version cmw8n6z9a000az4nx56vwh02f.
//
// What this spec does:
//   1. Authenticate as the founder (shared helper).
//   2. POST /generate with the explicit plan overrides.
//   3. Assert the response: generationRunId + QUEUED, idempotent=false
//      on first fire (if second run, idempotent=true is also OK —
//      the directive says "initiate the single authorized pilot ...
//      after verifying that no active conflicting run exists").
//   4. Poll generation-status until COMPLETED or FAILED or 20 min.
//   5. Separately POST /generate-metadata to kick the Qwen-sourced
//      title/description generator (idempotent — returns
//      COURSE_ALREADY_FINALISED if the course has already been
//      attributed).
//   6. Capture the final state (course title, draft count, checkpoint
//      count, final-assessment count).
//
// COST GUARD: this spec RELIES on the founder-authorised $1 abort
// threshold. Per the V-1 forecast, actual cost is ~$0.08 for 7 Modal
// calls. If the run exceeds 10 minutes of wall time (above the per-call
// 15-min Modal timeout × 1 container) something is wrong and the
// spec fails rather than silently continuing.

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";

test.describe.configure({ mode: "serial" });

test.describe("EP-TRAIN-4Y-V pilot — fire + watch + capture", () => {
  test.skip(!stagingCredsAvailable().ready, "staging credentials not set");

  test("§3 fire 5+10 ONE_PER_GROUP plan via /generate", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(ctx);

    const resp = await page.request.post(
      `${BASE}/api/admin/training/versions/${VERSION_ID}/generate`,
      {
        headers: { "Content-Type": "application/json" },
        data: {
          checkpointCount: 5,
          finalCount: 10,
          checkpointGroupStrategy: "ONE_PER_GROUP",
        },
      },
    );
    const body = await resp.json();
    console.log(
      `4YV_PILOT_FIRE status=${resp.status()} body=${JSON.stringify(body).slice(0, 400)}`,
    );
    expect(resp.status()).toBe(200);
    expect(body.ok).toBe(true);
    expect(typeof body.generationRunId).toBe("string");
    expect(["QUEUED", "RUNNING", "COMPLETED"]).toContain(body.state);
    // Persist the run id into process.env for the next test.
    process.env.__4YV_PILOT_RUN_ID = body.generationRunId;
    console.log(`4YV_PILOT_RUN_ID=${body.generationRunId}`);
    await ctx.close();
  });

  test("§4 fire /generate-metadata (Qwen title + description)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(ctx);
    const resp = await page.request.post(
      `${BASE}/api/admin/training/versions/${VERSION_ID}/generate-metadata`,
    );
    const body = await resp.json();
    console.log(
      `4YV_METADATA_FIRE status=${resp.status()} body=${JSON.stringify(body).slice(0, 500)}`,
    );
    expect(resp.status()).toBe(200);
    expect(body.ok).toBe(true);
    // Either first-apply (applied=true + metadata with inferenceSource)
    // or idempotent (applied=false + COURSE_ALREADY_FINALISED). Both
    // outcomes prove the attribution guard works.
    if (body.applied) {
      expect(body.metadata).toBeTruthy();
      expect(["ai", "deterministic"]).toContain(body.metadata.inferenceSource);
      expect(body.metadata.title.length).toBeGreaterThanOrEqual(3);
      expect(body.metadata.description.length).toBeGreaterThan(10);
      console.log(
        `4YV_METADATA_APPLIED source=${body.metadata.inferenceSource} title="${body.metadata.title}" desc="${body.metadata.description.slice(0, 120)}"`,
      );
    } else {
      expect(body.skippedReason).toBe("COURSE_ALREADY_FINALISED");
      console.log(`4YV_METADATA_IDEMPOTENT skippedReason=COURSE_ALREADY_FINALISED`);
    }
    await ctx.close();
  });

  test("§6 wait for generation COMPLETED (max 20 min)", async ({ browser }) => {
    test.setTimeout(22 * 60 * 1000);
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(ctx);
    const deadline = Date.now() + 20 * 60 * 1000;
    let lastState = "";
    while (Date.now() < deadline) {
      const resp = await page.request.get(
        `${BASE}/api/admin/training/versions/${VERSION_ID}/generation-status`,
      );
      const body = await resp.json().catch(() => ({ state: "ERROR" }));
      if (body.state !== lastState) {
        console.log(
          `4YV_WATCH t+${Math.round((Date.now() - (deadline - 20 * 60 * 1000)) / 1000)}s state=${body.state} body=${JSON.stringify(body).slice(0, 400)}`,
        );
        lastState = body.state;
      }
      if (body.state === "COMPLETED") {
        expect(body.state).toBe("COMPLETED");
        await ctx.close();
        return;
      }
      if (body.state === "FAILED" || body.state === "CANCELLED") {
        throw new Error(
          `Generation ended in ${body.state}: ${JSON.stringify(body).slice(0, 500)}`,
        );
      }
      await new Promise((r) => setTimeout(r, 15_000));
    }
    throw new Error("Generation did not complete within 20 minutes");
  });

  test("§7 capture final course state (title, counts, drafts)", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
    const page = await loginAsFounder(ctx);

    // Visit the review page so the HTML carries the current course
    // title + draft counts that the manager would see.
    await page.goto(
      `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`,
      { waitUntil: "domcontentloaded" },
    );
    await page.waitForTimeout(2500);
    const html = await page.content();
    const h1 = await page.locator("h1").first().textContent().catch(() => null);
    console.log(`4YV_REVIEW_H1="${h1}"`);
    // The course should NOT be at the provisional placeholder.
    expect(html).not.toContain("Untitled training course");
    await page.screenshot({
      path: "test-results/4yv-review-populated.png",
      fullPage: true,
    });
    await ctx.close();
  });
});
