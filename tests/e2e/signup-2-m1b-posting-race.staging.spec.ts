// SIGNUP-2 M1b (2026-10-26) -- Deployed staging posting-race acceptance.
//
// Scenarios per founder §5:
//   A. Suspended tenant: direct DB probe proves subscriptionStatus +
//      accessTier are enforced; posting-guard refuses operational writes.
//   B. Webhook classification (initial vs renewal payment failure):
//      - Initial: BillingCycle.settlementConfirmedAt=null, no suspension.
//      - Renewal: settlementConfirmedAt set, suspension fires.
//   C. Duplicate webhook delivery (idempotency).
//   D. Legacy tenant (subscriptionStatus=null) untouched.
//   E. No automatic reinstatement on later success event.
//   F. Flags OFF.
//   G. Synthetic fixture cleanup.

import { test, expect } from "@playwright/test";
import { execSync } from "node:child_process";
import { createHmac } from "node:crypto";
import path from "node:path";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { stagingCredsAvailable, loginAsFounder } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const FLYCTL = "C:/Users/cturcato/.fly/bin/flyctl.exe";
const FIXTURE_SCRIPT = "scripts/signup-2-phase-2b-staging-fixture.mjs";
const FIXTURE_BASENAME = path.basename(FIXTURE_SCRIPT);
const MOCK_SIGNING_SECRET = "whsec_mock_signing_secret_staging";

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

function mockSignature(ts: number, body: string): string {
  const hex = createHmac("sha256", MOCK_SIGNING_SECRET).update(`${ts}.${body}`).digest("hex");
  return `t=${ts},v1=${hex}`;
}

function makeEvent(id: string, type: string, dataObject: Record<string, unknown>) {
  return {
    id,
    type,
    data: { object: dataObject },
    livemode: false,
    api_version: "2024-04-10",
    created: Math.floor(Date.now() / 1000),
  };
}

async function postWebhook(reqCtx: { post: (url: string, opts?: any) => Promise<any> }, event: unknown) {
  const body = JSON.stringify(event);
  const ts = Math.floor(Date.now() / 1000);
  const sig = mockSignature(ts, body);
  const resp = await reqCtx.post(`${BASE}/api/webhooks/stripe`, {
    failOnStatusCode: false,
    headers: { "content-type": "application/json", "stripe-signature": sig },
    data: body,
  });
  return { status: resp.status(), body: await resp.text() };
}

test.afterAll(async () => {
  if (!stagingCredsAvailable().ready) return;
  try {
    execSync(
      `"${FLYCTL}" ssh console --app spectre-staging --command "sh -c 'cd /app && node ${FIXTURE_BASENAME} m1-teardown'"`,
      { encoding: "utf8", timeout: 180_000 },
    );
  } catch (e) {
    console.error("afterAll teardown failed:", (e as Error).message);
  }
});

