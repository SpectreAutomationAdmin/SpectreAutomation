// SIGNUP-2 M3A (2026-10-27) -- Deployed staging screenshot capture.
//
// Drives the signup status page at /signup/t/<token>/status with each
// of the four bank-verification query-param states and captures a
// screenshot at desktop (1440x900) + mobile (390x844) viewports.
//
// Precondition: the staging DB must have a synthetic registration
// whose plaintext resume token matches process.env.M3A_SCREENSHOT_TOKEN.
// The acceptance driver's `create-screenshot-reg` action creates one
// and prints the plaintext token.

import { test, expect } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const TOKEN = process.env.M3A_SCREENSHOT_TOKEN ?? "";

const DESKTOP = { width: 1440, height: 900 };
const MOBILE = { width: 390, height: 844 };

const STATES = [
  { key: "signed", label: "Mandate signed (default)" },
  { key: "verified", label: "Bank verified (instant)" },
  { key: "pending", label: "Microdeposit pending" },
  { key: "failed", label: "Verification failed (recovery)" },
] as const;

const OUT_DIR = path.join(process.cwd(), "test-results", "signup-2-m3a-screenshots");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  if (!TOKEN) {
    throw new Error(
      "M3A_SCREENSHOT_TOKEN env var is required. Run `node signup-2-m3a-staging-acceptance.mjs create-screenshot-reg` on staging first and pass the plaintextToken via env.",
    );
  }
});

for (const state of STATES) {
  test(`[DESKTOP 1440x900] bank_verification=${state.key} -- ${state.label}`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: DESKTOP });
    const page = await ctx.newPage();
    const url = `${BASE}/signup/t/${TOKEN}/status?mandate_signed=1&bank_verification=${state.key}`;
    await page.goto(url, { waitUntil: "networkidle" });
    // Wait for the status card to render (reliable visible element).
    await page.waitForSelector('[data-testid="signup-status-card"]', { timeout: 10_000 });
    await page.screenshot({
      path: path.join(OUT_DIR, `desktop-1440x900-${state.key}.png`),
      fullPage: true,
    });
    await ctx.close();
  });
}

for (const state of STATES) {
  test(`[MOBILE 390x844] bank_verification=${state.key} -- ${state.label}`, async ({ browser }) => {
    const ctx = await browser.newContext({ viewport: MOBILE, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    const url = `${BASE}/signup/t/${TOKEN}/status?mandate_signed=1&bank_verification=${state.key}`;
    await page.goto(url, { waitUntil: "networkidle" });
    await page.waitForSelector('[data-testid="signup-status-card"]', { timeout: 10_000 });
    await page.screenshot({
      path: path.join(OUT_DIR, `mobile-390x844-${state.key}.png`),
      fullPage: true,
    });
    await ctx.close();
  });
}
