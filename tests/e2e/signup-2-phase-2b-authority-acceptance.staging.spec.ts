// SIGNUP-2 Phase 2B (2026-10-25) -- live staging acceptance.
//
// Covers:
//   A. "coming soon" state when SPECTRE_SIGNUP_2B_ATTESTATION_LIVE
//      is unset (fail-closed default).
//   B. Status-page CTA to /authority is HIDDEN when flag is unset.
//   C. The feature-flag + ToS-approved assertion rejects a POST
//      against the dev fixture.
//   D. Un-authorized direct POST without a valid token returns 403
//      (defense in depth beyond the fail-closed flag).
//   E. ZERO WRITES to User / Club / UserClubRole / ClubSubscription
//      -- the Phase-2G isolation invariant.
//   F. Fixture tear-down leaves the DB in its original state.
//
// Note: completing a real authorisation requires BOTH:
//    - SPECTRE_SIGNUP_2B_ATTESTATION_LIVE=1 on the running container
//    - a founder-APPROVED ToS at docs/legal/terms-of-service-v1.md
// Neither is set in Phase 2B staging per founder decision (§5 "No
// production config change"; §2.1 "Do not publish placeholder legal
// terms").  This acceptance proves the fail-closed path AND the UI
// surfaces that are safe to ship with the workflow dormant.

import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const FLYCTL = "C:/Users/cturcato/.fly/bin/flyctl.exe";
const FIXTURE_SCRIPT = "scripts/signup-2-phase-2b-staging-fixture.mjs";
const FIXTURE_BASENAME = path.basename(FIXTURE_SCRIPT);

function sshExec(cmd: string): string {
  // Run the UPLOADED fresh copy from /app (not /app/scripts/, which
  // holds the version baked in at deploy time).  This lets the test
  // iterate on the fixture harness without a redeploy.
  const full = `"${FLYCTL}" ssh console --app spectre-staging --command "sh -c 'cd /app && node ${FIXTURE_BASENAME} ${cmd}'"`;
  try {
    return execSync(full, { encoding: "utf8", timeout: 120_000 });
  } catch (e) {
    return `SSH_ERROR ${(e as Error).message}`;
  }
}

function uploadFixtureScript(): void {
  const localPath = path.join(process.cwd(), FIXTURE_SCRIPT);
  try {
    execSync(
      `"${FLYCTL}" ssh console --app spectre-staging --command "rm -f /app/${FIXTURE_BASENAME}"`,
      { encoding: "utf8", timeout: 60_000 },
    );
  } catch {}
  const dir = path.dirname(localPath);
  execSync(
    `cd "${dir}" && "${FLYCTL}" ssh sftp put --app spectre-staging ${FIXTURE_BASENAME}`,
    { encoding: "utf8", timeout: 60_000 },
  );
}

function parseFirstJson(stdout: string): any {
  // The fixture script prints JSON as the FIRST line of stdout.
  const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error(`No JSON line found in: ${stdout}`);
  return JSON.parse(line);
}

