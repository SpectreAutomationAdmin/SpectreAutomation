// EP-TRAIN-5D-1 (2026-11-02) — READ-ONLY administrative Training module
// audit.  Logs in as the founder admin via loginAsFounder, walks every
// admin Training page + the employee-detail page, captures a full-page
// screenshot at 1440×900 per surface.  No destructive clicks.  No
// modifications to any legitimate course, employee, or obligation.
//
// Marc Maldiney's two outstanding INITIAL obligations and the founder's
// historical training records are untouched.

import { test, expect } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const outDir = path.resolve(process.cwd(), "test-results/ep-train-5d1-admin-audit");
fs.mkdirSync(outDir, { recursive: true });
const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

// Marc's employee id — the employee-detail screenshot targets his row
// since he is the pilot subject and will show the AssignTrainingButton
// + his OUTSTANDING INITIAL obligations in the Training section.  No
// mutation performed on his record.
const MARC_EMPLOYEE_ID = "cmu0ndf4p001vk9md2ntmo2ck";

// A representative Coulee Ridge course id for the course-detail +
// version-detail screenshots.  FIRE_SAFETY is a mandatory club-wide
// course with a current published v1 (per 5C-4A audit).
const FIRE_SAFETY_COURSE_ID = "cmvwwgs4k005gjjkgr20rxbv0";
const FIRE_SAFETY_VERSION_ID = "cmvwwgs5c005ijjkgt3zzuefw";

const PAGES: Array<{ label: string; path: string; wait?: string }> = [
  { label: "01-training-list",           path: "/app/admin/people/safety-training" },
  { label: "02-training-compliance",     path: "/app/admin/people/safety-training/compliance" },
  { label: "03-training-new",            path: "/app/admin/people/safety-training/new" },
  { label: "04-course-detail-fire",      path: `/app/admin/people/safety-training/${FIRE_SAFETY_COURSE_ID}` },
  { label: "05-version-detail-fire-v1",  path: `/app/admin/people/safety-training/${FIRE_SAFETY_COURSE_ID}/${FIRE_SAFETY_VERSION_ID}` },
  { label: "06-employee-detail-marc",    path: `/app/admin/people/employees/${MARC_EMPLOYEE_ID}` },
];

test.describe("EP-TRAIN-5D-1 :: admin training surface audit (READ-ONLY)", () => {
  test.setTimeout(600_000);

  test.beforeAll(() => {
    const creds = stagingCredsAvailable();
    if (!creds.ready) test.skip(true, creds.reason ?? "staging creds missing");
  });

  test("walk admin surfaces + screenshot each", async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);

    const results: Array<{ label: string; path: string; status: "OK" | "ERROR"; note?: string }> = [];
    for (const spec of PAGES) {
      const url = `${BASE}${spec.path}`;
      try {
        await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });
        // Give any lazy content a moment, no clicks.
        await page.waitForTimeout(800);
        await page.screenshot({ path: path.join(outDir, `${spec.label}-1440x900.png`), fullPage: true });
        results.push({ label: spec.label, path: spec.path, status: "OK" });
        console.log(`[5D-1] OK: ${spec.path}`);
      } catch (err) {
        const note = String((err as Error).message ?? err).slice(0, 240);
        await page.screenshot({ path: path.join(outDir, `${spec.label}-ERR-1440x900.png`), fullPage: true }).catch(() => {});
        results.push({ label: spec.label, path: spec.path, status: "ERROR", note });
        console.log(`[5D-1] ERROR: ${spec.path} :: ${note}`);
      }
    }

    // Additional viewport capture of the course-detail page (admin tablet).
    try {
      await page.setViewportSize({ width: 768, height: 1024 });
      await page.goto(`${BASE}/app/admin/people/safety-training/${FIRE_SAFETY_COURSE_ID}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(outDir, "04-course-detail-fire-768x1024.png"), fullPage: true });
    } catch { /* best-effort */ }

    await ctx.close();

    const summary = {
      runAt: new Date().toISOString(),
      results,
      outDir,
    };
    fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
    console.log("[5D-1] " + JSON.stringify(summary));

    // At least the training list must render.
    const listEntry = results.find((r) => r.label === "01-training-list");
    expect(listEntry?.status).toBe("OK");
  });
});
