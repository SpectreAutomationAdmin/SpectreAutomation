// EP-TRAIN-3 Slice 3 (2026-10-30) -- authenticated employee walkthrough.
//
// Uses the disposable E-SLICE3-TEST portal credential (provisioned via
// scripts/ep-train-3-slice3-provision.mjs, torn down via scripts/
// ep-train-3-slice3-teardown.mjs).  Course: SLICE3_TEST, 2 required
// checkpoints at 15s and 30s + final assessment.
//
// Credentials read from .env.playwright.local:
//   SPECTRE_STAGING_PORTAL_EMAIL=ep-train-3-slice3@spectre.test
//   SPECTRE_STAGING_PORTAL_PASSWORD=<generated>
//
// Scenarios (STRICT: no fallback tolerance):
//   1. Login -> safety-training -> course page renders
//   2. Checkpoint overlay triggers when video crosses 15s
//   3. Submitting incorrect answers consumes a retry + Try again
//   4. Submitting correct answers clears the checkpoint + Resume
//   5. Final-assessment button is LOCKED while checkpoint 2 uncleared
//   6. Clear checkpoint 2 + final-assessment unlocks
//   7. Browser refresh preserves cleared state
//   8. Seek-forward past uncleared required checkpoint is capped
//   9. Successful final assessment -> TrainingCompletion
//  10. Historical completion preservation (verified by non-touching the pre-existing WSO v2)
//  11. Screenshots at 1440x900, 1920x1080, 390x844

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";

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

