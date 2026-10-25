// SIGNUP-1G (2026-10-25) — Deterministic recovery-link expiry regression.
//
// Proves /signup/r/<token> rejects an EXPIRED recovery link without
// waiting 30 real minutes.  Uses the staging-only ops SSH script
// `expire-recovery-link <recoveryToken>` to backdate the matching
// SignupRecoveryLink.expiresAt into the past (<today> - 1s).
//
// Flow:
//   1. Walk Screen 1 through the real UI.
//   2. Call /api/admin/signup/debug/force-verify (staging-only) to
//      stamp verified identity + issue a fresh SignupRecoveryLink.
//      Captures the plaintext recovery token in the response.
//   3. Run the ops command to backdate that link's expiresAt.
//   4. Open /signup/r/<token> in a fresh browser.
//   5. Assert the browser lands on /signup/resume?error=expired
//      and the on-page copy renders the "expired" message.
//   6. Attempt to request a fresh link via the enumeration-safe
//      /api/signup/resume/request; confirm the operator-side
//      sent-ack path still renders (enumeration safety preserved).
//
// This spec does NOT send real email.  Phase C.2's live Graph
// positive-send test (founder-confirmed Outlook delivery) already
// proved the Spectre -> Microsoft Graph -> real-inbox pipeline.
// This spec is strictly the expiry-rejection half of the Phase D.4
// recovery-link lifecycle.

import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

