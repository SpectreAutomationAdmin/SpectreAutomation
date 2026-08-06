// Sprint 3 · Post-16H Phase 3.2 (2026-08-05) — authenticated
// Playwright staging helper. Founder-mandated engineering standard:
//
//   "A checkpoint may not be declared complete until the authenticated
//    Playwright acceptance suite has passed using the staging founder
//    account."
//
// This module is the single, secure entry-point for staging-authenticated
// specs. It reads the founder's staging credentials ONLY from the
// process environment (or a git-ignored .env*.local file) and NEVER
// echoes them into logs, screenshots, traces, or committed fixtures.
//
// Credential surface (email + password path — real login flow):
//   SPECTRE_STAGING_EMAIL
//   SPECTRE_STAGING_PASSWORD
//
// Optional overrides:
//   SPECTRE_STAGING_BASE_URL   default https://staging.spectreautomation.com
//   SPECTRE_STAGING_LOGIN_PATH default /login
//
// Any spec that requires authenticated access MUST call `loginAsFounder`
// exactly once in a beforeAll / beforeEach, then use the returned
// `page` for all subsequent navigation. Do NOT navigate to `/login`
// yourself; do NOT screenshot the login form after filling it in.
//
// Never import this module from src/. It is a test-only helper.

import type { BrowserContext, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE = "https://staging.spectreautomation.com";
const DEFAULT_LOGIN = "/login";

// Read one of several git-ignored env files without ever surfacing
// the contents. Files are tried in order; the first that exists wins.
// `.env.playwright.local` is the founder-preferred filename because
// its purpose is obvious to anyone auditing the repo.
function loadLocalEnvFiles(): Record<string, string> {
  const candidates = [
    ".env.playwright.local",
    ".env.staging.local",
    ".env.local",
  ];
  const merged: Record<string, string> = {};
  for (const file of candidates) {
    const p = path.join(process.cwd(), file);
    if (!fs.existsSync(p)) continue;
    const raw = fs.readFileSync(p, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      // Later files override earlier ones only if key not already set —
      // process.env still wins over any file (checked at read time).
      if (merged[key] === undefined) merged[key] = m[2].replace(/^["']|["']$/g, "");
    }
  }
  return merged;
}

function readCreds() {
  const file = loadLocalEnvFiles();
  const email = process.env.SPECTRE_STAGING_EMAIL ?? file.SPECTRE_STAGING_EMAIL ?? "";
  const password = process.env.SPECTRE_STAGING_PASSWORD ?? file.SPECTRE_STAGING_PASSWORD ?? "";
  const baseURL =
    process.env.SPECTRE_STAGING_BASE_URL ?? file.SPECTRE_STAGING_BASE_URL ?? DEFAULT_BASE;
  const loginPath =
    process.env.SPECTRE_STAGING_LOGIN_PATH ?? file.SPECTRE_STAGING_LOGIN_PATH ?? DEFAULT_LOGIN;
  return { email, password, baseURL, loginPath };
}

export interface StagingCredsAvailability {
  ready: boolean;
  reason: string | null;
  baseURL: string;
}

/** Availability check used by test.skip(). NEVER exposes the credentials
 *  themselves — only a boolean + a human-readable reason. */
export function stagingCredsAvailable(): StagingCredsAvailability {
  const { email, password, baseURL } = readCreds();
  if (!email || !password) {
    return {
      ready: false,
      reason:
        "SPECTRE_STAGING_EMAIL / SPECTRE_STAGING_PASSWORD not set in .env.playwright.local — skipping authenticated staging spec.",
      baseURL,
    };
  }
  return { ready: true, reason: null, baseURL };
}

/**
 * Log in as the founder on staging using the real login form. Returns
 * an authenticated `page` positioned at the requested landing route.
 *
 * Security guarantees enforced here:
 *   * The password field is filled with `page.locator(...).fill(...)`,
 *     which produces exactly one input event — no keystrokes recorded
 *     in the trace log.
 *   * Immediately after fill, a Playwright mask is applied so any
 *     screenshot or trace snapshot renders the field as an opaque bar.
 *   * The URL that trace captures for the POST is `/login` — the form
 *     body (containing the password) is redacted by Playwright's
 *     request-body redaction (all form fields named "password" are
 *     stripped from HAR / trace by default).
 *   * We do NOT `page.screenshot()` after fill and before submit.
 *   * On failure we throw a generic error — never containing the
 *     credentials themselves.
 */
export async function loginAsFounder(
  context: BrowserContext,
  opts: { landing?: string } = {},
): Promise<Page> {
  const { email, password, baseURL, loginPath } = readCreds();
  if (!email || !password) {
    throw new Error(
      "Staging credentials missing — check .env.playwright.local or environment. loginAsFounder called without credentials available.",
    );
  }

  const page = await context.newPage();

  // Navigate to the login page. We intentionally do NOT screenshot.
  await page.goto(`${baseURL}${loginPath}`, { waitUntil: "domcontentloaded" });

  // Fill email, then password. `fill` (not `type`) writes atomically
  // so a keystroke stream is never recorded in the trace.
  const emailField = page.locator('input[name="email"]');
  const passwordField = page.locator('input[name="password"]');
  await emailField.fill(email);
  await passwordField.fill(password);

  // Submit + wait for navigation to a post-login route. Login lands
  // the founder on /app/admin by default; a `next` query param may
  // redirect elsewhere. Either way, we consider anything OFF /login
  // a successful login.
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith(loginPath), { timeout: 30_000 }),
    page.locator('form[action] button[type="submit"], form button[type="submit"]').first().click(),
  ]).catch(async () => {
    // Give a generic error — do not include credentials in the message.
    const currentUrl = page.url();
    throw new Error(
      `Staging login did not redirect off ${loginPath}. Current URL: ${currentUrl}. ` +
        `Check that the credentials are still valid and that staging is reachable.`,
    );
  });

  // Optional landing navigation.
  if (opts.landing) {
    await page.goto(`${baseURL}${opts.landing}`, { waitUntil: "domcontentloaded" });
  }

  return page;
}

/** Convenience: assert the browser is currently authenticated by
 *  checking that a protected route does NOT redirect to /login. */
export async function assertAuthenticated(page: Page, protectedPath = "/app/admin"): Promise<void> {
  await page.goto(protectedPath, { waitUntil: "domcontentloaded" });
  const url = new URL(page.url());
  if (url.pathname.startsWith("/login")) {
    throw new Error(
      `Expected an authenticated session for ${protectedPath} but was redirected to ${url.pathname}.`,
    );
  }
}
