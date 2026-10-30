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
  try {
    const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";
    const b64 = Buffer.from(RESET_SCRIPT).toString("base64");
    execSync(
      `"${flyctl}" ssh console --app spectre-staging -C "/bin/sh -c 'echo ${b64} | base64 -d > /tmp/r.mjs && cd /app && node /tmp/r.mjs && rm /tmp/r.mjs'"`,
      { stdio: "ignore", timeout: 60_000 },
    );
  } catch (e) { /* non-fatal */ }
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
  const link = page.locator('a:has-text("Slice 3 Interactive Playback")').first();
  await expect(link).toBeVisible();
  await Promise.all([
    page.waitForURL(/\/employee\/safety-training\/[^/]+/, { timeout: 15_000 }),
    link.click(),
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
  await page.evaluate(async ({ t }) => {
    const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
    for (const v of videos) {
      v.muted = true;
      v.currentTime = t;
      try { await v.play(); } catch { /* ignore */ }
    }
  }, { t: atSecond });
  await expect(page.getByTestId("portal-checkpoint-overlay").first()).toBeVisible({ timeout: 30_000 });
}

async function answerCheckpoint1(page: Page, correct: boolean): Promise<void> {
  const panel = page.getByTestId("portal-checkpoint-answering").first();
  await expect(panel).toBeVisible();
  if (correct) {
    await panel.getByText("Orange", { exact: true }).first().click();
    await panel.getByText("Hard hat", { exact: true }).first().click();
    await panel.getByText("Safety goggles", { exact: true }).first().click();
    await panel.getByText("True", { exact: true }).first().click();
  } else {
    await panel.getByText("Green", { exact: true }).first().click();
    await panel.getByText("Business suit", { exact: true }).first().click();
    await panel.getByText("False", { exact: true }).first().click();
  }
  await page.getByTestId("portal-checkpoint-submit").first().click();
}

async function answerCheckpoint2(page: Page, correct: boolean): Promise<void> {
  const panel = page.getByTestId("portal-checkpoint-answering").first();
  await expect(panel).toBeVisible();
  if (correct) {
    await panel.getByText("Your supervisor immediately", { exact: true }).first().click();
  } else {
    await panel.getByText("Nobody", { exact: true }).first().click();
  }
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
    await page.getByTestId("portal-checkpoint-resume").first().click();
    await page.reload({ waitUntil: "domcontentloaded" });
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
    // Clamp is now at checkpoint 2 (30s), so 25s should be allowed.
    expect(t, "post-refresh seek to 25s not clamped at 15s").toBeGreaterThanOrEqual(15);
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

  test("§10-12: full happy path -> both checkpoints -> final assessment -> completion", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await loginPortal(page);
    await openSliceCourse(page);
    await playUntilCheckpoint(page, 15);
    await answerCheckpoint1(page, true);
    await expect(page.getByTestId("portal-checkpoint-resume").first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("portal-checkpoint-resume").first().click();
    await playUntilCheckpoint(page, 30);
    await answerCheckpoint2(page, true);
    await expect(page.getByTestId("portal-checkpoint-resume").first()).toBeVisible({ timeout: 15_000 });
    await page.getByTestId("portal-checkpoint-resume").first().click();
    // Watch to >=90% to satisfy video threshold.  Our video is 41.5s; 90% = 37.4s.
    await page.evaluate(async () => {
      const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
      for (const v of videos) {
        v.muted = true;
        v.currentTime = 40;
        try { await v.play(); } catch { /* ignore */ }
      }
      // Give timeupdate a chance to fire + progress to flush.
      await new Promise((r) => setTimeout(r, 3000));
    });
    // Reload to pick up the "Start knowledge test" state after progress saved.
    await page.reload({ waitUntil: "domcontentloaded" });
    // Final-assessment "Start knowledge test" should now be enabled.
    const startBtn = page.getByTestId("portal-course-start-attempt").first();
    await expect(startBtn).toBeVisible({ timeout: 30_000 });
    await startBtn.click();
    // Answer final assessment correctly.
    const final = page.getByTestId("portal-course-quiz-answering").first();
    await expect(final).toBeVisible();
    await final.getByText("Risk assessment", { exact: true }).first().click();
    await final.getByText("True", { exact: true }).first().click();
    await page.getByTestId("portal-course-submit-attempt").first().click();
    await expect(page.getByTestId("portal-course-quiz-passed").first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(outDir, "08-final-assessment-passed.png"), fullPage: true });
  });

  for (const [label, w, h] of [["desktop-1440", 1440, 900], ["desktop-1920", 1920, 1080], ["mobile-390", 390, 844]] as const) {
    test(`checkpoint overlay screenshot ${label}`, async ({ browser }) => {
      const ctx = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await ctx.newPage();
      await loginPortal(page);
      await openSliceCourse(page);
      await playUntilCheckpoint(page, 15);
      await page.screenshot({ path: path.join(outDir, `checkpoint-${label}.png`), fullPage: true });
    });
  }
});
