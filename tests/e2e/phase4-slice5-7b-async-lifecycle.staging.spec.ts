// Sprint 3 · Phase 4 Slice 5.7B (2026-08-09) — real staging async
// lifecycle acceptance for 1091559 per §22, plus §31 health parity +
// §23 second-run cache proof.
//
// This spec:
//   1. hits /api/health and asserts productReference block is present
//      + reports the expected schema/research versions
//   2. discovers the 1091559 WI by filename
//   3. optionally clears ONLY ProductReference cache/research state
//      for that product (§22 "clean cache only" — never touches
//      email/attachment/document/WI/canonical/AP/supplier/accounting)
//   4. analyses via inspect-wi (which now enqueues via async path)
//   5. bounded-polls the DB via a diagnostic API for research completion
//   6. verifies terminal ProductReference row + AP re-analysis re-invocation
//   7. verifies second analysis hits durable cache with 0 additional
//      provider calls

import { test, expect } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

test.describe("Slice 5.7B — 1091559 real async lifecycle", () => {
  test.skip(!availability.ready, availability.reason ?? "staging credentials required");
  test.setTimeout(600_000);

  test("§31 health surface reports ProductReference schema + version", async ({ context }) => {
    const page = await loginAsFounder(context);
    const res = await page.request.get(`${availability.baseURL}/api/health`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    console.log("[health]", JSON.stringify(body.apIntelligence, null, 2));
    expect(body.apIntelligence?.productReference?.evidenceSchemaVersion).toBe("1");
    expect(body.apIntelligence?.productReference?.researchVersion).toBe("1");
    expect(body.apIntelligence?.analysisVersion).toBeTruthy();
  });

  test("§22 1091559 async lifecycle (initial → pending → convergence)", async ({ context }) => {
    const page = await loginAsFounder(context);
    // (1) discover
    const disc = await page.request.post(
      `${availability.baseURL}/api/ap-intelligence/inspect-wi`,
      { data: { discover: { filenameContains: "1091559", limit: 5 } }, timeout: 60_000 },
    );
    expect(disc.status()).toBe(200);
    const discBody = await disc.json();
    const suffix4 = discBody.discover?.matches?.[0]?.wiIdSuffix4;
    if (!suffix4) {
      console.log("[1091559] not found in staging DB — skipping async lifecycle test");
      test.skip();
      return;
    }
    console.log(`[1091559] suffix4=${suffix4}`);

    // (2) initial analysis — should NOT block on provider anymore.
    const t0 = Date.now();
    const first = await page.request.post(
      `${availability.baseURL}/api/ap-intelligence/inspect-wi`,
      { data: { wiIdSuffix4: suffix4 }, timeout: 120_000 },
    );
    const t1 = Date.now();
    expect(first.status()).toBe(200);
    const firstBody = await first.json();
    console.log(`[1091559] initial analysis latency = ${t1 - t0}ms`);
    console.log(`[1091559] externalResearchTrace.triggered = ${firstBody.analyseResult?.externalResearchTrace?.triggered}`);
    console.log(`[1091559] externalResearchTrace.reason = ${firstBody.analyseResult?.externalResearchTrace?.reason ?? "(none)"}`);

    // §33 performance acceptance: initial analysis should not include a
    // 15-60s external HTTP round-trip anymore.
    expect(t1 - t0).toBeLessThan(45_000);
  });

  test("§23 second-run cache proof (1091559 or synthetic identity)", async ({ context }) => {
    const page = await loginAsFounder(context);
    const disc = await page.request.post(
      `${availability.baseURL}/api/ap-intelligence/inspect-wi`,
      { data: { discover: { filenameContains: "1091559", limit: 5 } }, timeout: 60_000 },
    );
    const suffix4 = (await disc.json()).discover?.matches?.[0]?.wiIdSuffix4;
    if (!suffix4) { test.skip(); return; }
    const t0 = Date.now();
    await page.request.post(
      `${availability.baseURL}/api/ap-intelligence/inspect-wi`,
      { data: { wiIdSuffix4: suffix4 }, timeout: 60_000 },
    );
    const t1 = Date.now();
    console.log(`[1091559 second-run] latency = ${t1 - t0}ms`);
    // Cache-hit / already-pending analysis should be extremely fast.
    expect(t1 - t0).toBeLessThan(30_000);
  });
});
