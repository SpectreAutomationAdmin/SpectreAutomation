// SIGNUP-2 M3B (2026-10-27) -- Deployed staging screenshot capture.
//
// Drives the signup status page at /signup/t/<token>/status WITHOUT
// any ?bank_verification query param -- the page must derive the
// banner from authoritative server-side state alone.
//
// Preconditions: M3B_FIXTURES env is a JSON string from the webhook
// driver's `screenshot-fixtures` action, mapping state keys to
// plaintext resumeTokens.  Example:
//   M3B_FIXTURES='{"signed":"<hex>","verified":"<hex>","pending":"<hex>","failed":"<hex>"}'

import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const FIXTURES_RAW = process.env.M3B_FIXTURES ?? "";

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const OUT_DIR = path.join(process.cwd(), "test-results", "signup-2-m3b-screenshots");

test.describe.configure({ mode: "serial" });

interface FixtureMap { [state: string]: string }
let FIXTURES: FixtureMap = {};

test.beforeAll(async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  if (!FIXTURES_RAW) {
    throw new Error(
      "M3B_FIXTURES env var is required. Run `node signup-2-m3b-signed-webhook-driver.mjs screenshot-fixtures` on staging first and pass the token map via env.",
    );
  }
  FIXTURES = JSON.parse(FIXTURES_RAW);
  const required = ["signed", "verified", "pending", "failed"];
  for (const k of required) {
    if (!FIXTURES[k]) throw new Error(`Missing fixture token for state="${k}"`);
  }
});

const STATES = [
  { key: "signed", label: "Mandate signed (no banner)" },
  { key: "verified", label: "Bank verified (via signed webhook)" },
  { key: "pending", label: "Microdeposit pending (via signed webhook)" },
  { key: "failed", label: "Verification failed (via signed webhook)" },
] as const;

for (const state of STATES) {
  test(`[DESKTOP 1440x900] ${state.key} -- ${state.label}`, async ({ browser }) => {
    const token = FIXTURES[state.key];
    const ctx = await browser.newContext({ viewport: DESKTOP });
    const page = await ctx.newPage();
    // IMPORTANT (M3B §3): NO ?bank_verification query param -- the page
    // must derive state from the DB.
    const url = `${BASE}/signup/t/${token}/status?mandate_signed=1`;
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="signup-status-card"]', { timeout: 10_000 });
    await page.screenshot({
      path: path.join(OUT_DIR, `desktop-1440x900-${state.key}.png`),
      fullPage: true,
    });
    await ctx.close();
  });
}

for (const state of STATES) {
  test(`[MOBILE 390x844] ${state.key} -- ${state.label}`, async ({ browser }) => {
    const token = FIXTURES[state.key];
    const ctx = await browser.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const url = `${BASE}/signup/t/${token}/status?mandate_signed=1`;
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="signup-status-card"]', { timeout: 10_000 });
    await page.screenshot({
      path: path.join(OUT_DIR, `mobile-390x844-${state.key}.png`),
      fullPage: true,
    });
    await ctx.close();
  });
}

// Negative test: PROVE that passing ?bank_verification=verified
// does NOT change what the page renders for a cycle that is actually
// in another state.
test(`[NEGATIVE] query param cannot override DB state`, async ({ browser }) => {
  const pendingToken = FIXTURES["pending"];
  const ctx = await browser.newContext({ viewport: DESKTOP });
  const page = await ctx.newPage();
  // Load the pending-state fixture WITH a verified query param.  The
  // page must render the pending banner, not the verified one.
  const url = `${BASE}/signup/t/${pendingToken}/status?mandate_signed=1&bank_verification=verified`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="signup-status-card"]', { timeout: 10_000 });
  // Pending banner uses the "info" testid; verified uses "ok".
  const infoBanner = await page.locator('[data-testid="signup-bank-verification-info"]').count();
  const okBanner = await page.locator('[data-testid="signup-bank-verification-ok"]').count();
  expect(infoBanner, "info (pending) banner must render for pending state despite ?bank_verification=verified").toBe(1);
  expect(okBanner, "ok (verified) banner must NOT render -- query param overrides are blocked").toBe(0);
  await page.screenshot({
    path: path.join(OUT_DIR, `negative-query-param-override-blocked.png`),
    fullPage: true,
  });
  await ctx.close();
});
