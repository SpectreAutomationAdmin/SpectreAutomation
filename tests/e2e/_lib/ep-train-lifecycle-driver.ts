// EP-TRAIN-5C-3B (2026-11-02) extracted lifecycle driver — reusable by
// every end-to-end Employee Portal spec that needs to drive the real
// video + checkpoints + final assessment through the browser.
//
// Shared by:
//   tests/e2e/ep-train-5c3b-full-retake-lifecycle.staging.spec.ts
//   tests/e2e/ep-train-5c3c-keep-both-and-revised.staging.spec.ts
//
// The driver DOES NOT fake watch coverage.  playbackRate acceleration
// only compresses wall-clock; the server-side recordVideoProgress +
// seek-cap + monotonic refuse-regress + attempt submission all run
// with real validation.  See the 5C-3B acceptance doc §2 for the
// correctness argument.

import { expect, type Page } from "@playwright/test";
import type { IsolatedFixture } from "./ep-train-3-fixture";

export const BASE =
  process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

/** Expected correct answers for the EP-TRAIN-3 Slice 3 fixture course.
 *  See tests/e2e/_lib/ep-train-3-fixture.ts PROVISION_SCRIPT for the
 *  seeded questions + options. */
export const EXPECTED_ANSWERS = {
  checkpoint1Single: "Orange",
  checkpoint1Multi: ["Hard hat", "Safety goggles"],
  checkpoint1TrueFalse: "True",
  checkpoint2Single: "Your supervisor immediately",
  finalSingle: "Risk assessment",
  finalTrueFalse: "True",
} as const;

