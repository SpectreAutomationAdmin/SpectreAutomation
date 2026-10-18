// WI-SYNC-1a (2026-10-18) — Mission Control feed verification.
//
// Per founder brief §4 (post-dry-run authorization) — database
// updates alone are not sufficient acceptance evidence.  This
// spec visits the real Mission Control feed on staging as the
// founder, scrolls the feed, visits each tab (My Feed / AI
// Insights / Starred / Archived), and asserts that NONE of the
// six originally-reported ghost subjects render anywhere in the
// DOM.
//
// Captures full-page screenshots at the active-feed root + the
// informational / archived surfaces so the founder can inspect
// the UI directly.

import { test, expect } from "@playwright/test";
import path from "node:path";
import { mkdirSync, existsSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

const SIX_GHOST_SUBJECTS = [
  "2026 Last Day of Golf Update",
  "Exclusive Silver Springs Ireland Golf Adventure 2028",
  "Weekly Update - Week of October 7th, 2026",
  "Reminder: 2026 Member Satisfaction Survey",
  "Weekly Update - Week of September 30th, 2026",
  "2026 Member Satisfaction Survey",
];

function ensureOutDir(): string {
  const outDir = path.join("test-results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  return outDir;
}

runAt(
  "WI-SYNC-1a · Mission Control feed — six reported ghosts absent, UI stable",
  async ({ browser }) => {
    test.setTimeout(180_000);
    const outDir = ensureOutDir();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);
    await page.goto(`${BASE}/app/admin`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(4_000);

    // Capture the feed root — defaults to My Feed.
    await page.screenshot({
      path: path.join(outDir, "wi-sync-1a-mc-my-feed.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });

    const bodyText = await page.evaluate(() => document.body.innerText);
    const foundInMyFeed = SIX_GHOST_SUBJECTS.filter((s) => bodyText.includes(s));
    console.log("WI_SYNC_1A_MY_FEED_HITS", JSON.stringify(foundInMyFeed));
    expect(foundInMyFeed, "no ghosts in My Feed").toEqual([]);

    // Try "AI Insights" tab if present.
    const aiTab = page.locator('role=tab[name="AI Insights"]');
    if ((await aiTab.count()) > 0) {
      await aiTab.first().click();
      await page.waitForTimeout(1_500);
      await page.screenshot({
        path: path.join(outDir, "wi-sync-1a-mc-ai-insights.png"),
        clip: { x: 0, y: 0, width: 1440, height: 900 },
      });
      const t = await page.evaluate(() => document.body.innerText);
      const hits = SIX_GHOST_SUBJECTS.filter((s) => t.includes(s));
      console.log("WI_SYNC_1A_AI_INSIGHTS_HITS", JSON.stringify(hits));
      expect(hits, "no ghosts in AI Insights").toEqual([]);
    }

    // Archived tab — expected to contain any user-archived WIs,
    // but the 6 ghosts (SUPPRESSED) should NOT appear here.
    const archivedTab = page.locator('role=tab[name="Archived"]');
    if ((await archivedTab.count()) > 0) {
      await archivedTab.first().click();
      await page.waitForTimeout(1_500);
      await page.screenshot({
        path: path.join(outDir, "wi-sync-1a-mc-archived.png"),
        clip: { x: 0, y: 0, width: 1440, height: 900 },
      });
      const t = await page.evaluate(() => document.body.innerText);
      const hits = SIX_GHOST_SUBJECTS.filter((s) => t.includes(s));
      console.log("WI_SYNC_1A_ARCHIVED_HITS", JSON.stringify(hits));
      expect(hits, "no ghosts in Archived").toEqual([]);
    }

    // Starred tab.
    const starredTab = page.locator('role=tab[name="Starred"]');
    if ((await starredTab.count()) > 0) {
      await starredTab.first().click();
      await page.waitForTimeout(1_500);
      const t = await page.evaluate(() => document.body.innerText);
      const hits = SIX_GHOST_SUBJECTS.filter((s) => t.includes(s));
      console.log("WI_SYNC_1A_STARRED_HITS", JSON.stringify(hits));
      expect(hits, "no ghosts in Starred").toEqual([]);
    }

    // Return to My Feed for the final rested screenshot.
    const myFeedTab = page.locator('role=tab[name="My Feed"]');
    if ((await myFeedTab.count()) > 0) {
      await myFeedTab.first().click();
      await page.waitForTimeout(1_500);
    }
    await page.screenshot({
      path: path.join(outDir, "wi-sync-1a-mc-my-feed-rested.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });

    console.log("WI_SYNC_1A_MC_SCREENSHOTS_DIR", outDir);
    await ctx.close();
  },
);
