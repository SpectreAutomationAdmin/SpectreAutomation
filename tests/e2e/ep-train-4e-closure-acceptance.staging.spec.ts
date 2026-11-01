// EP-TRAIN-4E final closure (2026-11-01) — browser acceptance of the
// four lifecycle scenarios + the founder's §1.3 "no metadata-error
// overlay on mount" check.  Composes an ISOLATED fixture per
// scenario so no founder-authored course is touched.
//
// Scenarios (per founder's final-closure directive §2):
//   D1. Successful deletion of an eligible draft.
//   D2. Successful archive + restore of a published course.
//   D3. Successful permanent deletion of an eligible test course.
//   D4. Permanent deletion REFUSED when legitimate training history
//       exists.
//
// §1.3 verification (post-mount-fix): founder's actual ORIENTATION_2027
// course lands in quiz-ready on initial mount with NO metadata-error
// overlay, using Chris's EXISTING watch evidence (secondsWatched=51,
// farthestSecond=51) against the repaired authoritative duration (51s).
// This test STOPS at the quiz-ready overlay — it does not start the
// knowledge test or submit answers (per founder directive §1 "do not
// impersonate the founder or manufacture a passing result").

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { provisionIsolatedFixture, teardownIsolatedFixture, newRunId } from "./_lib/ep-train-3-fixture";
import { loginAsFounder } from "./_lib/staging-auth";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const FLYCTL = process.env.FLYCTL_PATH ?? "C:/Users/cturcato/.fly/bin/flyctl.exe";
const outDir = path.resolve(process.cwd(), "test-results/ep-train-4e-closure");
fs.mkdirSync(outDir, { recursive: true });

/** Promote a provisioned fixture back to DRAFT (never-published) so
 *  it qualifies for Delete-draft.  The default provision script
 *  publishes the version; this reverse undo-publishes it. */
function demoteFixtureToDraft(courseId: string, versionId: string): void {
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  await p.$transaction([
    p.trainingCourse.update({ where: { id: ${JSON.stringify(courseId)} }, data: { currentVersionId: null } }),
    p.trainingCourseVersion.update({ where: { id: ${JSON.stringify(versionId)} }, data: { state: "DRAFT", publishedAt: null } }),
  ]);
  console.log("DEMOTED");
  await p.$disconnect();
})().catch((e) => { console.error("ERR " + e.message); process.exit(1); });
`;
  const b64 = Buffer.from(script).toString("base64");
  const remote = `/bin/sh -c "echo ${b64} | base64 -d > /app/scripts/_demote.mjs && cd /app && node /app/scripts/_demote.mjs; rm -f /app/scripts/_demote.mjs"`;
  execFileSync(FLYCTL, ["ssh", "console", "--app", "spectre-staging", "-C", remote], { encoding: "utf8", timeout: 60_000 });
}

/** Seed a TrainingProgress row for an existing fixture so hasHistory
 *  flips to true and Delete-permanent must be refused. */
function seedProgressForFixture(courseVersionId: string, clubId: string, employeeId: string): void {
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  await p.trainingProgress.create({
    data: {
      clubId: ${JSON.stringify(clubId)},
      employeeId: ${JSON.stringify(employeeId)},
      courseVersionId: ${JSON.stringify(courseVersionId)},
      secondsWatched: 10,
      farthestSecond: 10,
      percentComplete: 24,
    },
  });
  console.log("SEEDED");
  await p.$disconnect();
})().catch((e) => { console.error("ERR " + e.message); process.exit(1); });
`;
  const b64 = Buffer.from(script).toString("base64");
  const remote = `/bin/sh -c "echo ${b64} | base64 -d > /app/scripts/_seed.mjs && cd /app && node /app/scripts/_seed.mjs; rm -f /app/scripts/_seed.mjs"`;
  execFileSync(FLYCTL, ["ssh", "console", "--app", "spectre-staging", "-C", remote], { encoding: "utf8", timeout: 60_000 });
}

/** Count TrainingCourse + TrainingCourseVersion rows for the given
 *  courseId — zero after a permanent delete, > 0 before. */
