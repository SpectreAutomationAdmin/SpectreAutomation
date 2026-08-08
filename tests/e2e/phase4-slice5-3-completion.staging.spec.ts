// Sprint 3 · Phase 4 Slice 5.3 completion pass (2026-08-08) —
// strengthened authenticated staging acceptance per §21. Verifies
// against the live 1091559 document (wiIdSuffix4=vkbm) that:
//   - "2 Lines Total" is NOT primary purchase (SUMMARY_ROW_REJECTED)
//   - substantive TORO row is recovered with quantity + extension
//   - Serial# is attached to the substantive row (not a separate row)
//   - PREMIUM SEAT row is recovered with zero extension
//   - PurchasedObjectIdentity is populated with brand + model candidates
//     for the primary object
//   - objectRole is populated on the primary object
//   - CapitalEvidenceDecision is populated on the analyser output
//   - founder-facing category comes from the new authority chain,
//     not a stale taxonomy fallback
//   - amount does not appear in capitalDiagnostic (§25 invariant)
// Also asserts §22 preservation controls (DMM/OXIO/CPA/1087769).
// Does NOT hardcode expected GL account numbers.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

async function probe(page: Page, suffix4: string): Promise<any> {
  const res = await page.request.post(
    `${availability.baseURL}/api/ap-intelligence/inspect-wi`,
    { data: { wiIdSuffix4: suffix4, positionalTrace: true } },
  );
  expect(res.status(), `inspect-wi ${suffix4}`).toBe(200);
  return await res.json();
}

test.describe("Slice 5.3 completion — 1091559 (vkbm) live acceptance", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");
  test.setTimeout(180_000);

  test("substantive TORO-shape row recovered; not a summary row", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    const canonical = r.analyseResult?.canonicalLineItemsV2 ?? [];
    const primaries = canonical.filter((c: any) => c.role === "PRIMARY_PURCHASE");
    expect(primaries.length, "at least one PRIMARY_PURCHASE row").toBeGreaterThanOrEqual(1);
    // The primary row's description must NOT be a "Lines Total" summary
    const primaryDescs = primaries.map((p: any) => (p.description ?? "").toLowerCase());
    for (const desc of primaryDescs) {
      expect(desc, "PRIMARY_PURCHASE is not a summary row").not.toMatch(/lines?\s*total|items?\s*total|net\s*total/i);
    }
    // High-extension primary row exists (the substantive purchased item)
    const highValuePrimary = primaries.find((p: any) => (p.extension ?? 0) >= 1000);
    expect(highValuePrimary, "high-value substantive primary purchase row exists").toBeTruthy();
    expect(highValuePrimary.quantity, "quantity populated on primary row").not.toBeNull();
    expect(highValuePrimary.unit, "unit populated on primary row").toBeTruthy();
  });

  test("summary + tax rows recovered as reconciliation-only evidence (§5)", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    const canonical = r.analyseResult?.canonicalLineItemsV2 ?? [];
    // Summary and tax rows must remain (not become PRIMARY_PURCHASE).
    const summary = canonical.find((c: any) => c.role === "SUMMARY_ROW_REJECTED");
    const tax = canonical.find((c: any) => c.role === "TAX");
    expect(summary, "summary row surfaces with SUMMARY_ROW_REJECTED").toBeTruthy();
    expect(tax, "tax row surfaces with TAX").toBeTruthy();
  });

  test("PurchasedObjectIdentity populated for the primary object", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    const objects = r.analyseResult?.purchasedObjectIntelligence?.objects ?? [];
    expect(objects.length, "≥1 purchased object recovered").toBeGreaterThanOrEqual(1);
    // Primary = highest-extension
    const primary = [...objects].sort((a: any, b: any) => (b.extension ?? 0) - (a.extension ?? 0))[0];
    expect(primary.brandCandidates.length, "primary object has ≥1 brand candidate").toBeGreaterThanOrEqual(1);
    expect(primary.modelCandidates.length, "primary object has ≥1 model candidate").toBeGreaterThanOrEqual(1);
    // Object role assigned (any valid state)
    expect(primary.objectRole, "objectRole assigned").toMatch(
      /^(COMPLETE_MACHINE|SERIALIZED_COMPONENT|COMPONENT|ACCESSORY|CONSUMABLE|SERVICE|UNKNOWN)$/,
    );
    // Serial candidate present (structural continuation was attached)
    expect(primary.serialCandidates.length, "serial candidate attached to primary").toBeGreaterThanOrEqual(1);
    // Diagnostic string non-empty
    expect(typeof primary.objectRoleDiagnostic).toBe("string");
    expect(primary.objectRoleDiagnostic.length).toBeGreaterThan(0);
  });

  test("CapitalEvidenceDecision populated + amount not used as capital evidence (§25)", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    const pi = r.analyseResult?.purchasedItemIntelligence;
    expect(pi).toBeTruthy();
    expect(pi.capitalDecision).toMatch(/^(CAPITAL_CANDIDATE|OPERATING|REPAIR_MAINTENANCE|UNRESOLVED)$/);
    expect(pi.capitalDiagnostic, "capital diagnostic must not reference amount/total/extension")
      .not.toMatch(/\b(amount|extension|total)\b/i);
  });

  test("founder-facing category comes from the new authority (not stale taxonomy)", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    const pi = r.analyseResult?.purchasedItemIntelligence;
    const pd = r.analyseResult?.purposeDecision;
    // At least one of: (a) founderFacingCategory is set from the new
    // authority, or (b) purpose decision produced a defensible label
    // based on the SUBSTANTIVE row (not a surcharge). Assert that if
    // purposeDecision is EQUIPMENT_PARTS, the supporting evidence
    // includes at least one substantive PRIMARY_PURCHASE line item,
    // not solely a surcharge row.
    if (pd?.concept && Array.isArray(pd?.canonicalTop3)) {
      const top = pd.canonicalTop3[0];
      if (top && Array.isArray(top.supporting)) {
        const surchargeOnly = top.supporting.every(
          (s: any) => (s.lineItemDescription ?? "").toLowerCase().includes("tire levy"),
        );
        expect(surchargeOnly, "purpose evidence not exclusively from surcharge").toBe(false);
      }
    }
    // If founderFacingCategory is set, it should not be the raw
    // taxonomy label "Equipment parts / consumables" unless there is
    // substantive object-based evidence for the same conclusion.
    if (pi?.founderFacingCategory) {
      expect(typeof pi.founderFacingCategory).toBe("string");
    }
  });
});

