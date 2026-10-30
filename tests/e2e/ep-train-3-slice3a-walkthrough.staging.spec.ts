// EP-TRAIN-3 Slice 3A (2026-10-30) -- full 12-scenario authenticated
// employee walkthrough.
//
// Timing calibration: the shared WSO v2 video (reused as the disposable
// SLICE3_TEST course video) is NOT MP4 fast-start (moov atom lives at
// the END of a 47 MB file).  Chrome has to download the full file to
// decode, measured at 15-25 seconds cold.  Timeouts are set to 60s on
// video readiness waits to accommodate this; a dedicated fast-start-
// upload fix is scoped as a separate follow-up.
//
// All scenarios reset state via SSH beforeEach so cross-test
// contamination doesn't make tests order-sensitive.

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";

const outDir = path.resolve(process.cwd(), "test-results/ep-train-3-slice3a");
const BASE = "https://staging.spectreautomation.com";
const VIDEO_READY_TIMEOUT_MS = 60_000;

function loadEnv() {
  const envPath = path.resolve(process.cwd(), ".env.playwright.local");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("="); if (eq <= 0) continue;
      const k = t.slice(0, eq); const v = t.slice(eq + 1);
      if (!(k in process.env)) process.env[k] = v;
    }
  }
}
loadEnv();

const RESET_SCRIPT = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const run = async () => {
  const emp = await p.employee.findFirst({ where: { employeeNumber: "E-SLICE3-TEST" } });
  const course = await p.trainingCourse.findFirst({ where: { code: "SLICE3_TEST" }, include: { versions: { select: { id: true } } } });
  if (!emp || !course) return;
  const vids = course.versions.map((v) => v.id);
  await p.trainingQuestionResponse.deleteMany({ where: { attempt: { employeeId: emp.id, courseVersionId: { in: vids } } } });
  await p.trainingAttempt.deleteMany({ where: { employeeId: emp.id, courseVersionId: { in: vids } } });
  await p.trainingProgress.deleteMany({ where: { employeeId: emp.id, courseVersionId: { in: vids } } });
  await p.trainingCompletion.deleteMany({ where: { employeeId: emp.id, courseVersionId: { in: vids } } });
  await p.$disconnect();
};
run().catch((e) => { console.error("ERR", e); process.exit(1); });
`;

function resetState() {
  const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";
  const b64 = Buffer.from(RESET_SCRIPT).toString("base64");
  try {
    const out = execSync(
      `"${flyctl}" ssh console --app spectre-staging -C "/bin/sh -c 'echo ${b64} | base64 -d > /tmp/r.mjs && cd /app && node /tmp/r.mjs && rm /tmp/r.mjs'"`,
      { encoding: "utf8", timeout: 120_000 },
    );
    // eslint-disable-next-line no-console
    console.log("[resetState]", (out || "").trim().slice(-200));
  } catch (e: any) {
    // eslint-disable-next-line no-console
    console.log("[resetState] FAILED:", e.message?.slice(0, 300) ?? String(e).slice(0, 300));
    throw e;  // fail loudly - stale state causes downstream flakes
  }
}

async function loginPortal(page: Page): Promise<void> {
  const email = process.env.SPECTRE_STAGING_PORTAL_EMAIL!;
  const password = process.env.SPECTRE_STAGING_PORTAL_PASSWORD!;
  await page.goto(`${BASE}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
}

async function openSliceCourse(page: Page): Promise<void> {
  await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });
  // Match the canonical course-card testid pattern + visible filter.
  // Both desktop + mobile shells render identical markup; `:visible`
  // picks the active shell's instance per the current viewport.
  const link = page
    .locator('[data-testid^="portal-safety-training-course-"]')
    .filter({ hasText: "Slice 3 Interactive Playback" })
    .locator('visible=true')
    .first();
  // Fallback: if `:visible` CSS selector isn't supported in this
  // Playwright version, grab the first matching card + rely on it
  // being the visible one. The desktop shell is always first in DOM.
  const final = (await link.count()) > 0
    ? link
    : page
        .locator('[data-testid^="portal-safety-training-course-"]')
        .filter({ hasText: "Slice 3 Interactive Playback" })
        .first();
  await expect(final).toBeVisible({ timeout: 15_000 });
  await Promise.all([
    page.waitForURL(/\/employee\/safety-training\/[^/]+/, { timeout: 15_000 }),
    final.click(),
  ]);
}

