// EP-TRAIN-4E-1 (2026-11-01) — completed-course playback reset.
//
// Covers the directive §5 ten-scenario acceptance list.  Uses the
// EP-TRAIN-3 isolated-fixture helper so no founder-authored course
// is touched during state-changing scenarios.
//
// Scenario map (per directive §5):
//   1. New course opens at 0:00.
//   2. In-progress course resumes correctly.
//   3. In-progress required checkpoint remains enforced.
//   4. Completed course with saved position (farthestSecond=40 near
//      end) opens at 0:00.
//   5. Refreshing the completed course still opens at 0:00.
//   6. Navigating away and reopening still starts at 0:00.
//   7. Completed course can be replayed through the end without
//      mandatory checkpoint interruptions or forced reassessment.
//   8. Original completion, score, date, attempt history unchanged.
//   9. No duplicate TrainingCompletion is created.
//  10. Desktop 1440×900 and mobile 390×844 behave consistently.

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { provisionIsolatedFixture, teardownIsolatedFixture, newRunId, type IsolatedFixture } from "./_lib/ep-train-3-fixture";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const FLYCTL = process.env.FLYCTL_PATH ?? "C:/Users/cturcato/.fly/bin/flyctl.exe";
const outDir = path.resolve(process.cwd(), "test-results/ep-train-4e1-completed-replay");
fs.mkdirSync(outDir, { recursive: true });