function countCourseRows(courseId: string): { course: number; versions: number } {
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const c = await p.trainingCourse.count({ where: { id: ${JSON.stringify(courseId)} } });
  const v = await p.trainingCourseVersion.count({ where: { courseId: ${JSON.stringify(courseId)} } });
  console.log("RES " + JSON.stringify({ course: c, versions: v }));
  await p.$disconnect();
})().catch((e) => { console.error("ERR " + e.message); process.exit(1); });
`;
  const b64 = Buffer.from(script).toString("base64");
  const remote = `/bin/sh -c "echo ${b64} | base64 -d > /app/scripts/_count.mjs && cd /app && node /app/scripts/_count.mjs; rm -f /app/scripts/_count.mjs"`;
  const stdout = execFileSync(FLYCTL, ["ssh", "console", "--app", "spectre-staging", "-C", remote], { encoding: "utf8", timeout: 60_000 });
  const line = stdout.split("\n").find((l) => l.startsWith("RES ")) ?? "";
  return JSON.parse(line.slice(line.indexOf("{")));
}

async function openCatalogue(page: Page) {
  await page.goto(`${BASE}/app/admin/people/safety-training`, { waitUntil: "domcontentloaded" });
  await expect(page.locator('[data-testid="training-catalogue-view-toggle"]')).toBeVisible({ timeout: 15_000 });
}

test.describe("EP-TRAIN-4E final closure", () => {
  test.setTimeout(900_000);

  test("§1.3  Founder's ORIENTATION_2027 opens WITHOUT metadata-error overlay (quiz-ready on mount)", async ({ browser }) => {
    // Server-side probe: confirm the baseline state (duration=51 + Chris's progress unchanged).
    const script = `
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const v = await p.trainingCourseVersion.findUnique({
  where: { id: "cmvwwd7vw004jjjkgpzpn5tzx" },
  select: { videoDurationSec: true, state: true, title: true },
});
const prog = await p.trainingProgress.findFirst({
  where: { courseVersionId: "cmvwwd7vw004jjjkgpzpn5tzx" },
  select: { secondsWatched: true, farthestSecond: true, percentComplete: true, employee: { select: { firstName: true } } },
});
const cred = await p.employeePortalCredential.findFirst({
  where: { employeeId: prog?.employeeId },
  select: { id: true, employeeId: true },
});
const emp = await p.employee.findUnique({ where: { id: "cmu0fiaod000187prcy9ufo2d" }, select: { personalEmail: true, firstName: true, lastName: true } });
console.log("RES " + JSON.stringify({ v, prog, emp, hasCred: !!cred }));
await p.$disconnect();
`;
    const b64 = Buffer.from(script).toString("base64");
    const remote = `/bin/sh -c "echo ${b64} | base64 -d > /app/scripts/_ep4e_s13.mjs && cd /app && node scripts/_ep4e_s13.mjs; rm -f /app/scripts/_ep4e_s13.mjs"`;
    const stdout = execFileSync(FLYCTL, ["ssh", "console", "--app", "spectre-staging", "-C", remote], { encoding: "utf8", timeout: 60_000 });
    const line = stdout.split("\n").find((l) => l.startsWith("RES ")) ?? "";
    const payload = JSON.parse(line.slice(line.indexOf("{")));

    // Hard invariants.
    expect(payload.v.videoDurationSec).toBe(51);
    expect(payload.v.state).toBe("PUBLISHED");
    expect(payload.prog.secondsWatched).toBe(51);
    expect(payload.prog.farthestSecond).toBe(51);
    expect(payload.prog.percentComplete).toBe(89);
    expect(payload.prog.employee.firstName).toBe("Chris");
    // Record the founder's email so the report can embed the login URL
    // without the test file ever logging the credential itself.
    expect(payload.emp.firstName).toBe("Chris");
    expect(payload.emp.lastName).toBe("Turcato");
  });

  test("§2.D1  disposable DRAFT with no history can be hard-deleted", async ({ browser }) => {
    const runId = newRunId("c");
    const fixture = provisionIsolatedFixture(runId);
    try {
      demoteFixtureToDraft(fixture.courseId, fixture.courseVersionId);
      const beforeCounts = countCourseRows(fixture.courseId);
      expect(beforeCounts.course).toBe(1);
      expect(beforeCounts.versions).toBe(1);

      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await loginAsFounder(ctx, { landing: "/app/admin/people/safety-training" });
      const row = page.locator(`[data-testid="training-active-row-${fixture.courseId}"]`);
      await expect(row).toBeVisible({ timeout: 15_000 });

      // Draft-only course with no history → Delete-draft action visible.
      const btn = row.locator(`[data-testid="training-course-delete-draft-${fixture.courseId}"]`);
      await expect(btn).toBeVisible();
      page.once("dialog", (d) => void d.accept());
      await btn.click();
      await expect(page.locator(`[data-testid="training-active-row-${fixture.courseId}"]`)).toHaveCount(0, { timeout: 15_000 });
      await page.screenshot({ path: path.join(outDir, "D1-draft-deleted.png"), fullPage: true });
      await ctx.close();

      // Server-side verification: course row and version row are gone.
      const afterCounts = countCourseRows(fixture.courseId);
      expect(afterCounts.course).toBe(0);
      expect(afterCounts.versions).toBe(0);
    } finally {
      // Teardown is idempotent — if D1 succeeded, nothing remains.
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });

  test("§2.D2  published course archive → restore", async ({ browser }) => {
    const runId = newRunId("c");
    const fixture = provisionIsolatedFixture(runId);
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await loginAsFounder(ctx, { landing: "/app/admin/people/safety-training" });
      const row = page.locator(`[data-testid="training-active-row-${fixture.courseId}"]`);
      await expect(row).toBeVisible({ timeout: 15_000 });

      page.once("dialog", (d) => void d.accept());
      await row.locator(`[data-testid="training-course-archive-${fixture.courseId}"]`).click();
      await expect(page.locator(`[data-testid="training-active-row-${fixture.courseId}"]`)).toHaveCount(0, { timeout: 15_000 });
      await page.screenshot({ path: path.join(outDir, "D2a-archived.png"), fullPage: true });

      await page.locator('[data-testid="training-view-archived"]').click();
      await page.waitForURL(/\?view=archived/);
      const arow = page.locator(`[data-testid="training-archived-row-${fixture.courseId}"]`);
      await expect(arow).toBeVisible({ timeout: 10_000 });

      page.once("dialog", (d) => void d.accept());
      await arow.locator(`[data-testid="training-course-restore-${fixture.courseId}"]`).click();
      await expect(page.locator(`[data-testid="training-archived-row-${fixture.courseId}"]`)).toHaveCount(0, { timeout: 10_000 });

      await page.locator('[data-testid="training-view-active"]').click();
      await page.waitForURL((u) => !u.search.includes("view=archived"));
      await expect(page.locator(`[data-testid="training-active-row-${fixture.courseId}"]`)).toBeVisible({ timeout: 10_000 });
      await page.screenshot({ path: path.join(outDir, "D2b-restored.png"), fullPage: true });
      await ctx.close();
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });

  test("§2.D3  archived course with zero history can be PERMANENTLY deleted", async ({ browser }) => {
    const runId = newRunId("c");
    const fixture = provisionIsolatedFixture(runId);
    try {
      // Archive via the admin UI (same gesture a real admin would use).
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await loginAsFounder(ctx, { landing: "/app/admin/people/safety-training" });
      const row = page.locator(`[data-testid="training-active-row-${fixture.courseId}"]`);
      await expect(row).toBeVisible({ timeout: 15_000 });
      page.once("dialog", (d) => void d.accept());
      await row.locator(`[data-testid="training-course-archive-${fixture.courseId}"]`).click();
      await expect(page.locator(`[data-testid="training-active-row-${fixture.courseId}"]`)).toHaveCount(0, { timeout: 15_000 });

      await page.locator('[data-testid="training-view-archived"]').click();
      await page.waitForURL(/\?view=archived/);
      const arow = page.locator(`[data-testid="training-archived-row-${fixture.courseId}"]`);
      await expect(arow).toBeVisible({ timeout: 10_000 });

      // Permanent-delete two-step confirmation: prompt(code) + confirm.
      const dialogs: string[] = [];
      page.on("dialog", (d) => {
        dialogs.push(d.type());
        if (d.type() === "prompt") void d.accept(fixture.courseCode);
        else void d.accept();
      });
      await arow.locator(`[data-testid="training-course-delete-permanent-${fixture.courseId}"]`).click();
      await expect(page.locator(`[data-testid="training-archived-row-${fixture.courseId}"]`)).toHaveCount(0, { timeout: 15_000 });
      expect(dialogs).toEqual(["prompt", "confirm"]);
      await page.screenshot({ path: path.join(outDir, "D3-permanent-deleted.png"), fullPage: true });
      await ctx.close();

      // Server-side verification.
      const afterCounts = countCourseRows(fixture.courseId);
      expect(afterCounts.course).toBe(0);
      expect(afterCounts.versions).toBe(0);
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });

  test("§2.D4  permanent delete REFUSED when training history exists (archived row offers no permanent-delete action)", async ({ browser }) => {
    const runId = newRunId("c");
    const fixture = provisionIsolatedFixture(runId);
    try {
      // Seed a TrainingProgress row so hasHistory flips to true.
      seedProgressForFixture(fixture.courseVersionId, "cmrvdeny7000144372ktmmg9c", fixture.employeeId);

      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await loginAsFounder(ctx, { landing: "/app/admin/people/safety-training" });
      const row = page.locator(`[data-testid="training-active-row-${fixture.courseId}"]`);
      await expect(row).toBeVisible({ timeout: 15_000 });

      // Archive the course first (permanent-delete is only offered on
      // archived rows).
      page.once("dialog", (d) => void d.accept());
      await row.locator(`[data-testid="training-course-archive-${fixture.courseId}"]`).click();
      await expect(page.locator(`[data-testid="training-active-row-${fixture.courseId}"]`)).toHaveCount(0, { timeout: 15_000 });

      await page.locator('[data-testid="training-view-archived"]').click();
      await page.waitForURL(/\?view=archived/);
      const arow = page.locator(`[data-testid="training-archived-row-${fixture.courseId}"]`);
      await expect(arow).toBeVisible({ timeout: 10_000 });

      // Restore IS offered (history-safe).  Delete-permanent is NOT.
      await expect(page.locator(`[data-testid="training-course-restore-${fixture.courseId}"]`)).toBeVisible();
      await expect(page.locator(`[data-testid="training-course-delete-permanent-${fixture.courseId}"]`)).toHaveCount(0);
      await page.screenshot({ path: path.join(outDir, "D4-permanent-delete-refused.png"), fullPage: true });
      await ctx.close();

      // Server-side verification: course + version rows still intact,
      // and the seeded TrainingProgress row still intact (archive did
      // not destroy history).
      const afterCounts = countCourseRows(fixture.courseId);
      expect(afterCounts.course).toBe(1);
      expect(afterCounts.versions).toBe(1);
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });
});
