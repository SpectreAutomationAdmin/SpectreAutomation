#!/usr/bin/env node
// EP-TRAIN-4Y-AE §8 — acceptance screenshots at 1440×900.
//
// Captures:
//   1. 4yae-review-full.png                — entire training slide visible
//   2. 4yae-review-player-only.png         — just the video section (larger, no crop)
//   3. 4yae-review-markers.png             — 5 checkpoint markers
//   4. 4yae-review-q-clean-stem.png        — a question with a clean stem (no inlined options)
//   5. 4yae-review-edit-inline.png         — inline Edit → Save flow
//   6. 4yae-review-narrow.png              — responsive at 1024×900
//   7. 4yae-employee-portal.png            — employee player unchanged

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

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
  await page.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
  await Promise.all([page.waitForURL(/\/app\//), page.click('button[type="submit"]')]);
}

const browser = await chromium.launch({ headless: true });
fs.mkdirSync("test-results", { recursive: true });

// 1440x900 session
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await login(p);
  const reviewUrl = `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`;
  await p.goto(reviewUrl, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(4500);
  await p.screenshot({ path: "test-results/4yae-review-full.png", fullPage: true });

  const player = p.locator('[data-testid="portal-course-video-section"]');
  if (await player.count()) {
    await player.screenshot({ path: "test-results/4yae-review-player-only.png" });
    const dims = await player.boundingBox();
    console.log(`player size (1440×900): ${dims?.width ?? "?"} × ${dims?.height ?? "?"}`);
  }
  const seek = p.locator('[data-testid="portal-course-player-seek"]');
  if (await seek.count()) {
    await seek.screenshot({ path: "test-results/4yae-review-markers.png" });
    const markerCount = await p.locator('[data-testid^="portal-course-checkpoint-marker-"]').count();
    console.log(`markers rendered: ${markerCount}`);
  }
  const qPane = p.locator('[data-testid="manager-review-question-pane"]');
  if (await qPane.count()) {
    await qPane.screenshot({ path: "test-results/4yae-review-q-clean-stem.png" });
    const stem = await p.locator('[data-testid="manager-review-question-text"]').textContent().catch(() => null);
    console.log(`Q1 stem: "${(stem ?? "").slice(0, 140)}"`);
  }

  // Inline edit screenshot
  const editBtn = p.locator('[data-testid="manager-review-edit"]');
  if (await editBtn.count()) {
    await editBtn.click();
    await p.waitForTimeout(700);
    if (await qPane.count()) {
      await qPane.screenshot({ path: "test-results/4yae-review-edit-inline.png" });
    }
    const cancel = p.locator('[data-testid="manager-review-edit-cancel"]');
    if (await cancel.count()) await cancel.click();
  }

  await p.close();
  await ctx.close();
}

// Responsive narrow 1024x900
{
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 900 } });
  const p = await ctx.newPage();
  await login(p);
  await p.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(4500);
  await p.screenshot({ path: "test-results/4yae-review-narrow.png", fullPage: true });
  await p.close();
  await ctx.close();
}

// Employee portal (manager-visible via preview-as-employee, same primitive)
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await login(p);
  await p.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/preview-as-employee`, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(4500);
  await p.screenshot({ path: "test-results/4yae-employee-portal.png", fullPage: true });
  await p.close();
  await ctx.close();
}

await browser.close();
console.log("\n✓ screenshots captured");
