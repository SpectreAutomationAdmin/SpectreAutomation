// Sprint 3 · Checkpoint 16H rejection #2 (2026-08-06) — Playwright
// staging acceptance for the "every genuine email materializes" fix
// AND regression guard that the recovered Membership Inquiry reply
// is still visible after the one-purpose backfill route removal.
//
// Founder acceptance (§12 + §13):
//   1. The Weekly Update card appears in the Work Intake Feed.
//   2. It is INFORMATIONAL, not classified as an AP invoice.
//   3. Sender + subject render exactly (no fabricated fields).
//   4. Its original July 22 received date is preserved.
//   5. The Membership Inquiry reply (recovered previously via the
//      removed backfill route) still shows both inbound + outbound
//      in the /thread endpoint — proves route removal did not
//      disconnect the ConversationMessage row.
//
// Never sends a real reply; never resolves the Weekly Update card.

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

test.describe("16H rejection #2 · Informational materialization + preservation", () => {
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

  test("Weekly Update newsletter appears in the Work Intake Feed", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/app/admin");
    await page.waitForLoadState("networkidle");
    // The card's subject is the exact Weekly Update line — search by
    // that text so we don't couple to any fabricated formatting.
    const wu = page.locator(".spectre-mc-item", { hasText: "Weekly Update - Week of July" }).first();
    await expect(wu, "Weekly Update card must appear in the feed").toBeVisible();
    // Screenshot evidence.
    await page.screenshot({ path: "test-results/c16h-r2-weekly-update-in-feed.png", fullPage: false });
  });

  test("Membership Inquiry reply is still visible after backfill route removal", async ({ page }) => {
    // Membership Inquiry WI id captured on staging.
    const WI_ID = "cmrwz5cvu000j54ctbysjn9wd";
    const res = await page.request.get(`${STAGING}/api/mission-control/work-intake/${WI_ID}/thread`);
    expect(res.status(), "thread must load").toBe(200);
    const body = await res.json();
    expect(body.messageCount, "must include both inbound + outbound").toBeGreaterThanOrEqual(2);
    const directions = new Set<string>(
      (body.messages as Array<{ direction: string }>).map((m) => m.direction),
    );
    expect(directions.has("INBOUND"), "inbound preserved").toBe(true);
    expect(directions.has("OUTBOUND"), "outbound preserved").toBe(true);
  });
});
