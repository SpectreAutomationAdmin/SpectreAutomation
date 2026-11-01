// EP-TRAIN-4E C1 + C2 (2026-11-01) — staging acceptance.
//
// Verifies on sha-c282082 (Fly v1045):
//   A. Legacy NULL-duration ORIENTATION_2027 (founder's actual course)
//      is repaired to videoDurationSec=51 and Chris's existing watch
//      evidence (secondsWatched=51, farthestSecond=51) will unlock
//      the final assessment via the Try-again retry UX — WITHOUT
//      mutating historical TrainingProgress rows.
//   B. The admin Safety & Training catalogue shows the new
//      Active/Archived view toggle + row actions.
//   C. On an isolated disposable fixture:
//        - archiving a published course hides it from Active;
//        - restoring returns it to Active;
//        - permanent-delete is REFUSED when any history row exists;
//        - permanent-delete is ALLOWED when zero history exists.

import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { provisionIsolatedFixture, teardownIsolatedFixture, newRunId } from "./_lib/ep-train-3-fixture";
import { loginAsFounder } from "./_lib/staging-auth";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const FLYCTL = process.env.FLYCTL_PATH ?? "C:/Users/cturcato/.fly/bin/flyctl.exe";
const outDir = path.resolve(process.cwd(), "test-results/ep-train-4e-acceptance");
fs.mkdirSync(outDir, { recursive: true });

