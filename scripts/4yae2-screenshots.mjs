#!/usr/bin/env node
// EP-TRAIN-4Y-AE2 §9 — acceptance screenshots.
// Walk Q1..Q5 in order, screenshot each question pane, and prove the
// chronological ordering + marker sync + reconstructed Q2.

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
fs.mkdirSync("test-results", { recursive: true });

async function session(viewport, label) {
  const ctx = await b.newContext({ viewport });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await p.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
  await p.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
  await Promise.all([p.waitForURL(/\/app\//), p.click('button[type="submit"]')]);
  await p.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(4500);
  await p.screenshot({ path: `test-results/4yae2-${label}-full.png`, fullPage: true });

  // Walk Q1..Q5 and capture each pane.
  const stems = [];
  for (let i = 1; i <= 5; i++) {
    const stemEl = p.locator('[data-testid="manager-review-question-text"]');
    const stem = await stemEl.textContent().catch(() => null);
    stems.push({ index: i, stem: (stem ?? "").slice(0, 120) });
    const pane = p.locator('[data-testid="manager-review-question-pane"]');
    if (await pane.count()) {
      await pane.screenshot({ path: `test-results/4yae2-${label}-Q${i}.png` });
    }
    const next = p.locator('[data-testid="manager-review-next"]');
    const nextEnabled = await next.isEnabled().catch(() => false);
    if (!nextEnabled || i === 5) break;
    await next.click();
    await p.waitForTimeout(500);
  }
  await ctx.close();
  return stems;
}

const firstPass = await session({ width: 1440, height: 900 }, "first-load");
console.log("\n--- first load, Q1..Q5 stems in chronological order ---");
firstPass.forEach((s) => console.log(` Q${s.index}: ${s.stem}`));

// Refresh = second session; order must match.
const refreshPass = await session({ width: 1440, height: 900 }, "after-refresh");
console.log("\n--- after fresh browser context (refresh/sign-in), Q1..Q5 stems ---");
refreshPass.forEach((s) => console.log(` Q${s.index}: ${s.stem}`));

const sameOrder = firstPass.every((s, i) => s.stem === refreshPass[i]?.stem);
console.log(`\nordering identical across sessions: ${sameOrder}`);

const report = { capturedAt: new Date().toISOString(), firstPass, refreshPass, sameOrder };
fs.writeFileSync("test-results/4yae2-screenshot-report.json", JSON.stringify(report, null, 2));
await b.close();
if (!sameOrder) process.exit(1);
