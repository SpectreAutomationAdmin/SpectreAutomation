#!/usr/bin/env node
// EP-TRAIN-4Y-V V-2 — HTTP pre-flight (no SSH, no mutation).
// Reads /generation-status + /transcription-status for the founder
// course. Reports whether the pilot is clear to fire, without
// visiting /auto-prepare (which would auto-trigger a default-plan
// run on the V-1 deploy).

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";

function envOrFile(k) {
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

const EMAIL = envOrFile("SPECTRE_STAGING_EMAIL");
const PASSWORD = envOrFile("SPECTRE_STAGING_PASSWORD");
if (!EMAIL || !PASSWORD) {
  console.error("Missing SPECTRE_STAGING_EMAIL / SPECTRE_STAGING_PASSWORD");
  process.exit(2);
}

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
const page = await ctx.newPage();

console.log(`→ login as ${EMAIL}`);
await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await page.locator('input[name="email"]').fill(EMAIL);
await page.locator('input[name="password"]').fill(PASSWORD);
await Promise.all([
  page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30000 }),
  page.locator('form button[type="submit"]').first().click(),
]);
console.log("  logged in");

console.log(`\n→ /transcription-status`);
const tResp = await page.request.get(
  `${BASE}/api/admin/training/versions/${VERSION_ID}/transcription-status`,
);
const t = await tResp.json();
console.log(`  status=${tResp.status()} state=${t.state} reason=${t.reason ?? ""}`);
console.log(`  buildId=${t.transcript?.buildId ?? "(none)"} segments=${t.transcript?.segmentCount ?? 0}`);

console.log(`\n→ /generation-status`);
const gResp = await page.request.get(
  `${BASE}/api/admin/training/versions/${VERSION_ID}/generation-status`,
);
const g = await gResp.json();
console.log(`  status=${gResp.status()} state=${g.state}`);
if (g.state !== "NOT_STARTED") {
  console.log(`  runId=${g.runId ?? "(none)"} executionStatus=${g.executionStatus ?? ""}`);
}

let blockers = 0;
console.log("\n=== Pilot preconditions ===");
function check(cond, msg) {
  console.log(`  ${cond ? "OK" : "BLOCKER"}: ${msg}`);
  if (!cond) blockers++;
}
check(tResp.status() === 200, "transcription-status returned 200");
check(t.state === "COMPLETED", `transcription COMPLETED (got ${t.state})`);
check((t.transcript?.segmentCount ?? 0) >= 100, `transcript ≥100 segments (got ${t.transcript?.segmentCount ?? 0})`);
check(gResp.status() === 200, "generation-status returned 200");
check(g.state === "NOT_STARTED", `no active generation run (got ${g.state})`);

if (blockers > 0) {
  console.log(`\n${blockers} blocker(s). NOT clear to fire V-3 pilot.`);
  await browser.close();
  process.exit(1);
}
console.log("\nCLEAR TO FIRE V-3 PILOT.");
console.log(`  Course: ${COURSE_ID}`);
console.log(`  Version: ${VERSION_ID}`);
await browser.close();
