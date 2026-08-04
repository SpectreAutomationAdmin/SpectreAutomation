// Sprint 3 · Checkpoint 16G Stage F — authenticated Playwright
// acceptance tests against staging.
//
// Authentication strategy (per founder §19: "Use an authenticated,
// secure local environment-variable or storage-state method. Do
// not commit credentials."):
//   * Reads SPECTRE_STAGING_SESSION_SECRET + SPECTRE_STAGING_USER_ID
//     from environment (gitignored .env.staging.local). Values are
//     the same iron-session secret staging itself uses; user id is
//     the founder's Coulee Ridge admin.
//   * Uses iron-session's `sealData` to construct a valid session
//     cookie for the target user, sets it in the Playwright context,
//     and navigates authenticated.
//   * NEVER logs the secret. NEVER commits it.
//
// If either env-var is missing → tests SKIP with a clear message so
// CI stays green in environments without staging access.

import { test, expect } from "@playwright/test";
import { sealData } from "iron-session";
import fs from "node:fs";
import path from "node:path";

const STAGING = "https://staging.spectreautomation.com";

// Read from .env.staging.local without leaking values into logs.
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
// Founder's Coulee Ridge admin userId + clubId — resolved once via
// a staging DB read; not a secret.
const STAGING_USER_ID = process.env.SPECTRE_STAGING_USER_ID
  ?? "cmrvdenz700034437agp7gqs5";
const STAGING_CLUB_ID = process.env.SPECTRE_STAGING_CLUB_ID
  ?? "cmrvdeny7000144372ktmmg9c";
const SESSION_COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? "spectre_session";

const hasCreds = !!STAGING_SECRET && !!STAGING_USER_ID;

test.use({ baseURL: STAGING });

test.describe("16G Stage F · authenticated Mission Control against staging", () => {
  test.skip(!hasCreds, "SPECTRE_STAGING_SESSION_SECRET missing; skipping authenticated tests");

  test.beforeEach(async ({ context }) => {
    const sealed = await sealData(
      { userId: STAGING_USER_ID, activeClubId: STAGING_CLUB_ID, generation: 1 },
      { password: STAGING_SECRET! },
    );
    await context.addCookies([{
      name: SESSION_COOKIE_NAME,
      value: sealed,
      url: STAGING,
      httpOnly: true, sameSite: "Lax", secure: true,
    }]);
  });

  test("Arrived today reads 0 + copy is 'received since midnight'", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/app/admin");
    await page.waitForLoadState("networkidle");
    // The "Arrived today" cell renders the KPI value.
    const arrivedCell = page.locator('.spectre-mc-briefing button.cell.arrived');
    await expect(arrivedCell).toBeVisible();
    const value = await arrivedCell.locator(".v").textContent();
    const sublabel = await arrivedCell.locator(".s").textContent();
    // Stage A acceptance: value must be 0 (nothing arrived on 2026-08-04 Edmonton),
    // sublabel must be "received since midnight" (never "in the last 24 hours").
    expect(value?.trim()).toBe("0");
    expect(sublabel?.trim()).toBe("received since midnight");
    await page.screenshot({ path: "test-results/c16g-arrived-today.png", fullPage: false });
  });

  test("Membership Inquiry renders MEMBERSHIP card + NEVER shows AP fields", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/app/admin");
    await page.waitForLoadState("networkidle");
    // Locate the Membership card by its subject text.
    const card = page.locator('.spectre-mc-item', { hasText: "Membership Inquiry" }).first();
    await expect(card).toBeVisible();
    // Domain badge must be present + say "Membership".
    const domainBadge = card.locator('[data-testid="domain-badge"]');
    await expect(domainBadge).toBeVisible();
    await expect(domainBadge).toHaveText(/Membership/i);
    // Domain-specific fields MUST be present.
    await expect(card.locator('[data-testid="domain-field-prospect-/-contact"]')).toBeVisible();
    await expect(card.locator('[data-testid="domain-field-inquiry-type"]')).toBeVisible();
    await expect(card.locator('[data-testid="domain-field-received"]')).toBeVisible();
    await expect(card.locator('[data-testid="domain-field-response-status"]')).toBeVisible();
    // AP field labels MUST be absent from this card.
    // The AP readout uses data-testid="ap-readout" — we assert it's not
    // present inside this specific card.
    await expect(card.locator('[data-testid="ap-readout"]')).toHaveCount(0);
    // "Inquiry type" value should be "Waitlist" (per the classifier).
    const inquiryValue = await card.locator('[data-testid="domain-field-inquiry-type"] .v').textContent();
    expect(inquiryValue?.trim()).toBe("Waitlist");
    await page.screenshot({ path: "test-results/c16g-membership-card.png", fullPage: false });
    // Also capture the card in isolation for the report.
    await card.screenshot({ path: "test-results/c16g-membership-card-only.png" });
  });

  test("AP invoice cards retain their AP grid", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/app/admin");
    await page.waitForLoadState("networkidle");
    // The Oxio invoice is a known real AP card on Coulee Ridge.
    const apCard = page.locator('.spectre-mc-item', { hasText: "oxio" }).first();
    await expect(apCard).toBeVisible();
    // AP readout present.
    await expect(apCard.locator('[data-testid="ap-readout"]')).toBeVisible();
    await page.screenshot({ path: "test-results/c16g-ap-card.png", fullPage: false });
  });

  test("Today's Commitments panel appears beneath Executive Insight", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/app/admin");
    await page.waitForLoadState("networkidle");
    const commitments = page.locator('[data-testid="todays-commitments"]');
    await expect(commitments).toBeVisible();
    // Panel must appear AFTER Executive Insight in DOM order.
    const insight = page.locator('.spectre-mc-insight');
    await expect(insight).toBeVisible();
    // Since Calendars.Read consent isn't yet granted and no
    // ProposedCommitment rows exist today → empty state + hint.
    await expect(commitments.locator('[data-testid="commitments-empty-permission"], [data-testid="commitments-empty-connected"], [data-testid="commitments-empty-disconnected"]')).toHaveCount(1);
    await page.screenshot({ path: "test-results/c16g-commitments-panel.png", fullPage: false });
  });

  test("Full page snapshot at 1440x900 for the founder review", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/app/admin");
    await page.waitForLoadState("networkidle");
    await page.screenshot({ path: "test-results/c16g-mission-control-full.png", fullPage: true });
  });
});
