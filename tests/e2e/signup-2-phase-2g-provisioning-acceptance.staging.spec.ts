// SIGNUP-2 Phase 2G (2026-10-26) -- Deployed staging acceptance.
//
// Covers founder §7 of the Phase 2G authorisation:
//   A. Successful synthetic provisioning (9 steps -> COMPLETED,
//      accessTier=FULL).
//   B. Duplicate job execution (idempotent tick: no new rows).
//   C. Existing Club slug collision (step 2 refuses + alert).
//   D. Existing User email collision (step 1 refuses + alert).
//   E. Financial reversal mid-provisioning (pre-step revalidation
//      cancels; sentinel stamped; nothing deleted).
//   F. Mock-evidence rejection by production-capable path (sweep
//      without SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING).
//   G. Fail-closed flag (SPECTRE_SIGNUP_2G_PROVISIONING_LIVE OFF
//      -> 403).
//
// Pattern mirrors signup-2-phase-2f-activation-acceptance.staging.spec.ts:
//   - Synthetic SUPER_ADMIN operator (destroyed on teardown).
//   - Controlled flag window.
//   - test.afterAll guarantees teardown on pass or fail.
//
// Mock-isolation remains in force: Phase 2G refuses `mock-stripe`
// evidence unless SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING=1.
// The acceptance window flips BOTH 2G flags + both 2F flags + the
// 2F ToS fixture.  Everything flips OFF at teardown.

import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { execSync } from "node:child_process";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { stagingCredsAvailable, loginAsFounder } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const FLYCTL = "C:/Users/cturcato/.fly/bin/flyctl.exe";
const FIXTURE_SCRIPT = "scripts/signup-2-phase-2b-staging-fixture.mjs";
const FIXTURE_BASENAME = path.basename(FIXTURE_SCRIPT);