export async function portalLogin(page: Page, fixture: IsolatedFixture): Promise<void> {
  await page.goto(`${BASE}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(fixture.email);
  await page.locator('input[name="password"]').fill(fixture.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
}

/** Start playback at `rate` via document.querySelector.  Not a fake —
 *  the native timeupdate event still fires and the server records
 *  real progress.  Rate 4 gives the client-side state machine enough
 *  timeupdate ticks to catch checkpoint triggers reliably; rate 1 is
 *  used by §4 (1× sanity scenario). */
export async function startVideoPlayback(page: Page, rate: number = 4): Promise<void> {
  await page.evaluate((r) => {
    const v = document.querySelector('video[data-testid="portal-course-video"]') as HTMLVideoElement | null;
    if (!v) throw new Error("video element missing");
    v.playbackRate = r;
    void v.play();
  }, rate);
}

async function clickCheckpointOption(page: Page, text: string): Promise<void> {
  const overlay = page.locator('[data-testid="portal-checkpoint-answering"]');
  await overlay.locator("label", { hasText: text }).first().click({ force: true });
}

async function clickFinalOption(page: Page, text: string): Promise<void> {
  const overlay = page.locator('[data-testid="portal-course-quiz-answering"]');
  await overlay.locator("label", { hasText: text }).first().click({ force: true });
}

/** Full training lifecycle driver.  See EP-TRAIN-5C-3B acceptance
 *  doc §3 for why we MUST click portal-checkpoint-resume after each
 *  checkpoint submit — the phase transitions to checkpoint-result
 *  (success overlay), not back to video.  Clicking Resume runs the
 *  real onResumeAfterCheckpoint handler which flips openingCheckpointRef
 *  = null + phase = "video" + video.play(). */
export async function driveFullTrainingLifecycle(
  page: Page,
  opts: { rate?: number } = {},
): Promise<void> {
  const rate = opts.rate ?? 4;
  // 1. Start playback (video is already loaded on the course page).
  await page.waitForSelector('video[data-testid="portal-course-video"]', { state: "attached", timeout: 30_000 });
  await startVideoPlayback(page, rate);

  // 2. Checkpoint 1 overlay at atSecond=15.
  await page.waitForSelector('[data-testid="portal-checkpoint-answering"]', { state: "visible", timeout: 60_000 });
  await clickCheckpointOption(page, EXPECTED_ANSWERS.checkpoint1Single);
  for (const text of EXPECTED_ANSWERS.checkpoint1Multi) {
    await clickCheckpointOption(page, text);
  }
  await clickCheckpointOption(page, EXPECTED_ANSWERS.checkpoint1TrueFalse);
  await page.locator('[data-testid="portal-checkpoint-submit"]').click();
  await page.waitForSelector('[data-testid="portal-checkpoint-result"]', { state: "visible", timeout: 15_000 });
  await page.locator('[data-testid="portal-checkpoint-resume"]').click();

  // 3. Re-arm accelerated rate (onResumeAfterCheckpoint plays at 1×).
  await startVideoPlayback(page, rate);

  // 4. Checkpoint 2 overlay at atSecond=28.
  await page.waitForSelector('[data-testid="portal-checkpoint-answering"]', { state: "visible", timeout: 60_000 });
  await clickCheckpointOption(page, EXPECTED_ANSWERS.checkpoint2Single);
  await page.locator('[data-testid="portal-checkpoint-submit"]').click();
  await page.waitForSelector('[data-testid="portal-checkpoint-result"]', { state: "visible", timeout: 15_000 });
  await page.locator('[data-testid="portal-checkpoint-resume"]').click();

  // 5. Resume + play through to the 90% threshold (~38s).
  await startVideoPlayback(page, rate);

  // 6. Final-assessment unlocks → "Start Knowledge Test" overlay.
  await page.waitForSelector('[data-testid="portal-course-quiz-ready"]', { state: "visible", timeout: 60_000 });
  await page.locator('[data-testid="portal-course-start-attempt"]').click();

  // 7. Submit the final assessment with passing answers.
  await page.waitForSelector('[data-testid="portal-course-quiz-answering"]', { state: "visible", timeout: 15_000 });
  await clickFinalOption(page, EXPECTED_ANSWERS.finalSingle);
  await clickFinalOption(page, EXPECTED_ANSWERS.finalTrueFalse);
  await page.locator('[data-testid="portal-course-submit-attempt"]').click();

  // 8. Grading → passed overlay.
  await page.waitForSelector('[data-testid="portal-course-quiz-passed"]', { state: "visible", timeout: 20_000 });
}

/** Drive only the first checkpoint-to-checkpoint sequence at the given
 *  playback rate.  Returns after CP1 resumes playback.  Used by §4 to
 *  verify timing at 1× without a full ~45-second lifecycle. */
export async function driveFirstCheckpointSequence(
  page: Page,
  opts: { rate?: number } = {},
): Promise<void> {
  const rate = opts.rate ?? 1;
  await page.waitForSelector('video[data-testid="portal-course-video"]', { state: "attached", timeout: 30_000 });
  await startVideoPlayback(page, rate);

  // CP1 at 15s; at 1× rate this is a ~15s wait.
  await page.waitForSelector('[data-testid="portal-checkpoint-answering"]', { state: "visible", timeout: 60_000 });
  await clickCheckpointOption(page, EXPECTED_ANSWERS.checkpoint1Single);
  for (const text of EXPECTED_ANSWERS.checkpoint1Multi) {
    await clickCheckpointOption(page, text);
  }
  await clickCheckpointOption(page, EXPECTED_ANSWERS.checkpoint1TrueFalse);
  await page.locator('[data-testid="portal-checkpoint-submit"]').click();
  await page.waitForSelector('[data-testid="portal-checkpoint-result"]', { state: "visible", timeout: 15_000 });
  await page.locator('[data-testid="portal-checkpoint-resume"]').click();
}

/** Scope a locator to the active (visible) shell to avoid double-match
 *  against portal-desktop-shell + portal-mobile-shell. */
export function activeShell(page: Page) {
  return page.locator('[data-testid="portal-desktop-shell"]');
}

export { expect };
