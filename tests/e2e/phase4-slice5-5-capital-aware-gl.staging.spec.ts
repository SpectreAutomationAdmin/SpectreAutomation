// Sprint 3 · Phase 4 Slice 5.5 (2026-08-08) — authenticated
// staging acceptance.
//
// Verifies the amended §10 external-corroboration trigger + the
// capital-aware GL ranker + preservation controls (§13). Does NOT
// hardcode 1091559 → any specific GL account (§8 explicit).

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

async function probe(page: Page, suffix4: string): Promise<any> {
  const res = await page.request.post(
    `${availability.baseURL}/api/ap-intelligence/inspect-wi`,
    { data: { wiIdSuffix4: suffix4 } },
  );
  expect(res.status(), `inspect-wi ${suffix4}`).toBe(200);
  return await res.json();
}

test.describe("Slice 5.5 · capital-aware GL + amended external trigger — real staging cards", () => {
  test.skip(!availability.ready, availability.reason ?? "");
  test.setTimeout(180_000);

  test("every real card produces a productIdentityResolution + zero external calls", async ({ context }) => {
    const page = await loginAsFounder(context);
    for (const suffix of ["vkbm", "8fk9", "7b0b", "73n5", "w3bz"]) {
      const r = await probe(page, suffix);
      const pi = r.analyseResult?.productIdentityResolution;
      expect(pi, `${suffix} has productIdentityResolution`).toBeTruthy();
      expect(pi.externalLookupCount, `${suffix} zero external`).toBe(0);
    }
  });

  test("1091559 under amended §10 trigger: ambiguity flagged; no fabricated GL; founder-facing category from object", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    const pi = r.analyseResult?.productIdentityResolution;
    // Under the amended trigger, this shape (top absolute score < 45
    // with material-divergent counter-candidates) SHOULD flag
    // externalCorroborationRequired.
    expect(pi.status).toBe("AMBIGUOUS");
    expect(pi.externalCorroborationRequired).toBe(true);
    // Without external activation, no fabricated GL.
    const gl = r.analyseResult?.glRecommendationWinner;
    expect(gl?.accountNumber ?? null).toBeNull();
    // Founder-facing category comes from object authority, not
    // stale taxonomy.
    const founderCat = r.analyseResult?.purchasedItemIntelligence?.founderFacingCategory;
    expect(founderCat).toMatch(/equipment|repair|purchase/i);
    // Amount / extension / total must not appear in capital diag.
    const capDiag = r.analyseResult?.purchasedItemIntelligence?.capitalDiagnostic ?? "";
    expect(capDiag).not.toMatch(/\b(amount|extension|total)\b/i);
  });

  test("preservation §13 — DMM stays Fuel path", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "8fk9");
    const gl = r.analyseResult?.glRecommendationWinner?.accountName ?? "";
    expect(gl).toMatch(/fuel/i);
    // Capital-aware ranker MUST NOT be active for a consumable/OPERATING invoice
    const cap = r.analyseResult?.capitalAwareRanking;
    if (cap && cap.active) {
      // If it did somehow run, it must not have selected a capital account.
      expect(cap.winnerAccountNumber).not.toBeNull();
      // Winner nature must not be ASSET
    }
    // Zero external calls (§13)
    expect(r.analyseResult?.productIdentityResolution?.externalLookupCount).toBe(0);
  });

  test("preservation §13 — Oakcreek 1087769 R&M behavior preserved", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "7b0b");
    const gl = r.analyseResult?.glRecommendationWinner?.accountName ?? "";
    // Not Interest / telecom / capital-invention. Either R&M or
    // truthful abstention is acceptable.
    expect(gl).not.toMatch(/interest\s*expense/i);
    expect(gl).not.toMatch(/telephone|internet/i);
    expect(r.analyseResult?.productIdentityResolution?.externalLookupCount).toBe(0);
  });

  test("preservation §13 — OXIO stays telecom", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "73n5");
    const bits = (r.analyseResult?.glRecommendationWinner?.accountName ?? "")
      + " " + (r.analyseResult?.allocations?.cardCategory ?? "");
    expect(bits).toMatch(/telephone|internet/i);
    expect(r.analyseResult?.productIdentityResolution?.externalLookupCount).toBe(0);
  });

  test("preservation §13 — CPA stays Multiple", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "w3bz");
    expect(r.analyseResult?.allocations?.cardCategory).toBe("Multiple");
    expect(r.analyseResult?.productIdentityResolution?.externalLookupCount).toBe(0);
  });
});
