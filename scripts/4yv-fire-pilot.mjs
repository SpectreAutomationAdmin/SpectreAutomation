#!/usr/bin/env node
// EP-TRAIN-4Y-V V-3 — one-shot pilot orchestrator.
//
// Fires ONE authenticated POST to /generate with the 5+10 ONE_PER_GROUP
// override, then watches /generation-status until COMPLETED. Also
// fires /generate-metadata (idempotent). Prints everything the
// acceptance report needs: run ID, state transitions, timing,
// Modal call counts.
//
// Intentionally NOT a Playwright spec — it's a flat Node script so
// the operator has a single `npm run pilot:4yv` style invocation.
// Authentication reuses the staging-auth helper by shelling out to
// Playwright's authenticated request context via a tiny wrapper.
//
// Alternatively, this script can read a founder session cookie from
// FOUNDER_SESSION_COOKIE env var. For 4Y-V's pilot run, the Playwright
// path is preferred so the audit trail shows the founder as the
// authenticated principal.

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
  console.error(
    "ERROR: SPECTRE_STAGING_EMAIL + SPECTRE_STAGING_PASSWORD env vars required (or .env.playwright.local).",
  );
  process.exit(2);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  const page = await ctx.newPage();

  console.log(`→ ${BASE}/login`);
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[type="email"], input[name="email"]', FOUNDER_EMAIL);
  await page.fill('input[type="password"], input[name="password"]', FOUNDER_PASSWORD);
  await Promise.all([
    page.waitForURL(/\/app\//, { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);
  console.log(`  logged in as ${FOUNDER_EMAIL}`);

  // ── Step 1: fire /generate
  console.log("\n--- V-3 §3 fire 5+10 ONE_PER_GROUP ---");
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
    console.error("FIRE FAILED");
    process.exit(1);
  }
  const runId = genBody.generationRunId;
  console.log(`  RUN_ID: ${runId}`);
  console.log(`  idempotent: ${genBody.idempotent}  state: ${genBody.state}`);

  // ── Step 2: fire /generate-metadata (idempotent on retry)
  console.log("\n--- V-3 §4 fire /generate-metadata (Qwen title + description) ---");
  const mdResp = await page.request.post(
    `${BASE}/api/admin/training/versions/${VERSION_ID}/generate-metadata`,
  );
  const mdBody = await mdResp.json();
  console.log(`  status=${mdResp.status()} body=${JSON.stringify(mdBody).slice(0, 500)}`);

  // ── Step 3: watch generation-status
  console.log("\n--- V-3 §6 watching generation-status ---");
  const deadline = Date.now() + 20 * 60 * 1000;
  let lastState = "";
  let completedBody = null;
  while (Date.now() < deadline) {
    const r = await page.request.get(
      `${BASE}/api/admin/training/versions/${VERSION_ID}/generation-status`,
    );
    const b = await r.json().catch(() => ({ state: "ERROR" }));
    if (b.state !== lastState) {
      console.log(
        `  t+${Math.round((Date.now() - fireStart) / 1000)}s state=${b.state} ${JSON.stringify(b).slice(0, 400)}`,
      );
      lastState = b.state;
    }
    if (b.state === "COMPLETED") {
      completedBody = b;
      break;
    }
    if (b.state === "FAILED" || b.state === "CANCELLED") {
      console.error("GENERATION TERMINATED:", JSON.stringify(b));
      await browser.close();
      process.exit(1);
    }
    await new Promise((r) => setTimeout(r, 15_000));
  }
  if (!completedBody) {
    console.error("TIMEOUT waiting for generation to complete");
    await browser.close();
    process.exit(1);
  }
  const wallSec = Math.round((Date.now() - fireStart) / 1000);
  console.log(`  COMPLETED in ${wallSec}s`);

  // ── Step 4: visit review page and screenshot
  console.log("\n--- V-3 §7 capturing review screenshot ---");
  await page.goto(
    `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForTimeout(3000);
  const h1 = await page.locator("h1").first().textContent().catch(() => null);
  console.log(`  review H1: "${h1}"`);
  await page.screenshot({ path: "test-results/4yv-review-populated.png", fullPage: true });

  // ── Step 5: summary
  console.log("\n--- V-3 PILOT SUMMARY ---");
  console.log(`  RUN_ID:             ${runId}`);
  console.log(`  metadata outcome:   ${mdBody.applied ? `applied (${mdBody.metadata?.inferenceSource})` : mdBody.skippedReason}`);
  console.log(`  metadata title:     ${mdBody.metadata?.title ?? "(unchanged)"}`);
  console.log(`  wall time:          ${wallSec}s`);
  console.log(`  completed payload:  ${JSON.stringify(completedBody).slice(0, 500)}`);
  console.log(`  review H1:          "${h1}"`);
  console.log(`  screenshot:         test-results/4yv-review-populated.png`);

  await browser.close();
  console.log("\nDONE. Proceed to V-4 acceptance report.");
}

main().catch((err) => {
  console.error("FATAL:", err?.stack ?? err);
  process.exit(1);
});
