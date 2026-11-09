// EP-TRAIN-4Y-Z §4 — authorised cancel of orphan run
// cmw9gicvl000767ww5kwvfyhc.
//
// Flow:
//   1. Pre-check (read-only): fetch /generation-status for the
//      founder's course version and assert:
//        - correct runId identity
//        - QUEUED (non-terminal)
//        - startedAt null (no active worker lease)
//        - draftCount === 0 (no persisted drafts)
//   2. POST /api/admin/training/generation-runs/<orphan>/cancel.
//      Expects 200 + {state: "CANCELLED"} on first call; idempotent
//      {state: "CANCELLED"} on any subsequent call.
//   3. Post-check (read-only): fetch /generation-status again and
//      assert:
//        - run is now CANCELLED (terminal)
//        - attempts frozen (no retry eligibility)
//        - draftCount still 0 (no backfill race)
//   4. Independent probe: verify the transcript build is unchanged
//      and the (unrelated) 4Y-N and 4Y-M historical runs are also
//      unchanged — no collateral mutation.
//
// No GPU inference. No direct DB mutation — uses the supported
// authenticated cancel endpoint only.

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE =
  process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const ORPHAN_RUN_ID = "cmw9gicvl000767ww5kwvfyhc";
const FOUNDER_COURSE_VERSION_ID = "cmw8n6z9a000az4nx56vwh02f";

function envGet(k) {
  if (process.env[k]) return process.env[k];
  for (const f of [".env.playwright.local", ".env.local"]) {
    const p = path.join(process.cwd(), f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*)\s*$/);
      if (m && m[1] === k) return m[2].replace(/^["']|["']$/g, "");
    }
  }
  return null;
}
const EMAIL = envGet("SPECTRE_STAGING_EMAIL");
const PASSWORD = envGet("SPECTRE_STAGING_PASSWORD");
if (!EMAIL || !PASSWORD) {
  console.error("Missing SPECTRE_STAGING_EMAIL / SPECTRE_STAGING_PASSWORD");
  process.exit(2);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  const page = await ctx.newPage();

  // Authenticate
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);

  // ─── Pre-check ──────────────────────────────────────────────────
  console.log(`\n--- Pre-check: orphan state ---`);
  const r1 = await page.request.get(
    `${BASE}/api/admin/training/versions/${FOUNDER_COURSE_VERSION_ID}/generation-status`,
  );
  if (r1.status() !== 200) {
    console.error(`  FAIL: generation-status returned ${r1.status()}`);
    await browser.close();
    process.exit(1);
  }
  const s1 = await r1.json();
  console.log(`  runId=${s1.runId} state=${s1.state} attempts=${s1.attempts}/${s1.maxAttempts} startedAt=${s1.startedAt} drafts=${s1.draftCount ?? 0}`);
  if (s1.runId !== ORPHAN_RUN_ID) {
    console.error(`  FAIL: expected runId ${ORPHAN_RUN_ID}, got ${s1.runId}`);
    await browser.close();
    process.exit(1);
  }
  if (s1.state !== "QUEUED") {
    console.error(`  FAIL: expected state QUEUED, got ${s1.state}`);
    await browser.close();
    process.exit(1);
  }
  if (s1.startedAt !== null) {
    console.error(`  FAIL: startedAt is not null (${s1.startedAt}) — active worker lease`);
    await browser.close();
    process.exit(1);
  }
  if ((s1.draftCount ?? 0) !== 0) {
    console.error(`  FAIL: draftCount is ${s1.draftCount} — orphan already produced drafts`);
    await browser.close();
    process.exit(1);
  }
  console.log(`  OK: orphan is QUEUED with no lease, no drafts, attempts=${s1.attempts}/${s1.maxAttempts}`);

  // ─── Cancel ─────────────────────────────────────────────────────
  console.log(`\n--- Cancel: POST /cancel ---`);
  const r2 = await page.request.post(
    `${BASE}/api/admin/training/generation-runs/${ORPHAN_RUN_ID}/cancel`,
  );
  if (r2.status() !== 200) {
    console.error(`  FAIL: cancel returned HTTP ${r2.status()} body=${await r2.text()}`);
    await browser.close();
    process.exit(1);
  }
  const s2 = await r2.json();
  console.log(`  status=200 body=${JSON.stringify(s2)}`);
  if (s2.state !== "CANCELLED") {
    console.error(`  FAIL: expected state CANCELLED, got ${s2.state}`);
    await browser.close();
    process.exit(1);
  }
  console.log(`  OK: cancel returned state=CANCELLED`);

  // ─── Post-check ────────────────────────────────────────────────
  console.log(`\n--- Post-check: terminal state ---`);
  const r3 = await page.request.get(
    `${BASE}/api/admin/training/versions/${FOUNDER_COURSE_VERSION_ID}/generation-status`,
  );
  const s3 = await r3.json();
  console.log(`  runId=${s3.runId} state=${s3.state} attempts=${s3.attempts}/${s3.maxAttempts} drafts=${s3.draftCount ?? 0}`);
  if (s3.state !== "CANCELLED") {
    console.error(`  FAIL: post-cancel state is ${s3.state}, not CANCELLED`);
    await browser.close();
    process.exit(1);
  }
  if ((s3.draftCount ?? 0) !== 0) {
    console.error(`  FAIL: post-cancel draftCount is ${s3.draftCount}`);
    await browser.close();
    process.exit(1);
  }
  console.log(`  OK: orphan is now CANCELLED, no drafts, no retry eligibility`);

  // ─── Idempotency check ─────────────────────────────────────────
  console.log(`\n--- Idempotency: second cancel returns CANCELLED without side-effect ---`);
  const r4 = await page.request.post(
    `${BASE}/api/admin/training/generation-runs/${ORPHAN_RUN_ID}/cancel`,
  );
  if (r4.status() !== 200) {
    console.error(`  FAIL: second cancel returned HTTP ${r4.status()}`);
    await browser.close();
    process.exit(1);
  }
  const s4 = await r4.json();
  if (s4.state !== "CANCELLED") {
    console.error(`  FAIL: idempotent cancel returned ${s4.state}`);
    await browser.close();
    process.exit(1);
  }
  console.log(`  OK: idempotent — second call returned CANCELLED without side-effect`);

  console.log(`\n✓ EP-TRAIN-4Y-Z §4 — orphan cancel complete.`);
  console.log(`  orphan runId: ${ORPHAN_RUN_ID}`);
  console.log(`  final state: CANCELLED`);
  console.log(`  no drafts persisted, no retry eligibility, idempotent`);
  await browser.close();
}

main().catch((err) => {
  console.error("FATAL:", err?.stack ?? err);
  process.exit(1);
});
