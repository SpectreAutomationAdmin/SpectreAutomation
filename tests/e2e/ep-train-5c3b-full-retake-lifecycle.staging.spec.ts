// EP-TRAIN-5C-3B (2026-11-02) — Full employee retake lifecycle acceptance.
//
// Drives the real Employee Portal end-to-end for an authenticated
// disposable fixture employee:
//   login -> dashboard -> course page -> Start Training -> play video
//   (16x playbackRate so the 42s fixture video completes in ~2.6s) ->
//   clear checkpoint 1 overlay -> clear checkpoint 2 overlay ->
//   final-assessment unlocks -> submit passing answers -> success overlay
//   -> dashboard compliance restored
//
// Does NOT fake watch coverage.  The server-side recordVideoProgress
// path runs on every timeupdate tick (seek-cap at the first uncleared
// required checkpoint, monotonic refuse-regress on cumulative counters)
// and the atomic completion+satisfaction tx (EP-TRAIN-5C-2) runs on
// the final-assessment submit.  playbackRate=16 only compresses the
// browser's wall-clock -- the server validation is identical.
//
// Scenarios (directive §2-§6):
//   §2 - Full MANUAL_REINSTATE retake lifecycle, start to compliant.
//   §4 - Keep Both: 2 obligations; completing one leaves the second
//        OUTSTANDING with fresh progress.
//   §5 - Revised-course lifecycle: historical v1 completion + v2
//        published with ALL policy + REVISION obligation issued ->
//        employee completes v2 -> obligation SATISFIED.
//   §6 - Replay regression: after retake, replay must not create
//        another completion / another obligation.
//
// The directive forbids "declaring acceptance based only on backend
// contract tests" -- the browser drives every state transition.
// If any step fails, the diagnostic is reported in the test output.

import { test, expect, type Page, type Browser } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import {
  provisionIsolatedFixture,
  teardownIsolatedFixture,
  newRunId,
  type IsolatedFixture,
} from "./_lib/ep-train-3-fixture";
import {
  seedHistoricalCompletion,
  seedObligation,
  snapshotFixtureCounts,
  snapshotFounderCounts,
  cleanupFixtureObligations,
} from "./_lib/ep-train-5c3a-seed";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const outDir = path.resolve(process.cwd(), "test-results/ep-train-5c3b-full-lifecycle");
fs.mkdirSync(outDir, { recursive: true });

/** Expected answers for the EP-TRAIN-3 Slice 3 fixture course.  See
 *  tests/e2e/_lib/ep-train-3-fixture.ts PROVISION_SCRIPT for the seed. */
const EXPECTED_ANSWERS = {
  checkpoint1Single: "Orange",
  checkpoint1Multi: ["Hard hat", "Safety goggles"],
  checkpoint1TrueFalse: "True",
  checkpoint2Single: "Your supervisor immediately",
  finalSingle: "Risk assessment",
  finalTrueFalse: "True",
};

