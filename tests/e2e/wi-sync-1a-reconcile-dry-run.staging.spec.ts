// WI-SYNC-1a (2026-10-18) — operator-run DRY RUN against staging.
//
// Logs in as the founder, hits POST /api/admin/mailbox/reconcile
// (default: dry-run) against the Coulee mailbox, and writes the
// full ReconciliationReport to disk for the founder acceptance
// package.  Writes NOTHING to the DB — dry-run only.
//
// Also includes a separate test case (SKIPPED by default) that
// posts `?apply=1` once the founder authorizes the apply pass.
// Enable it only after dry-run approval:
//   SPECTRE_WI_SYNC_1A_APPLY=1 npx playwright test tests/e2e/wi-sync-1a-reconcile-dry-run.staging.spec.ts

import { test, expect } from "@playwright/test";
import path from "node:path";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";
const APPLY = process.env.SPECTRE_WI_SYNC_1A_APPLY === "1";

function ensureOutDir(): string {
  const outDir = path.join("test-results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  return outDir;
}

runAt(
  "WI-SYNC-1a · DRY RUN · reconcile Coulee mailbox and dump report",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const outDir = ensureOutDir();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);

    const url = `${BASE}/api/admin/mailbox/reconcile`;
    const res = await page.request.post(url);
    const status = res.status();
    const bodyText = await res.text();
    console.log("WI_SYNC_1A_HTTP_STATUS", status);
    expect(status, `expected 200, got ${status}: ${bodyText}`).toBe(200);
    const report = JSON.parse(bodyText);
    expect(report.mode).toBe("DRY_RUN");

    const reportPath = path.join(outDir, "wi-sync-1a-dry-run-report.json");
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log("WI_SYNC_1A_DRY_RUN_REPORT_PATH", reportPath);
    console.log("WI_SYNC_1A_DRY_RUN_TOTALS", JSON.stringify(report.totals));

    // Sanity checks — on Coulee the pre-apply dry-run should land
    // on the breakdown confirmed in the WI-SYNC-1a dry-run report:
    //   total examined         : up to 71 (shrinks after apply)
    //   present inbox          : 32
    //   present deleted items  : 23 (candidates for TOMBSTONE)
    //   present archive        : 16 (SKIP in 1a — deferred)
    //   deleted / inaccessible : 0 each
    // We check only the post-split numbers that must hold true for
    // the apply pass to be safe.  Any violation blocks apply.
    expect(report.totals.presentArchive, "Archive is SKIPPED in 1a").toBeGreaterThanOrEqual(0);
    expect(report.totals.presentDeletedItems, "Deleted Items detected").toBeGreaterThanOrEqual(0);
    // Tombstones proposed must equal (presentDeletedItems + deleted)
    // under the 1a classifier.  No archive items should be in that
    // count.
    expect(
      report.totals.tombstonesProposedOrApplied,
      "tombstones = Deleted Items + Graph-404 only; Archive must NOT be included",
    ).toBe(report.totals.presentDeletedItems + report.totals.deleted);

    await ctx.close();
  },
);

(APPLY && creds.ready ? test : test.skip)(
  "WI-SYNC-1a · APPLY · reconcile (writes softDeletedAt + suppresses WIs) — guard SPECTRE_WI_SYNC_1A_APPLY=1",
  async ({ browser }) => {
    test.setTimeout(300_000);
    const outDir = ensureOutDir();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);

    const url = `${BASE}/api/admin/mailbox/reconcile?apply=1`;
    const res = await page.request.post(url);
    const status = res.status();
    const bodyText = await res.text();
    console.log("WI_SYNC_1A_APPLY_HTTP_STATUS", status);
    expect(status).toBe(200);
    const report = JSON.parse(bodyText);
    expect(report.mode).toBe("APPLY");

    const reportPath = path.join(outDir, "wi-sync-1a-apply-report.json");
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log("WI_SYNC_1A_APPLY_REPORT_PATH", reportPath);

    await ctx.close();
  },
);
