#!/usr/bin/env node
// EP-TRAIN-4Y-AF — authenticated preflight check against live staging.
// No GPU is invoked. This POST uses the dry-run body `{preflight: true}`
// which, per the route handler, is the default for any absent/false
// `confirm` key. The server responds with the full chunk plan, existing
// FA draft count, and projected USD — NO run is created, NO job is
// enqueued, NO Modal call is reachable.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const RUN_ID = "cmw9rrl1g000rj41xaoxvzqbb";

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

const b = await chromium.launch({ headless: true });
const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
const p = await ctx.newPage();
await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await p.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await p.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([p.waitForURL(/\/app\//), p.click('button[type="submit"]')]);

const resp = await p.request.post(
  `${BASE}/api/admin/ai-training/runs/${RUN_ID}/recover-final-assessment`,
  { headers: { "Content-Type": "application/json" }, data: { preflight: true } },
);
const body = await resp.json();
console.log(JSON.stringify({ status: resp.status(), body }, null, 2));
fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yaf-preflight-live.json", JSON.stringify({ status: resp.status(), body }, null, 2));
await b.close();

// Exit non-zero if the preflight didn't come back ready with 10 shortfall.
if (resp.status() !== 200) process.exit(1);
if (body.ready !== true) process.exit(1);
if (body.targetShortfall !== 10) process.exit(1);
if (!Array.isArray(body.chunksProposed) || body.chunksProposed.length !== 4) process.exit(1);
