// EP-TRAIN-5D-2 (2026-11-02) — Founder-facing walkthrough screenshot capture.
//
// Captures the Training-tab view of Marc's employee profile + the
// RequireRetakeDialog opened state + the course-detail "Revise
// training" state. All READ-ONLY: no form submissions, no publish
// actions, no obligation creation. The dialog opens are closed via
// Escape before navigating away.

import { test } from "@playwright/test";
import path from "node:path";
import fs from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const outDir = path.resolve(process.cwd(), "test-results/ep-train-5d2-walkthrough");
fs.mkdirSync(outDir, { recursive: true });
const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";

const MARC_ID = "cmu0ndf4p001vk9md2ntmo2ck";
const FIRE_SAFETY_COURSE_ID = "cmvwwgs4k005gjjkgr20rxbv0";

test("5D-2 walkthrough: training tab + require-retake dialog open", async ({ browser }) => {
  const creds = stagingCredsAvailable();
  test.skip(!creds.ready, creds.reason ?? "staging creds missing");

  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await loginAsFounder(ctx);

  // 1) Marc's Training tab on employee profile.
  await page.goto(`${BASE}/app/admin/people/employees/${MARC_ID}?tab=training`, { waitUntil: "networkidle" });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(outDir, "07-employee-detail-marc-training-tab-1440x900.png"), fullPage: true });

  // 2) Require Retake dialog (open-only; close via Escape without submitting).
  await page.goto(`${BASE}/app/admin/people/safety-training/${FIRE_SAFETY_COURSE_ID}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(500);
  try {
    const btn = page.getByRole("button", { name: /require retake/i }).first();
    if (await btn.count() > 0) {
      await btn.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: path.join(outDir, "08-require-retake-dialog-step1-1440x900.png"), fullPage: true });
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
  } catch { /* best-effort */ }

  await ctx.close();
});
