// EP-TRAIN-4Y-X Batch A verification — cancel endpoint probe (no GPU).
//
// Non-mutating probes against POST /api/admin/training/generation-
// runs/[runId]/cancel on staging. Verifies:
//
//   1. Endpoint is permission-gated — unauthenticated → 401 (via
//      curl with no session).
//   2. Endpoint rejects non-existent / cross-tenant runIds — 404
//      without any state write.
//   3. Endpoint is idempotent — calling cancel on the orphaned run
//      is explicitly SKIPPED (per §2 directive: "Do not cancel or
//      mutate the historical pilot run unless specifically
//      authorized").
//
// The authoritative cancel/idempotency/stale-worker tests run
// against the local SQLite DB in
// `tests/ep-train-4y-x-acceptance.test.ts` and
// `tests/ep-train-4y-w-retry-governance.test.ts` (5+3 PASS).

import { chromium } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const BASE =
  process.env.SPECTRE_STAGING_BASE_URL ?? "https://staging.spectreautomation.com";
const BOGUS_RUN_ID = "cm0000000000000000000bogus";

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
  // Probe 1: unauthenticated → 401
  console.log(`\n--- Probe 1: unauthenticated cancel ---`);
  const r1 = await fetch(
    `${BASE}/api/admin/training/generation-runs/${BOGUS_RUN_ID}/cancel`,
    { method: "POST" },
  );
  const b1 = await r1.text();
  console.log(`  status=${r1.status} body=${b1.slice(0, 200)}`);
  if (r1.status !== 401) {
    console.error(`  FAIL: expected 401, got ${r1.status}`);
    process.exit(1);
  }
  console.log(`  OK: unauthenticated cancel refused with 401`);

  // Probe 2: authenticated + non-existent runId → 404
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
  const page = await ctx.newPage();
  console.log(`\n--- Probe 2: authenticated cancel on bogus runId ---`);
  await page.goto(`${BASE}/login`, { waitUntil: "domcontentloaded" });
  await page.locator('input[name="email"]').fill(EMAIL);
  await page.locator('input[name="password"]').fill(PASSWORD);
  await Promise.all([
    page.waitForURL((u) => !u.pathname.startsWith("/login"), { timeout: 30_000 }),
    page.locator('form button[type="submit"]').first().click(),
  ]);
  const r2 = await page.request.post(
    `${BASE}/api/admin/training/generation-runs/${BOGUS_RUN_ID}/cancel`,
  );
  const b2 = await r2.text();
  console.log(`  status=${r2.status()} body=${b2.slice(0, 200)}`);
  if (r2.status() !== 404) {
    console.error(`  FAIL: expected 404, got ${r2.status()}`);
    await browser.close();
    process.exit(1);
  }
  console.log(`  OK: bogus runId refused with 404 (no state write)`);

  // Probe 3: verify the orphaned run is STILL QUEUED and not
  // auto-revived. §5.10 containment check. Read-only.
  console.log(`\n--- Probe 3: orphan run containment (read-only) ---`);
  const r3 = await page.request.get(
    `${BASE}/api/admin/training/versions/cmw8n6z9a000az4nx56vwh02f/generation-status`,
  );
  const b3 = await r3.json();
  console.log(`  status=${r3.status()} runId=${b3.runId ?? "(none)"} state=${b3.state} attempts=${b3.attempts}/${b3.maxAttempts}`);
  if (b3.runId !== "cmw9gicvl000767ww5kwvfyhc") {
    console.error(`  FAIL: unexpected runId ${b3.runId} — was something else enqueued?`);
    await browser.close();
    process.exit(1);
  }
  if (b3.state !== "QUEUED") {
    console.error(`  FAIL: orphan run state changed to ${b3.state} (was QUEUED)`);
    await browser.close();
    process.exit(1);
  }
  if (b3.startedAt !== null) {
    console.error(`  FAIL: orphan run has startedAt=${b3.startedAt} — attempt 2 may have fired`);
    await browser.close();
    process.exit(1);
  }
  if ((b3.draftCount ?? 0) !== 0) {
    console.error(`  FAIL: orphan run has ${b3.draftCount} drafts — pilot was executed`);
    await browser.close();
    process.exit(1);
  }
  console.log(`  OK: orphan run is QUEUED attempts=${b3.attempts}, no startedAt, no drafts`);

  console.log(`\n✓ Batch A cancel-endpoint + orphan-containment probes PASS.`);
  await browser.close();
}

main().catch((err) => {
  console.error("FATAL:", err?.stack ?? err);
  process.exit(1);
});
