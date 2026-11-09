#!/usr/bin/env node
// EP-TRAIN-4Y-Z §6 — one-shot authorized live pilot.
//
// Fires ONE authenticated POST to /generate with 5 checkpoints + 10
// final-assessment questions using the ONE_PER_GROUP strategy, then
// watches /generation-status until terminal.
//
// Deliberately does NOT call /generate-metadata — the deterministic
// fallback. All metadata is produced by Qwen inside the worker via
// maybeGenerateCourseMetadata. The directive's §6 is explicit: "One
// professional AI-generated course title. One grounded AI-generated
// course description."
//
// Budget guard: per-pilot $1 ceiling is enforced inside the worker
// (pilot-budget-guard.ts). On trip, the worker fails with
// PILOT_BUDGET_EXCEEDED (non-retryable), which this script will
// surface as a FAILED state transition.
//
// Retry policy: the worker enforces maxAttempts=2 at the generation-run
// level. §6 of the directive: "if the first attempt fails, inspect its
// error classification BEFORE permitting an automatic retry. A
// non-retryable or unexplained failure must not trigger another GPU
// invocation." This script surfaces every state transition so a human
// reviewer can halt if attempt 1 fails with an unexpected code.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";

function env(k) {
  if (process.env[k]) return process.env[k];
  for (const f of [".env.playwright.local", ".env.staging.local", ".env.local"]) {
    const p = path.join(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}

const FOUNDER_EMAIL = env("SPECTRE_STAGING_EMAIL") ?? env("FOUNDER_EMAIL");
const FOUNDER_PASSWORD = env("SPECTRE_STAGING_PASSWORD") ?? env("FOUNDER_PASSWORD");

if (!FOUNDER_EMAIL || !FOUNDER_PASSWORD) {
  console.error("ERROR: SPECTRE_STAGING_EMAIL + SPECTRE_STAGING_PASSWORD required.");
  process.exit(2);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  const page = await ctx.newPage();

  console.log(`→ ${BASE}/login as ${FOUNDER_EMAIL}`);
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"], input[name="email"]', FOUNDER_EMAIL);
  await page.fill('input[type="password"], input[name="password"]', FOUNDER_PASSWORD);
  await Promise.all([
    page.waitForURL(/\/app\//, { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
  console.log(`  logged in`);

  // ─── Step 1: fire /generate ─────────────────────────────────────
  console.log("\n--- §6 fire 5+10 ONE_PER_GROUP ---");
  const fireStart = Date.now();
  const genResp = await page.request.post(
    `${BASE}/api/admin/training/versions/${VERSION_ID}/generate`,
    {
      headers: { "Content-Type": "application/json" },
      data: {
        checkpointCount: 5,
        finalCount: 10,
        checkpointGroupStrategy: "ONE_PER_GROUP",
      },
    },
  );
  const genBody = await genResp.json();
  console.log(`  status=${genResp.status()} body=${JSON.stringify(genBody)}`);
  if (!genResp.ok() || !genBody.ok) {
    console.error("FIRE FAILED — aborting without GPU use.");
    await browser.close();
    process.exit(1);
  }
  const runId = genBody.generationRunId;
  console.log(`  RUN_ID: ${runId}`);
  console.log(`  idempotent: ${genBody.idempotent}  state: ${genBody.state}`);

  // ─── Step 2: watch generation-status ────────────────────────────
  console.log("\n--- §6 watching generation-status ---");
  const deadline = Date.now() + 30 * 60 * 1000; // 30 min wall time ceiling
  let lastState = "";
  let completedBody = null;
  let terminated = null;
  while (Date.now() < deadline) {
    const r = await page.request.get(
      `${BASE}/api/admin/training/versions/${VERSION_ID}/generation-status`,
    );
    const b = await r.json().catch(() => ({ state: "ERROR" }));
    if (b.state !== lastState) {
      console.log(
        `  t+${Math.round((Date.now() - fireStart) / 1000)}s state=${b.state} ${JSON.stringify(b).slice(0, 500)}`,
      );
      lastState = b.state;
    }
    if (b.state === "COMPLETED") {
      completedBody = b;
      break;
    }
    if (b.state === "FAILED" || b.state === "CANCELLED") {
      terminated = b;
      break;
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  const wallSec = Math.round((Date.now() - fireStart) / 1000);

  if (terminated) {
    console.error(
      `\nGENERATION TERMINATED (${terminated.state}) in ${wallSec}s. ` +
      `code=${terminated.executionErrorCode} message=${terminated.executionErrorMessage}`,
    );
    console.error(`Per §6 directive: inspect error classification BEFORE retry.`);
    await browser.close();
    process.exit(1);
  }
  if (!completedBody) {
    console.error(`TIMEOUT waiting for generation to complete (${wallSec}s)`);
    await browser.close();
    process.exit(1);
  }
  console.log(`  COMPLETED in ${wallSec}s`);

  // ─── Step 3: read course metadata post-pilot ────────────────────
  console.log("\n--- §6 course metadata after worker completed ---");
  const mdResp = await page.request.get(
    `${BASE}/api/admin/training/courses/${COURSE_ID}/metadata`,
  );
  if (mdResp.ok()) {
    const mdBody = await mdResp.json();
    const c = mdBody.course ?? {};
    console.log(`  title: ${c.title}`);
    console.log(`  description: ${c.description?.slice(0, 200) ?? "(none)"}`);
    console.log(`  attributionSource: ${c.aiMetadataAttributionSource ?? "(none)"}`);
    console.log(`  attributionRunId: ${c.aiMetadataAttributionRunId ?? "(none)"}`);
    console.log(`  attributionAt: ${c.aiMetadataAttributionAt ?? "(none)"}`);
  } else {
    console.log(`  (metadata endpoint HTTP ${mdResp.status()})`);
  }

  // ─── Step 4: visit review page + screenshot ─────────────────────
  console.log("\n--- §7 capturing manager-review screenshots ---");
  await page.goto(
    `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForTimeout(5000);
  const h1 = await page.locator("h1").first().textContent().catch(() => null);
  console.log(`  review H1: "${h1}"`);
  const screenshotRoot = "test-results";
  if (!fs.existsSync(screenshotRoot)) fs.mkdirSync(screenshotRoot, { recursive: true });
  await page.screenshot({ path: `${screenshotRoot}/4yz-review-full.png`, fullPage: true });
  console.log(`  screenshot: ${screenshotRoot}/4yz-review-full.png`);

  // Counts from the completed body's draft breakdown (authoritative):
  const breakdown = completedBody.draftBreakdown ?? {};
  const totalDrafts = completedBody.draftCount ?? 0;
  console.log(`\n  draftCount: ${totalDrafts}`);
  console.log(`  breakdown: ${JSON.stringify(breakdown)}`);

  // ─── Step 5: summary ────────────────────────────────────────────
  console.log("\n━━━━━━━━━━━━━━ 4Y-Z PILOT SUMMARY ━━━━━━━━━━━━━━");
  console.log(`  RUN_ID:         ${runId}`);
  console.log(`  wall time:      ${wallSec}s`);
  console.log(`  review H1:      "${h1}"`);
  console.log(`  total drafts:   ${totalDrafts} (target was 15: 5 CP + 10 FA)`);
  console.log(`  breakdown:      ${JSON.stringify(breakdown)}`);
  console.log(`  shortfall:      ${JSON.stringify(completedBody.shortfall)?.slice(0, 200) ?? "(none)"}`);
  console.log(`  screenshot:     ${screenshotRoot}/4yz-review-full.png`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

  // Export a machine-readable summary for the acceptance report.
  const summary = {
    runId,
    wallSec,
    state: completedBody.state,
    attempts: completedBody.attempts,
    draftCount: totalDrafts,
    draftBreakdown: breakdown,
    shortfall: completedBody.shortfall,
    reviewH1: h1,
    screenshotPath: `${screenshotRoot}/4yz-review-full.png`,
    firedAt: new Date(fireStart).toISOString(),
  };
  fs.writeFileSync(
    `${screenshotRoot}/4yz-pilot-summary.json`,
    JSON.stringify(summary, null, 2),
  );
  console.log(`  summary JSON:   ${screenshotRoot}/4yz-pilot-summary.json`);

  await browser.close();
}

main().catch((err) => {
  console.error("FATAL:", err?.stack ?? err);
  process.exit(1);
});
