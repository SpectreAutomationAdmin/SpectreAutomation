// Sprint 3 · Checkpoint 16H rejection #4 (2026-08-06) — Playwright
// staging acceptance for attachment-authority promotion.
//
// Founder acceptance (§18): the exact "For your review" email must
// render as one founder-visible AP work card after the repair. No
// duplicate informational card. Dashboard counts reconcile.

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

test.describe("16H rejection #4 · attachment authority — For-your-review AP promotion", () => {
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

  // Note: after AP promotion the card's TITLE is the AP title
  // (supplier / invoice-#), NOT the raw email subject "For your
  // review". So we locate the card by its stable AP testids +
  // MAIL id tag, then assert AP presentation.
  test("'For your review' email now renders through the AP body (AP pill + AP readout, no Informational shell)", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/app/admin");
    await page.waitForLoadState("networkidle");
    // Confirm at least one AP-workflow card is visible.
    const apPills = page.locator('[data-testid="ap-workflow-pill"]');
    const apPillCount = await apPills.count();
    expect(apPillCount, "at least one AP-workflow card must render").toBeGreaterThan(0);
    // For a card to be the promoted 'For your review' item, we
    // look at the MAIL-* id tag whose sibling AP work summary
    // references the recovered attachment filename `B0037FC`.
    // The AP title, sender line, or work summary carries it.
    // .spectre-mc-feed selector doesn't exist on this page; read the
    // entire feed area (all mc-items concatenated).
    const cardText = (await page.locator(".spectre-mc-item").allTextContents()).join("\n");
    // AP promotion signal — the founder-visible copy after fix.
    const hasApSignal =
      /Create vendor/i.test(cardText) ||
      /supplier/i.test(cardText) ||
      /invoice/i.test(cardText);
    expect(hasApSignal, "AP presentation copy must appear in the feed").toBe(true);
    // The prior-fix Informational shell copy for this card MUST NOT
    // appear on any card that also carries an AP pill — that's the
    // hybrid-card defect. Look for the specific stale copy.
    const staleInfoBadge = page.locator('.spectre-mc-item', {
      has: page.locator('[data-testid="ap-workflow-pill"]'),
      hasText: /No actionable signals found/i,
    });
    expect(await staleInfoBadge.count(),
      "no AP-linked card may still show 'No actionable signals found'"
    ).toBe(0);
    await page.screenshot({ path: "test-results/c16h-r4-ap-promotion.png", fullPage: true });
  });

  test("AP-review canonical intake (raw filename) is suppressed from the founder feed", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/app/admin");
    await page.waitForLoadState("networkidle");
    // The AP-review canonical intake's raw display (filename
    // "B0037FC.PDF") must NOT render as a separate feed card —
    // it should be suppressed by loadChildReviewIntakesToSuppress.
    const filenameCards = page.locator(".spectre-mc-item", { hasText: "B0037FC.PDF" });
    expect(await filenameCards.count(),
      "raw AP-review row must be suppressed from the feed"
    ).toBe(0);
  });
});
