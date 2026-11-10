#!/usr/bin/env node
// EP-TRAIN-4Y-AB — inspect cmw9s03mk00nxpe990f6fwawr which the
// cleanup reported as EDIT_TEXT_LEAKAGE.
import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
const BASE = "https://staging.spectreautomation.com";
function env(k) {
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
const ctx = await b.newContext();
const p = await ctx.newPage();
await p.goto(`${BASE}/login`, {waitUntil: "domcontentloaded"});
await p.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await p.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([p.waitForURL(/\/app\//), p.click('button[type="submit"]')]);
const r = await p.request.get(`${BASE}/api/admin/ai-training/drafts/cmw9s03mk00nxpe990f6fwawr`);
const d = await r.json();
console.log("STATE:", d.state);
console.log("CONTENT HASH:", d.contentHash);
console.log("\n=== RAW questionText ===");
console.log(JSON.stringify(d.draft?.questionText));
console.log("\n=== RAW options ===");
for (const o of (d.draft?.options ?? [])) console.log("- ", JSON.stringify(o));
await b.close();
