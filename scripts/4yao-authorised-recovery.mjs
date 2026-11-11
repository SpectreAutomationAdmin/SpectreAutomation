#!/usr/bin/env node
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

const gatesPath = "test-results/4yao-pre-execution-gates.json";
if (!fs.existsSync(gatesPath)) { console.error("REFUSING — gates report missing"); process.exit(2); }
const g = JSON.parse(fs.readFileSync(gatesPath, "utf8"));
const failed = (g.gates ?? []).filter((x) => !x.pass);
if (failed.length > 0) { console.error("REFUSING — failed gates:", failed.map((f) => f.name)); process.exit(2); }
if (g.gates.length !== 10) { console.error(`REFUSING — expected 10 gates, got ${g.gates.length}`); process.exit(2); }

const todayUtc = new Date().toISOString().slice(0, 10);
const confirmToken = `AF-GPU-AUTHORIZED-${todayUtc}`;
console.log(`Gates CLEAN (10/10). Confirm token: ${confirmToken}`);

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const pg = await ctx.newPage();
await pg.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await pg.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await pg.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([pg.waitForURL(/\/app\//), pg.click('button[type="submit"]')]);
console.log("Firing AUTHORISED 1-question recovery POST...");
const resp = await pg.request.post(
  `${BASE}/api/admin/ai-training/runs/${ORIGINAL_RUN}/recover-final-assessment`,
  { headers: { "Content-Type": "application/json" }, data: { confirm: confirmToken, maxPerChunk: 1 } },
);
const body = await resp.json();
console.log(`HTTP ${resp.status()}`);
console.log(JSON.stringify(body, null, 2));
fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yao-recovery-dispatch.json",
  JSON.stringify({ at: new Date().toISOString(), status: resp.status(), body }, null, 2));
await b.close();
if (resp.status() !== 200 || !body.ok || !body.recoveryRunId) { console.error("REFUSED"); process.exit(1); }
console.log(`\nAUTHORISED RECOVERY DISPATCHED — run ${body.recoveryRunId}, state ${body.state}, ceiling $${body.projectedCostUsd}`);
