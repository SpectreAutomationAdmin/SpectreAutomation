// EP-TRAIN-3 Slice 3D (2026-10-30) -- isolated three-journey acceptance.
//
// Satisfies founder directive 2026-10-30 §4-§5 "Complete browser
// acceptance ... three consecutive successful complete journeys
// against independently provisioned fixtures" at desktop 1440x900,
// desktop 1920x1080, and mobile 390x844.
//
// Per-test fixture isolation (replaces the shared resetState() model):
//   - Each test generates a unique runId
//   - Each test provisions its OWN employee / credential / course /
//     version / checkpoints / questions via tests/e2e/_lib/ep-train-3-fixture
//   - Each test tears down ONLY the records tied to its runId (prefix-
//     scoped, legitimate records never touched)
//   - No shared state, no cross-test contamination
//
// Each journey runs the full 15-step sequence in a REAL browser with
// REAL application state (no injected watched-progress, no fabricated
// TrainingCompletion rows).  TrainingCompletion existence is
// confirmed via a server-side Prisma query after the journey.

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import {
  provisionIsolatedFixture,
  teardownIsolatedFixture,
  newRunId,
  type IsolatedFixture,
} from "./_lib/ep-train-3-fixture";

const outDir = path.resolve(process.cwd(), "test-results/ep-train-3-slice3d-isolated");
fs.mkdirSync(outDir, { recursive: true });

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const FLYCTL = process.env.FLYCTL_PATH ?? "C:/Users/cturcato/.fly/bin/flyctl.exe";
const VIDEO_READY_TIMEOUT_MS = 60_000;

