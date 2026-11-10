#!/usr/bin/env node
// EP-TRAIN-4Y-AE1 §8 — screenshot the founder-reported question
// (the "former judge" one) specifically, after advancing through
// the review tabs.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";

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

await p.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "domcontentloaded" });
await p.waitForTimeout(4500);

fs.mkdirSync("test-results", { recursive: true });

// Walk through Q1..Q5 and screenshot each question pane when the stem
// contains "former judge" (the founder-reported one).
for (let i = 1; i <= 5; i++) {
  const stem = await p.locator('[data-testid="manager-review-question-text"]').textContent().catch(() => null);
  console.log(`[Q${i}] stem: ${(stem ?? "").slice(0, 160)}`);
  if (stem && stem.toLowerCase().includes("former judge")) {
    const qPane = p.locator('[data-testid="manager-review-question-pane"]');
    await qPane.screenshot({ path: "test-results/4yae1-former-judge-q.png" });
    // Full-page shot too, so the reviewer sees the context.
    await p.screenshot({ path: "test-results/4yae1-former-judge-full.png", fullPage: true });
    console.log(`  → captured 4yae1-former-judge-q.png + full`);
    break;
  }
  const next = p.locator('[data-testid="manager-review-next"]');
  if (!(await next.count())) break;
  await next.click();
  await p.waitForTimeout(500);
}
await b.close();