function ensureOutDir(): string {
  const d = path.join("test-results");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

const flyctl = "C:/Users/cturcato/.fly/bin/flyctl.exe";

let opsUploaded = false;
function uploadOpsOnce() {
  if (opsUploaded) return;
  const local = path.join(
    process.env.USERPROFILE || process.env.HOME || "",
    "AppData/Local/Temp/claude/c--dev-SpectreAutomation/0024fdd7-1cbc-4a67-8903-1a917d6d43e4/scratchpad/signup-1-staging-ops.mjs",
  );
  const dir = path.dirname(local);
  try { execSync(`"${flyctl}" ssh console --app spectre-staging --command "rm -f /app/signup-1-staging-ops.mjs"`, { encoding: "utf8", timeout: 60_000 }); } catch {}
  execSync(`cd "${dir}" && "${flyctl}" ssh sftp put --app spectre-staging signup-1-staging-ops.mjs`, { encoding: "utf8", timeout: 60_000 });
  opsUploaded = true;
}

function sshExec(cmd: string): string {
  uploadOpsOnce();
  return execSync(
    `"${flyctl}" ssh console --app spectre-staging --command "node /app/signup-1-staging-ops.mjs ${cmd}"`,
    { encoding: "utf8", timeout: 120_000 },
  );
}

function parse<T>(raw: string, tag: string): T | null {
  const line = raw.split(/\r?\n/).map((l) => l.trim()).find((l) => l.startsWith(tag + " "));
  if (!line) return null;
  return JSON.parse(line.slice(tag.length + 1).trim()) as T;
}

runAt(
  "SIGNUP-1G · deterministic expiry — backdate SignupRecoveryLink.expiresAt and confirm /signup/r rejects",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const outDir = ensureOutDir();

    // ================================================================
    // 1. Walk Screen 1
    // ================================================================
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/signup`, { waitUntil: "domcontentloaded", timeout: 60_000 });
    const uniq = `EXPIRY-DET ${Date.now()}`;
    await page.locator('[data-testid="signup-input-legalName"]').fill(uniq);
    await page.locator('[data-testid="signup-select-country"]').selectOption("CA");
    await page.locator('[data-testid="signup-select-province"]').selectOption("ON");
    await page.locator('[data-testid="signup-input-addressLine1"]').fill("77 King Street W");
    await page.locator('[data-testid="signup-input-city"]').fill("Toronto");
    await page.locator('[data-testid="signup-input-postalCode"]').fill("M5K 1A1");
    await page.locator('[data-testid="signup-identity-submit"]').click();
    await page.waitForURL(/\/signup\/t\/[A-Za-z0-9_-]+\/admin$/, { timeout: 30_000 });
    const token = page.url().match(/\/signup\/t\/([A-Za-z0-9_-]+)\/admin$/)![1];

    // ================================================================
    // 2. Force-verify so a SignupRecoveryLink is issued.
    // ================================================================
    const forceResp = await page.request.post(
      `${BASE}/api/admin/signup/debug/force-verify?token=${encodeURIComponent(token)}`,
    );
    expect(forceResp.status(), "force-verify succeeded").toBe(200);
    const forceBody = await forceResp.json();
    expect(forceBody.ok).toBe(true);
    const recoveryToken: string = forceBody.emailResumeToken;
    expect(recoveryToken, "recovery token issued").toMatch(/^[A-Za-z0-9_-]{32,}$/);
    const linkIdTail: string = forceBody.recoveryLinkIdTail;
    expect(linkIdTail, "recovery link id tail").toMatch(/^[a-z0-9]{6}$/);
    const expiresAtIso: string = forceBody.recoveryLinkExpiresAt;
    const ttlMinutes = Math.round(
      (new Date(expiresAtIso).getTime() - Date.now()) / 60_000,
    );
    expect(ttlMinutes, "recovery TTL is 30 min at issue").toBeGreaterThanOrEqual(29);
    expect(ttlMinutes).toBeLessThanOrEqual(31);

    // ================================================================
    // 3. Deterministic: backdate the SignupRecoveryLink's expiresAt
    // ================================================================
    const backdate = parse<{ ok: boolean; linkIdTail: string; newExpiresAt: string; error?: string }>(
      sshExec(`expire-recovery-link ${encodeURIComponent(recoveryToken)}`),
      "EXPIRE_RECOVERY_LINK",
    );
    expect(backdate, "ops expire-recovery-link returned JSON").toBeTruthy();
    expect(backdate!.ok, `expire-recovery-link ok (saw ${JSON.stringify(backdate)})`).toBe(true);
    expect(backdate!.linkIdTail).toBe(linkIdTail);
    expect(
      new Date(backdate!.newExpiresAt).getTime(),
      "backdated expiresAt is in the past",
    ).toBeLessThan(Date.now());

    // ================================================================
    // 4. Fresh browser clicks /signup/r/<token>.  Expect expired.
    //
    // SIGNUP-1G repair (2026-10-25): the GET lands on a stateless
    // confirmation page; the EXPIRED classification only happens
    // on the POST triggered by clicking "Continue".
    // ================================================================
    const expiredCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const expiredPage = await expiredCtx.newPage();
    await expiredPage.goto(
      `${BASE}/signup/r/${encodeURIComponent(recoveryToken)}`,
      { waitUntil: "domcontentloaded", timeout: 60_000 },
    );
    await expect(
      expiredPage.locator('[data-testid="signup-recovery-confirm-form"]'),
      "Browser lands on confirmation page (even for expired tokens -- stateless GET)",
    ).toBeVisible();
    await expiredPage.locator('[data-testid="signup-recovery-confirm-submit"]').click();
    await expiredPage.waitForURL(/\/signup\/resume\?error=expired/, { timeout: 30_000 });
    const errText = await expiredPage.locator('[data-testid="signup-resume-error"]').innerText();
    expect(errText, "expired message rendered").toMatch(/expired/i);
    await expiredPage.screenshot({
      path: path.join(outDir, "signup-1g-expiry-deterministic-expired.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });

    // ================================================================
    // 5. Enumeration-safe fresh-link request from the same browser
    // ================================================================
    await expiredPage.locator('[data-testid="signup-resume-input-email"]').fill(
      "debug.verified@spectre.local",
    );
    await expiredPage.locator('[data-testid="signup-resume-submit"]').click();
    await expiredPage.waitForURL(/\/signup\/resume\?sent=1/, { timeout: 30_000 });
    await expect(expiredPage.locator('[data-testid="signup-resume-sent"]')).toBeVisible();

    console.log("SIGNUP_1G_EXPIRY_DETERMINISTIC_PASSED");
    await ctx.close();
    await expiredCtx.close();
  },
);