async function waitForVideoPlayable(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
      return videos.some((v) => v.readyState >= 2 && Number.isFinite(v.duration) && v.duration > 0);
    },
    undefined,
    { timeout: VIDEO_READY_TIMEOUT_MS },
  );
}

async function playUntilCheckpoint(page: Page, atSecond: number): Promise<void> {
  await waitForVideoPlayable(page);
  // Nudge ONLY the visible video.
  await page.evaluate(async ({ t }) => {
    const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
    const v = videos.find((el) => el.offsetParent !== null);
    if (!v) return;
    v.muted = true;
    v.currentTime = t;
    try { await v.play(); } catch { /* ignore */ }
  }, { t: atSecond });
  await expect(page.locator('[data-testid="portal-checkpoint-overlay"]:visible').first()).toBeVisible({ timeout: 30_000 });
}

/** Play the video naturally (no seek) at the given rate from its
 *  current position, waiting until a checkpoint overlay opens. Used by
 *  §10-14 which needs real secondsWatched accumulation to satisfy the
 *  90% threshold. */
async function playNaturallyUntilCheckpoint(page: Page, playbackRate = 2): Promise<void> {
  await waitForVideoPlayable(page);
  await page.evaluate(async ({ rate }) => {
    const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
    const v = videos.find((el) => el.offsetParent !== null);
    if (!v) return;
    v.muted = true;
    v.playbackRate = rate;
    try { await v.play(); } catch { /* ignore */ }
  }, { rate: playbackRate });
  await expect(page.locator('[data-testid="portal-checkpoint-overlay"]:visible').first()).toBeVisible({ timeout: 60_000 });
}

async function answerCheckpoint1(page: Page, correct: boolean): Promise<void> {
  const panel = page.getByTestId("portal-checkpoint-answering").first();
  await expect(panel).toBeVisible();
  await expect
    .poll(async () => panel.locator('input:checked').count(), { timeout: 5000 })
    .toBe(0);
  // Click the native input directly (not the label span). Playwright
  // .check() dispatches a click to the input element itself, which:
  //   (a) fires the input's native onChange — React setState via
  //       the input's own `onChange={toggleOption}` prop; AND
  //   (b) bubbles up to the parent <label> where my onClick handler
  //       sees e.target.tagName === "INPUT" and no-ops.
  // So state updates once, via the input's own onChange.
  if (correct) {
    await panel.getByRole("radio", { name: "Orange", exact: true }).check();
    await panel.getByRole("checkbox", { name: "Hard hat", exact: true }).check();
    await panel.getByRole("checkbox", { name: "Safety goggles", exact: true }).check();
    await panel.getByRole("radio", { name: "True", exact: true }).check();
  } else {
    await panel.getByRole("radio", { name: "Green", exact: true }).check();
    await panel.getByRole("checkbox", { name: "Business suit", exact: true }).check();
    await panel.getByRole("radio", { name: "False", exact: true }).check();
  }
  const expectedChecked = correct ? 4 : 3;
  await expect
    .poll(async () => await panel.locator('input:checked').count(), { timeout: 10_000 })
    .toBe(expectedChecked);
  await page.getByTestId("portal-checkpoint-submit").first().click();
}

async function answerCheckpoint2(page: Page, correct: boolean): Promise<void> {
  const panel = page.getByTestId("portal-checkpoint-answering").first();
  await expect(panel).toBeVisible();
  const name = correct ? "Your supervisor immediately" : "Nobody";
  await panel.getByText(name, { exact: true }).first().click();
  await expect(panel.getByRole("radio", { name, exact: true })).toBeChecked();
  await page.getByTestId("portal-checkpoint-submit").first().click();
}

