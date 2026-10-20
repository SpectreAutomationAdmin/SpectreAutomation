// SIGNUP-1C (2026-10-20) — real-browser regression for the
// Microsoft sign-in button.  Required because the SIGNUP-1
// acceptance tested the /api/signup/microsoft/start endpoint
// via page.request.post(), which bypasses the CSP form-action
// enforcement that silently blocked the actual button-click
// navigation.
//
// This spec:
//   1. Opens /signup in a fresh browser context.
//   2. Completes Screen 1 through the real UI.
//   3. Reaches Screen 2.
//   4. CLICKS the Microsoft sign-in button through the real UI.
//   5. Asserts the browser navigates to
//      https://login.microsoftonline.com/organizations/oauth2/...
//      (not that an API call returned 303 — that was the exact
//      hole that let the SIGNUP-1 regression ship).
//   6. Asserts identity-only scopes (no Mail / Calendars).
//   7. Fails loudly if the button is inert, the request fails
//      silently, or the browser remains on Screen 2.
//
// This test will catch any future CSP / form-action / middleware
// regression that re-breaks the cross-origin navigation.

import { test, expect } from "@playwright/test";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

function ensureOutDir(): string {
  const d = path.join("test-results");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

runAt(
  "SIGNUP-1C · real-browser Microsoft button regression — click → navigate to login.microsoftonline.com",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const outDir = ensureOutDir();

    // Fresh context — no shared cookies / state with other tests.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    // Capture console errors + failed network requests so we can
    // surface them if the test fails.
    const consoleErrors: Array<{ type: string; text: string }> = [];
    const failedRequests: Array<{ url: string; failure: string | null }> = [];
    page.on("console", (msg) => {
      if (msg.type() === "error" || msg.type() === "warning") {
        consoleErrors.push({ type: msg.type(), text: msg.text() });
      }
    });
    page.on("requestfailed", (req) => {
      failedRequests.push({ url: req.url(), failure: req.failure()?.errorText ?? null });
    });

    // ============================================================
    // Step 1 — Open /signup
    // ============================================================
    await page.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await expect(page.locator('[data-testid="signup-identity-form"]')).toBeVisible();

    // ============================================================
    // Step 2 — Complete Screen 1 through the UI
    // ============================================================
    const uniq = `MS-BTN-REGRESSION ${Date.now()}`;
    await page.locator('[data-testid="signup-input-legalName"]').fill(uniq);
    await page.locator('[data-testid="signup-select-country"]').selectOption("CA");
    await page.locator('[data-testid="signup-select-province"]').selectOption("ON");
    await page.locator('[data-testid="signup-input-addressLine1"]').fill("1 Front St W");
    await page.locator('[data-testid="signup-input-city"]').fill("Toronto");
    await page.locator('[data-testid="signup-input-postalCode"]').fill("M5J 2W4");
    await page.locator('[data-testid="signup-identity-submit"]').click();

    // ============================================================
    // Step 3 — Reach Screen 2
    // ============================================================
    await page.waitForURL(/\/signup\/t\/[A-Za-z0-9_-]+\/admin$/, { timeout: 30_000 });
    const screen2Url = page.url();
    await expect(page.locator('[data-testid="signup-ms-form"]')).toBeVisible();
    const msButton = page.locator('[data-testid="signup-ms-button"]');
    await expect(msButton, "Microsoft button is rendered + visible").toBeVisible();
    await expect(msButton, "Microsoft button is enabled").toBeEnabled();

    // Snapshot the pre-click DOM for diagnostics.
    await page.screenshot({
      path: path.join(outDir, "signup-1c-pre-click.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });

    // ============================================================
    // Step 4 — CLICK THE REAL BUTTON (not an API call)
    // ============================================================
    const navigationPromise = page.waitForURL(
      /login\.microsoftonline\.com\/organizations\/oauth2\//,
      { timeout: 30_000 },
    ).catch(() => null);

    // Also catch any request to the signup/microsoft/start endpoint
    // for diagnostic purposes.
    const requestWitness: Array<{ url: string; method: string; status?: number }> = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/signup/microsoft/start") || req.url().includes("login.microsoftonline.com")) {
        requestWitness.push({ url: req.url(), method: req.method() });
      }
    });
    page.on("response", (res) => {
      const url = res.url();
      if (url.includes("/api/signup/microsoft/start") || url.includes("login.microsoftonline.com")) {
        const r = requestWitness.find((e) => e.url === url);
        if (r) r.status = res.status();
      }
    });

    await msButton.click();

    const nav = await navigationPromise;

    writeFileSync(
      path.join(outDir, "signup-1c-request-witness.json"),
      JSON.stringify({ requestWitness, consoleErrors, failedRequests, screen2Url, finalUrl: page.url() }, null, 2),
    );

    // ============================================================
    // Step 5 — Assert navigation reached Microsoft
    // ============================================================
    expect(
      nav,
      `Microsoft button inert — browser did not navigate.  Final URL: ${page.url()}.  Request witness: ${JSON.stringify(requestWitness)}.  Console errors: ${JSON.stringify(consoleErrors)}.`,
    ).not.toBeNull();
    expect(page.url(), "browser is on login.microsoftonline.com").toMatch(
      /^https:\/\/login\.microsoftonline\.com\/organizations\/oauth2\/v2\.0\/authorize\?/,
    );

    // ============================================================
    // Step 6 — Verify identity-only scopes
    // ============================================================
    const finalUrl = new URL(page.url());
    const scopes = finalUrl.searchParams.get("scope") ?? "";
    expect(scopes, "scope includes openid").toMatch(/\bopenid\b/);
    expect(scopes, "scope includes profile").toMatch(/\bprofile\b/);
    expect(scopes, "scope includes email").toMatch(/\bemail\b/);
    expect(scopes, "scope includes offline_access").toMatch(/\boffline_access\b/);
    expect(scopes, "no Mail.Read scope").not.toMatch(/Mail\.Read/i);
    expect(scopes, "no Mail.ReadWrite scope").not.toMatch(/Mail\.ReadWrite/i);
    expect(scopes, "no Mail.Send scope").not.toMatch(/Mail\.Send/i);
    expect(scopes, "no Calendars.Read scope").not.toMatch(/Calendars\.Read/i);
    expect(
      finalUrl.pathname,
      "authority is /organizations (rejects personal accounts)",
    ).toMatch(/^\/organizations\/oauth2\//);
    expect(
      finalUrl.searchParams.get("code_challenge_method"),
      "PKCE S256 enforced",
    ).toBe("S256");
    expect(
      finalUrl.searchParams.get("response_type"),
      "authorization code flow",
    ).toBe("code");

    console.log("SIGNUP_1C_MS_BUTTON_REGRESSION_PASSED", JSON.stringify({
      finalUrl: `${finalUrl.origin}${finalUrl.pathname}`,
      scopes,
    }));

    // Capture the Microsoft page for the evidence package.
    await page.screenshot({
      path: path.join(outDir, "signup-1c-post-click.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });

    await ctx.close();
  },
);
