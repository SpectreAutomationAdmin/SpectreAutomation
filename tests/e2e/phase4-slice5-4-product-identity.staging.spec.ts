// Sprint 3 · Phase 4 Slice 5.4 (2026-08-08) — authenticated
// staging acceptance for Product Identity Resolution scaffolding.
//
// Verifies against the deployed analyser on the five real Outlook-
// backed staging cards that:
//   - ProductIdentityResolution runs on every card
//   - Null-provider scaffolding produces zero external calls on EVERY
//     card (§29-§31 preservation)
//   - 1091559 (vkbm) internal reasoning surfaces both COMPLETE_MACHINE
//     and REPLACEMENT_ENGINE / SERIALIZED_COMPONENT candidates
//   - 1091559 downstream capital decision reflects the resolved
//     identity (not the previous UNRESOLVED)
//   - controls (DMM/OXIO/CPA) never surface an unrelated GL
// Does NOT hardcode which identity the resolver should choose for
// 1091559 — asserts only that both candidate types exist and the
// resolution status is one of the valid enum values.

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

test.describe("Slice 5.4 · Product Identity Resolution — real staging cards", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");
  test.setTimeout(180_000);

  test("every real card produces a ProductIdentityResolution + zero external calls (scaffolding)", async ({ context }) => {
    const page = await loginAsFounder(context);
    const cases = ["vkbm", "8fk9", "7b0b", "73n5", "w3bz"];
    for (const suffix of cases) {
      const r = await probe(page, suffix);
      const pi = r.analyseResult?.productIdentityResolution;
      expect(pi, `${suffix} has productIdentityResolution`).toBeTruthy();
      expect(pi.status, `${suffix} status is valid enum`).toMatch(
        /^(RESOLVED_INTERNAL|RESOLVED_WITH_EXTERNAL_CORROBORATION|AMBIGUOUS|UNRESOLVED)$/,
      );
      // §29-§31 preservation: zero external calls on all cards while
      // scaffolding is active.
      expect(pi.externalLookupCount, `${suffix} zero external lookups`).toBe(0);
    }
  });

  test("1091559 internal reasoning surfaces both COMPLETE_MACHINE and REPLACEMENT_ENGINE / SERIALIZED_COMPONENT candidates", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    const pi = r.analyseResult?.productIdentityResolution;
    expect(pi.candidates.length).toBeGreaterThanOrEqual(2);
    const types = new Set(pi.candidates.map((c: any) => c.objectType));
    expect(types.has("COMPLETE_MACHINE"), "COMPLETE_MACHINE candidate emitted").toBe(true);
    const hasComponentSide =
      types.has("REPLACEMENT_ENGINE")
      || types.has("SERIALIZED_COMPONENT")
      || types.has("REPLACEMENT_COMPONENT");
    expect(hasComponentSide, "component-side candidate emitted").toBe(true);
    // Diagnostic should NOT reference amount/extension/total — §1
    // structural invariant (price does not directly drive capital).
    expect(pi.diagnostic).not.toMatch(/\b(amount|extension|total)\b/i);
    // Every candidate should carry an internalEvidenceScore.
    for (const c of pi.candidates) {
      expect(typeof c.internalEvidenceScore).toBe("number");
    }
  });

  test("1091559 capital decision reflects ProductIdentityResolution when RESOLVED_INTERNAL / _EXTERNAL", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    const pi = r.analyseResult?.productIdentityResolution;
    const capital = r.analyseResult?.purchasedItemIntelligence?.capitalDecision;
    if (pi.status === "RESOLVED_INTERNAL" || pi.status === "RESOLVED_WITH_EXTERNAL_CORROBORATION") {
      // If resolved to COMPLETE_MACHINE, capital should be
      // CAPITAL_CANDIDATE or at minimum not REPAIR_MAINTENANCE (the
      // previous erroneous verdict).
      if (pi.selectedObjectType === "COMPLETE_MACHINE") {
        expect(capital).not.toBe("REPAIR_MAINTENANCE");
      }
    }
    // Whatever the state, capital diagnostic must remain amount-free.
    const capitalDiag = r.analyseResult?.purchasedItemIntelligence?.capitalDiagnostic ?? "";
    expect(capitalDiag).not.toMatch(/\b(amount|extension|total)\b/i);
  });

  test("preservation controls: DMM/OXIO/CPA/1087769 never surface an unrelated GL", async ({ context }) => {
    const page = await loginAsFounder(context);
    // DMM stays not-telecom
    const dmm = await probe(page, "8fk9");
    expect(dmm.analyseResult?.glRecommendationWinner?.accountName ?? "")
      .not.toMatch(/telephone|internet/i);
    // OXIO stays telecom
    const oxio = await probe(page, "73n5");
    const oxioBits = (oxio.analyseResult?.glRecommendationWinner?.accountName ?? "")
      + " " + (oxio.analyseResult?.allocations?.cardCategory ?? "");
    expect(oxioBits).toMatch(/telephone|internet/i);
    // CPA stays Multiple
    const cpa = await probe(page, "w3bz");
    expect(cpa.analyseResult?.allocations?.cardCategory).toBe("Multiple");
    // 1087769 supplier + total frozen
    const oc7 = await probe(page, "7b0b");
    expect(oc7.analyseResult?.supplierGuessedName).toMatch(/Oakcreek/i);
    expect(Number(oc7.analyseResult?.total)).toBe(1056.22);
  });
});