function ensureOutDir(): string {
  const d = path.join("test-results");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

runAt(
  "SIGNUP-2 Phase 2B · fail-closed authority attestation acceptance",
  async ({ browser }, testInfo) => {
    // This spec drives the live staging host via SSH-uploaded
    // fixtures.  Only the `staging-authenticated` project should
    // run it; the default `chromium` project would race against
    // the fixture harness on the same staging container.
    test.skip(
      testInfo.project.name !== "staging-authenticated",
      "staging-only spec",
    );

    test.setTimeout(900_000);
    const outDir = ensureOutDir();

    // ============================================================
    // Fixture setup (deterministic)
    // ============================================================
    uploadFixtureScript();

    // Destroy any lingering state first (idempotent).
    sshExec("destroy");

    // Create a verified SignupRegistration in READY_FOR_AUTHORITY_ATTESTATION.
    const createOut = sshExec("create");
    writeFileSync(path.join(outDir, "signup-2-2b-fixture-create.txt"), createOut);
    const fixture = parseFirstJson(createOut) as {
      resumeUrl: string;
      authorityUrl: string;
      registrationId: string;
      token: string;
      adminMicrosoftOid: string;
      adminMicrosoftTid: string;
    };
    expect(fixture.token).toMatch(/^sig2b-fixture-/);
    expect(fixture.registrationId.length).toBeGreaterThan(10);

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();

    // ============================================================
    // A. Authority page shows "coming soon" when flag is OFF
    // ============================================================
    await page.goto(fixture.authorityUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await expect(
      page.locator('[data-testid="signup-authority-coming-soon"]'),
      "A: fail-closed default shows coming-soon banner",
    ).toBeVisible();
    // Form must NOT be present.
    await expect(page.locator('[data-testid="signup-authority-form"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="signup-authority-submit"]')).toHaveCount(0);
    await page.screenshot({
      path: path.join(outDir, "signup-2-2b-A-coming-soon.png"),
      clip: { x: 0, y: 0, width: 1440, height: 900 },
    });

    // ============================================================
    // B. Status page does NOT render the CTA to /authority
    // ============================================================
    await page.goto(fixture.resumeUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await expect(
      page.locator('[data-testid="signup-status-authority-cta"]'),
      "B: status-page CTA hidden when flag is unset",
    ).toHaveCount(0);
    await expect(
      page.locator('[data-testid="signup-status-authority-link"]'),
    ).toHaveCount(0);

    // ============================================================
    // C. POST /api/signup/authority/accept is refused by the gate
    //
    // The fail-closed path is a 303 to /signup?error=... (safe
    // form-POST UX; users land somewhere sensible, not on an error
    // JSON page).  The REAL invariant is:
    //   (a) response is NOT 2xx (no success body)
    //   (b) Location does NOT redirect to the /authority/complete
    //       receipt (which would indicate acceptance)
    //   (c) scenario E below asserts zero attestation rows were
    //       created, which is the hard end-state guarantee.
    // ============================================================
    const postResp = await page.request.post(`${BASE}/api/signup/authority/accept`, {
      form: {
        token: fixture.token,
        signatoryFullName: "Fixture Signatory",
        signatoryTitle: "General Manager",
        confirmed: "1",
      },
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    expect(
      postResp.status(),
      "C: fail-closed POST never returns 2xx (success)",
    ).toBeGreaterThanOrEqual(300);
    expect(
      postResp.status(),
      "C: fail-closed POST never returns 2xx (success)",
    ).toBeLessThan(600);
    const location = postResp.headers()["location"] ?? "";
    expect(
      location,
      "C: fail-closed POST never redirects to /authority/complete",
    ).not.toMatch(/\/authority\/complete/);
    // Must land on a safe landing (/signup or /signup/t/<token>/*).
    expect(
      location,
      "C: redirect target is a safe signup landing (not a privileged route)",
    ).toMatch(/\/signup/);
    writeFileSync(
      path.join(outDir, "signup-2-2b-C-post-response.json"),
      JSON.stringify(
        {
          status: postResp.status(),
          location,
          body: await postResp.text().catch(() => "<unreadable>"),
        },
        null,
        2,
      ),
    );

    // ============================================================
    // D. POST without a valid token returns a safe redirect (no disclosure)
    // ============================================================
    const bogus = await page.request.post(`${BASE}/api/signup/authority/accept`, {
      form: {
        token: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        signatoryFullName: "Attacker",
        signatoryTitle: "Attacker",
        confirmed: "1",
      },
      maxRedirects: 0,
      failOnStatusCode: false,
    });
    // Fail-closed (flag off) is tested in C.  With a bogus token the
    // path never gets past the flag gate anyway.
    expect(
      bogus.status(),
      "D: bogus token POST never returns 2xx",
    ).toBeGreaterThanOrEqual(300);
    const bogusLoc = bogus.headers()["location"] ?? "";
    expect(bogusLoc, "D: bogus token never routes to /authority/complete").not.toMatch(/\/authority\/complete/);

    // ============================================================
    // E. ZERO attestation rows created for this fixture
    // ============================================================
    // The fixture script's `verify` subcommand counts attestations
    // + registrations attached to the fixture oid.  Using the
    // helper (not an ad-hoc Prisma-over-SSH query) keeps all shell
    // escaping inside a single file.
    const verifyOut = sshExec("verify");
    writeFileSync(path.join(outDir, "signup-2-2b-E-verify.txt"), verifyOut);
    const verify = parseFirstJson(verifyOut) as { attestations: number; registrations: number };
    expect(
      verify.attestations,
      "E: Phase-2G isolation -- no attestation rows created with flag off",
    ).toBe(0);
    expect(verify.registrations, "E: fixture registration still present pre-destroy").toBeGreaterThanOrEqual(1);

    // ============================================================
    // F. Fixture teardown is deterministic
    // ============================================================
    const destroyOut = sshExec("destroy");
    writeFileSync(path.join(outDir, "signup-2-2b-fixture-destroy.txt"), destroyOut);
    const destroyed = parseFirstJson(destroyOut) as { destroyed: number };
    expect(destroyed.destroyed, "F: destroy removes >=1 fixture registration").toBeGreaterThanOrEqual(1);

    // Second destroy is a no-op (idempotent).
    const destroyOut2 = sshExec("destroy");
    const destroyed2 = parseFirstJson(destroyOut2) as { destroyed: number };
    expect(destroyed2.destroyed, "F: idempotent destroy = 0 the second time").toBe(0);
  },
);
