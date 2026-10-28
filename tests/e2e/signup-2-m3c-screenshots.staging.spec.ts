// SIGNUP-2 M3C (2026-10-28) -- Capture the branded status page
// screenshot showing the founder's recovered registration in
// BANK_VERIFIED state (derived from real DB state, not query param).
//
// Precondition: M3C_FOUNDER_TOKEN env is the fresh-minted resumeToken
// from the recovery driver's output.

import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import path from "node:path";

const BASE = "https://staging.spectreautomation.com";
const TOKEN = process.env.M3C_FOUNDER_TOKEN ?? "";
const OUT_DIR = path.join(process.cwd(), "test-results", "signup-2-m3c-screenshots");

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  mkdirSync(OUT_DIR, { recursive: true });
  if (!TOKEN) throw new Error("M3C_FOUNDER_TOKEN env var required");
});

test("[DESKTOP 1440x900] founder recovered registration -- BANK_VERIFIED banner from real DB state", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const url = `${BASE}/signup/t/${TOKEN}/status?mandate_signed=1`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="signup-status-card"]', { timeout: 10_000 });
  await page.screenshot({
    path: path.join(OUT_DIR, "desktop-1440x900-founder-recovered-verified.png"),
    fullPage: true,
  });
  await ctx.close();
});

test("[MOBILE 390x844] founder recovered registration -- BANK_VERIFIED banner from real DB state", async ({ browser }) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const url = `${BASE}/signup/t/${TOKEN}/status?mandate_signed=1`;
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForSelector('[data-testid="signup-status-card"]', { timeout: 10_000 });
  await page.screenshot({
    path: path.join(OUT_DIR, "mobile-390x844-founder-recovered-verified.png"),
    fullPage: true,
  });
  await ctx.close();
});