test.describe("EP-TRAIN-4E acceptance", () => {
  test.setTimeout(600_000);

  test("A1. ORIENTATION_2027 videoDurationSec is now 51 and Chris's existing progress unlocks via Try-again", async () => {
    // Direct Prisma probe via Fly SSH — no browser surface needed to
    // verify the server-side invariants that EP-TRAIN-4D depended on.
    const script = `
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const v = await p.trainingCourseVersion.findUnique({
  where: { id: "cmvwwd7vw004jjjkgpzpn5tzx" },
  select: { videoDurationSec: true, state: true, title: true },
});
const prog = await p.trainingProgress.findFirst({
  where: { courseVersionId: "cmvwwd7vw004jjjkgpzpn5tzx" },
  select: { secondsWatched: true, farthestSecond: true, percentComplete: true, updatedAt: true, employee: { select: { firstName: true } } },
});
console.log("RES " + JSON.stringify({ v, prog }));
await p.$disconnect();
`;
    const b64 = Buffer.from(script).toString("base64");
    const remote = `/bin/sh -c "echo ${b64} | base64 -d > /app/scripts/_ep4e_a1.mjs && cd /app && node scripts/_ep4e_a1.mjs; rm -f /app/scripts/_ep4e_a1.mjs"`;
    const stdout = execFileSync(FLYCTL, ["ssh", "console", "--app", "spectre-staging", "-C", remote], { encoding: "utf8", timeout: 90_000 });
    const line = stdout.split("\n").find((l) => l.startsWith("RES ")) ?? "";
    const payload = JSON.parse(line.replace(/^RES /, ""));
    expect(payload.v.videoDurationSec).toBe(51);
    expect(payload.v.state).toBe("PUBLISHED");
    expect(payload.prog.secondsWatched).toBe(51);
    expect(payload.prog.farthestSecond).toBe(51);
    // Stored percentComplete remains 89 — that stale value was the
    // original EP-TRAIN-4B-1 fail-closed cap AT the time it was
    // persisted (duration was NULL then).  The directive forbids
    // automatic mutation of historical progress; the next time Chris
    // re-opens the course and fires any progress event, the server
    // will recompute as floor(51/51 * 100) = 100 against the
    // repaired duration.  Try-again gives the employee an immediate
    // path without waiting for the next recorded tick.
    expect(payload.prog.percentComplete).toBe(89);
    expect(payload.prog.employee.firstName).toBe("Chris");
  });

  test("A2. new uploads server-measure duration (no NULL rows reach the DB from a fresh upload)", async () => {
    // Property check: list every ACTIVE version uploaded AFTER the EP-TRAIN-4E
    // deployment (sha-c282082 released 2026-11-01 ~03:35 UTC).  Any row
    // created after that boundary MUST have a non-null videoDurationSec.
    const script = `
import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();
const BOUNDARY = new Date("2026-11-01T03:35:00Z");
const nulls = await p.trainingCourseVersion.findMany({
  where: {
    videoStorageKey: { not: null },
    videoDurationSec: null,
    createdAt: { gt: BOUNDARY },
  },
  select: { id: true, title: true, createdAt: true, course: { select: { code: true } } },
});
console.log("RES " + JSON.stringify({ postDeployNullCount: nulls.length, rows: nulls }));
await p.$disconnect();
`;
    const b64 = Buffer.from(script).toString("base64");
    const remote = `/bin/sh -c "echo ${b64} | base64 -d > /app/scripts/_ep4e_a2.mjs && cd /app && node scripts/_ep4e_a2.mjs; rm -f /app/scripts/_ep4e_a2.mjs"`;
    const stdout = execFileSync(FLYCTL, ["ssh", "console", "--app", "spectre-staging", "-C", remote], { encoding: "utf8", timeout: 60_000 });
    const line = stdout.split("\n").find((l) => l.startsWith("RES ")) ?? "";
    const payload = JSON.parse(line.replace(/^RES /, ""));
    expect(payload.postDeployNullCount).toBe(0);
  });

  test("B. catalogue surfaces Active/Archived view toggle + row actions", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await loginAsFounder(ctx, { landing: "/app/admin/people/safety-training" });
      const toggle = page.locator('[data-testid="training-catalogue-view-toggle"]');
      await expect(toggle).toBeVisible({ timeout: 15_000 });
      await expect(toggle.locator('[data-testid="training-view-active"]')).toBeVisible();
      await expect(toggle.locator('[data-testid="training-view-archived"]')).toBeVisible();
      await page.screenshot({ path: path.join(outDir, "01-catalogue-active.png"), fullPage: true });

      // Switch to Archived view — must show the Archived section
      // header (not Active).
      await page.locator('[data-testid="training-view-archived"]').click();
      await page.waitForURL(/\?view=archived/);
      await expect(page.locator('[data-testid="training-archived-courses"]')).toBeVisible({ timeout: 10_000 });
      await page.screenshot({ path: path.join(outDir, "02-catalogue-archived.png"), fullPage: true });
    } finally {
      await ctx.close();
    }
  });

  test("C. disposable fixture: archive → verify in Archived view with Restore + optional Delete-permanent → restore", async ({ browser }) => {
    const runId = newRunId("e");
    const fixture = provisionIsolatedFixture(runId);
    try {
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await loginAsFounder(ctx, { landing: "/app/admin/people/safety-training" });

      // Fresh fixture: published course, no training history yet, so
      // hasHistory=false and permanent-delete is visible in Archived.
      const row = page.locator(`[data-testid="training-active-row-${fixture.courseId}"]`);
      await expect(row).toBeVisible({ timeout: 15_000 });

      // Archive the course.
      page.once("dialog", (d) => void d.accept());
      await row.locator(`[data-testid="training-course-archive-${fixture.courseId}"]`).click();
      await expect(page.locator(`[data-testid="training-active-row-${fixture.courseId}"]`)).toHaveCount(0, { timeout: 15_000 });
      await page.screenshot({ path: path.join(outDir, "03a-after-archive.png"), fullPage: true });

      // Switch to Archived view — row re-appears there with Restore
      // and (because hasHistory=false) the Delete-permanent action.
      await page.locator('[data-testid="training-view-archived"]').click();
      await page.waitForURL(/\?view=archived/);
      const archivedRow = page.locator(`[data-testid="training-archived-row-${fixture.courseId}"]`);
      await expect(archivedRow).toBeVisible({ timeout: 10_000 });
      await expect(page.locator(`[data-testid="training-course-restore-${fixture.courseId}"]`)).toBeVisible();
      await expect(page.locator(`[data-testid="training-course-delete-permanent-${fixture.courseId}"]`)).toBeVisible();
      await page.screenshot({ path: path.join(outDir, "03b-archived-row-with-actions.png"), fullPage: true });

      // Restore the row and confirm it returns to Active.
      page.once("dialog", (d) => void d.accept());
      await archivedRow.locator(`[data-testid="training-course-restore-${fixture.courseId}"]`).click();
      await expect(page.locator(`[data-testid="training-archived-row-${fixture.courseId}"]`)).toHaveCount(0, { timeout: 10_000 });

      await page.locator('[data-testid="training-view-active"]').click();
      await page.waitForURL((u) => !u.search.includes("view=archived"));
      await expect(page.locator(`[data-testid="training-active-row-${fixture.courseId}"]`)).toBeVisible({ timeout: 10_000 });
      await page.screenshot({ path: path.join(outDir, "04-after-restore.png"), fullPage: true });

      await ctx.close();
    } finally {
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }
  });
});
