// SIGNUP-1E (2026-10-20) — real-browser regression: the founding
// administrator role is PROMPTED, SUBMITTED, and PERSISTED through
// to the status page.
//
// The SIGNUP-1E defect: /api/signup/microsoft/start was setting the
// OAuth returnPath to `/signup/t/<token>/status` instead of `/admin`.
// After Microsoft callback, the user was redirected to the status
// page, bypassing the position form.  Role on status showed
// "Pending" forever.  Fixed in commit (this slice).
//
// This spec uses the staging-only force-verify endpoint to simulate
// the Microsoft round-trip (identity captured, position null) and
// then exercises the REAL UI — clicks the role dropdown, submits
// the position form, and verifies the status page displays the
// role (not "Pending").
//
// Why not a full Microsoft round-trip: as before, driving the
// Microsoft consent screen requires a real work account.  The
// force-verify endpoint stops at the exact SAME state the real
// callback leaves — adminVerifiedAt set, adminPosition null — so
// the subsequent position-form behaviour is identical.

import { test, expect } from "@playwright/test";
import path from "node:path";
import { existsSync, mkdirSync } from "node:fs";
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
  "SIGNUP-1E · real-browser role persistence — role prompted, submitted, persisted; status is NOT Pending",
  async ({ browser }) => {
    test.setTimeout(600_000);
    const outDir = ensureOutDir();

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    // ============================================================
    // Walk Screen 1 → Screen 2 pre-verify
    // ============================================================
    await page.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const uniq = `ROLE-REGRESSION ${Date.now()}`;
    await page.locator('[data-testid="signup-input-legalName"]').fill(uniq);
    await page.locator('[data-testid="signup-select-country"]').selectOption("CA");
    await page.locator('[data-testid="signup-select-province"]').selectOption("BC");
    await page.locator('[data-testid="signup-input-addressLine1"]').fill("1066 Hastings Street");
    await page.locator('[data-testid="signup-input-city"]').fill("Vancouver");
    await page.locator('[data-testid="signup-input-postalCode"]').fill("V6E 3X1");
    await page.locator('[data-testid="signup-identity-submit"]').click();
    await page.waitForURL(/\/signup\/t\/[A-Za-z0-9_-]+\/admin$/, { timeout: 30_000 });
    const token = page.url().match(/\/signup\/t\/([A-Za-z0-9_-]+)\/admin$/)![1];

    // ============================================================
    // Simulate the Microsoft round-trip via the staging-only
    // force-verify endpoint (leaves adminPosition null, which is
    // the EXACT state after a real Microsoft callback).
    // ============================================================
    const forceResp = await page.request.post(
      `${BASE}/api/admin/signup/debug/force-verify?token=${encodeURIComponent(token)}`,
    );
    expect(forceResp.status(), "force-verify succeeded").toBe(200);

    // ============================================================
    // Admin page MUST render the verified-admin state + position
    // form.  THIS is the state that the SIGNUP-1E defect broke —
    // the previous returnPath=/status would have redirected the
    // user past this screen entirely.
    // ============================================================
    await page.reload({ waitUntil: "domcontentloaded" });
    await expect(
      page.locator('[data-testid="signup-ms-verified"]'),
      "Admin page shows the verified-admin banner (not redirecting past it)",
    ).toBeVisible();
    await expect(
      page.locator('[data-testid="signup-position-form"]'),
      "Admin page shows the position form (NOT redirecting straight to /status)",
    ).toBeVisible();
    await page.screenshot({
      path: path.join(outDir, "signup-1e-admin-with-position-form.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });

    // ============================================================
    // Click the role dropdown + submit.  This exercises the EXACT
    // UI path the founder reportedly didn't reach.
    // ============================================================
    const roleSelect = page.locator('[data-testid="signup-select-position"]');
    await expect(roleSelect, "role dropdown is visible").toBeVisible();
    await expect(roleSelect, "role dropdown is enabled").toBeEnabled();
    await roleSelect.selectOption("Head Golf Professional / Director of Golf");

    const submit = page.locator('[data-testid="signup-position-submit"]');
    await expect(submit, "position submit button is visible").toBeVisible();
    await submit.click();

    // ============================================================
    // Browser navigates to /status.  Role field MUST display
    // "Head Golf Professional / Director of Golf" (NOT "Pending").
    // ============================================================
    await page.waitForURL(/\/signup\/t\/[A-Za-z0-9_-]+\/status$/, { timeout: 30_000 });
    await expect(page.locator('[data-testid="signup-status-card"]')).toBeVisible();

    const statusHtml = await page.locator('[data-testid="signup-status-card"]').innerText();
    expect(statusHtml, "status page displays the submitted role").toContain(
      "Head Golf Professional / Director of Golf",
    );
    expect(statusHtml, "status page does NOT display the role as Pending").not.toMatch(
      /Role\s*\n?\s*Pending/i,
    );
    await page.screenshot({
      path: path.join(outDir, "signup-1e-status-role-persisted.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });

    console.log("SIGNUP_1E_ROLE_PERSISTENCE_PASSED");
    await ctx.close();
  },
);
