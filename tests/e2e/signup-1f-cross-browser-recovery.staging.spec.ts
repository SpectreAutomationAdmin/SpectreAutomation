// SIGNUP-1F (2026-10-20) — Cross-browser recovery acceptance.
//
// Simulates the real cross-device flow:
//   1. Browser A starts the signup + reaches Screen 2.
//   2. Browser A triggers the force-verify debug endpoint (which
//      mirrors the exact post-callback state and ALSO issues a
//      SignupRecoveryLink — same code path the real Microsoft
//      callback uses).
//   3. The recovery link's plaintext token is returned by
//      force-verify (staging only).
//   4. Browser B (fresh context, no cookies) clicks /signup/r/<token>.
//   5. Asserts Browser B lands on /signup/t/<newResumeToken>/status
//      and the status card renders the SAME registration + the SAME
//      "Head Golf Professional" position.
//   6. Browser B's cookie is set.
//   7. A second click of the SAME link in Browser C fails with the
//      "already used" error — the link is single-use.
//   8. Browser B requests a fresh link via /signup/resume → ack page
//      renders without disclosing match/no-match.
//
// Scope: this test depends on the staging force-verify endpoint for
// the Microsoft identity portion.  The subsequent /signup/r/ consume
// is driven exclusively through the real UI — no backdoors.

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
  "SIGNUP-1F · cross-browser recovery — issue, consume once, replay rejected, fresh-link flow intact",
  async ({ browser }) => {
    test.setTimeout(600_000);
    const outDir = ensureOutDir();

    // ================================================================
    // Browser A — start Screen 1 → Screen 2 → force-verify
    // ================================================================
    const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageA = await ctxA.newPage();

    await pageA.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const uniq = `XB-RECOVERY ${Date.now()}`;
    await pageA.locator('[data-testid="signup-input-legalName"]').fill(uniq);
    await pageA.locator('[data-testid="signup-select-country"]').selectOption("CA");
    await pageA.locator('[data-testid="signup-select-province"]').selectOption("ON");
    await pageA.locator('[data-testid="signup-input-addressLine1"]').fill("88 Richmond Street W");
    await pageA.locator('[data-testid="signup-input-city"]').fill("Toronto");
    await pageA.locator('[data-testid="signup-input-postalCode"]').fill("M5H 2L4");
    await pageA.locator('[data-testid="signup-identity-submit"]').click();
    await pageA.waitForURL(/\/signup\/t\/[A-Za-z0-9_-]+\/admin$/, { timeout: 30_000 });
    const token = pageA.url().match(/\/signup\/t\/([A-Za-z0-9_-]+)\/admin$/)![1];

    const forceResp = await pageA.request.post(
      `${BASE}/api/admin/signup/debug/force-verify?token=${encodeURIComponent(token)}`,
    );
    expect(forceResp.status(), "force-verify succeeded").toBe(200);
    const forceBody = await forceResp.json();
    expect(forceBody.ok).toBe(true);
    expect(forceBody.emailResumeToken, "recovery token issued").toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(forceBody.recoveryLinkIdTail, "recovery link id tail present").toMatch(/^[a-z0-9]{6}$/);
    const recoveryToken: string = forceBody.emailResumeToken;

    // Browser A finishes capturing position so we can later confirm
    // Browser B sees the SAME persisted role.
    await pageA.reload({ waitUntil: "domcontentloaded" });
    await pageA.locator('[data-testid="signup-select-position"]').selectOption(
      "Head Golf Professional / Director of Golf",
    );
    await pageA.locator('[data-testid="signup-position-submit"]').click();
    await pageA.waitForURL(/\/signup\/t\/[A-Za-z0-9_-]+\/status$/, { timeout: 30_000 });

    // ================================================================
    // Browser B — fresh context, no cookies.  Click /signup/r/<token>.
    //
    // SIGNUP-1G repair (2026-10-25): the GET on /signup/r/<token>
    // now renders a stateless confirmation landing page.  The actual
    // consume happens when the user clicks the on-page "Continue"
    // button (POST to /signup/r/<token>/consume).  This defeats
    // Microsoft Defender Safe Links pre-fetch.
    //
    // The landing page is the first stop; the POST is the second.
    // ================================================================
    const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageB = await ctxB.newPage();
    await pageB.goto(`${BASE}/signup/r/${encodeURIComponent(recoveryToken)}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    // Confirmation landing page is rendered -- not a redirect.
    await expect(pageB.locator('[data-testid="signup-recovery-confirm-form"]'), "Browser B lands on recovery confirmation page").toBeVisible();
    await pageB.locator('[data-testid="signup-recovery-confirm-submit"]').click();
    await pageB.waitForURL(/\/signup\/t\/[A-Za-z0-9_-]+\/status$/, { timeout: 30_000 });

    // Browser B lands on the SAME registration — status card
    // contains the Club name AND the submitted role.
    const bText = await pageB.locator('[data-testid="signup-status-card"]').innerText();
    expect(bText, "Browser B sees the same registration").toContain(uniq);
    expect(bText, "Browser B sees the persisted role").toContain(
      "Head Golf Professional / Director of Golf",
    );
    // Browser B has a cookie set now.
    const bCookies = await ctxB.cookies();
    const bResume = bCookies.find((c) => c.name === "spectre_signup_resume");
    expect(bResume, "Browser B has the resume cookie").toBeDefined();
    expect(bResume!.httpOnly, "cookie is HTTPOnly").toBe(true);
    expect(bResume!.sameSite, "cookie is sameSite=lax").toBe("Lax");

    await pageB.screenshot({
      path: path.join(outDir, "signup-1f-browser-b-status.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });

    // ================================================================
    // Browser C — second attempt on the SAME link must be rejected
    // (single-use).  Expected: landing page renders (stateless), the
    // POST then redirects to /signup/resume?error=already_used.
    // ================================================================
    const ctxC = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const pageC = await ctxC.newPage();
    await pageC.goto(`${BASE}/signup/r/${encodeURIComponent(recoveryToken)}`, {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    // Same landing page -- the GET classifies nothing.
    await expect(pageC.locator('[data-testid="signup-recovery-confirm-form"]'), "Browser C lands on the same stateless confirmation page").toBeVisible();
    await pageC.locator('[data-testid="signup-recovery-confirm-submit"]').click();
    await pageC.waitForURL(/\/signup\/resume\?error=already_used/, { timeout: 30_000 });
    const cErrText = await pageC.locator('[data-testid="signup-resume-error"]').innerText();
    expect(cErrText, "the already-used copy renders").toMatch(/already been used/i);

    // ================================================================
    // Browser C — request a fresh link via /signup/resume.
    // Enumeration-safe: ack renders without disclosing match status.
    // ================================================================
    await pageC.locator('[data-testid="signup-resume-input-email"]').fill("debug.verified@spectre.local");
    await pageC.locator('[data-testid="signup-resume-submit"]').click();
    await pageC.waitForURL(/\/signup\/resume\?sent=1/, { timeout: 30_000 });
    await expect(pageC.locator('[data-testid="signup-resume-sent"]')).toBeVisible();

    // Also try an obviously-non-matching email — must get the SAME ack.
    await pageC.goto(`${BASE}/signup/resume`, { waitUntil: "domcontentloaded" });
    await pageC.locator('[data-testid="signup-resume-input-email"]').fill(`no-match-${Date.now()}@example.com`);
    await pageC.locator('[data-testid="signup-resume-submit"]').click();
    await pageC.waitForURL(/\/signup\/resume\?sent=1/, { timeout: 30_000 });
    await expect(
      pageC.locator('[data-testid="signup-resume-sent"]'),
      "enumeration-safe: non-match renders identical ack",
    ).toBeVisible();

    await pageC.screenshot({
      path: path.join(outDir, "signup-1f-browser-c-fresh-ack.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });

    console.log("SIGNUP_1F_CROSS_BROWSER_RECOVERY_PASSED");
    await ctxA.close();
    await ctxB.close();
    await ctxC.close();
  },
);
