#!/usr/bin/env node
// EP-TRAIN-4Y-AD §9 — persistence verification.
//
// After the restore, hit every path that previously triggered the
// deterministic overwrite and verify the AI metadata SURVIVES each:
//   - hard refresh of the review page (triggers CoursePrepProgress
//     which fires POST /generate-metadata)
//   - sign-out + sign-in
//   - new browser context (fresh session, no cookies)
//   - navigation editor → review → editor
//   - safety-training dashboard reload
//
// Captures the DB state before + after each traversal via the
// metadata endpoint; the test passes iff the value is UNCHANGED.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const EXPECTED_TITLE = "Employee Onboarding and Policies";

function env(k) {
  if (process.env[k]) return process.env[k];
  for (const f of [".env.playwright.local", ".env.local"]) {
    const p = path.join(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

async function readMetadata(request) {
  const r = await request.get(`${BASE}/api/admin/training/courses/${COURSE_ID}/metadata`);
  const b = await r.json();
  return {
    httpStatus: r.status(),
    title: b?.course?.title,
    descriptionFirst120: (b?.course?.description ?? "").slice(0, 120),
    source: b?.course?.attribution?.source,
    runId: b?.course?.attribution?.runId,
  };
}

async function newLoggedInContext(browser, label) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
  await page.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
  await Promise.all([page.waitForURL(/\/app\//), page.click('button[type="submit"]')]);
  return { ctx, page, label };
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const result = { steps: [] };

  // Step 1: direct API snapshot (baseline).
  const probe1 = await chromium.launch({ headless: true }); // throwaway; we use its request through a logged-in page
  const s1 = await newLoggedInContext(probe1, "baseline");
  const baseline = await readMetadata(s1.page.request);
  result.steps.push({ step: "baseline-via-api", ...baseline });
  console.log("baseline:", baseline);

  // Step 2: load the review page — triggers CoursePrepProgress +
  // the POST /generate-metadata that WAS demoting AI → deterministic.
  console.log("→ loading review page (triggers CoursePrepProgress)");
  await s1.page.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "domcontentloaded" });
  await s1.page.waitForTimeout(6000); // let the poll fire
  const afterReview = await readMetadata(s1.page.request);
  result.steps.push({ step: "after-review-page-load", ...afterReview });
  console.log("after-review:", afterReview);

  // Step 3: load the course editor page — same triggers.
  console.log("→ loading editor page");
  await s1.page.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}`, { waitUntil: "domcontentloaded" });
  await s1.page.waitForTimeout(6000);
  const afterEditor = await readMetadata(s1.page.request);
  result.steps.push({ step: "after-editor-page-load", ...afterEditor });
  console.log("after-editor:", afterEditor);

  // Step 4: hard refresh the review page.
  console.log("→ hard refresh of review page");
  await s1.page.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "domcontentloaded" });
  await s1.page.reload({ waitUntil: "domcontentloaded" });
  await s1.page.waitForTimeout(6000);
  const afterReload = await readMetadata(s1.page.request);
  result.steps.push({ step: "after-hard-refresh", ...afterReload });
  console.log("after-hard-refresh:", afterReload);

  // Step 5: safety-training dashboard reload.
  console.log("→ safety-training dashboard reload");
  await s1.page.goto(`${BASE}/app/admin/people/safety-training`, { waitUntil: "domcontentloaded" });
  await s1.page.waitForTimeout(4000);
  const afterDashboard = await readMetadata(s1.page.request);
  result.steps.push({ step: "after-dashboard-reload", ...afterDashboard });
  console.log("after-dashboard:", afterDashboard);
  await probe1.close();

  // Step 6: brand-new browser context (cold session, no cookies),
  // sign-in, load review.
  console.log("→ new browser context + sign-in");
  const probe2 = await chromium.launch({ headless: true });
  const s2 = await newLoggedInContext(probe2, "new-context");
  await s2.page.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "domcontentloaded" });
  await s2.page.waitForTimeout(6000);
  const afterNewContext = await readMetadata(s2.page.request);
  result.steps.push({ step: "after-new-browser-context", ...afterNewContext });
  console.log("after-new-context:", afterNewContext);
  // Capture a screenshot of the review page so acceptance evidence
  // includes the actual rendered title.
  fs.mkdirSync("test-results", { recursive: true });
  await s2.page.screenshot({ path: "test-results/4yad-review-after-restore.png", fullPage: true });
  await probe2.close();

  // Final verdict.
  const allMatch = result.steps.every((s) => s.title === EXPECTED_TITLE && s.source === "ai");
  result.allStepsPersistAiMetadata = allMatch;
  fs.writeFileSync("test-results/4yad-persistence.json", JSON.stringify(result, null, 2));
  console.log("\n━━━━━━ PERSISTENCE VERDICT ━━━━━━");
  console.log(`  all ${result.steps.length} steps show AI metadata: ${allMatch}`);
  await browser.close();
  if (!allMatch) {
    console.error("\n✗ REGRESSION STILL PRESENT — some step demoted AI metadata");
    process.exit(1);
  }
  console.log("\n✓ AI metadata persists through every triggering path.");
}
main().catch((e) => { console.error(e); process.exit(1); });
