#!/usr/bin/env node
// EP-TRAIN-4Y-AL §5 — inspect Manager Review layout at 1440x900.
// Capture BEFORE screenshot + run DOM measurement to decide on narrow
// adjustment. No code change yet.

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
const pg = await ctx.newPage();
await pg.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
await pg.fill('input[name="email"]', env("SPECTRE_STAGING_EMAIL"));
await pg.fill('input[name="password"]', env("SPECTRE_STAGING_PASSWORD"));
await Promise.all([pg.waitForURL(/\/app\//), pg.click('button[type="submit"]')]);
await pg.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "domcontentloaded" });
await pg.waitForTimeout(3500);

// Click the FA tab so we see the question panel occupied.
const faTab = pg.locator('button:has-text("Final Assessment"), button:has-text("Final assessment")');
if (await faTab.count()) { await faTab.first().click(); await pg.waitForTimeout(500); }

await pg.screenshot({ path: "test-results/4yal-ui-before.png", fullPage: false });
await pg.screenshot({ path: "test-results/4yal-ui-before-full.png", fullPage: true });

// Measure the key elements.
const measurements = await pg.evaluate(() => {
  const vp = { w: window.innerWidth, h: window.innerHeight };
  const video = document.querySelector('video, [data-testid="training-video-player"], .training-video-player, [aria-label*="video"]');
  const videoR = video?.getBoundingClientRect?.() ?? null;
  const panel = document.querySelector('[data-testid="manager-review-question-pane"]');
  const panelR = panel?.getBoundingClientRect?.() ?? null;
  const next = document.querySelector('[data-testid="manager-review-next"]');
  const nextR = next?.getBoundingClientRect?.() ?? null;
  const accept = document.querySelector('[data-testid="manager-review-accept"], button[aria-label*="Accept"]');
  const acceptR = accept?.getBoundingClientRect?.() ?? null;
  return {
    viewport: vp,
    video: videoR ? { top: videoR.top, left: videoR.left, bottom: videoR.bottom, right: videoR.right, width: videoR.width, height: videoR.height } : null,
    panel: panelR ? { top: panelR.top, left: panelR.left, bottom: panelR.bottom, right: panelR.right, width: panelR.width, height: panelR.height } : null,
    nextBtn: nextR ? { top: nextR.top, left: nextR.left } : null,
    acceptBtn: acceptR ? { top: acceptR.top, left: acceptR.left } : null,
    doc: { scrollHeight: document.documentElement.scrollHeight, clientHeight: document.documentElement.clientHeight },
  };
});

console.log(JSON.stringify(measurements, null, 2));

fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yal-ui-measurements.json", JSON.stringify(measurements, null, 2));

await b.close();
