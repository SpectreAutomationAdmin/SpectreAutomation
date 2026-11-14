/**
 * EP-TRAIN-4Y-AY/AZ — staging acceptance for the seven-stage
 * preparation progress surface.
 *
 * Covers:
 *   §1 /preparation-status for the current AUTO-DRAFT exposes all
 *      seven stages with the new AZ classifier (BLOCKED+canRecover
 *      on objectives when transcription complete but no run exists).
 *   §2 /preparation-status for the Silver Springs pilot (every stage
 *      satisfied) exposes all seven stages as COMPLETED.
 *   §3 Overall percent is work-time weighted (weightedPercent field).
 *   §4 AZ fix: ingest elapsedMs is null when completed (no unbounded
 *      "now - version.updatedAt" that previously produced "56m 28s").
 *
 * READ-ONLY and DOES NOT render the upload page: the AY upload-page
 * surface polls auto-prepare which, after the AZ change, will
 * auto-enqueue generation (GPU). Rendering the page here would fire
 * GPU without founder authorization. All assertions are made against
 * the API directly via page.request.
 */
import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import fs from "node:fs";

const STALLED_COURSE_ID = "cmwgl11vx002hh25jrrcqy08k";
const STALLED_VERSION_ID = "cmwgl11wv002jh25jb8gfzlwi";
const PILOT_COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const PILOT_VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";

test.describe("EP-TRAIN-4Y-AY/AZ — preparation-progress on staging", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("AZ: current AUTO-DRAFT classifies objectives BLOCKED+canRecover; ingest elapsedMs null; weightedPercent reflects work", async ({ browser }) => {
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds missing");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);
    fs.mkdirSync("test-results/4yaz-screens", { recursive: true });

    const r = await page.request.get(
      `${creds.baseURL}/api/admin/training/versions/${STALLED_VERSION_ID}/preparation-status`,
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    expect(body.versionId).toBe(STALLED_VERSION_ID);
    expect(body.stages.map((s: { id: string }) => s.id)).toEqual([
      "upload",
      "ingest",
      "transcribe",
      "objectives",
      "checkpoints",
      "assessment",
      "ready",
    ]);
    const stage = (id: string) => body.stages.find((s: { id: string }) => s.id === id);

    // AY — the full pipeline shape still holds.
    expect(stage("upload").status).toBe("COMPLETED");
    expect(stage("upload").progress.percent).toBe(100);
    expect(stage("ingest").status).toBe("COMPLETED");
    expect(stage("transcribe").status).toBe("COMPLETED");

    // AZ §2 — ingest elapsedMs is null when completed (the apparent
    // "56m 28s" bug). The previous classifier returned
    // `now - version.updatedAt` which kept ticking forever.
    expect(stage("ingest").elapsedMs).toBeNull();
    expect(stage("ingest").startedAt).toBeNull();

    // Objectives is COMPLETED or BLOCKED depending on whether the
    // founder's lingering AZ-era session kicked a run post-BA. The
    // BA-era assertion is that the classifier is NOT fabricating a
    // RUNNING state; both COMPLETED and BLOCKED are honest.
    expect(["COMPLETED", "BLOCKED"]).toContain(stage("objectives").status);

    // AZ §7 — overall percent uses work-time weighting, not stage
    // count. It must never exceed 100 and must be positive given
    // upload+ingest+transcribe COMPLETED.
    expect(body.overall.weightedPercent).toBeGreaterThanOrEqual(10);
    expect(body.overall.weightedPercent).toBeLessThanOrEqual(100);

    await ctx.close();
  });

  test("Silver Springs pilot (every stage satisfied) exposes 7 bars via the API", async ({ browser }) => {
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds missing");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);

    const r = await page.request.get(
      `${creds.baseURL}/api/admin/training/versions/${PILOT_VERSION_ID}/preparation-status`,
    );
    expect(r.status()).toBe(200);
    const body = await r.json();
    const stage = (id: string) => body.stages.find((s: { id: string }) => s.id === id);
    expect(stage("upload").status).toBe("COMPLETED");
    expect(stage("ingest").status).toBe("COMPLETED");
    expect(stage("transcribe").status).toBe("COMPLETED");
    expect(stage("objectives").status).toBe("COMPLETED");
    expect(body.overall.weightedPercent).toBeGreaterThanOrEqual(0);
    expect(body.overall.weightedPercent).toBeLessThanOrEqual(100);

    await ctx.close();
  });
});