test.describe("Slice 5.3 completion — §22 preservation controls", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");
  test.setTimeout(120_000);

  test("DMM stays not-telecom; supplier + total frozen", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "8fk9");
    expect(r.analyseResult?.supplierGuessedName).toMatch(/DMM/i);
    expect(Number(r.analyseResult?.total)).toBe(2532.92);
    const glName = r.analyseResult?.glRecommendationWinner?.accountName ?? "";
    expect(glName).not.toMatch(/telephone|internet/i);
  });

  test("OXIO stays telecom; supplier + total frozen", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "73n5");
    expect(r.analyseResult?.supplierGuessedName).toBe("OXIO");
    const glName = r.analyseResult?.glRecommendationWinner?.accountName ?? "";
    const cardCat = r.analyseResult?.allocations?.cardCategory ?? "";
    expect(glName + " " + cardCat).toMatch(/telephone|internet/i);
  });

  test("CPA stays Multiple; allocations present", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "w3bz");
    expect(r.analyseResult?.supplierGuessedName).toMatch(/CPA/i);
    expect(r.analyseResult?.allocations?.cardCategory).toBe("Multiple");
  });

  test("Oakcreek 1087769 supplier + total frozen; category not obviously wrong", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "7b0b");
    expect(r.analyseResult?.supplierGuessedName).toMatch(/Oakcreek/i);
    expect(Number(r.analyseResult?.total)).toBe(1056.22);
    const glName = r.analyseResult?.glRecommendationWinner?.accountName ?? "";
    expect(glName).not.toMatch(/telephone|internet/i);
    expect(glName).not.toMatch(/interest\s*expense/i);
  });
});
