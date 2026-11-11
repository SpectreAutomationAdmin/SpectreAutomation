#!/usr/bin/env node
// EP-TRAIN-4Y-AU §1 — reproduce the founder's view precisely.
// Navigate to Final Assessment tab, scroll through to Q7, capture
// DOM text + full-page screenshot. Also measure tab counts.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";
const AS_DRAFT_ID = "cmwbl6aic0007107lhfo4n0wl";

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
await pg.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "networkidle" });
await pg.waitForTimeout(3500);

// Read the two mode tabs' labels + counts.
const cpTab = pg.locator('[data-testid="manager-review-mode-checkpoints"]');
const faTab = pg.locator('[data-testid="manager-review-mode-final"]');
const cpTabText = (await cpTab.count()) ? await cpTab.innerText() : "(absent)";
const faTabText = (await faTab.count()) ? await faTab.innerText() : "(absent)";

// Switch to Final Assessment tab first.
if (await faTab.count()) {
  await faTab.first().click();
  await pg.waitForTimeout(1200);
}

// Walk questions. Spectre's manager review page uses forward-nav
// buttons that advance "X of 10". Try to find a next button and
// click until we land on Q7.
const goToQ7 = async () => {
  for (let i = 0; i < 20; i++) {
    const marker = pg.locator('[data-testid="manager-review-question-pane"]');
    const txt = (await marker.count()) ? await marker.innerText().catch(() => "") : "";
    const match = /question\s+(\d+)\s+of\s+(\d+)/i.exec(txt);
    if (match && Number(match[1]) === 7) return true;
    // Try a few navigation signals.
    const next = pg.locator('button:has-text("Next"), [aria-label*="Next"], button[data-testid*="next"]').first();
    if (await next.count()) {
      try { await next.click({ timeout: 2000 }); await pg.waitForTimeout(400); continue; } catch {}
    }
    const q7direct = pg.locator('button:has-text("7"), button[aria-label*="7"]').first();
    if (await q7direct.count()) {
      try { await q7direct.click({ timeout: 2000 }); await pg.waitForTimeout(400); return true; } catch {}
    }
    break;
  }
  return false;
};
const landedOnQ7 = await goToQ7();
await pg.screenshot({ path: "test-results/4yau-fa-q7.png", fullPage: true });

// Grab the FULL page DOM (every string the user can read) +
// specifically scan for "destination unknown" / "Unknown" in any
// question-pane header.
const bodyText = await pg.locator("body").innerText();
const hasDestinationUnknown = /destination\s+unknown/i.test(bodyText);
// Spectre's tabs render "Checkpoints · N" and "Final assessment · N"
const cpMatch = /checkpoints\s*·\s*(\d+)/i.exec(bodyText);
const faMatch = /final\s+assessment\s*·\s*(\d+)/i.exec(bodyText);

// Attempt to see if the AS draft is rendered on the CHECKPOINTS tab too.
if (await cpTab.count()) {
  await cpTab.first().click();
  await pg.waitForTimeout(800);
}
const cpBody = await pg.locator("body").innerText();
const cpHasPayStubText = /pay\s*stubs?/i.test(cpBody);
await pg.screenshot({ path: "test-results/4yau-cp-tab.png", fullPage: true });

const report = {
  cpTabText, faTabText,
  parsedCounts: {
    checkpoints: cpMatch ? Number(cpMatch[1]) : null,
    finalAssessment: faMatch ? Number(faMatch[1]) : null,
  },
  landedOnQ7,
  hasDestinationUnknown,
  // Did the AS pay-stub question appear on the Checkpoints tab?
  cpTabContainsPayStubQuestion: cpHasPayStubText,
  bodyTextSample: bodyText.slice(0, 2000),
};
fs.mkdirSync("test-results", { recursive: true });
fs.writeFileSync("test-results/4yau-reproduction.json", JSON.stringify(report, null, 2));
await b.close();
console.log(JSON.stringify(report, null, 2));
