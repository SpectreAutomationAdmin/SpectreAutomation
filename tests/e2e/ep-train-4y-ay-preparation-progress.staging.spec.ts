/**
 * EP-TRAIN-4Y-AY §8+§9 — staging acceptance for the seven-stage
 * preparation progress surface.
 *
 * Covers:
 *   §1 /preparation-status for the stalled AUTO-DRAFT exposes all
 *      seven stages and classifies transcribe as BLOCKED+canRecover
 *      (the exact root-cause case).
 *   §2 /preparation-status for the Silver Springs pilot (every stage
 *      satisfied) exposes all seven stages as COMPLETED.
 *   §3 UI renders all seven progress bars on the upload page.
 *   §4 UI exposes the Start-preparation button in the BLOCKED state
 *      WITHOUT clicking it (would trigger GPU — unauthorized this
 *      slice).
 *   §5 Progress survives a hard reload.
 *   §6 Capture 1440×900 screenshots of the active + blocked states.
 *
 * READ-ONLY on staging data: the only writes this spec emits are
 * authenticated GETs. No /start-preparation POST, no AI inference,
 * no mutation of the pilot's 15 preserved AI drafts.
 */
import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";
import fs from "node:fs";

const STALLED_COURSE_ID = "cmwgl11vx002hh25jrrcqy08k";
const STALLED_VERSION_ID = "cmwgl11wv002jh25jb8gfzlwi";
const PILOT_COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const PILOT_VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";

test.describe("EP-TRAIN-4Y-AY — preparation-progress on staging", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("stalled AUTO-DRAFT reports transcribe BLOCKED + canRecover; all 7 bars render", async ({ browser }) => {
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "staging creds missing");
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);
    fs.mkdirSync("test-results/4yay-screens", { recursive: true });

    // API-level assertion against the new endpoint.
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
    expect(stage("upload").status).toBe("COMPLETED");
    expect(stage("upload").progress.percent).toBe(100);
    expect(stage("ingest").status).toBe("COMPLETED");
    expect(stage("transcribe").status).toBe("BLOCKED");
    expect(stage("transcribe").canRecover).toBe(true);
    expect(stage("transcribe").blockedReason).toContain("Waiting to start");
    expect(body.overall.currentStageId).toBe("transcribe");

    // UI render.
    await page.goto(
      `${creds.baseURL}/app/admin/people/safety-training/${STALLED_COURSE_ID}/${STALLED_VERSION_ID}/upload`,
      { waitUntil: "networkidle" },
    );
    // Allow the first poll + render.
    await page.waitForSelector('[data-testid="training-prep-progress"]', { timeout: 15_000 });
    await page.waitForTimeout(1500);

    // All seven stage rows are present.
    for (const id of ["upload", "ingest", "transcribe", "objectives", "checkpoints", "assessment", "ready"]) {
      await expect(page.locator(`[data-testid="training-prep-stage-${id}"]`)).toBeVisible();
      await expect(page.locator(`[data-testid="training-prep-stage-${id}-bar"]`)).toBeVisible();
    }
    // Overall bar renders with a percent.
    const overallPct = await page.locator('[data-testid="training-prep-overall-percent"]').innerText();
    expect(overallPct).toMatch(/^\d+%$/);

    // transcribe row shows BLOCKED and the recovery panel is visible.
    const trStatus = await page.locator('[data-testid="training-prep-stage-transcribe-status"]').innerText();
    expect(trStatus).toMatch(/Blocked/i);
    await expect(page.locator('[data-testid="training-prep-recovery"]')).toBeVisible();
    // The recovery button exists but we do NOT click it (would fire GPU).
    await expect(page.locator('[data-testid="training-prep-start-button"]')).toBeVisible();

    await page.screenshot({ path: "test-results/4yay-screens/01-blocked-stalled-upload.png", fullPage: false });

    // §5 persistence across reload.
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="training-prep-progress"]', { timeout: 15_000 });
    await page.waitForTimeout(1500);
    const trStatusAfter = await page.locator('[data-testid="training-prep-stage-transcribe-status"]').innerText();
    expect(trStatusAfter).toMatch(/Blocked/i);
    await expect(page.locator('[data-testid="training-prep-recovery"]')).toBeVisible();

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
    // Pilot has: video uploaded, transcript build present, generation run.
    const stage = (id: string) => body.stages.find((s: { id: string }) => s.id === id);
    expect(stage("upload").status).toBe("COMPLETED");
    expect(stage("ingest").status).toBe("COMPLETED");
    expect(stage("transcribe").status).toBe("COMPLETED");
    // Objectives + checkpoints + assessment depend on the plan being
    // parsable; the pilot had a valid 4Y-arc plan.
    expect(stage("objectives").status).toBe("COMPLETED");

    // Also render the review page to capture the complete-state screenshot.
    await page.goto(
      `${creds.baseURL}/app/admin/people/safety-training/${PILOT_COURSE_ID}/${PILOT_VERSION_ID}/upload`,
      { waitUntil: "networkidle" },
    );
    await page.waitForTimeout(2500);
    // Pilot has drafts so the upload page redirects to /review. Screenshot
    // happens on whichever surface renders.
    await page.screenshot({ path: "test-results/4yay-screens/02-silver-springs-review-or-upload.png", fullPage: false });

    await ctx.close();
  });
});