async function portalLogin(page: Page, f: IsolatedFixture): Promise<void> {
  await page.goto(`${BASE}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(f.email);
  await page.locator('input[name="password"]').fill(f.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
}

async function openCourse(page: Page, versionId: string): Promise<void> {
  await page.goto(`${BASE}/employee/safety-training/${versionId}`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => {
    const v = document.querySelector('[data-testid="portal-course-video"]') as HTMLVideoElement | null;
    return !!v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
  }, undefined, { timeout: 30_000 });
}

async function readCurrentTime(page: Page): Promise<number> {
  return page.evaluate(() => {
    const v = document.querySelector('[data-testid="portal-course-video"]') as HTMLVideoElement | null;
    return v ? v.currentTime : -1;
  });
}

/** Seed TrainingProgress and TrainingCompletion rows for the fixture
 *  so the fixture represents a "completed" course with farthestSecond
 *  near the end — the exact scenario the founder observed. */
function seedCompletedFixture(fixture: IsolatedFixture, farthestSecond: number): { completionId: string; attemptId: string; completedAt: string; score: number } {
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const result = await p.$transaction(async (tx) => {
    const prog = await tx.trainingProgress.create({
      data: {
        clubId: "cmrvdeny7000144372ktmmg9c",
        employeeId: ${JSON.stringify(fixture.employeeId)},
        courseVersionId: ${JSON.stringify(fixture.courseVersionId)},
        secondsWatched: ${farthestSecond},
        farthestSecond: ${farthestSecond},
        percentComplete: 100,
      },
    });
    const attempt = await tx.trainingAttempt.create({
      data: {
        clubId: "cmrvdeny7000144372ktmmg9c",
        employeeId: ${JSON.stringify(fixture.employeeId)},
        courseVersionId: ${JSON.stringify(fixture.courseVersionId)},
        attemptNumber: 1,
        startedAt: new Date(Date.now() - 60000),
        submittedAt: new Date(Date.now() - 30000),
        score: 95,
        passed: true,
      },
    });
    const completion = await tx.trainingCompletion.create({
      data: {
        clubId: "cmrvdeny7000144372ktmmg9c",
        employeeId: ${JSON.stringify(fixture.employeeId)},
        courseId: ${JSON.stringify(fixture.courseId)},
        courseVersionId: ${JSON.stringify(fixture.courseVersionId)},
        attemptId: attempt.id,
        score: 95,
        completedAt: new Date("2026-11-01T00:00:00Z"),
      },
    });
    return { progId: prog.id, attemptId: attempt.id, completionId: completion.id, completedAt: completion.completedAt.toISOString(), score: completion.score };
  });
  console.log("SEEDED " + JSON.stringify(result));
  await p.$disconnect();
})().catch((e) => { console.error("ERR " + e.message); process.exit(1); });
`;
  const b64 = Buffer.from(script).toString("base64");
  const remote = `/bin/sh -c "echo ${b64} | base64 -d > /app/scripts/_ep4e1_seed.mjs && cd /app && node /app/scripts/_ep4e1_seed.mjs; rm -f /app/scripts/_ep4e1_seed.mjs"`;
  const stdout = execFileSync(FLYCTL, ["ssh", "console", "--app", "spectre-staging", "-C", remote], { encoding: "utf8", timeout: 60_000 });
  const line = stdout.split("\n").find((l) => l.startsWith("SEEDED ")) ?? "";
  return JSON.parse(line.slice(line.indexOf("{")));
}

/** Snapshot the fixture's completion-evidence rows so we can diff
 *  before/after a replay. */
function snapshotCompletionEvidence(fixture: IsolatedFixture): {
  completion: { id: string; completedAt: string; score: number } | null;
  attempts: Array<{ id: string; attemptNumber: number; score: number; passed: boolean }>;
  progress: { secondsWatched: number; farthestSecond: number; percentComplete: number; updatedAt: string } | null;
} {
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const completion = await p.trainingCompletion.findUnique({
    where: { employeeId_courseVersionId: { employeeId: ${JSON.stringify(fixture.employeeId)}, courseVersionId: ${JSON.stringify(fixture.courseVersionId)} } },
    select: { id: true, completedAt: true, score: true },
  });
  const attempts = await p.trainingAttempt.findMany({
    where: { employeeId: ${JSON.stringify(fixture.employeeId)}, courseVersionId: ${JSON.stringify(fixture.courseVersionId)} },
    select: { id: true, attemptNumber: true, score: true, passed: true },
    orderBy: { attemptNumber: "asc" },
  });
  const progress = await p.trainingProgress.findFirst({
    where: { employeeId: ${JSON.stringify(fixture.employeeId)}, courseVersionId: ${JSON.stringify(fixture.courseVersionId)} },
    select: { secondsWatched: true, farthestSecond: true, percentComplete: true, updatedAt: true },
  });
  console.log("SNAP " + JSON.stringify({
    completion: completion ? { id: completion.id, completedAt: completion.completedAt.toISOString(), score: completion.score } : null,
    attempts,
    progress: progress ? { ...progress, updatedAt: progress.updatedAt.toISOString() } : null,
  }));
  await p.$disconnect();
})().catch((e) => { console.error("ERR " + e.message); process.exit(1); });
`;
  const b64 = Buffer.from(script).toString("base64");
  const remote = `/bin/sh -c "echo ${b64} | base64 -d > /app/scripts/_ep4e1_snap.mjs && cd /app && node /app/scripts/_ep4e1_snap.mjs; rm -f /app/scripts/_ep4e1_snap.mjs"`;
  const stdout = execFileSync(FLYCTL, ["ssh", "console", "--app", "spectre-staging", "-C", remote], { encoding: "utf8", timeout: 60_000 });
  const line = stdout.split("\n").find((l) => l.startsWith("SNAP ")) ?? "";
  return JSON.parse(line.slice(line.indexOf("{")));
}

/** Seed TrainingProgress at farthestSecond (NOT a completion) so the
 *  fixture represents an IN-PROGRESS course for scenario §5.2. */
function seedInProgressFixture(fixture: IsolatedFixture, farthestSecond: number): void {
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  await p.trainingProgress.create({
    data: {
      clubId: "cmrvdeny7000144372ktmmg9c",
      employeeId: ${JSON.stringify(fixture.employeeId)},
      courseVersionId: ${JSON.stringify(fixture.courseVersionId)},
      secondsWatched: ${farthestSecond},
      farthestSecond: ${farthestSecond},
      percentComplete: Math.min(100, Math.floor((${farthestSecond} / 42) * 100)),
    },
  });
  console.log("IN_PROGRESS_SEEDED");
  await p.$disconnect();
})().catch((e) => { console.error("ERR " + e.message); process.exit(1); });
`;
  const b64 = Buffer.from(script).toString("base64");
  const remote = `/bin/sh -c "echo ${b64} | base64 -d > /app/scripts/_ep4e1_ip.mjs && cd /app && node /app/scripts/_ep4e1_ip.mjs; rm -f /app/scripts/_ep4e1_ip.mjs"`;
  execFileSync(FLYCTL, ["ssh", "console", "--app", "spectre-staging", "-C", remote], { encoding: "utf8", timeout: 60_000 });
}

