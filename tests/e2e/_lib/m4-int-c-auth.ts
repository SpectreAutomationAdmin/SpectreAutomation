// SIGNUP-2 M4-INT-C (2026-10-29) -- Test-only helper that logs in
// as a specific M4-INT-C operator (A or B).
//
// Reads credentials from .env.playwright.local only.  Never logs
// password values.  Follows the Phase 2D fixture convention + the
// loginAsFounder shape from staging-auth.ts.

import type { BrowserContext, Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const DEFAULT_BASE = "https://staging.spectreautomation.com";
const DEFAULT_LOGIN = "/login";

function loadLocalEnvFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of [".env.playwright.local", ".env.local"]) {
    const p = path.join(process.cwd(), name);
    if (!fs.existsSync(p)) continue;
    const content = fs.readFileSync(p, "utf8");
    for (const line of content.split("\n")) {
      const m = line.trim().match(/^([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (!m || line.trim().startsWith("#")) continue;
      let value = m[2];
      if (value.startsWith("\"") && value.endsWith("\"")) value = value.slice(1, -1);
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1);
      out[m[1]] = value;
    }
  }
  return out;
}

export type OperatorKey = "A" | "B";

export interface OperatorCreds {
  key: OperatorKey;
  email: string;
  windowExpiresAt: string | null;
}

export function m4IntCCredsAvailable(): {
  ready: boolean;
  reason: string | null;
  windowExpiresAt: string | null;
} {
  const env = loadLocalEnvFiles();
  const emailA = env.M4_INTC_OP_A_EMAIL;
  const passA = env.M4_INTC_OP_A_PASSWORD;
  const emailB = env.M4_INTC_OP_B_EMAIL;
  const passB = env.M4_INTC_OP_B_PASSWORD;
  const windowExpiresAt = env.M4_INTC_WINDOW_EXPIRES_AT ?? null;
  if (!emailA || !passA || !emailB || !passB) {
    return {
      ready: false,
      reason: "M4_INTC_OP_* credentials missing — skipping authorized spec. Run the provision script first.",
      windowExpiresAt,
    };
  }
  if (windowExpiresAt && Date.parse(windowExpiresAt) <= Date.now()) {
    return {
      ready: false,
      reason: `M4_INTC window has expired at ${windowExpiresAt}. Re-provision before running.`,
      windowExpiresAt,
    };
  }
  return { ready: true, reason: null, windowExpiresAt };
}

export async function loginAsM4IntCOperator(
  context: BrowserContext,
  key: OperatorKey,
): Promise<Page> {
  const env = loadLocalEnvFiles();
  const email = env[`M4_INTC_OP_${key}_EMAIL`] ?? "";
  const password = env[`M4_INTC_OP_${key}_PASSWORD`] ?? "";
  const baseURL = env.SPECTRE_STAGING_BASE_URL ?? DEFAULT_BASE;
  const loginPath = env.SPECTRE_STAGING_LOGIN_PATH ?? DEFAULT_LOGIN;
  if (!email || !password) {
    throw new Error(`M4-INT-C operator ${key} credentials missing — check .env.playwright.local`);
  }

  const page = await context.newPage();
  await page.goto(`${baseURL}${loginPath}`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await Promise.all([
    page.waitForURL((url) => !url.pathname.startsWith(loginPath), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]).catch(() => {
    const currentUrl = page.url();
    throw new Error(
      `M4-INT-C operator ${key} login did not redirect off ${loginPath}. Current URL: ${currentUrl}.`,
    );
  });
  return page;
}
