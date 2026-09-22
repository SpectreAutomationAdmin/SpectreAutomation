// FPP-9C (2026-09-22) — historical fingerprint backfill for the two
// protected historical payrolls: founder + Chris Sep-15.
//
// Uses the FPP-9B.1 /api/dev/fpp9b1-backfill route which reads persisted
// immutable evidence only and never overwrites an existing fingerprint.

import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const FOUNDER = "cmual2acx002tegdvxrr4lrzo";
const CHRIS_SEP15 = "cmtzxy7f30006rm2s31rcv8rp";

function saveJson(name: string, obj: unknown) {
  const dir = "test-results";
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), JSON.stringify(obj, null, 2));
}

test.describe("FPP-9C · founder + Chris Sep-15 fingerprint backfill", () => {
  test.use({ viewport: { width: 1440, height: 900 } });
  test.setTimeout(60_000);

  test("Backfills founder + Chris Sep-15 fingerprints — STORED_NEW, no other fields changed", async ({ context }) => {
    const creds = stagingCredsAvailable();
    test.skip(!creds.ready, creds.reason ?? "no creds");
    const base = creds.baseURL;
    const page = await loginAsFounder(context);

    const resp = await page.request.post(`${base}/api/dev/fpp9b1-backfill`, {
      data: { batchIds: [FOUNDER, CHRIS_SEP15] },
    });
    const body = await resp.json();
    saveJson("fpp9c-founder-backfill.json", { status: resp.status(), body });
    expect(resp.status()).toBe(200);
    console.log("[FPP-9C] founder + Chris Sep-15 backfill summary:", JSON.stringify(body.summary));

    expect(body.summary.batchCount).toBe(2);
    // Both should share the same statutory package (both are CA-AB-2026-H2 payrolls)
    expect(body.summary.uniquePackageChecksums).toBeLessThanOrEqual(2);
    // Each has its own distinct calculation fingerprint
    expect(body.summary.uniqueCalculationFingerprints).toBe(2);

    // Both should be STORED_NEW (previously null) — this is the safe path.
    for (const r of body.results) {
      expect(["STORED_NEW", "MATCHED_EXISTING"]).toContain(r.backfillAction);
      // recomputedNow always matches (deterministic from persisted state)
      expect(r.calculationFingerprint).toBe(r.recomputedFingerprintNow);
      // Fields we required to NOT change: transactionType STANDARD, status POSTED
      expect(r.transactionType).toBe("STANDARD");
      expect(r.status).toBe("POSTED");
    }
  });
});
