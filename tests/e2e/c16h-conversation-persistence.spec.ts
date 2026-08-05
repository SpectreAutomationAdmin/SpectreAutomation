// Sprint 3 · Checkpoint 16H rejection (2026-08-06) — Playwright
// staging acceptance for the Conversation-tab visibility fix.
//
// Founder acceptance evidence (§21):
//   • Restored Membership Inquiry card visibly shows BOTH the
//     original inbound email AND the previously-sent Spectre reply.
//   • The reply is marked outbound (not another inbound).
//   • Refresh preserves the same content.
//   • Completed History renders a chronological order + timeline
//     separator (§22).
//
// Runs authenticated via sealed iron-session cookie against the
// live staging deployment. Never sends a real reply.

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

test.describe("16H rejection · Conversation-tab visibility acceptance", () => {
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

  test("restored Membership Inquiry conversation shows both messages via /thread", async ({ page }) => {
    // The restored Membership Inquiry WorkIntakeItem id on staging.
    const WI_ID = "cmrwz5cvu000j54ctbysjn9wd";
    // page.request shares the browser context's cookies (including
    // the sealed session cookie beforeEach attached). request from
    // the test fixture does not.
    const res = await page.request.get(`${STAGING}/api/mission-control/work-intake/${WI_ID}/thread`);
    expect(res.status(), "thread endpoint should return 200").toBe(200);
    const body = await res.json();
    expect(body.messageCount, "must show at least 2 messages after backfill").toBeGreaterThanOrEqual(2);
    // At least one INBOUND (source email) and at least one OUTBOUND
    // (canonical Spectre reply).
    const directions = new Set<string>((body.messages as Array<{ direction: string }>).map((m) => m.direction));
    expect(directions.has("INBOUND"), "must include inbound").toBe(true);
    expect(directions.has("OUTBOUND"), "must include outbound").toBe(true);
    // The outbound row must be sourced from a Spectre-originated reply
    // — not a Sync-imported message that happens to be outbound.
    const spectreReply = (body.messages as Array<{ direction: string; source: string }>)
      .find((m) => m.direction === "OUTBOUND" && m.source === "SPECTRE_REPLY");
    expect(spectreReply, "must include a SPECTRE_REPLY row").toBeDefined();
  });

  test("Completed History renders a timeline marker + list", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/app/admin?view=history");
    await page.waitForLoadState("networkidle");
    // At least one timeline marker MUST appear (§22 — visible boundary).
    const markers = page.locator('[data-testid="mc-timeline-marker"]');
    await expect(markers.first()).toBeVisible();
    const count = await markers.count();
    expect(count, "completed history must show at least one timeline separator").toBeGreaterThanOrEqual(1);
    await page.screenshot({ path: "test-results/c16h-completed-history-timeline.png", fullPage: false });
  });
});