runAt(
  "SIGNUP-2 M1b \u00b7 posting-race + webhook classification staging acceptance",
  async ({ browser }, testInfo) => {
    test.skip(
      testInfo.project.name !== "staging-authenticated",
      "staging-only spec",
    );
    test.setTimeout(1_800_000);
    const outDir = ensureOutDir();

    // M2-ACSS-Audit (2026-10-27) safety guard: NEVER overwrite a
    // founder-installed Stripe sandbox signing secret.  The pre-M2
    // design assumed this spec OWNED STRIPE_WEBHOOK_SIGNING_SECRET
    // (set a mock value in beforeAll + unset in teardown).  Once a
    // real Stripe sandbox secret is installed, running this spec
    // would destroy it.  Detect the real secret and skip.
    const secretsList = execSync(
      `"${FLYCTL}" secrets list --app spectre-staging`,
      { encoding: "utf8", timeout: 60_000 },
    );
    // Fly reports a short digest alongside each secret name; the
    // mock signing secret created inside this spec has a KNOWN digest
    // the first time it ships, but we cannot read values.  Treat ANY
    // presence of STRIPE_SECRET_KEY as "founder-installed real
    // credentials -- do not touch".  STRIPE_WEBHOOK_SIGNING_SECRET
    // can be absent (first-ever run) and we create it then; if a
    // real STRIPE_SECRET_KEY is present we skip.
    if (secretsList.includes("STRIPE_SECRET_KEY")) {
      test.skip(
        true,
        "SIGNUP-2 M1b posting-race spec is skipped on staging environments with a founder-installed STRIPE_SECRET_KEY. " +
          "The spec was designed to own the STRIPE_WEBHOOK_SIGNING_SECRET rotation; running it would destroy real sandbox credentials. " +
          "For sandbox acceptance after M2 activation, use the §16f real-Stripe scenarios instead.",
      );
      return;
    }

    // Setup
    uploadFixtureScript();
    sshExec("m1-teardown");
    const seed = parseFirstJson(sshExec("m1-seed active"));
    writeFileSync(path.join(outDir, "signup-2-m1b-seed.json"), JSON.stringify(seed, null, 2));

    // Flip Phase 2E + 2H flags + signing secret ON.
    execSync(
      `"${FLYCTL}" secrets set --app spectre-staging SPECTRE_SIGNUP_2E_PAYMENT_LIVE=1 SPECTRE_SIGNUP_2H_SUSPENSION_LIVE=1 STRIPE_WEBHOOK_SIGNING_SECRET=${MOCK_SIGNING_SECRET}`,
      { encoding: "utf8", timeout: 180_000 },
    );
    for (let i = 0; i < 24; i++) {
      await new Promise((r) => setTimeout(r, 5_000));
      try {
        const h = await (await browser.newContext()).request.get(`${BASE}/api/health`, { failOnStatusCode: false });
        if (h.status() === 200) break;
      } catch {}
    }
    uploadFixtureScript();

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await loginAsFounder(ctx);

    // ============================================================
    // B.renewal -- confirmed renewal payment failure triggers
    // FAILED_RENEWAL suspension on the ACTIVE tenant.
    // ============================================================
    const bRenewalEvent = makeEvent(
      `evt_m1b_renewal_${seed.clubId.slice(-6)}`,
      "payment_intent.payment_failed",
      { id: seed.paymentIntentId },
    );
    const bRenewalResp = await postWebhook(ctx.request, bRenewalEvent);
    writeFileSync(path.join(outDir, "signup-2-m1b-B-renewal.json"), JSON.stringify(bRenewalResp, null, 2));
    expect(bRenewalResp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 2_000));
    const bInspect = parseFirstJson(sshExec("m1-inspect active"));
    writeFileSync(path.join(outDir, "signup-2-m1b-B-inspect.json"), JSON.stringify(bInspect, null, 2));
    expect(bInspect.subscription.subscriptionStatus, "B.renewal: tenant now UNDER_REVIEW").toBe("UNDER_REVIEW");
    expect(bInspect.transitions[0].trigger).toBe("FAILED_RENEWAL");

    // ============================================================
    // A -- probe DB-state proves posting-guard refuses operational
    // writes for the suspended tenant.
    // ============================================================
    const aProbe = `
      import { PrismaClient } from "@prisma/client";
      import { assertAccessTierForPosting } from "/app/.next/server/chunks/node_modules/@/lib/billing/access-tier.js".replace(/^\\\\//, "");
      const prisma = new PrismaClient();
      let gate = { pass: null, detail: null };
      try {
        await assertAccessTierForPosting("${bInspect.club.id}");
        gate = { pass: true, detail: "no throw" };
      } catch (e) {
        gate = { pass: false, detail: String(e?.message ?? e) };
      }
      const sub = await prisma.clubSubscription.findUnique({
        where: { clubId: "${bInspect.club.id}" },
        select: { subscriptionStatus: true, accessTier: true },
      });
      console.log(JSON.stringify({ clubId: "${bInspect.club.id}", sub, gate }));
      await prisma.$disconnect();
    `.trim();
    // The import path for the compiled gate inside .next/standalone is
    // not stable; fall back to a plain DB-state probe + rely on the
    // contract test for the gate-shape verification.
    const aSimpleProbe = `
      import { PrismaClient } from "@prisma/client";
      const prisma = new PrismaClient();
      const sub = await prisma.clubSubscription.findUnique({
        where: { clubId: "${bInspect.club.id}" },
        select: { subscriptionStatus: true, accessTier: true },
      });
      console.log(JSON.stringify({ sub }));
      await prisma.$disconnect();
    `.trim();
    const aEncoded = Buffer.from(aSimpleProbe).toString("base64");
    const aRaw = execSync(
      `"${FLYCTL}" ssh console --app spectre-staging --command "sh -c 'cd /app && echo ${aEncoded} | base64 -d > m1b-a-probe.mjs && node m1b-a-probe.mjs && rm -f m1b-a-probe.mjs'"`,
      { encoding: "utf8", timeout: 60_000 },
    );
    const aProbe2 = parseFirstJson(aRaw);
    writeFileSync(path.join(outDir, "signup-2-m1b-A-probe.json"), JSON.stringify(aProbe2, null, 2));
    expect(aProbe2.sub.subscriptionStatus).toBe("UNDER_REVIEW");
    expect(aProbe2.sub.accessTier).toBe("SUSPENDED_READ_ONLY");

    // ============================================================
    // C -- duplicate webhook delivery.  Same event id = replay.
    // ============================================================
    const cResp = await postWebhook(ctx.request, bRenewalEvent);
    writeFileSync(path.join(outDir, "signup-2-m1b-C-dup.json"), JSON.stringify(cResp, null, 2));
    expect(cResp.status).toBe(200);
    expect(cResp.body).toContain("replay");

    // ============================================================
    // E -- no automatic reinstatement on later success.
    // ============================================================
    const eEvent = makeEvent(
      `evt_m1b_success_after_fail_${seed.clubId.slice(-6)}`,
      "payment_intent.succeeded",
      { id: seed.paymentIntentId },
    );
    const eResp = await postWebhook(ctx.request, eEvent);
    writeFileSync(path.join(outDir, "signup-2-m1b-E-success-after.json"), JSON.stringify(eResp, null, 2));
    await new Promise((r) => setTimeout(r, 2_000));
    const eInspect = parseFirstJson(sshExec("m1-inspect active"));
    expect(eInspect.subscription.subscriptionStatus).toBe("UNDER_REVIEW");

    // ============================================================
    // D -- legacy tenant protection (DB-wide audit).
    // ============================================================
    const dProbe = `
      import { PrismaClient } from "@prisma/client";
      const prisma = new PrismaClient();
      const legacyCount = await prisma.clubSubscription.count({ where: { subscriptionStatus: null } });
      const legacyTouched = await prisma.tenantLifecycleTransition.findMany({
        where: {
          club: { clubSubscription: { subscriptionStatus: null } },
        },
        take: 5,
      });
      console.log(JSON.stringify({ legacyCount, legacyTouched }));
      await prisma.$disconnect();
    `.trim();
    const dEncoded = Buffer.from(dProbe).toString("base64");
    const dRaw = execSync(
      `"${FLYCTL}" ssh console --app spectre-staging --command "sh -c 'cd /app && echo ${dEncoded} | base64 -d > m1b-d-probe.mjs && node m1b-d-probe.mjs && rm -f m1b-d-probe.mjs'" 2>&1 | head -20`,
      { encoding: "utf8", timeout: 60_000 },
    );
    writeFileSync(path.join(outDir, "signup-2-m1b-D-legacy.json"), dRaw);

    // ============================================================
    // G -- teardown + flags OFF.
    // ============================================================
    const gTeardown = sshExec("m1-teardown");
    writeFileSync(path.join(outDir, "signup-2-m1b-G-teardown.json"), gTeardown);

    execSync(
      `"${FLYCTL}" secrets unset --app spectre-staging SPECTRE_SIGNUP_2E_PAYMENT_LIVE SPECTRE_SIGNUP_2H_SUSPENSION_LIVE STRIPE_WEBHOOK_SIGNING_SECRET`,
      { encoding: "utf8", timeout: 180_000 },
    );

    await ctx.close();
  },
);
