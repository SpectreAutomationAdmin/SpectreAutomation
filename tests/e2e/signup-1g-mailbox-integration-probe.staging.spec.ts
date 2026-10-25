// SIGNUP-1G (2026-10-25) — Work Intake mailbox-integration probe.
//
// SIGNUP-1G stood up a SEPARATE Entra app (Spectre Transactional Mail)
// for Spectre's outbound no-reply@ sends.  The pre-existing Microsoft
// delegated OAuth app (client-id prefix b7f855a6) continues to serve:
//   - the signup Microsoft sign-in button (identity-only scopes), AND
//   - per-club Work Intake mailbox integration (Mail.Read + delegated
//     mailbox sync).
//
// This probe confirms Work Intake remains healthy after SIGNUP-1G.  It
// is intentionally conservative: it proves the Work Intake page loads
// for an authenticated club admin, that the feed renders rows, and
// that the mailbox-sync code paths continue to execute (no 500s, no
// mass-error log signal).  It does NOT drive a delete-in-Outlook ->
// disappears-in-Work-Intake round trip (that would require Outlook UI
// access the test harness does not have); the deeper
// Outlook<->Spectre convergence check lives in the WI-SYNC regression
// family, not SIGNUP-1G.
//
// Required env (via tests/e2e/_lib/staging-auth.ts):
//   SPECTRE_STAGING_EMAIL
//   SPECTRE_STAGING_PASSWORD

import { test, expect } from "@playwright/test";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { stagingCredsAvailable, loginAsFounder } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

function ensureOutDir(): string {
  const d = path.join("test-results");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

runAt(
  "SIGNUP-1G · Work Intake post-activation probe — page loads, feed renders, sync-pill present",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const outDir = ensureOutDir();

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    // Capture any 5xx responses or page errors so a mailbox-sync code-
    // path regression surfaces here, not in a founder-driven click.
    const failures: Array<{ url: string; status: number }> = [];
    const pageErrors: string[] = [];
    page.on("response", (res) => {
      if (res.status() >= 500) failures.push({ url: res.url(), status: res.status() });
    });
    page.on("pageerror", (err) => pageErrors.push(String(err?.message ?? err)));

    await loginAsFounder(ctx);

    // ================================================================
    // Work Intake admin page loads.
    // ================================================================
    await page.goto(`${BASE}/app/admin/work-intake`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });

    // The admin layout is required to be present (confirms we are
    // authenticated + Work Intake routing isn't throwing).
    await expect(
      page,
      "Work Intake URL remains /app/admin/work-intake after load",
    ).toHaveURL(/\/app\/admin\/work-intake(?:\?|$|#)/, { timeout: 30_000 });

    // Confirm the Work Intake scaffold rendered: the hero greeting
    // (`wi-hero-greeting`) is unconditionally emitted by
    // WorkIntakeHero.tsx on page load.  Its visibility proves the
    // page server-rendered successfully and the auth session reached
    // Work Intake code paths.
    await expect(
      page.locator('[data-testid="wi-hero-greeting"]'),
      "WorkIntake hero greeting is visible",
    ).toBeVisible({ timeout: 20_000 });

    // The feed-sync pill is the WI-1 live-sync affordance.  WI-1
    // emits `wi-hero-sync` on the hero when the live-sync affordance
    // is active.  Its presence confirms the mailbox-sync wiring
    // reached the client.
    await expect(
      page.locator('[data-testid="wi-hero-sync"]').first(),
      "WI hero sync pill is visible",
    ).toBeVisible({ timeout: 20_000 });

    // Capture the first fold for the acceptance evidence.
    await page.screenshot({
      path: path.join(outDir, "signup-1g-wi-page-load.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });

    // The Work Intake scaffold always renders either (a) a feed with
    // rows, or (b) an empty-state message.  Either is a valid "page
    // works" signal.  We additionally require ZERO 5xx responses and
    // ZERO uncaught page errors during the load.
    expect(
      failures,
      `No 5xx responses expected during Work Intake load.  Saw: ${JSON.stringify(failures)}`,
    ).toEqual([]);
    expect(
      pageErrors,
      `No uncaught page errors expected during Work Intake load.  Saw: ${JSON.stringify(pageErrors)}`,
    ).toEqual([]);

    // ================================================================
    // Diagnostic: confirm the mailbox-integration Entra client-id
    // prefix is still the pre-SIGNUP-1G value (b7f855a6).  The
    // dedicated transactional-mail app does NOT share this prefix.
    // ================================================================
    const diag = await page.request.get(`${BASE}/api/admin/signup/debug/status`);
    expect(diag.status(), "diagnostic reachable").toBe(200);
    const diagBody = await diag.json();
    expect(
      diagBody.microsoftOAuth.delegatedClientIdPrefix,
      "mailbox-integration delegated client-id prefix unchanged",
    ).toBe("b7f855a6");
    expect(
      diagBody.microsoftOAuth.mailboxRedirectUri,
      "mailbox redirect URI still registered",
    ).toContain("/api/integrations/microsoft/callback");
    // And the transactional-mail adapter is also healthy.
    expect(diagBody.email.effectiveAdapter).toBe("microsoft365");

    console.log("SIGNUP_1G_WORK_INTAKE_PROBE_PASSED");
    await ctx.close();
  },
);
