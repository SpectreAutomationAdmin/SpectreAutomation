// EP-TRAIN-4Y-Z §7 — Supplemental manager-review screenshots.
// Captures: Final Assessment tab, checkpoint timeline, question-nav
// inside the Checkpoints tab.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const COURSE_ID = "cmw8n6z8f0008z4nxck6uvms9";
const VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";

function envGet(k) {
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
  const ctx = await b.newContext({ viewport: { width: 1600, height: 1100 } });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/login`);
  await p.fill("input[name=email]", envGet("SPECTRE_STAGING_EMAIL"));
  await p.fill("input[name=password]", envGet("SPECTRE_STAGING_PASSWORD"));
  await Promise.all([
    p.waitForURL((u) => !u.pathname.startsWith("/login")),
    p.click("form button[type=submit]"),
  ]);
  await p.goto(`${BASE}/app/admin/people/safety-training/${COURSE_ID}/${VERSION_ID}/review`, { waitUntil: "networkidle" });
  await p.waitForTimeout(2000);

  // Checkpoints tab (default)
  await p.screenshot({ path: "test-results/4yz-review-checkpoints-q1.png", fullPage: true });

  // Click through Q2-Q5 via Next
  for (let i = 2; i <= 5; i++) {
    const nextBtn = p.locator('button:has-text("Next")').first();
    if (await nextBtn.isVisible().catch(() => false)) {
      await nextBtn.click();
      await p.waitForTimeout(500);
      await p.screenshot({ path: `test-results/4yz-review-checkpoints-q${i}.png`, fullPage: true });
    }
  }

  // Switch to Final assessment tab
  const faTab = p.locator('button:has-text("Final assessment")').first();
  if (await faTab.isVisible().catch(() => false)) {
    await faTab.click();
    await p.waitForTimeout(1500);
    await p.screenshot({ path: "test-results/4yz-review-final-assessment.png", fullPage: true });
    // Extract visible text to confirm emptiness or count.
    const panelText = await p.locator("main").innerText().catch(() => "");
    const faCount = (panelText.match(/Question\s+\d+\s+of\s+(\d+)/) ?? [])[1] ?? "0";
    console.log(`Final-assessment visible count hint: ${faCount}`);
    console.log(`FA panel text sample: ${panelText.slice(0, 400)}`);
  } else {
    console.log("Final assessment tab not found");
  }

  await b.close();
}
main().catch((e) => { console.error(e); process.exit(1); });
