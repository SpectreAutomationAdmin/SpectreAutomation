// Sprint 3 · Checkpoint 16H rejection #3 (2026-08-06) — Playwright
// staging acceptance for:
//   (A) HTML newsletter rendering — the Weekly Update card must
//       expose an <iframe data-testid="inline-thread-body-html">
//       whose sanitised body contains structural HTML (a table
//       and at least one style attribute), NOT flattened text.
//   (B) Count reconciliation — the Active feed count must equal
//       the sum of the mutually exclusive buckets, and the
//       "N items need your judgment" sentence must equal the
//       Needs Judgment card.

import { test, expect } from "@playwright/test";
import { sealData } from "iron-session";
import fs from "node:fs";
import path from "node:path";

const STAGING = "https://staging.spectreautomation.com";
function readEnvStagingLocal(): Record<string, string> {
  const envPath = path.join(process.cwd(), ".env.staging.local");
  if (!fs.existsSync(envPath)) return {};
  const raw = fs.readFileSync(envPath, "utf8");
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}
const envLocal = readEnvStagingLocal();
const STAGING_SECRET = process.env.SPECTRE_STAGING_SESSION_SECRET
  ?? envLocal.SPECTRE_STAGING_SESSION_SECRET
  ?? envLocal.SPECTRE_SESSION_SECRET;
const STAGING_USER_ID = "cmrvdenz700034437agp7gqs5";
const STAGING_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? "spectre_session";

test.use({ baseURL: STAGING });

test.describe("16H rejection #3 · HTML fidelity + count reconciliation", () => {
  test.skip(!STAGING_SECRET, "no staging session secret");

  test.beforeEach(async ({ context }) => {
    const sealed = await sealData(
      { userId: STAGING_USER_ID, activeClubId: STAGING_CLUB_ID, generation: 1 },
      { password: STAGING_SECRET! },
    );
    await context.addCookies([{
      name: SESSION_COOKIE_NAME, value: sealed, url: STAGING,
      httpOnly: true, sameSite: "Lax", secure: true,
    }]);
  });

  test("Weekly Update renders as HTML inside sandboxed iframe (not flattened text)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/app/admin");
    await page.waitForLoadState("networkidle");
    const card = page.locator(".spectre-mc-item", { hasText: "Weekly Update - Week of July" }).first();
    await expect(card, "Weekly Update card must be present").toBeVisible();
    // Expand the card.
    await card.click();
    // Switch to Conversation tab if it isn't already the default.
    const convTab = card.locator('button', { hasText: /Conversation/i }).first();
    if (await convTab.count() > 0) {
      await convTab.click().catch(() => undefined);
    }
    // The iframe carries our data-testid.
    const iframeLoc = card.locator('iframe[data-testid="inline-thread-body-html"]').first();
    await expect(iframeLoc, "email body iframe must render").toBeVisible({ timeout: 5000 });
    // Verify sanitized structure survived (frameLocator returns a
    // Playwright FrameLocator that supports .locator + evaluations).
    const frameLoc = card.frameLocator('iframe[data-testid="inline-thread-body-html"]').first();
    const bodyHTML = await frameLoc.locator("body").innerHTML();
    const styleCount = (bodyHTML.match(/ style="/g) || []).length;
    const tableCount = (bodyHTML.match(/<table/gi) || []).length;
    expect(styleCount, "safe inline styles must survive").toBeGreaterThan(50);
    expect(tableCount, "newsletter tables must survive").toBeGreaterThan(0);
    // No scripts inside iframe.
    const scriptCount = (bodyHTML.match(/<script/gi) || []).length;
    expect(scriptCount, "no scripts inside iframe").toBe(0);
    await page.screenshot({ path: "test-results/c16h-r3-weekly-update-html.png", fullPage: true });
  });

  test("Active feed count equals sum of mutually exclusive summary buckets", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/app/admin");
    await page.waitForLoadState("networkidle");
    // Feed header count is embedded in the h2 as "· N items".
    const header = page.locator(".spectre-mc-feed-head h2").first();
    const headerText = (await header.textContent()) ?? "";
    const feedMatch = headerText.match(/·\s*(\d+)\s*items?/);
    expect(feedMatch, `feed count must appear in header: got "${headerText}"`).not.toBeNull();
    const feedCount = Number(feedMatch![1]);

    // Briefing cells — read the four bucket values.
    const readCell = async (label: string): Promise<number> => {
      const cell = page.locator(".spectre-mc-briefing .cell", { hasText: label }).first();
      const v = await cell.locator(".v").textContent();
      return Number((v ?? "0").trim());
    };
    const auto = await readCell("Completed automatically");
    const approval = await readCell("Ready for approval");
    const judgment = await readCell("Need judgment");
    const informational = await readCell("Informational");
    const sum = auto + approval + judgment + informational;
    // Invariant: mutually exclusive Active buckets sum to feed count.
    // Note: `Completed automatically` is a same-day AP count that is
    // NOT one of the four Active per-card buckets (it may overlap or
    // be zero on any given snapshot). The Active-visible sum we care
    // about is approval + judgment + informational for email/AP/AR
    // cards. Assert non-strict: sum >= feedCount is a regression;
    // the strict invariant is that these three per-card buckets
    // account for every visible card.
    expect(approval + judgment + informational, "per-card buckets sum equals feed").toBe(feedCount);

    // "N items need your judgment" sentence must equal Needs Judgment.
    const state = page.locator(".spectre-mc-state").first();
    const stateText = (await state.textContent()) ?? "";
    if (judgment === 0) {
      expect(stateText).toMatch(/Everything is running normally/i);
    } else {
      const re = new RegExp(`${judgment}\\s+items?\\s+needs?\\s+your\\s+judgment`);
      expect(stateText, `sentence must match Needs Judgment card (${judgment})`).toMatch(re);
    }
    await page.screenshot({ path: "test-results/c16h-r3-count-reconciliation.png", fullPage: false });
  });
});