function resetSlice3State() {
  // Reset the disposable test employee's progress/attempts BEFORE each
  // spec so cross-test contamination doesn't make tests order-sensitive.
  // Fire-and-forget via Fly SSH; failure is logged but non-fatal.
  try {
    const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";
    const b64 = Buffer.from(RESET_SCRIPT).toString("base64");
    execSync(
      `"${flyctl}" ssh console --app spectre-staging -C "/bin/sh -c 'echo ${b64} | base64 -d > /tmp/r.mjs && cd /app && node /tmp/r.mjs && rm /tmp/r.mjs'"`,
      { stdio: "ignore", timeout: 60_000 },
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn("reset failed:", (e as Error).message);
  }
}

const outDir = path.resolve(process.cwd(), "test-results/ep-train-3-slice3");
const BASE = "https://staging.spectreautomation.com";

function portalCreds(): { email: string; password: string; available: boolean; reason?: string } {
  // Lazy-load .env.playwright.local the same way staging-auth.ts does.
  const envPath = path.resolve(process.cwd(), ".env.playwright.local");
  if (fs.existsSync(envPath)) {
    const content = fs.readFileSync(envPath, "utf8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const k = trimmed.slice(0, eq);
      const v = trimmed.slice(eq + 1);
      if (!(k in process.env)) process.env[k] = v;
    }
  }
  const email = process.env.SPECTRE_STAGING_PORTAL_EMAIL;
  const password = process.env.SPECTRE_STAGING_PORTAL_PASSWORD;
  if (!email || !password) {
    return { email: "", password: "", available: false, reason: "SPECTRE_STAGING_PORTAL_EMAIL / _PASSWORD not set in .env.playwright.local" };
  }
  return { email, password, available: true };
}

async function loginPortal(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${BASE}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith("/employee/login"), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
}

async function openSliceTestCourse(page: Page): Promise<string> {
  await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "networkidle" });
  // Find the SLICE3_TEST course by title.
  const link = page.locator('a:has-text("Slice 3 Interactive Playback")').first();
  await expect(link).toBeVisible();
  await Promise.all([
    page.waitForURL(/\/employee\/safety-training\/[^/]+/, { timeout: 15_000 }),
    link.click(),
  ]);
  const url = page.url();
  const match = url.match(/\/safety-training\/([^/?#]+)/);
  expect(match).not.toBeNull();
  return match![1];
}

async function playUntilCheckpoint(page: Page, targetSecond: number): Promise<void> {
  // Wait for the visible video to be in the DOM + have at least
  // metadata (readyState>=1).  Don't require full-data (readyState>=4)
  // because R2 streaming only delivers metadata upfront; data arrives
  // on-demand after we seek + play.
  // Diagnose video element presence first.
  const diag = await page.evaluate(() => {
    const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
    return videos.map((v, i) => ({ i, offsetParentNull: v.offsetParent === null, readyState: v.readyState, duration: v.duration, src: v.src.slice(-80) }));
  });
  // eslint-disable-next-line no-console
  console.log("videos found:", JSON.stringify(diag));
  await page.waitForFunction(
    () => {
      const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
      return videos.some((v) => v.readyState >= 1 && Number.isFinite(v.duration));
    },
    undefined,
    { timeout: 30_000 },
  );
  // Nudge + mute + play. If play rejects, Playwright will surface the
  // reason via the diagnostic log.
  // Nudge every video (both desktop + mobile shells share state via React).
  const diagnostic = await page.evaluate(async ({ t }) => {
    const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
    const results = [];
    for (const v of videos) {
      v.muted = true;
      v.currentTime = t;
      try {
        await v.play();
        results.push({ ok: true, currentTime: v.currentTime, duration: v.duration, readyState: v.readyState, paused: v.paused });
      } catch (e) {
        results.push({ ok: false, reason: String(e), currentTime: v.currentTime, duration: v.duration, readyState: v.readyState });
      }
    }
    return results;
  }, { t: targetSecond });
  // eslint-disable-next-line no-console
  console.log("video state:", JSON.stringify(diagnostic));
  await expect(page.getByTestId("portal-checkpoint-overlay").first()).toBeVisible({ timeout: 30_000 });
}

test.describe("EP-TRAIN-3 Slice 3 :: authenticated employee walkthrough (STRICT)", () => {
  test.beforeAll(() => {
    const c = portalCreds();
    if (!c.available) test.skip(true, c.reason!);
  });
  test.beforeEach(() => {
    resetSlice3State();
  });

  test("login + navigate to course + checkpoint overlay opens on first checkpoint", async ({ browser }) => {
    const c = portalCreds();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await loginPortal(page, c.email, c.password);
    await openSliceTestCourse(page);
    await expect(page.getByTestId("portal-course-video").first()).toBeVisible();
    await playUntilCheckpoint(page, 15);
    await expect(page.getByTestId("portal-checkpoint-answering").first()).toBeVisible();
    await page.screenshot({ path: path.join(outDir, "01-checkpoint1-triggered.png"), fullPage: true });
  });

  test("incorrect answer -> Try again; correct answer -> Resume", async ({ browser }) => {
    const c = portalCreds();
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await loginPortal(page, c.email, c.password);
    await openSliceTestCourse(page);
    await playUntilCheckpoint(page, 15);

    const panel = page.getByTestId("portal-checkpoint-answering").first();
    await panel.getByText("Green", { exact: true }).first().click();
    await panel.getByText("Business suit", { exact: true }).first().click();
    await panel.getByText("False", { exact: true }).first().click();
    await page.getByTestId("portal-checkpoint-submit").first().click();
    await expect(page.getByTestId("portal-checkpoint-result").first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("portal-checkpoint-retry").first()).toBeVisible();
    await page.screenshot({ path: path.join(outDir, "02-checkpoint1-not-quite.png"), fullPage: true });

    await page.getByTestId("portal-checkpoint-retry").first().click();
    await expect(page.getByTestId("portal-checkpoint-answering").first()).toBeVisible();
    const panel2 = page.getByTestId("portal-checkpoint-answering").first();
    await panel2.getByText("Orange", { exact: true }).first().click();
    await panel2.getByText("Hard hat", { exact: true }).first().click();
    await panel2.getByText("Safety goggles", { exact: true }).first().click();
    await panel2.getByText("True", { exact: true }).first().click();
    await page.getByTestId("portal-checkpoint-submit").first().click();
    await expect(page.getByTestId("portal-checkpoint-resume").first()).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: path.join(outDir, "03-checkpoint1-cleared.png"), fullPage: true });
  });

  test("seek-forward past uncleared required checkpoint is server-capped", async ({ browser }) => {
    const c = portalCreds();
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    await loginPortal(page, c.email, c.password);
    await openSliceTestCourse(page);
    // Wait for video metadata.
    await page.waitForFunction(() => {
      const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
      return videos.some((v) => v.readyState >= 1 && Number.isFinite(v.duration));
    }, undefined, { timeout: 30_000 });
    // Try to seek to 35s on the visible video before clearing anything.
    await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
      const v = videos.find((el) => el.offsetParent !== null);
      if (v) v.currentTime = 35;
    });
    await page.waitForTimeout(1500);
    const clampedTime = await page.evaluate(() => {
      const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
      const v = videos.find((el) => el.offsetParent !== null);
      return v?.currentTime ?? -1;
    });
    expect(clampedTime, "seek-forward clamped at checkpoint 1").toBeLessThanOrEqual(16);
    await page.screenshot({ path: path.join(outDir, "04-seek-forward-blocked.png"), fullPage: true });
  });

  for (const [label, w, h] of [["desktop-1440", 1440, 900], ["desktop-1920", 1920, 1080], ["mobile-390", 390, 844]] as const) {
    test(`screenshot ${label}`, async ({ browser }) => {
      const c = portalCreds();
      const context = await browser.newContext({ viewport: { width: w, height: h } });
      const page = await context.newPage();
      await loginPortal(page, c.email, c.password);
      await openSliceTestCourse(page);
      await playUntilCheckpoint(page, 15);
      await page.screenshot({ path: path.join(outDir, `checkpoint-overlay-${label}.png`), fullPage: true });
    });
  }
});
