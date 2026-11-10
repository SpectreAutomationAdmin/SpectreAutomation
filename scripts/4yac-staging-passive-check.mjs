#!/usr/bin/env node
// EP-TRAIN-4Y-AC §8 — passive staging check (NO deletions performed).
//
// Verifies the dashboard renders cleanly post-deploy + confirms the
// known-repro course row is still present (so the subsequent
// founder-authorized delete step has a target). Does NOT click any
// delete button.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const KNOWN_REPRO_COURSE_ID = "cmvzs3vz9000256qcu7lfysoz";
const PROTECTED_PILOT_COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";

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
  const b = await chromium.launch({ headless: true });
  const ctx = await b.newContext({ viewport: { width: 1440, height: 900 } });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await p.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
  await p.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
  await Promise.all([p.waitForURL(/\/app\//), p.click('button[type="submit"]')]);

  const listUrl = `${BASE}/app/admin/people/safety-training`;
  await p.goto(listUrl, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(3000);

  fs.mkdirSync("test-results", { recursive: true });
  await p.screenshot({ path: "test-results/4yac-dashboard-passive.png", fullPage: true });

  const bodyText = (await p.locator('body').innerText()).slice(0, 500);
  const crashed = bodyText.includes("Application error");
  const errorBoundary = (await p.locator('[data-testid="training-dashboard-error"]').count()) > 0;
  const reproRowPresent = (await p.locator(`[data-testid="training-active-row-${KNOWN_REPRO_COURSE_ID}"]`).count()) > 0;
  const reproDeleteBtnPresent = (await p.locator(`[data-testid="training-course-delete-draft-${KNOWN_REPRO_COURSE_ID}"]`).count()) > 0;
  const pilotPresent = (await p.locator(`[data-testid="training-active-row-${PROTECTED_PILOT_COURSE_ID}"]`).count()) > 0;
  const pilotDeleteDraftBtn = (await p.locator(`[data-testid="training-course-delete-draft-${PROTECTED_PILOT_COURSE_ID}"]`).count()) > 0;
  const pilotDeleteDraftVersionBtn = (await p.locator(`[data-testid="training-course-delete-draft-version-${PROTECTED_PILOT_COURSE_ID}"]`).count()) > 0;

  const result = {
    base: BASE,
    capturedAt: new Date().toISOString(),
    dashboardCrashed: crashed,
    errorBoundaryShown: errorBoundary,
    reproRowPresent,
    reproDeleteButtonPresent: reproDeleteBtnPresent,
    pilotRowPresent: pilotPresent,
    pilotHasDeleteDraftButton: pilotDeleteDraftBtn,
    pilotHasDeleteDraftVersionButton: pilotDeleteDraftVersionBtn,
    bodySample: bodyText,
  };
  fs.writeFileSync("test-results/4yac-passive-check.json", JSON.stringify(result, null, 2));

  console.log("━━━━━━ 4Y-AC PASSIVE CHECK ━━━━━━");
  console.log(`  dashboard crashed:       ${crashed}`);
  console.log(`  error boundary shown:    ${errorBoundary}`);
  console.log(`  repro row present:       ${reproRowPresent}`);
  console.log(`  repro delete btn:        ${reproDeleteBtnPresent}`);
  console.log(`  pilot row present:       ${pilotPresent}`);
  console.log(`  pilot delete-draft btn:  ${pilotDeleteDraftBtn}`);
  console.log(`  pilot delete-draft-ver:  ${pilotDeleteDraftVersionBtn}`);
  console.log(`  body sample: ${bodyText.slice(0, 200)}...`);

  await b.close();
  if (crashed) process.exit(2);
}
main().catch((e) => { console.error(e); process.exit(1); });