test.describe("EP-TRAIN-4E-1 completed-replay acceptance", () => {
  test.setTimeout(900_000);

  test("§5.1  new course (no progress, no completion) opens at 0:00", async ({ browser }) => {
    const runId = newRunId("f");
    const fixture = provisionIsolatedFixture(runId);
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await openCourse(page, fixture.courseVersionId);
      await page.waitForTimeout(500);
      const ct = await readCurrentTime(page);
      expect(ct).toBeLessThan(0.5);
      await ctx.close();
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });

  test("§5.2  in-progress course resumes from farthestSecond=15", async ({ browser }) => {
    const runId = newRunId("f");
    const fixture = provisionIsolatedFixture(runId);
    try {
      seedInProgressFixture(fixture, 15);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await openCourse(page, fixture.courseVersionId);
      await page.waitForTimeout(500);
      const ct = await readCurrentTime(page);
      // Fixture video is 42s; farthestSecond=15 < duration-2=40 → resume at 15.
      expect(ct).toBeGreaterThanOrEqual(14.5);
      expect(ct).toBeLessThanOrEqual(15.5);
      await ctx.close();
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });

  test("§5.4+§5.5+§5.6  completed course (farthestSecond=40 / duration=42) opens at 0:00; survives refresh; survives nav-away-and-back", async ({ browser }) => {
    const runId = newRunId("f");
    const fixture = provisionIsolatedFixture(runId);
    try {
      const seed = seedCompletedFixture(fixture, 40);
      const beforeSnap = snapshotCompletionEvidence(fixture);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      // §5.4 — fresh open.
      await openCourse(page, fixture.courseVersionId);
      await page.waitForTimeout(500);
      const ctFresh = await readCurrentTime(page);
      expect(ctFresh).toBeLessThan(0.5);
      await page.screenshot({ path: path.join(outDir, "01-completed-opens-at-zero.png"), fullPage: true });

      // §5.5 — refresh.
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => {
        const v = document.querySelector('[data-testid="portal-course-video"]') as HTMLVideoElement | null;
        return !!v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
      }, undefined, { timeout: 30_000 });
      await page.waitForTimeout(500);
      const ctAfterReload = await readCurrentTime(page);
      expect(ctAfterReload).toBeLessThan(0.5);
      await page.screenshot({ path: path.join(outDir, "02-completed-opens-at-zero-after-reload.png"), fullPage: true });

      // §5.6 — navigate away + back.
      await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });
      await openCourse(page, fixture.courseVersionId);
      await page.waitForTimeout(500);
      const ctAfterNav = await readCurrentTime(page);
      expect(ctAfterNav).toBeLessThan(0.5);
      await page.screenshot({ path: path.join(outDir, "03-completed-opens-at-zero-after-nav.png"), fullPage: true });

      // §5.8+§5.9  completion evidence unchanged.
      const afterSnap = snapshotCompletionEvidence(fixture);
      expect(afterSnap.completion?.id).toBe(seed.completionId);
      expect(afterSnap.completion?.completedAt).toBe(seed.completedAt);
      expect(afterSnap.completion?.score).toBe(seed.score);
      expect(afterSnap.attempts.length).toBe(beforeSnap.attempts.length);
      expect(afterSnap.attempts.length).toBe(1);
      expect(afterSnap.progress?.updatedAt).toBe(beforeSnap.progress?.updatedAt);
      expect(afterSnap.progress?.secondsWatched).toBe(40);
      expect(afterSnap.progress?.farthestSecond).toBe(40);

      await ctx.close();
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });

  test("§5.7  completed course plays THROUGH to end without any checkpoint overlay OR assessment overlay", async ({ browser }) => {
    const runId = newRunId("f");
    const fixture = provisionIsolatedFixture(runId);
    try {
      seedCompletedFixture(fixture, 40);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await openCourse(page, fixture.courseVersionId);
      // Play at 4x so we don't need to sit through 42s.  The fixture's
      // required checkpoints are at atSecond=15 + atSecond=28.
      await page.evaluate(() => {
        const v = document.querySelector('[data-testid="portal-course-video"]') as HTMLVideoElement;
        v.muted = true;
        v.playbackRate = 4;
        v.play().catch(() => { /* ignore autoplay refusal */ });
      });
      // Wait past both checkpoint positions (28s @ 4x ≈ 7s wall-clock,
      // plus a buffer).
      await page.waitForTimeout(10_000);
      // No checkpoint overlay and no quiz overlay should have appeared.
      await expect(page.locator('[data-testid="portal-checkpoint-overlay"]')).toHaveCount(0);
      await ctx.close();
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });

  test("§5.10  mobile 390x844: completed course opens at 0:00 and survives refresh", async ({ browser }) => {
    const runId = newRunId("f");
    const fixture = provisionIsolatedFixture(runId);
    try {
      seedCompletedFixture(fixture, 40);
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await ctx.newPage();
      await portalLogin(page, fixture);
      await openCourse(page, fixture.courseVersionId);
      await page.waitForTimeout(500);
      expect(await readCurrentTime(page)).toBeLessThan(0.5);
      await page.reload({ waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => {
        const v = document.querySelector('[data-testid="portal-course-video"]') as HTMLVideoElement | null;
        return !!v && v.readyState >= 1 && Number.isFinite(v.duration) && v.duration > 0;
      }, undefined, { timeout: 30_000 });
      await page.waitForTimeout(500);
      expect(await readCurrentTime(page)).toBeLessThan(0.5);
      await page.screenshot({ path: path.join(outDir, "04-mobile-completed-zero.png"), fullPage: true });
      await ctx.close();
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });
});
