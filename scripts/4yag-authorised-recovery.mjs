#!/usr/bin/env node
// EP-TRAIN-4Y-AG §3 — authorised single-run final-assessment recovery.
// Prerequisite: `scripts/4yag-pre-execution-checks.mjs` must pass all
// 10 gates (its JSON report at test-results/4yag-pre-execution-checks.json
// is loaded and verified before any POST fires).

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const ORIGINAL_RUN = "cmw9rrl1g000rj41xaoxvzqbb";

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

// Verify pre-execution gates passed.
const gatesPath = "test-results/4yag-pre-execution-checks.json";
if (!fs.existsSync(gatesPath)) {
  console.error("REFUSING — pre-execution report missing. Run 4yag-pre-execution-checks.mjs first.");
  process.exit(2);
}
const gatesReport = JSON.parse(fs.readFileSync(gatesPath, "utf8"));
const failed = (gatesReport.gates ?? []).filter((g) => !g.pass);
if (failed.length > 0) {
  console.error("REFUSING — pre-execution gate failures:", failed.map((f) => f.name));
  process.exit(2);
}
if (gatesReport.gates.length !== 10) {
  console.error(`REFUSING — expected 10 gates, got ${gatesReport.gates.length}.`);
  process.exit(2);
}
console.log("Pre-execution report confirmed clean (10/10 gates).");

const todayUtc = new Date().toISOString().slice(0, 10);
const confirmToken = `AF-GPU-AUTHORIZED-${todayUtc}`;
console.log(`Confirm token: ${confirmToken}`);
console.log("");

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await ctx.newPage();
await pg.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await pg.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await pg.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([pg.waitForURL(/\/app\//), pg.click('button[type="submit"]')]);

console.log("Firing single authorised recovery POST...");
const resp = await pg.request.post(
  `${BASE}/api/admin/ai-training/runs/${ORIGINAL_RUN}/recover-final-assessment`,
  {
    headers: { "Content-Type": "application/json" },
    data: { confirm: confirmToken },
  },
);
const body = await resp.json();

console.log(`HTTP ${resp.status()}`);
console.log(JSON.stringify(body, null, 2));

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yag-recovery-dispatch.json",
  JSON.stringify({ at: new Date().toISOString(), status: resp.status(), body }, null, 2));

await b.close();

if (resp.status() !== 200 || !body.ok) {
  console.error("REFUSED — recovery POST did not succeed.");
  process.exit(1);
}
if (!body.recoveryRunId) {
  console.error("REFUSED — response missing recoveryRunId.");
  process.exit(1);
}
console.log(`\nAUTHORISED RECOVERY DISPATCHED. New run id: ${body.recoveryRunId}, state: ${body.state}.`);
console.log(`Projected worst-case cost: $${body.projectedCostUsd}. maxAttempts=1 (no retries).`);