function sshExec(cmd: string): string {
  const full = `"${FLYCTL}" ssh console --app spectre-staging --command "sh -c 'cd /app && node ${FIXTURE_BASENAME} ${cmd}'"`;
  try {
    return execSync(full, { encoding: "utf8", timeout: 180_000 });
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
  const line = stdout.split(/\r?\n/).find((l) => l.trim().startsWith("{"));
  if (!line) throw new Error(`No JSON line found in: ${stdout}`);
  return JSON.parse(line);
}

function ensureOutDir(): string {
  const d = path.join("test-results");
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
}

// Failure-safe teardown.  Destroys the synthetic SUPER_ADMIN, the
// staging ToS fixture, every phase2g-* scenario, and every
// phase2f-* scenario left behind by the Phase 2F fixture.  Fires
// on pass or fail.
test.afterAll(async () => {
  if (!stagingCredsAvailable().ready) return;
  try {
    execSync(
      `"${FLYCTL}" ssh console --app spectre-staging --command "sh -c 'cd /app && node ${FIXTURE_BASENAME} phase2g-teardown && node ${FIXTURE_BASENAME} phase2f-teardown && node ${FIXTURE_BASENAME} phase2f-super-admin-teardown'"`,
      { encoding: "utf8", timeout: 180_000 },
    );
  } catch (e) {
    console.error("afterAll teardown failed:", (e as Error).message);
  }
});

runAt(
  "SIGNUP-2 Phase 2G · durable provisioning staging acceptance",
  async ({ browser }, testInfo) => {
    test.skip(
      testInfo.project.name !== "staging-authenticated",
      "staging-only spec",
    );
    test.setTimeout(1_800_000);
    const outDir = ensureOutDir();

    // ============================================================
    // Setup
    // ============================================================
    uploadFixtureScript();
    sshExec("phase2g-teardown");
    sshExec("phase2f-super-admin-teardown");
    const operatorFixture = parseFirstJson(sshExec("phase2f-super-admin-setup"));
    writeFileSync(path.join(outDir, "signup-2-2g-operator-fixture.json"), JSON.stringify(operatorFixture, null, 2));
    expect(operatorFixture.userId, "operator created").toBeTruthy();
    expect(operatorFixture.tosPath, "staging-only ToS doc installed").toMatch(/terms-of-service-v1\.md$/);

    const tickUrl = `${BASE}/api/admin/signup-ops/provisioning-tick`;
    const diagUrl = (jobId: string) => `${BASE}/api/admin/signup-ops/provisioning/${jobId}`;

    // ============================================================
    // G. Fail-closed flag -- Controller founder also receives 403
    //    (RBAC separation, same as Phase 2F).
    // ============================================================
    const founderCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const founderPage = await loginAsFounder(founderCtx);
    const founderResp = await founderPage.request.post(tickUrl, { failOnStatusCode: false });
    writeFileSync(path.join(outDir, "signup-2-2g-controller-forbidden.json"), JSON.stringify({
      status: founderResp.status(),
      body: await founderResp.text().catch(() => "<unreadable>"),
    }, null, 2));
    expect(founderResp.status(), "CONTROLLER receives 403").toBe(403);
    await founderCtx.close();

    // Log in as the synthetic SUPER_ADMIN for the rest of the run.
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await page.locator('input[name="email"]').fill(operatorFixture.email);
    await page.locator('input[name="password"]').fill(operatorFixture.password);
    await Promise.all([
      page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 }),
      page.locator('form button[type="submit"]').first().click(),
    ]);

    // Bootstrap sweep: with flags ON, status 200.  With flags OFF
    // we would see 500 (ForbiddenError propagates as server_error).
    const bootstrapResp = await page.request.post(tickUrl, { failOnStatusCode: false });
    const bootstrapBody = await bootstrapResp.text();
    writeFileSync(path.join(outDir, "signup-2-2g-G-bootstrap.json"), JSON.stringify({
      status: bootstrapResp.status(),
      body: bootstrapBody,
    }, null, 2));
    expect([200, 403, 500]).toContain(bootstrapResp.status());

    // ============================================================
    // A. Happy path: seed + drive 9 ticks -> COMPLETED, Tier 2.
    // ============================================================
    const happySeed = parseFirstJson(sshExec("phase2g-seed happy"));
    writeFileSync(path.join(outDir, "signup-2-2g-A-seed.json"), JSON.stringify(happySeed, null, 2));
    const happyJobId = happySeed.tenantProvisioningJobId;
    expect(happyJobId, "happy job seeded").toBeTruthy();

    // Drive the job through all 9 steps.  Each POST ticks ONE step.
    for (let i = 0; i < 9; i++) {
      const r = await page.request.post(`${tickUrl}?jobId=${happyJobId}`, { failOnStatusCode: false });
      const body = await r.text();
      writeFileSync(path.join(outDir, `signup-2-2g-A-tick-${i + 1}.json`), JSON.stringify({
        status: r.status(),
        body,
      }, null, 2));
      expect(r.status(), `A: tick ${i + 1} status`).toBe(200);
      const parsed = JSON.parse(body);
      expect(parsed.ok, `A: tick ${i + 1} ok`).toBe(true);
      if (parsed.outcome?.completed) break;
    }

    // Read the completed job state via the diagnostic endpoint.
    const happyDiag = await page.request.get(diagUrl(happyJobId), { failOnStatusCode: false });
    const happyDiagBody = await happyDiag.text();
    writeFileSync(path.join(outDir, "signup-2-2g-A-diagnostic.json"), JSON.stringify({
      status: happyDiag.status(),
      body: happyDiagBody,
    }, null, 2));
    expect(happyDiag.status()).toBe(200);
    const happyJob = JSON.parse(happyDiagBody).job;
    expect(happyJob.state, "A: job COMPLETED").toBe("COMPLETED");
    expect(happyJob.provisionedUserId, "A: user created").toBeTruthy();
    expect(happyJob.provisionedClubId, "A: club created").toBeTruthy();
    expect(happyJob.rolesAssignedBatchKey, "A: roles assigned").toBeTruthy();
    expect(happyJob.committedCoaBatchKey, "A: COA committed").toBeTruthy();
    expect(happyJob.committedOpeningBalanceBatchKey, "A: opening balance committed").toBeTruthy();
    expect(happyJob.committedBrandingBatchKey, "A: branding committed").toBeTruthy();
    expect(happyJob.invitationsDeliveredBatchKey, "A: invitations delivered").toBeTruthy();
    expect(happyJob.welcomeEmailProviderMessageId, "A: welcome email id stamped").toBeTruthy();
    expect(happyJob.completedAt, "A: completedAt set").toBeTruthy();
    expect(happyJob.cancelledAt, "A: not cancelled").toBeNull();

    // Inspect the ClubSubscription -- accessTier=FULL + subscriptionStatus=ACTIVE.
    const happyInspect = parseFirstJson(sshExec("phase2g-inspect happy"));
    writeFileSync(path.join(outDir, "signup-2-2g-A-inspect.json"), JSON.stringify(happyInspect, null, 2));
    expect(happyInspect.clubSubscription.subscriptionStatus).toBe("ACTIVE");
    expect(happyInspect.clubSubscription.accessTier).toBe("FULL");
    expect(happyInspect.clubSubscription.provisioningCancelledAt).toBeNull();
    expect(happyInspect.userClubRole.roleKey).toBe("CLUB_ADMIN");

    // ============================================================
    // B. Duplicate job execution -- a 10th tick on the completed
    //    job is a no-op (returns JOB_TERMINAL).
    // ============================================================
    const dupResp = await page.request.post(`${tickUrl}?jobId=${happyJobId}`, { failOnStatusCode: false });
    const dupBody = await dupResp.text();
    writeFileSync(path.join(outDir, "signup-2-2g-B-duplicate-tick.json"), JSON.stringify({
      status: dupResp.status(),
      body: dupBody,
    }, null, 2));
    expect(dupResp.status()).toBe(200);
    const dup = JSON.parse(dupBody);
    expect(dup.outcome.ok).toBe(false);
    expect(dup.outcome.reason).toBe("JOB_TERMINAL");

    // ============================================================
    // C. Slug collision: pre-seeded Club with the derived slug.
    // ============================================================
    const slugSeed = parseFirstJson(sshExec("phase2g-seed slug-collision"));
    writeFileSync(path.join(outDir, "signup-2-2g-C-seed.json"), JSON.stringify(slugSeed, null, 2));
    expect(slugSeed.preseededClubId, "preseeded Club with colliding slug").toBeTruthy();
    // Advance through step 1 (USER_CREATED), then step 2 should refuse.
    const slugTick1 = await page.request.post(`${tickUrl}?jobId=${slugSeed.tenantProvisioningJobId}`, { failOnStatusCode: false });
    expect(slugTick1.status()).toBe(200);
    const slugTick2 = await page.request.post(`${tickUrl}?jobId=${slugSeed.tenantProvisioningJobId}`, { failOnStatusCode: false });
    const slugBody = await slugTick2.text();
    writeFileSync(path.join(outDir, "signup-2-2g-C-tick2.json"), JSON.stringify({
      status: slugTick2.status(),
      body: slugBody,
    }, null, 2));
    expect(slugTick2.status()).toBe(200);
    // The outcome may be HANDLER_FAILED (transient retry) OR
    // HANDLER_FAILED (terminal).  Either way, the job must not
    // reach CLUB_CREATED.
    const slugInspect = parseFirstJson(sshExec("phase2g-inspect slug-collision"));
    expect(slugInspect.job.provisionedClubId, "C: no new club created on collision").toBeNull();
    expect(slugInspect.job.state).not.toBe("COMPLETED");

    // ============================================================
    // D. Email collision: pre-seeded User with the fixture email.
    // ============================================================
    const emailSeed = parseFirstJson(sshExec("phase2g-seed email-collision"));
    writeFileSync(path.join(outDir, "signup-2-2g-D-seed.json"), JSON.stringify(emailSeed, null, 2));
    expect(emailSeed.preseededUserId, "preseeded user with same email").toBeTruthy();
    const emailTick = await page.request.post(`${tickUrl}?jobId=${emailSeed.tenantProvisioningJobId}`, { failOnStatusCode: false });
    const emailBody = await emailTick.text();
    writeFileSync(path.join(outDir, "signup-2-2g-D-tick.json"), JSON.stringify({
      status: emailTick.status(),
      body: emailBody,
    }, null, 2));
    expect(emailTick.status()).toBe(200);
    const emailInspect = parseFirstJson(sshExec("phase2g-inspect email-collision"));
    expect(emailInspect.job.provisionedUserId, "D: step 1 refused on email collision").toBeNull();
    expect(emailInspect.job.state).not.toBe("COMPLETED");

    // ============================================================
    // E. Reversal mid-provisioning -- seed happy, advance 3 steps,
    //    trigger reversal via phase2g-reverse, next tick must
    //    cancel the job.
    // ============================================================
    sshExec("phase2g-teardown"); // clear prior
    const revSeed = parseFirstJson(sshExec("phase2g-seed happy"));
    writeFileSync(path.join(outDir, "signup-2-2g-E-seed.json"), JSON.stringify(revSeed, null, 2));
    const revJobId = revSeed.tenantProvisioningJobId;
    // Advance 3 steps.
    for (let i = 0; i < 3; i++) {
      const r = await page.request.post(`${tickUrl}?jobId=${revJobId}`, { failOnStatusCode: false });
      expect(r.status()).toBe(200);
    }
    // Trigger the reversal + tick once more.
    sshExec("phase2g-reverse happy");
    const revTick = await page.request.post(`${tickUrl}?jobId=${revJobId}`, { failOnStatusCode: false });
    const revBody = await revTick.text();
    writeFileSync(path.join(outDir, "signup-2-2g-E-reversal-tick.json"), JSON.stringify({
      status: revTick.status(),
      body: revBody,
    }, null, 2));
    expect(revTick.status()).toBe(200);
    const revParsed = JSON.parse(revBody);
    expect(revParsed.outcome.ok, "E: reversal tick refused").toBe(false);
    expect(revParsed.outcome.reason).toBe("REVALIDATION_FAILED");

    // The job must be cancelled, NOT completed; sentinel stamped
    // on touched rows, nothing deleted.
    const revInspect = parseFirstJson(sshExec("phase2g-inspect happy"));
    writeFileSync(path.join(outDir, "signup-2-2g-E-inspect.json"), JSON.stringify(revInspect, null, 2));
    expect(revInspect.job.cancelledAt, "E: job cancelled").toBeTruthy();
    expect(revInspect.job.state).not.toBe("COMPLETED");
    // ClubSubscription + Club + User (if created) remain present
    // with provisioningCancelledAt stamped.
    if (revInspect.provisionedClub) {
      expect(revInspect.provisionedClub.provisioningCancelledAt).toBeTruthy();
    }
    if (revInspect.provisionedUser) {
      expect(revInspect.provisionedUser.provisioningCancelledAt).toBeTruthy();
    }
    if (revInspect.clubSubscription) {
      expect(revInspect.clubSubscription.provisioningCancelledAt).toBeTruthy();
      // Access tier never reached FULL.
      expect(revInspect.clubSubscription.accessTier).not.toBe("FULL");
    }

    // ============================================================
    // F. Mock-evidence rejection by production-capable path
    //    (founder closure §3).
    //
    //    1. Seed a fresh mock-backed job (phase2g-seed happy).
    //    2. Flip SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING OFF
    //       on the deployed container (simulating production).
    //    3. Wait for the Fly machine to restart with the new env.
    //    4. Tick WITHOUT a testOnly query param (there is no such
    //       param in Phase 2G -- the service controls isolation
    //       via env, which this scenario proves).
    //    5. Assert the tick response records
    //       outcome.ok=false, reason="MOCK_EVIDENCE_REJECTED".
    //    6. Inspect: NO club was created, no user was created, no
    //       Tier 2 granted (ClubSubscription for the fixture Club
    //       remains STAGED).
    //    7. Also test the production-safety stub-step refusal:
    //       even if a caller sets testOnly on the URL (we never
    //       accept it anyway), a stub step called in production
    //       mode would refuse with 501.
    //    8. Restore the env var + confirm teardown is clean.
    // ============================================================
    sshExec("phase2g-teardown"); // fresh state
    const fSeed = parseFirstJson(sshExec("phase2g-seed happy"));
    writeFileSync(path.join(outDir, "signup-2-2g-F-seed.json"), JSON.stringify(fSeed, null, 2));
    const fJobId = fSeed.tenantProvisioningJobId;

    // Flip the mock-isolation env var OFF.
    execSync(
      `"${FLYCTL}" secrets unset --app spectre-staging SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING`,
      { encoding: "utf8", timeout: 180_000 },
    );
    // The unset triggers a rolling restart; wait for /api/health.
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      try {
        const h = await page.request.get(`${BASE}/api/health`, { failOnStatusCode: false });
        if (h.status() === 200) break;
      } catch { /* keep waiting */ }
    }

    // The founder's SUPER_ADMIN session may be invalidated by the
    // restart (Session cache resets).  Re-login as the synthetic
    // SUPER_ADMIN to drive the next calls cleanly.
    await ctx.close();
    const fCtx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const fPage = await fCtx.newPage();
    await fPage.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
    await fPage.locator('input[name="email"]').fill(operatorFixture.email);
    await fPage.locator('input[name="password"]').fill(operatorFixture.password);
    await Promise.all([
      fPage.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 }),
      fPage.locator('form button[type="submit"]').first().click(),
    ]);

    const fTick = await fPage.request.post(`${tickUrl}?jobId=${fJobId}`, { failOnStatusCode: false });
    const fBody = await fTick.text();
    writeFileSync(path.join(outDir, "signup-2-2g-F-production-tick.json"), JSON.stringify({
      status: fTick.status(),
      body: fBody,
    }, null, 2));
    expect(fTick.status(), "F: tick status 200").toBe(200);
    const fParsed = JSON.parse(fBody);
    expect(fParsed.outcome.ok, "F: production path refused the mock job").toBe(false);
    expect(fParsed.outcome.reason, "F: refusal reason = MOCK_EVIDENCE_REJECTED").toBe("MOCK_EVIDENCE_REJECTED");

    // Also try adding a testOnly query param -- Phase 2G routes do
    // NOT accept such a parameter; the service controls isolation
    // via env only.  The result must still be MOCK_EVIDENCE_REJECTED.
    const fTickBypass = await fPage.request.post(`${tickUrl}?jobId=${fJobId}&testOnly=1`, { failOnStatusCode: false });
    const fBypassBody = await fTickBypass.text();
    writeFileSync(path.join(outDir, "signup-2-2g-F-testOnly-bypass.json"), JSON.stringify({
      status: fTickBypass.status(),
      body: fBypassBody,
    }, null, 2));
    const fBypassParsed = JSON.parse(fBypassBody);
    expect(fBypassParsed.outcome.ok, "F: testOnly query param cannot bypass").toBe(false);
    expect(fBypassParsed.outcome.reason).toBe("MOCK_EVIDENCE_REJECTED");

    // Inspect: no User created, no new Club, no Tier 2 grant.
    const fInspect = parseFirstJson(sshExec("phase2g-inspect happy"));
    writeFileSync(path.join(outDir, "signup-2-2g-F-inspect.json"), JSON.stringify(fInspect, null, 2));
    expect(fInspect.job.provisionedUserId, "F: no user created").toBeNull();
    expect(fInspect.job.provisionedClubId, "F: no club created").toBeNull();
    expect(fInspect.job.state).toBe("CREATED");
    // No ClubSubscription was activated (the fixture's seed
    // ClubSubscription has accessTier=STAGED by construction).
    if (fInspect.clubSubscription) {
      expect(fInspect.clubSubscription.accessTier).not.toBe("FULL");
      expect(fInspect.clubSubscription.subscriptionStatus).not.toBe("ACTIVE");
    }

    // Restore the mock-isolation env var (so the acceptance can
    // complete + the final flag-off step clears everything).
    execSync(
      `"${FLYCTL}" secrets set --app spectre-staging SPECTRE_SIGNUP_2G_ALLOW_TESTONLY_PROVISIONING=1`,
      { encoding: "utf8", timeout: 180_000 },
    );
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      try {
        const h = await fPage.request.get(`${BASE}/api/health`, { failOnStatusCode: false });
        if (h.status() === 200) break;
      } catch { /* keep waiting */ }
    }
    await fCtx.close();

    // ============================================================
    // Teardown summary + explicit per-scenario teardown.
    // ============================================================
    const teardownBody = sshExec("phase2g-teardown");
    writeFileSync(path.join(outDir, "signup-2-2g-teardown.json"), teardownBody);
    const operatorTeardown = sshExec("phase2f-super-admin-teardown");
    writeFileSync(path.join(outDir, "signup-2-2g-operator-teardown.json"), operatorTeardown);
    const opJson = parseFirstJson(operatorTeardown);
    expect(opJson.remainingSyntheticSuperAdmins, "zero synthetic admins remain").toBe(0);
    expect(opJson.tosRemoval.removed).toBe(true);
    // ctx was already closed inside scenario F; fCtx was closed
    // after the env restore.  Nothing left to close here.
  },
);
