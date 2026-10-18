// WI-SYNC-1b (2026-10-18) — staging acceptance for the scheduled
// reconciliation sweep + health observability.
//
// Verifies, as the founder on staging:
//   §A GET /api/admin/mailbox/health returns 200 + the shape the
//      service documents (per-mailbox + totals + thresholds).
//   §B Every connected mailbox reports deltaLagSeconds and a
//      lastSuccessfulReconciliationAt (populated by either the
//      WI-SYNC-1a apply run or a scheduled sweep since).
//   §C No mailbox requires intervention under normal operation.
//
// NOT in scope: forcing a Graph deletion from the test itself —
// that would mutate the founder's real mailbox.  The equivalent
// end-to-end "delete → disappears" scenario is covered by the
// WI-SYNC-1a founder acceptance report + the ongoing scheduled
// sweep's observability metrics.

import { test, expect } from "@playwright/test";
import path from "node:path";
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const creds = stagingCredsAvailable();
const runAt = creds.ready ? test : test.skip;
const BASE = "https://staging.spectreautomation.com";

function ensureOutDir(): string {
  const outDir = path.join("test-results");
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  return outDir;
}

runAt(
  "WI-SYNC-1b · health endpoint returns reconciliation + delta metrics",
  async ({ browser }) => {
    test.setTimeout(180_000);
    const outDir = ensureOutDir();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await loginAsFounder(ctx);

    const res = await page.request.get(`${BASE}/api/admin/mailbox/health`);
    const status = res.status();
    const bodyText = await res.text();
    console.log("WI_SYNC_1B_HEALTH_HTTP_STATUS", status);
    expect(status, `expected 200, got ${status}: ${bodyText}`).toBe(200);

    const report = JSON.parse(bodyText);
    writeFileSync(
      path.join(outDir, "wi-sync-1b-health-report.json"),
      JSON.stringify(report, null, 2),
    );
    console.log("WI_SYNC_1B_HEALTH_TOTALS", JSON.stringify(report.totals));

    expect(report.clubId).toBeTruthy();
    expect(Array.isArray(report.mailboxes)).toBe(true);
    expect(report.thresholds).toMatchObject({
      deltaLagRedSeconds: expect.any(Number),
      reconcileLagRedSeconds: expect.any(Number),
      consecutiveFailureRedCount: expect.any(Number),
    });

    // §B — Coulee has one CONNECTED mailbox; its row must have
    //      every per-mailbox field the health service documents.
    const coulee = report.mailboxes.find(
      (m: { status: string }) => m.status === "CONNECTED",
    );
    expect(coulee, "connected mailbox present").toBeTruthy();
    console.log(
      "WI_SYNC_1B_COULEE",
      JSON.stringify({
        tail: coulee.mailboxConnectionIdTail,
        status: coulee.status,
        deltaLink: coulee.deltaLink,
        lastSuccessfulDeltaAt: coulee.lastSuccessfulDeltaAt,
        lastSuccessfulReconciliationAt: coulee.lastSuccessfulReconciliationAt,
        deltaLagSeconds: coulee.deltaLagSeconds,
        reconcileLagSeconds: coulee.reconcileLagSeconds,
        consecutiveDeltaFailures: coulee.consecutiveDeltaFailures,
        requiresIntervention: coulee.requiresIntervention,
        interventionReasons: coulee.interventionReasons,
        mostRecentReconciliation: coulee.mostRecentReconciliation,
      }),
    );
    expect(coulee.deltaLink).toBe(true);
    expect(coulee.lastSuccessfulDeltaAt).toBeTruthy();
    // Reconciliation ran at least once (WI-SYNC-1a apply) — so this
    // is populated by now.
    expect(coulee.lastSuccessfulReconciliationAt).toBeTruthy();
    expect(coulee.deltaLagSeconds).not.toBeNull();
    expect(coulee.consecutiveDeltaFailures).toBeGreaterThanOrEqual(0);
    expect(coulee.mostRecentReconciliation).toBeTruthy();

    // §C — No mailbox should require intervention under normal
    //      operation.  If the scheduler fell behind, this check
    //      surfaces it.
    if (coulee.requiresIntervention) {
      console.log(
        "WI_SYNC_1B_INTERVENTION_REASONS",
        JSON.stringify(coulee.interventionReasons),
      );
    }
    expect(coulee.requiresIntervention, "no intervention needed").toBe(false);
  },
);