async function loginPortal(page: Page, fixture: IsolatedFixture): Promise<void> {
  await page.goto(`${BASE}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(fixture.email);
  await page.locator('input[name="password"]').fill(fixture.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
}

async function openIsolatedCourse(page: Page, fixture: IsolatedFixture): Promise<void> {
  await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });
  // Both desktop + mobile shells render identical markup; filter to
  // the shell visible at the current viewport.
  const link = page
    .locator('[data-testid^="portal-safety-training-course-"]:visible')
    .filter({ hasText: fixture.courseTitle })
    .first();
  await expect(link).toBeVisible({ timeout: 15_000 });
  await Promise.all([
    page.waitForURL(/\/employee\/safety-training\/[^/]+/, { timeout: 15_000 }),
    link.click(),
  ]);
  await page.waitForLoadState("domcontentloaded");
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
  // Native-input click + explicit toBeChecked guard per option.
  // Avoid Playwright's `.check()` "already checked" short-circuit —
  // when a controlled React radio briefly reflects an interim commit
  // the short-circuit skips the click and no onChange fires.  A plain
  // `.click()` on the input unconditionally dispatches, re-triggers
  // onChange, and lets `toBeChecked()` observe the authoritative DOM.
  const choose = async (role: "radio" | "checkbox", name: string) => {
    const input = panel.getByRole(role, { name, exact: true });
    await expect(input).toHaveCount(1);
    await input.click();
    await expect(input).toBeChecked();
  };
  if (correct) {
    await choose("radio", "Orange");
    await choose("checkbox", "Hard hat");
    await choose("checkbox", "Safety goggles");
    await choose("radio", "True");
  } else {
    await choose("radio", "Green");
    await choose("checkbox", "Business suit");
    await choose("radio", "False");
  }
  const expectedChecked = correct ? 4 : 3;
  // Diagnostic trace: capture the state settle for root-cause triage.
  const trace: string[] = [];
  for (let i = 0; i < 20; i++) {
    const checked = await panel.locator('input:checked').count();
    trace.push(`t+${i * 100}ms checked=${checked}`);
    if (checked === expectedChecked) break;
    await page.waitForTimeout(100);
  }
  const finalChecked = await panel.locator('input:checked').count();
  if (finalChecked !== expectedChecked) {
    // eslint-disable-next-line no-console
    console.log("[answerCp1 TRACE]", trace.join(" | "));
  }
  expect(finalChecked, `expected ${expectedChecked} checked after clicks; actual=${finalChecked}; trace=${trace.join(" | ")}`).toBe(expectedChecked);
  await page.getByTestId("portal-checkpoint-submit").first().click();
}

async function answerCheckpoint2(page: Page): Promise<void> {
  const panel = page.getByTestId("portal-checkpoint-answering").first();
  await expect(panel).toBeVisible();
  await expect
    .poll(async () => panel.locator('input:checked').count(), { timeout: 5000 })
    .toBe(0);
  const sup = panel.getByRole("radio", { name: "Your supervisor immediately", exact: true });
  await expect(sup).toHaveCount(1);
  await sup.click();
  await expect(sup).toBeChecked();
  await page.getByTestId("portal-checkpoint-submit").first().click();
}

async function completionExistsOnServer(fixture: IsolatedFixture): Promise<{ exists: boolean; score: number | null; completedAt: string | null }> {
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
const run = async () => {
  const c = await p.trainingCompletion.findFirst({ where: { employeeId: ${JSON.stringify(fixture.employeeId)}, courseVersionId: ${JSON.stringify(fixture.courseVersionId)} } });
  console.log("COMPLETION " + JSON.stringify({ exists: !!c, score: c?.score ?? null, completedAt: c?.completedAt?.toISOString?.() ?? null }));
  await p.$disconnect();
};
run().catch((e) => { console.error("ERR " + e.message); process.exit(1); });
`;
  const b64 = Buffer.from(script).toString("base64");
  const tmp = `/tmp/ep3q-${Date.now().toString(36)}.mjs`;
  const remoteCmd = `/bin/sh -c "echo ${b64} | base64 -d > ${tmp} && cd /app && node ${tmp}; rc=$?; rm -f ${tmp}; exit $rc"`;
  const stdout = execFileSync(
    FLYCTL,
    ["ssh", "console", "--app", "spectre-staging", "-C", remoteCmd],
    { encoding: "utf8", timeout: 90_000 },
  );
  const line = stdout.split(/\r?\n/).reverse().find((l) => l.startsWith("COMPLETION "));
  if (!line) throw new Error(`no COMPLETION line in stdout: ${stdout.slice(-400)}`);
  return JSON.parse(line.slice(line.indexOf("{")));
}

type ViewportSpec = { label: string; width: number; height: number };
const JOURNEYS: ViewportSpec[] = [
  { label: "desktop-1440x900", width: 1440, height: 900 },
  { label: "desktop-1920x1080", width: 1920, height: 1080 },
  { label: "mobile-390x844", width: 390, height: 844 },
];

test.describe("EP-TRAIN-3 Slice 3D :: three consecutive isolated-fixture journeys", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(600_000); // 10 min per journey to accommodate video playback

  for (const vp of JOURNEYS) {
    test(`complete employee training journey @ ${vp.label}`, async ({ browser }) => {
      const runId = newRunId("j");
      const consoleErrors: string[] = [];
      let fixture: IsolatedFixture | undefined;
      try {
        // ------- PROVISION ISOLATED FIXTURE -------
        fixture = provisionIsolatedFixture(runId);
        expect(fixture.runId).toBe(runId);
        expect(fixture.courseCode).toBe(`SLICE3_${runId}`);
        expect(fixture.employeeNumber).toBe(`E-SLICE3-${runId}`);
        // Save credentials for post-hoc debugging (gitignored test-results).
        fs.writeFileSync(
          path.join(outDir, `${vp.label}-${runId}-fixture.json`),
          JSON.stringify({ runId: fixture.runId, email: fixture.email, courseCode: fixture.courseCode, employeeId: fixture.employeeId, courseVersionId: fixture.courseVersionId }, null, 2),
        );

        const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height } });
        const page = await ctx.newPage();
        page.on("pageerror", (e) => consoleErrors.push(`PAGEERROR: ${e.message}`));
        page.on("console", (m) => {
          if (m.type() === "error") consoleErrors.push(`CONSOLE: ${m.text().slice(0, 400)}`);
        });

        // ------- STEP 1: LOGIN -------
        await loginPortal(page, fixture);
        await openIsolatedCourse(page, fixture);
        await page.screenshot({ path: path.join(outDir, `${vp.label}-${runId}-01-course-open.png`), fullPage: true });

        // ------- STEP 2: VIDEO PLAYBACK + STEP 3: CP1 TRIGGERS -------
        await playNaturallyUntilCheckpoint(page, 2);
        await page.screenshot({ path: path.join(outDir, `${vp.label}-${runId}-02-cp1-triggered.png`), fullPage: true });

        // ------- STEP 4: INCORRECT ANSWER -------
        await answerCheckpoint1(page, false);
        await expect(page.getByTestId("portal-checkpoint-result").first()).toBeVisible({ timeout: 15_000 });
        await expect(page.getByTestId("portal-checkpoint-retry").first()).toBeVisible();
        await page.screenshot({ path: path.join(outDir, `${vp.label}-${runId}-03-cp1-wrong.png`), fullPage: true });

        // ------- STEP 5: RETRY + CORRECT ANSWER -------
        await page.getByTestId("portal-checkpoint-retry").first().click();
        await answerCheckpoint1(page, true);
        await expect(page.getByTestId("portal-checkpoint-resume").first()).toBeVisible({ timeout: 15_000 });
        await page.screenshot({ path: path.join(outDir, `${vp.label}-${runId}-04-cp1-cleared.png`), fullPage: true });

        // ------- STEP 6: PLAYBACK CONTINUATION -------
        await page.getByTestId("portal-checkpoint-resume").first().click();
        await expect(page.getByTestId("portal-checkpoint-overlay").first()).toHaveCount(0, { timeout: 10_000 });

        // ------- STEP 7: CP2 TRIGGERS -------
        await playNaturallyUntilCheckpoint(page, 2);
        await page.screenshot({ path: path.join(outDir, `${vp.label}-${runId}-05-cp2-triggered.png`), fullPage: true });

        // ------- STEP 8: CP2 CLEARED -------
        await answerCheckpoint2(page);
        await expect(page.getByTestId("portal-checkpoint-resume").first()).toBeVisible({ timeout: 15_000 });
        await page.getByTestId("portal-checkpoint-resume").first().click();

        // ------- STEP 9: VIDEO COVERAGE TO END (secondsWatched >= 90%) -------
        // Play the final segment at 1x so timeupdate cadence stays
        // comfortably under PLAYBACK_JUMP_GRACE_SECONDS_PER_RATE
        // (0.75s) and every tick extends the interval.
        await page.evaluate(async () => {
          const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
          const v = videos.find((el) => el.offsetParent !== null);
          if (!v) return;
          v.muted = true;
          v.playbackRate = 1;
          try { await v.play(); } catch { /* ignore */ }
        });
        await page.waitForFunction(() => {
          const videos = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
          const v = videos.find((el) => el.offsetParent !== null);
          return !!v && v.ended;
        }, undefined, { timeout: 180_000 });
        // Dispatch pagehide so the useEffect flush fires a force-send
        // of the complete interval union (onEnded's own force-send
        // already committed the final interval, this is belt-and-
        // suspenders for CI-side event-loop stalls).
        await page.waitForTimeout(1500);
        await page.evaluate(() => {
          window.dispatchEvent(new Event("pagehide"));
        });
        // Poll the course-page's `Watch progress` badge for %>=90 —
        // this reads the SERVER's canonical percentComplete after the
        // final flush.  The badge "Watch progress N%" renders as two
        // sibling elements; we scope to the shared parent and parse.
        await expect
          .poll(
            async () => {
              const pct = await page.evaluate(() => {
                const nodes = Array.from(document.querySelectorAll("*"));
                for (const n of nodes) {
                  const t = n.textContent ?? "";
                  const m = t.match(/Watch progress[^0-9]*(\d+)\s*%/);
                  if (m) return parseInt(m[1], 10);
                }
                return 0;
              });
              return pct;
            },
            { timeout: 45_000, intervals: [500, 1000, 2000] },
          )
          .toBeGreaterThanOrEqual(90);

        // ------- STEP 10: FINAL ASSESSMENT UNLOCKED (after refresh) -------
        // Scope all subsequent locators to the active shell for this
        // viewport.  Both shells render identical markup; the hidden
        // one would otherwise be matched by `.first()`.
        await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });
        await openIsolatedCourse(page, fixture);
        const shellSel = vp.width < 768 ? '[data-testid="portal-mobile-shell"]' : '[data-testid="portal-desktop-shell"]';
        const shell = page.locator(shellSel);
        await expect(shell).toBeVisible({ timeout: 10_000 });
        const startBtn = shell.getByTestId("portal-course-start-attempt").first();
        await expect(startBtn).toBeVisible({ timeout: 30_000 });
        await page.screenshot({ path: path.join(outDir, `${vp.label}-${runId}-06-final-unlocked.png`), fullPage: true });

        // ------- STEP 11: FAIL FINAL ASSESSMENT -------
        await startBtn.click();
        const final1 = shell.getByTestId("portal-course-quiz-answering").first();
        await expect(final1).toBeVisible();
        const dn = final1.getByRole("radio", { name: "Doing nothing", exact: true });
        const fF = final1.getByRole("radio", { name: "False", exact: true });
        await dn.click();
        await expect(dn).toBeChecked();
        await fF.click();
        await expect(fF).toBeChecked();
        await shell.getByTestId("portal-course-submit-attempt").first().click();
        await expect(shell.getByTestId("portal-course-quiz-failed").first()).toBeVisible({ timeout: 15_000 });
        await page.screenshot({ path: path.join(outDir, `${vp.label}-${runId}-07-final-failed.png`), fullPage: true });

        // ------- STEP 12: RETAKE PERMITTED -------
        await shell.getByTestId("portal-course-quiz-retake").first().click();
        const startBtn2 = shell.getByTestId("portal-course-start-attempt").first();
        await expect(startBtn2).toBeVisible({ timeout: 10_000 });

        // ------- STEP 13: SUCCESSFUL FINAL ASSESSMENT -------
        await startBtn2.click();
        const final2 = shell.getByTestId("portal-course-quiz-answering").first();
        await expect(final2).toBeVisible();
        const ra = final2.getByRole("radio", { name: "Risk assessment", exact: true });
        const tT = final2.getByRole("radio", { name: "True", exact: true });
        await ra.click();
        await expect(ra).toBeChecked();
        await tT.click();
        await expect(tT).toBeChecked();
        await shell.getByTestId("portal-course-submit-attempt").first().click();
        // After a passing submission, router.refresh() re-fetches the
        // page with `completion !== null`, which conditionally
        // unmounts the quiz section (and its `portal-course-quiz-passed`
        // div) and renders `portal-course-completed-banner` above.
        // Either confirmation means the pass took: check both and
        // require at least one to be visible.
        await expect(
          shell.locator('[data-testid="portal-course-quiz-passed"], [data-testid="portal-course-completed-banner"]').first(),
        ).toBeVisible({ timeout: 15_000 });
        await page.screenshot({ path: path.join(outDir, `${vp.label}-${runId}-08-final-passed.png`), fullPage: true });

        // ------- STEP 14: TRAININGCOMPLETION CREATED (server-side) -------
        const completion = await completionExistsOnServer(fixture);
        expect(completion.exists, `TrainingCompletion must exist for ${fixture.employeeNumber} / ${fixture.courseCode}`).toBe(true);
        expect(completion.score, "completion score must be set").not.toBeNull();
        expect(completion.completedAt, "completedAt must be set").not.toBeNull();

        // ------- STEP 15: REFRESH CONFIRMS DURABLE COMPLETION -------
        await page.goto(`${BASE}/employee/safety-training`, { waitUntil: "domcontentloaded" });
        await openIsolatedCourse(page, fixture);
        const shell2 = page.locator(shellSel);
        await expect(shell2.getByTestId("portal-course-completed-banner").first()).toBeVisible({ timeout: 15_000 });
        await page.screenshot({ path: path.join(outDir, `${vp.label}-${runId}-09-completion-persists.png`), fullPage: true });

        // Record console errors if any (non-fatal).
        if (consoleErrors.length > 0) {
          fs.writeFileSync(
            path.join(outDir, `${vp.label}-${runId}-console-errors.log`),
            consoleErrors.join("\n"),
          );
        }

        await ctx.close();
      } catch (e: any) {
        // Preserve diagnostics on failure per directive §3.
        if (fixture) {
          fs.writeFileSync(
            path.join(outDir, `${vp.label}-${runId}-FAILURE-fixture.json`),
            JSON.stringify({ runId: fixture.runId, email: fixture.email, employeeId: fixture.employeeId, courseVersionId: fixture.courseVersionId, errorMessage: e.message, consoleErrors }, null, 2),
          );
        }
        throw e;
      } finally {
        // Scoped teardown — only this test's fixture.
        if (fixture) {
          try {
            const td = teardownIsolatedFixture(runId);
            expect(td.ok).toBe(true);
            expect(td.summary.employeeDeleted).toBe(true);
            expect(td.summary.courseDeleted).toBe(true);
          } catch (e: any) {
            // eslint-disable-next-line no-console
            console.error(`[teardown] FAILED for ${runId}:`, e.message);
          }
        }
      }
    });
  }
});