test.describe("EP-TRAIN-3 Slice 3A :: full 12-scenario employee walkthrough", () => {
  test.beforeAll(() => {
    if (!process.env.SPECTRE_STAGING_PORTAL_EMAIL) test.skip(true, "no portal creds");
  });
  test.beforeEach(() => {
    resetState();
  });
  test.setTimeout(300_000); // 5 min per test to accommodate 15-25s video startup × multiple cycles

  test("§1-2: video loads + first checkpoint pauses playback automatically", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await loginPortal(page);
    await openSliceCourse(page);
    await playUntilCheckpoint(page, 15);
    await expect(page.getByTestId("portal-checkpoint-answering").first()).toBeVisible();
    await page.screenshot({ path: path.join(outDir, "01-cp1-triggered.png"), fullPage: true });
  });

  test("§3-5: incorrect -> retry -> correct -> video resumes without reloading", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await loginPortal(page);
    await openSliceCourse(page);
    await playUntilCheckpoint(page, 15);
    // Capture video src BEFORE answering, prove it stays the same (no remount).
    const srcBefore = await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
      const v = videos.find((el) => el.offsetParent !== null) ?? videos[0];
      return v?.src ?? null;
    });
    await answerCheckpoint1(page, false);
    await expect(page.getByTestId("portal-checkpoint-result").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("portal-checkpoint-retry").first()).toBeVisible();
    await page.screenshot({ path: path.join(outDir, "02-cp1-not-quite.png"), fullPage: true });
    await page.getByTestId("portal-checkpoint-retry").first().click();
    await answerCheckpoint1(page, true);
    await expect(page.getByTestId("portal-checkpoint-resume").first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(outDir, "03-cp1-cleared.png"), fullPage: true });
    await page.getByTestId("portal-checkpoint-resume").first().click();
    await expect(page.getByTestId("portal-checkpoint-overlay").first()).toHaveCount(0, { timeout: 10_000 });
    const srcAfter = await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
      const v = videos.find((el) => el.offsetParent !== null) ?? videos[0];
      return v?.src ?? null;
    });
    expect(srcAfter, "video src must not change (no remount)").toBe(srcBefore);
  });

  test("§6: second checkpoint triggers at its configured timestamp", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await loginPortal(page);
    await openSliceCourse(page);
    await playUntilCheckpoint(page, 15);
    await answerCheckpoint1(page, true);
    await expect(page.getByTestId("portal-checkpoint-resume").first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("portal-checkpoint-resume").first().click();
    await playUntilCheckpoint(page, 30);
    // STRICT: second checkpoint's prompt text appears.
    await expect(page.getByTestId("portal-checkpoint-answering").first()).toBeVisible();
    await expect(page.getByText(/Who should you report/).first()).toBeVisible();
    await page.screenshot({ path: path.join(outDir, "04-cp2-triggered.png"), fullPage: true });
  });

  test("§7: seek-forward past uncleared required checkpoint is clamped", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await ctx.newPage();
    await loginPortal(page);
    await openSliceCourse(page);
    await waitForVideoPlayable(page);
    await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
      const v = videos.find((el) => el.offsetParent !== null);
      if (v) v.currentTime = 35;
    });
    await page.waitForTimeout(2_000);
    const t = await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
      const v = videos.find((el) => el.offsetParent !== null);
      return v?.currentTime ?? -1;
    });
    expect(t, "seek clamped to <=16s").toBeLessThanOrEqual(16);
    await page.screenshot({ path: path.join(outDir, "05-seek-forward-clamped.png"), fullPage: true });
  });

  test("§8: browser refresh preserves cleared-checkpoint state", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await loginPortal(page);
    await openSliceCourse(page);
    await playUntilCheckpoint(page, 15);
    await answerCheckpoint1(page, true);
    await expect(page.getByTestId("portal-checkpoint-resume").first()).toBeVisible({ timeout: 15_000 });
    // Explicit wait for the submit's progress-record to be durable
    // before reloading (progress may lag the client-visible clear flag).
    await page.waitForTimeout(1_500);
    // Full navigation (not just reload) + fresh openSliceCourse so the
    // page re-fetches getPlayerState with the persisted cleared set.
    await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });
    await openSliceCourse(page);
    await waitForVideoPlayable(page);
    // After refresh, seek-cap should allow up to checkpoint 2 (30s), not clamp at 15.
    await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
      const v = videos.find((el) => el.offsetParent !== null);
      if (v) v.currentTime = 25;
    });
    await page.waitForTimeout(2_000);
    const t = await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
      const v = videos.find((el) => el.offsetParent !== null);
      return v?.currentTime ?? -1;
    });
    // Clamp is now at checkpoint 2 (30s), so a seek to 25s should land AT 25
    // (not clamped back to 15 as it would be if cp1 were un-cleared).
    expect(t, "post-refresh seek to 25s not clamped at 15s").toBeGreaterThan(15);
    await page.screenshot({ path: path.join(outDir, "06-refresh-preserves-cleared.png"), fullPage: true });
  });

  test("§9: retry exhaustion prevents further checkpoint attempts", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await loginPortal(page);
    await openSliceCourse(page);
    await playUntilCheckpoint(page, 15);
    // maxRetries=2 -> 3 total submissions allowed; fail all 3
    for (let i = 0; i < 3; i++) {
      await answerCheckpoint1(page, false);
      await expect(page.getByTestId("portal-checkpoint-result").first()).toBeVisible({ timeout: 15_000 });
      if (i < 2) {
        await page.getByTestId("portal-checkpoint-retry").first().click();
      }
    }
    // After 3rd fail, UI should show "no retries remaining" and NOT a Try again button.
    const retryVisible = await page.getByTestId("portal-checkpoint-retry").first().count();
    expect(retryVisible, "Try again button must not be present after exhaustion").toBe(0);
    await expect(page.getByText(/No retries remaining|Contact your manager/).first()).toBeVisible();
    await page.screenshot({ path: path.join(outDir, "07-retry-exhausted.png"), fullPage: true });
  });

  test("§10-14: full journey -> both checkpoints -> watch to 90% -> final assessment fail/retake/pass -> completion persists on refresh", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await loginPortal(page);
    await openSliceCourse(page);
    // Natural playback from 0 at 2x. Checkpoint 1 fires around 15s
    // (~7.5s wall-clock), secondsWatched accumulates ~15s via the
    // client's MAX_DT_PER_TICK=2 guarded timeupdate.
    await playNaturallyUntilCheckpoint(page, 2);
    await answerCheckpoint1(page, true);
    await expect(page.getByTestId("portal-checkpoint-resume").first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("portal-checkpoint-resume").first().click();
    // Natural continue to cp2 at 30s. Another ~7.5s wall-clock + 15s
    // watch accumulation. Total secondsWatched ~30s.
    await playNaturallyUntilCheckpoint(page, 2);
    await answerCheckpoint2(page, true);
    await expect(page.getByTestId("portal-checkpoint-resume").first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("portal-checkpoint-resume").first().click();
    // Final segment: play from 30 to end naturally. Accumulates
    // another ~11s of watch time (41 total = 100%). Video ends ->
    // onEnded force-flushes progress POST.
    await page.evaluate(async () => {
      const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
      const v = videos.find((el) => el.offsetParent !== null);
      if (!v) return;
      v.muted = true;
      v.playbackRate = 2;
      try { await v.play(); } catch { /* ignore */ }
    });
    await page.waitForFunction(() => {
      const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
      const v = videos.find((el) => el.offsetParent !== null);
      return !!v && v.ended;
    }, undefined, { timeout: 60_000 });
    // Flush pattern: pause -> wait for in-flight guard to clear ->
    // pagehide dispatch -> wait for final POST. sendProgress has an
    // inFlightRef that drops concurrent sends; we have to wait for
    // the current flight to resolve + trigger a fresh force-send.
    await page.evaluate(async () => {
      const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
      const v = videos.find((el) => el.offsetParent !== null);
      if (v && !v.paused) v.pause();
      await new Promise((r) => setTimeout(r, 2500));
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("pagehide"));
    });
    await page.waitForTimeout(5_000);
    // Full navigation picks up fresh getPlayerState w/ unlocked final.
    await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });
    await openSliceCourse(page);
    const startBtn = page.getByTestId("portal-course-start-attempt").first();
    await expect(startBtn).toBeVisible({ timeout: 30_000 });
    // --- §11 FAIL the final assessment first ---
    await startBtn.click();
    const final1 = page.getByTestId("portal-course-quiz-answering").first();
    await expect(final1).toBeVisible();
    await final1.getByText("Doing nothing", { exact: true }).first().click();
    await final1.getByText("False", { exact: true }).first().click();
    await page.getByTestId("portal-course-submit-attempt").first().click();
    await expect(page.getByTestId("portal-course-quiz-failed").first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(outDir, "08-final-failed.png"), fullPage: true });
    // --- §12 Retake + PASS ---
    await page.getByTestId("portal-course-quiz-retake").first().click();
    const startBtn2 = page.getByTestId("portal-course-start-attempt").first();
    await expect(startBtn2).toBeVisible({ timeout: 10_000 });
    await startBtn2.click();
    const final2 = page.getByTestId("portal-course-quiz-answering").first();
    await expect(final2).toBeVisible();
    await final2.getByText("Risk assessment", { exact: true }).first().click();
    await final2.getByText("True", { exact: true }).first().click();
    await page.getByTestId("portal-course-submit-attempt").first().click();
    await expect(page.getByTestId("portal-course-quiz-passed").first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(outDir, "09-final-passed.png"), fullPage: true });
    // --- §14 Completion persists on refresh ---
    await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });
    await openSliceCourse(page);
    await expect(page.getByTestId("portal-course-completed-banner").first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(outDir, "10-completion-persists.png"), fullPage: true });
  });

  for (const [label, w, h, shellTestId] of [
    ["desktop-1440", 1440, 900, "portal-desktop-shell"],
    ["desktop-1920", 1920, 1080, "portal-desktop-shell"],
    ["mobile-390", 390, 844, "portal-mobile-shell"],
  ] as const) {
    test(`checkpoint overlay screenshot ${label}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      await loginPortal(page);
      await openSliceCourse(page);
      // EP-TRAIN-3 Slice 3-final (2026-10-30): scope every selector to
      // the ACTIVE shell for this viewport.  Both shells render in the
      // DOM; the inactive one has display:none via Tailwind.  Scoping
      // ensures we drive the visible shell's player instance only.
      const shell = page.getByTestId(shellTestId);
      await expect(shell).toBeVisible();
      await page.waitForFunction(({ shellId }) => {
        const scope = document.querySelector(`[data-testid="${shellId}"]`);
        const v = scope?.querySelector('[data-testid="portal-course-video"]') as HTMLVideoElement | null;
        return !!v && v.readyState >= 1 && Number.isFinite(v.duration);
      }, { shellId: shellTestId }, { timeout: 30_000 });
      await page.evaluate(async ({ shellId }) => {
        const scope = document.querySelector(`[data-testid="${shellId}"]`);
        const v = scope?.querySelector('[data-testid="portal-course-video"]') as HTMLVideoElement | null;
        if (!v) return;
        v.muted = true;
        v.currentTime = 15;
        try { await v.play(); } catch { /* ignore */ }
      }, { shellId: shellTestId });
      await expect(shell.getByTestId("portal-checkpoint-overlay")).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: path.join(outDir, `checkpoint-${label}.png`), fullPage: true });
    });
  }
});
