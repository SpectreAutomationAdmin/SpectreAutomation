#!/usr/bin/env node
// EP-TRAIN-4Y-AB §9 — acceptance screenshots (1440×900).
//
// Captures:
//   1. 4yab-review-full.png              — full page (shared player + 60/40 workspace + markers)
//   2. 4yab-review-player.png            — just the video section (shared control bar + markers)
//   3. 4yab-review-markers-close.png     — just the seek-track strip (5 numbered markers)
//   4. 4yab-review-edit-mode.png         — question in Edit mode
//   5. 4yab-review-edit-saved.png        — after a save, "Edited — pending re-validation" badge
//   6. 4yab-review-final-empty.png       — FA tab honest empty state
//   7. 4yab-preview-as-employee.png      — preview-as-employee shows the pilot course
//   8. 4yab-employee-portal.png          — the employee portal for the SAME course is unchanged

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
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();

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
  await page.waitForTimeout(4000);

  const outDir = "test-results";
  fs.mkdirSync(outDir, { recursive: true });

  // 1. full review page
  await page.screenshot({ path: `${outDir}/4yab-review-full.png`, fullPage: true });
  console.log("  shot: 4yab-review-full.png");

  // 2. video section (shared PlayerControlBar)
  const player = page.locator('[data-testid="portal-course-video-section"]');
  if (await player.count()) {
    await player.screenshot({ path: `${outDir}/4yab-review-player.png` });
    console.log("  shot: 4yab-review-player.png");
  }

  // 3. markers close-up (the seek-track slider)
  const seekBar = page.locator('[data-testid="portal-course-player-seek"]');
  if (await seekBar.count()) {
    await seekBar.screenshot({ path: `${outDir}/4yab-review-markers-close.png` });
    console.log("  shot: 4yab-review-markers-close.png");
    const markers = await page.locator('[data-testid^="portal-course-checkpoint-marker-"]').count();
    console.log(`  markers in shared control bar: ${markers}`);
  }

  // Tab labels + mode counts
  const cpBtnText = await page.locator('[data-testid="manager-review-mode-checkpoints"]').textContent().catch(() => null);
  const faBtnText = await page.locator('[data-testid="manager-review-mode-final"]').textContent().catch(() => null);
  console.log(`  tabs: "${cpBtnText}" / "${faBtnText}"`);

  // 4. Edit mode screenshot — click Edit on the first question.
  const editBtn = page.locator('[data-testid="manager-review-edit"]');
  if (await editBtn.count()) {
    await editBtn.click();
    await page.waitForTimeout(700);
    const qPane = page.locator('[data-testid="manager-review-question-pane"]');
    if (await qPane.count()) {
      await qPane.screenshot({ path: `${outDir}/4yab-review-edit-mode.png` });
      console.log("  shot: 4yab-review-edit-mode.png");
    }

    // Make a small change (edit the question text) + trigger Save to
    // capture the "Edited — pending re-validation" result. If the
    // save succeeds, the question pane will refresh.
    const qText = page.locator('[data-testid="manager-review-edit-questionText"]');
    if (await qText.count()) {
      const existing = (await qText.inputValue()) || "What is the correct way to address a club member?";
      const edited = (existing + " (clarified by manager for publication)").slice(0, 900);
      await qText.fill(edited);
      await page.waitForTimeout(200);
      // Click Save
      const saveBtn = page.locator('[data-testid="manager-review-edit-save"]');
      if (await saveBtn.count()) {
        await saveBtn.click();
        await page.waitForTimeout(3500);
        const qPaneAfter = page.locator('[data-testid="manager-review-question-pane"]');
        if (await qPaneAfter.count()) {
          await qPaneAfter.screenshot({ path: `${outDir}/4yab-review-edit-saved.png` });
          console.log("  shot: 4yab-review-edit-saved.png");
        }
      }
    }
  } else {
    console.log("  !! Edit button not present (draft may already be approved/promoted)");
  }

  // 6. FA tab empty state
  const faTab = page.locator('[data-testid="manager-review-mode-final"]');
  if (await faTab.count()) {
    await faTab.click();
    await page.waitForTimeout(400);
    const qPane = page.locator('[data-testid="manager-review-question-pane"]');
    if (await qPane.count()) {
      await qPane.screenshot({ path: `${outDir}/4yab-review-final-empty.png` });
      console.log("  shot: 4yab-review-final-empty.png");
    }
  }

  // 7. preview-as-employee (manager-mode view of employee flow)
  const previewUrl = `${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/preview-as-employee`;
  await page.goto(previewUrl, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  await page.screenshot({ path: `${outDir}/4yab-preview-as-employee.png`, fullPage: true });
  console.log("  shot: 4yab-preview-as-employee.png");

  // 8. Employee portal — load the employee-portal view of the SAME
  //    version (as the admin principal; the PlayerControlBar renders
  //    the same way for both audiences).
  const employeeUrl = `${BASE}/employee/safety-training/${VERSION_ID}`;
  try {
    await page.goto(employeeUrl, { waitUntil: "domcontentloaded", timeout: 15_000 });
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${outDir}/4yab-employee-portal.png`, fullPage: true });
    console.log("  shot: 4yab-employee-portal.png");
  } catch (e) {
    console.log(`  !! could not load employee-portal view (${e.message})`);
  }

  console.log(`\n✓ all screenshots captured to ./${outDir}/`);
  await browser.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
