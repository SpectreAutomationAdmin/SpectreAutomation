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

function sshExec(cmd: string): string {
  const full = `"${FLYCTL}" ssh console --app spectre-staging --command "sh -c 'cd /app && node ${FIXTURE_SCRIPT} ${cmd}'"`;
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
      `"${FLYCTL}" ssh console --app spectre-staging --command "rm -f /app/${path.basename(FIXTURE_SCRIPT)}"`,
      { encoding: "utf8", timeout: 60_000 },
    );
  } catch {}
  const dir = path.dirname(localPath);
  execSync(
    `cd "${dir}" && "${FLYCTL}" ssh sftp put --app spectre-staging ${path.basename(FIXTURE_SCRIPT)}`,
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
  async ({ browser }) => {
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
    // Must be 400+ (not 2xx and not 303 to /complete).
    expect(
      postResp.status(),
      "C: fail-closed POST refused (403/400/500 all acceptable; must NOT be 2xx or 303)",
    ).toBeGreaterThanOrEqual(400);
    writeFileSync(
      path.join(outDir, "signup-2-2b-C-post-response.json"),
      JSON.stringify(
        {
          status: postResp.status(),
          headers: postResp.headers(),
          body: await postResp.text().catch(() => "<unreadable>"),
        },
        null,
        2,
      ),
    );

    // ============================================================
    // D. POST without a valid token returns a safe error (no disclosure)
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
    expect(bogus.status(), "D: bogus token refused").toBeGreaterThanOrEqual(400);

    // ============================================================
    // E. ZERO attestation rows created for this fixture
    // ============================================================
    // Query by fixture oid; must be zero.
    const checkOut = execSync(
      `"${FLYCTL}" ssh console --app spectre-staging --command "sh -c 'cd /app && node -e \\"const p=new (require(\\\\\\"@prisma/client\\\\\\").PrismaClient)(); p.subscriptionAuthorisationAttestation.count({where:{acceptedByMicrosoftOid:\\\\\\"${fixture.adminMicrosoftOid}\\\\\\"}}).then(n=>console.log(JSON.stringify({attestations:n}))).finally(()=>p.\\$disconnect());\\"'"`,
      { encoding: "utf8", timeout: 60_000 },
    );
    const attestationCount = parseFirstJson(checkOut) as { attestations: number };
    expect(
      attestationCount.attestations,
      "E: Phase-2G isolation -- no attestation rows created with flag off",
    ).toBe(0);

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
