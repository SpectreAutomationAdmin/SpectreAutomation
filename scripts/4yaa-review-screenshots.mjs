#!/usr/bin/env node
// EP-TRAIN-4Y-AA §10 — acceptance screenshots for the new Manager
// Review surface. Authenticated against staging as the founder.
//
// Captures:
//   1. 4yaa-review-header.png            — inline title + description + preview button
//   2. 4yaa-review-timeline-markers.png  — 5 markers on the video timeline
//   3. 4yaa-review-checkpoint-tab.png    — Checkpoints tab active, question 1
//   4. 4yaa-review-final-empty-state.png — Final assessment tab with truthful 0 state
//   5. 4yaa-review-edit-title.png        — pencil-open title inline editor
//   6. 4yaa-review-edit-description.png  — pencil-open description inline editor

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

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  const page = await ctx.newPage();

  console.log("→ login");
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
  await page.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
  await Promise.all([
    page.waitForURL(/\/app\//, { timeout: 30_000 }),
    page.click('button[type="submit"]'),
  ]);

  const reviewUrl = `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`;
  console.log(`→ ${reviewUrl}`);
  await page.goto(reviewUrl, { waitUntil: "domcontentloaded" });
  // Wait for the video + markers to render.
  await page.waitForTimeout(3500);

  const outDir = "test-results";
  fs.mkdirSync(outDir, { recursive: true });

  // ─── Screenshot 1: full page (overview) ─────────────────────────
  await page.screenshot({ path: `${outDir}/4yaa-review-full.png`, fullPage: true });
  console.log("  shot: 4yaa-review-full.png");

  // ─── Screenshot 2: header only ──────────────────────────────────
  const header = page.locator('[data-testid="manager-review-header"]');
  if (await header.count()) {
    await header.screenshot({ path: `${outDir}/4yaa-review-header.png` });
    console.log("  shot: 4yaa-review-header.png");
  } else {
    console.log("  !! header testid missing — fallback to full-page");
  }

  // ─── Screenshot 3: timeline markers ─────────────────────────────
  const timeline = page.locator('[data-testid="manager-review-checkpoint-timeline"]');
  if (await timeline.count()) {
    await timeline.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await timeline.screenshot({ path: `${outDir}/4yaa-review-timeline-markers.png` });
    console.log("  shot: 4yaa-review-timeline-markers.png");
    const markers = await page.locator('[data-testid^="manager-review-checkpoint-marker-"]').count();
    console.log(`  markers rendered: ${markers}`);
  } else {
    console.log("  !! timeline testid missing");
  }

  // ─── Screenshot 4: Checkpoints tab (default) ────────────────────
  const qPane = page.locator('[data-testid="manager-review-question-pane"]');
  if (await qPane.count()) {
    await qPane.screenshot({ path: `${outDir}/4yaa-review-checkpoint-tab.png` });
    console.log("  shot: 4yaa-review-checkpoint-tab.png");
    const questionText = await page
      .locator('[data-testid="manager-review-question-text"]')
      .textContent()
      .catch(() => null);
    console.log(`  CP tab visible Q1: "${(questionText ?? "").slice(0, 120)}"`);
  }

  // Tab counts
  const cpBtnText = await page
    .locator('[data-testid="manager-review-mode-checkpoints"]')
    .textContent()
    .catch(() => null);
  const faBtnText = await page
    .locator('[data-testid="manager-review-mode-final"]')
    .textContent()
    .catch(() => null);
  console.log(`  tab labels: "${cpBtnText}" / "${faBtnText}"`);

  // ─── Screenshot 5: Final assessment tab (truthful empty) ────────
  await page.click('[data-testid="manager-review-mode-final"]');
  await page.waitForTimeout(500);
  const finalEmpty = page.locator('[data-testid="manager-review-final-empty"]');
  if (await finalEmpty.count()) {
    await qPane.screenshot({ path: `${outDir}/4yaa-review-final-empty-state.png` });
    console.log("  shot: 4yaa-review-final-empty-state.png");
    const emptyCopy = await finalEmpty.textContent();
    console.log(`  FA empty state copy: "${(emptyCopy ?? "").slice(0, 160)}"`);
  } else {
    console.log("  !! final-empty testid missing — FA tab may have drafts after all");
    await qPane.screenshot({ path: `${outDir}/4yaa-review-final-tab.png` });
  }

  // Back to Checkpoints for the edit screenshots
  await page.click('[data-testid="manager-review-mode-checkpoints"]');
  await page.waitForTimeout(400);

  // ─── Screenshot 6: title inline editor open ─────────────────────
  const titleEdit = page.locator('[data-testid="manager-review-title-edit"]');
  if (await titleEdit.count()) {
    await titleEdit.click();
    await page.waitForTimeout(300);
    await header.screenshot({ path: `${outDir}/4yaa-review-edit-title.png` });
    console.log("  shot: 4yaa-review-edit-title.png");
    // Cancel to restore state.
    const cancelBtn = page.locator('[data-testid="manager-review-title-cancel"]');
    if (await cancelBtn.count()) await cancelBtn.click();
    await page.waitForTimeout(200);
  }

  // ─── Screenshot 7: description inline editor open ───────────────
  const descEdit = page.locator('[data-testid="manager-review-description-edit"]');
  if (await descEdit.count()) {
    await descEdit.click();
    await page.waitForTimeout(300);
    await header.screenshot({ path: `${outDir}/4yaa-review-edit-description.png` });
    console.log("  shot: 4yaa-review-edit-description.png");
    const cancelBtn = page.locator('[data-testid="manager-review-description-cancel"]');
    if (await cancelBtn.count()) await cancelBtn.click();
  }

  await browser.close();
  console.log("\n✓ all screenshots captured to ./test-results/");
}
main().catch((e) => { console.error(e); process.exit(1); });
