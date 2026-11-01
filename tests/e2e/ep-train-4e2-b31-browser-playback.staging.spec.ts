// EP-TRAIN-4E-2 §4 (2026-11-01) — real-browser B31 playback.
//
// Loads the restored Workplace Safety Orientation video through
// the EMPLOYEE PORTAL and proves:
//   1. The <video> element reaches readyState >= 2 (HAVE_CURRENT_DATA)
//      — metadata loaded, first frames decoded.
//   2. The video advances past 0s during actual playback.
//   3. No MediaError fires on the element.
//
// The portal principal is a disposable fixture employee (via the
// EP-TRAIN-3 isolated-fixture harness).  B31_STAGING_ACCEPTANCE
// has `appliesToAll: true` so any Coulee Ridge employee carries
// applicability, allowing the fixture to access B31 directly
// without any modification to Chris's legitimate records.
//
// Preservation (per directive §5):
//   Chris's `TrainingProgress` row on B31 is snapshotted before
//   and after the test, and asserted unchanged.  The fixture
//   employee's actions NEVER touch Chris's rows.  The test does
//   NOT start a knowledge-test attempt, submit answers, or create
//   a completion.

import { test, expect, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { provisionIsolatedFixture, teardownIsolatedFixture, newRunId, type IsolatedFixture } from "./_lib/ep-train-3-fixture";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const FLYCTL = process.env.FLYCTL_PATH ?? "C:/Users/cturcato/.fly/bin/flyctl.exe";
const outDir = path.resolve(process.cwd(), "test-results/ep-train-4e2-b31-browser");
fs.mkdirSync(outDir, { recursive: true });

const B31_VERSION_ID = "cmt7twe5s00029z87bicm8qqb";

async function portalLogin(page: Page, f: IsolatedFixture): Promise<void> {
  await page.goto(`${BASE}/employee/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(f.email);
  await page.locator('input[name="password"]').fill(f.password);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/employee/login"), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
}

/** Snapshot Chris's TrainingProgress row for B31 before and after
 *  the test so we can assert zero drift. */
function snapshotChrisB31(): { secondsWatched: number; farthestSecond: number; percentComplete: number; updatedAt: string } | null {
  const script = `
import { createRequire } from "node:module";
const require = createRequire("/app/.next/standalone/node_modules/@prisma/client/");
const { PrismaClient } = require("@prisma/client");
const p = new PrismaClient();
(async () => {
  const row = await p.trainingProgress.findFirst({
    where: { employeeId: "cmu0fiaod000187prcy9ufo2d", courseVersionId: "cmt7twe5s00029z87bicm8qqb" },
    select: { secondsWatched: true, farthestSecond: true, percentComplete: true, updatedAt: true },
  });
  console.log("SNAP " + JSON.stringify(row ? { ...row, updatedAt: row.updatedAt.toISOString() } : null));
  await p.$disconnect();
})().catch((e) => { console.error("ERR " + e.message); process.exit(1); });
`;
  const b64 = Buffer.from(script).toString("base64");
  const remote = `/bin/sh -c "echo ${b64} | base64 -d > /app/scripts/_sn.mjs && cd /app && node scripts/_sn.mjs; rm -f /app/scripts/_sn.mjs"`;
  const stdout = execFileSync(FLYCTL, ["ssh", "console", "--app", "spectre-staging", "-C", remote], { encoding: "utf8", timeout: 60_000 });
  const line = stdout.split("\n").find((l) => l.startsWith("SNAP ")) ?? "";
  return JSON.parse(line.slice(line.indexOf("{")));
}

test.describe("EP-TRAIN-4E-2 :: B31 actual browser playback", () => {
  test.setTimeout(300_000);

  test("Workplace Safety Orientation plays in the portal: readyState >= 2, currentTime advances, no MediaError", async ({ browser }) => {
    const before = snapshotChrisB31();
    expect(before).not.toBeNull();

    const runId = newRunId("bp");
    const fixture = provisionIsolatedFixture(runId);
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    try {
      const page = await ctx.newPage();
      await portalLogin(page, fixture);

      // Open B31_STAGING_ACCEPTANCE directly (appliesToAll=true, so
      // the fixture employee carries applicability).  No fixture-
      // owned course is touched here.
      await page.goto(`${BASE}/employee/safety-training/${B31_VERSION_ID}`, { waitUntil: "domcontentloaded" });
      await page.waitForSelector('[data-testid="portal-course-video"]', { state: "attached", timeout: 30_000 });

      // Kick the browser into actually fetching + playing.  preload=auto
      // alone isn't aggressive enough in headless Chromium.
      await page.evaluate(async () => {
        const vs = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
        for (const v of vs) {
          try {
            v.muted = true;
            v.load();
            await v.play().catch(() => { /* autoplay refusal is fine, load() is what we need */ });
          } catch { /* noop */ }
        }
      });

      // Wait for readyState >= 2 (HAVE_CURRENT_DATA).
      await page.waitForFunction(() => {
        const vs = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
        return vs.some((v) => v.readyState >= 2 && Number.isFinite(v.duration) && v.duration > 0);
      }, undefined, { timeout: 60_000 });

      // Snapshot: initial currentTime should be 0 (completed-course
      // reset from EP-TRAIN-4E-1).
      const initial = await page.evaluate(() => {
        const vs = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
        const v = vs.find((x) => x.offsetParent !== null) ?? vs[0];
        return {
          readyState: v.readyState,
          currentTime: v.currentTime,
          duration: v.duration,
          error: v.error ? { code: v.error.code, message: v.error.message } : null,
        };
      });
      expect(initial.readyState).toBeGreaterThanOrEqual(2);
      expect(initial.currentTime).toBeLessThan(0.5);
      expect(initial.duration).toBeGreaterThan(10);
      expect(initial.error).toBeNull();
      await page.screenshot({ path: path.join(outDir, "01-B31-readystate2-currenttime0.png"), fullPage: true });

      // Let playback run for 2s + poll currentTime.
      await page.evaluate(() => {
        const vs = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
        for (const v of vs) { v.muted = true; v.play().catch(() => {}); }
      });
      await page.waitForFunction(() => {
        const vs = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
        return vs.some((v) => v.currentTime > 0.5 && !v.error);
      }, undefined, { timeout: 30_000 });
      const advanced = await page.evaluate(() => {
        const vs = Array.from(document.querySelectorAll('[data-testid="portal-course-video"]')) as HTMLVideoElement[];
        const v = vs.find((x) => x.currentTime > 0.5) ?? vs[0];
        return {
          currentTime: v.currentTime,
          error: v.error ? { code: v.error.code, message: v.error.message } : null,
          paused: v.paused,
          ended: v.ended,
        };
      });
      expect(advanced.currentTime).toBeGreaterThan(0.5);
      expect(advanced.error).toBeNull();
      await page.screenshot({ path: path.join(outDir, "02-B31-currenttime-advanced.png"), fullPage: true });

      await ctx.close();
    } finally {
      try { await ctx.close(); } catch { /* already closed */ }
      try { teardownIsolatedFixture(runId); } catch { /* noop */ }
    }

    // Preservation check: Chris's TrainingProgress row for B31 is
    // unchanged by this test.  The fixture employee is a different
    // employeeId, so the browser's progress writes (if any) go
    // against the fixture's own row — Chris's row remains frozen.
    const after = snapshotChrisB31();
    expect(after).toEqual(before);
  });
});