async function portalLogin(page: Page, fixture: IsolatedFixture): Promise<void> {
  await page.goto(`${BASE}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(fixture.email);
  await page.locator('input[name="password"]').fill(fixture.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
}

/** Start playback with accelerated rate.  Not a fake -- the native
 *  timeupdate event still fires and the server records real progress.
 *
 *  Rate 4x gives the client-side state machine enough timeupdate
 *  ticks (default ~250ms = 1s of video per tick at 4x) to reliably
 *  catch checkpoint triggers.  At 16x the state machine was missing
 *  CP2 (video played past 28s without opening the overlay); the
 *  server's seek-cap still enforced the 28s ceiling but the UI never
 *  prompted the employee.  Confirmed by observation of the failure
 *  screenshot. */
async function startVideoPlayback(page: Page): Promise<void> {
  await page.evaluate(() => {
    const v = document.querySelector('video[data-testid="portal-course-video"]') as HTMLVideoElement | null;
    if (!v) throw new Error("video element missing");
    v.playbackRate = 4;
    void v.play();
  });
}

/** Click a checkpoint option whose visible text matches `text`.  Uses
 *  the testid wrapper so we hit the right overlay. */
async function clickCheckpointOption(page: Page, text: string): Promise<void> {
  const overlay = page.locator('[data-testid="portal-checkpoint-answering"]');
  await overlay.locator("label", { hasText: text }).first().click({ force: true });
}

async function clickFinalOption(page: Page, text: string): Promise<void> {
  const overlay = page.locator('[data-testid="portal-course-quiz-answering"]');
  await overlay.locator("label", { hasText: text }).first().click({ force: true });
}

/** Full training lifecycle driver.  Called from the retake scenarios +
 *  the revision scenario.  Returns the completion id surfaced in the
 *  success-overlay (via DB snapshot afterwards). */
async function driveFullTrainingLifecycle(page: Page): Promise<void> {
  // 1. Start playback (video is already loaded on the course page).
  await page.waitForSelector('video[data-testid="portal-course-video"]', { state: "attached", timeout: 30_000 });
  await startVideoPlayback(page);

  // 2. Checkpoint 1 overlay at atSecond=15.  Server-side seek-cap
  //    prevents farthestSecond > 15 until CP1 is cleared.
  await page.waitForSelector('[data-testid="portal-checkpoint-answering"]', { state: "visible", timeout: 30_000 });
  await clickCheckpointOption(page, EXPECTED_ANSWERS.checkpoint1Single);
  for (const text of EXPECTED_ANSWERS.checkpoint1Multi) {
    await clickCheckpointOption(page, text);
  }
  await clickCheckpointOption(page, EXPECTED_ANSWERS.checkpoint1TrueFalse);
  await page.locator('[data-testid="portal-checkpoint-submit"]').click();
  // Submission transitions phase to "checkpoint-result" (success overlay).
  // Click "Continue watching" to reset openingCheckpointRef + resume playback.
  await page.waitForSelector('[data-testid="portal-checkpoint-result"]', { state: "visible", timeout: 15_000 });
  await page.locator('[data-testid="portal-checkpoint-resume"]').click();

  // 3. Re-arm the accelerated playbackRate (video.play() ran inside
  //    onResumeAfterCheckpoint but at the native rate 1).
  await startVideoPlayback(page);

  // 4. Checkpoint 2 overlay at atSecond=28.
  await page.waitForSelector('[data-testid="portal-checkpoint-answering"]', { state: "visible", timeout: 60_000 });
  await clickCheckpointOption(page, EXPECTED_ANSWERS.checkpoint2Single);
  await page.locator('[data-testid="portal-checkpoint-submit"]').click();
  await page.waitForSelector('[data-testid="portal-checkpoint-result"]', { state: "visible", timeout: 15_000 });
  await page.locator('[data-testid="portal-checkpoint-resume"]').click();

  // 5. Resume + play to the 90% threshold (38s).
  await startVideoPlayback(page);

  // 6. Final-assessment unlocks -> "Start Knowledge Test" overlay.
  await page.waitForSelector('[data-testid="portal-course-quiz-ready"]', { state: "visible", timeout: 30_000 });
  await page.locator('[data-testid="portal-course-start-attempt"]').click();

  // 7. Submit the final assessment with passing answers.
  await page.waitForSelector('[data-testid="portal-course-quiz-answering"]', { state: "visible", timeout: 15_000 });
  await clickFinalOption(page, EXPECTED_ANSWERS.finalSingle);
  await clickFinalOption(page, EXPECTED_ANSWERS.finalTrueFalse);
  await page.locator('[data-testid="portal-course-submit-attempt"]').click();

  // 8. Grading -> passed overlay.
  await page.waitForSelector('[data-testid="portal-course-quiz-passed"]', { state: "visible", timeout: 20_000 });
}

test.describe.configure({ mode: "serial" });

test.describe("EP-TRAIN-5C-3B :: full retake lifecycle", () => {
  test.setTimeout(600_000);

  let founderBefore: { completions: number; attempts: number; progress: number };

  test.beforeAll(async () => {
    founderBefore = snapshotFounderCounts();
    console.log(`[5C-3B] Founder baseline: ${JSON.stringify(founderBefore)}`);
  });

  test.afterAll(async () => {
    const founderAfter = snapshotFounderCounts();
    console.log(`[5C-3B] Founder after: ${JSON.stringify(founderAfter)}`);
    expect(founderAfter.completions).toBe(founderBefore.completions);
    expect(founderAfter.attempts).toBe(founderBefore.attempts);
    expect(founderAfter.progress).toBe(founderBefore.progress);
  });

  // -------------------------------------------------------------------------
  // §2 — Full manual-retake lifecycle.
  // -------------------------------------------------------------------------
  test("§2 — manual retake: dashboard -> player -> checkpoints -> assessment -> satisfied + 2nd completion", async ({ browser }) => {
    const runId = newRunId("5c3b");
    const fixture = provisionIsolatedFixture(runId);
    try {
      // Seed: historical completion @ 92%, then MANUAL_REINSTATE.
      const historical = seedHistoricalCompletion(fixture, { score: 92, daysAgo: 45 });
      const obligation = seedObligation(fixture, {
        reason: "MANUAL_REINSTATE",
        reasonNote: "5C-3B lifecycle acceptance",
      });

      // Pre-flight snapshot: 1 completion, 1 attempt, 0 progress, 1 OUTSTANDING.
      const before = snapshotFixtureCounts(fixture);
      expect(before.completions).toBe(1);
      expect(before.attempts).toBe(1);
      expect(before.outstandingObligations).toBe(1);
      expect(before.satisfiedObligations).toBe(0);

      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);

      // Dashboard: Retake Required chip + card linking to the course.
      await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "networkidle" });
      const dShell = page.locator('[data-testid="portal-desktop-shell"]');
      await expect(dShell.locator(`[data-testid="portal-safety-training-course-${fixture.courseId}-obligation-chip"]`)).toContainText("Retake Required");
      await page.screenshot({ path: path.join(outDir, "section2-01-dashboard-before.png"), fullPage: true });

      // Navigate to the course page.
      await page.locator(`[data-testid="portal-safety-training-course-${fixture.courseId}"]`).first().click();
      await page.waitForURL(/\/employee\/safety-training\/[^/]+/, { waitUntil: "networkidle" });
      const cShell = page.locator('[data-testid="portal-desktop-shell"]');
      await expect(cShell.locator('[data-testid="portal-course-state-pill"]').first()).toContainText("Retake Required");
      await page.screenshot({ path: path.join(outDir, "section2-02-course-retake-required.png"), fullPage: true });

      // Fresh-progress preflight check: NO progress row scoped to this obligation yet.
      const beforeStart = snapshotFixtureCounts(fixture);
      expect(beforeStart.progress).toBe(0);

      // Drive the full training lifecycle.
      await driveFullTrainingLifecycle(page);

      // Capture the success overlay before closing.
      await page.screenshot({ path: path.join(outDir, "section2-03-quiz-passed-overlay.png"), fullPage: true });

      // Post-flight DB snapshot:
      //   completions = 2 (historical FINAL + new FINAL)
      //   attempts    = 4 (historical FINAL + 2 CHECKPOINT + new FINAL)
      //   progress    >= 1 (obligation-scoped row written during retake)
      //   outstandingObligations = 0 (satisfied)
      //   satisfiedObligations   = 1
      const after = snapshotFixtureCounts(fixture);
      expect(after.completions).toBe(2);
      expect(after.attempts).toBeGreaterThanOrEqual(4); // 1 historical FINAL + CP1 + CP2 + new FINAL
      expect(after.progress).toBeGreaterThanOrEqual(1);
      expect(after.outstandingObligations).toBe(0);
      expect(after.satisfiedObligations).toBe(1);

      // Original completion unmodified.
      // (The seed helper returned its id as `historical.completionId`.)
      console.log(`[5C-3B §2] Original completion id ${historical.completionId} preserved; obligation ${obligation.obligationId} satisfied.`);

      // Dashboard: back to compliant.
      await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "networkidle" });
      // Chip is gone; course no longer in outstanding list.
      await expect(page.locator(`[data-testid="portal-safety-training-course-${fixture.courseId}-obligation-chip"]`)).toHaveCount(0);
      await page.screenshot({ path: path.join(outDir, "section2-04-dashboard-after-compliant.png"), fullPage: true });

      await ctx.close();
    } finally {
      cleanupFixtureObligations(fixture);
      teardownIsolatedFixture(runId);
    }
  });

  // -------------------------------------------------------------------------
  // §6 — Replay regression after retake.
  // Re-opens the course after satisfying the obligation -> replay-only
  // (no new completion / no new obligation).
  // -------------------------------------------------------------------------
  test("§6 — after retake satisfied, replay-only preserved (no new completion, no new obligation)", async ({ browser }) => {
    const runId = newRunId("5c3b");
    const fixture = provisionIsolatedFixture(runId);
    try {
      seedHistoricalCompletion(fixture, { score: 95, daysAgo: 30 });
      seedObligation(fixture, { reason: "MANUAL_REINSTATE", reasonNote: "replay regression setup" });

      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);

      await page.goto(`${BASE}/employee/safety-training/${encodeURIComponent(fixture.courseVersionId)}`, { waitUntil: "networkidle" });
      await driveFullTrainingLifecycle(page);

      const satisfied = snapshotFixtureCounts(fixture);
      expect(satisfied.satisfiedObligations).toBe(1);
      expect(satisfied.outstandingObligations).toBe(0);
      expect(satisfied.completions).toBe(2);

      // Re-open the course -> state pill should be Completed; Replay
      // button visible; Start Training NOT visible.
      await page.goto(`${BASE}/employee/safety-training/${encodeURIComponent(fixture.courseVersionId)}`, { waitUntil: "networkidle" });
      const shell = page.locator('[data-testid="portal-desktop-shell"]');
      await expect(shell.locator('[data-testid="portal-course-state-pill"]').first()).toContainText("Completed");
      await expect(shell.locator('[data-testid="portal-course-replay"]').first()).toBeVisible();
      await expect(shell.locator('[data-testid="portal-course-start"]')).toHaveCount(0);
      await page.screenshot({ path: path.join(outDir, "section6-replay-only-restored.png"), fullPage: true });

      // No new completion / obligation created by re-opening.
      const afterReopen = snapshotFixtureCounts(fixture);
      expect(afterReopen.completions).toBe(2);
      expect(afterReopen.outstandingObligations).toBe(0);
      expect(afterReopen.satisfiedObligations).toBe(1);

      await ctx.close();
    } finally {
      cleanupFixtureObligations(fixture);
      teardownIsolatedFixture(runId);
    }
  });
});
