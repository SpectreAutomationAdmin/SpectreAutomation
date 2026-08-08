// Sprint 3 · Phase 4 Slice 5.3 (2026-08-08) — authenticated
// acceptance for the purchased-item substance authority slice,
// against the same five real Outlook-backed staging cards used by
// Slice 5.2 acceptance.
//
// This spec asserts SHAPE + REASONING PRESERVATION, not that any
// specific real invoice codes to any specific GL account (per the
// AP intelligence anti-overfitting rule). What it proves:
//   1. Every card gets a `purchasedItemIntelligence` block from the
//      analyser.
//   2. Cards with line-item-rich invoices produce ≥1 purchased-item
//      identity entry.
//   3. Amount is not reflected as capital evidence (invariant).
//   4. Supplier + total remain stable (Slice 4-reopen frozen).
//   5. Slice 5.2 assertions still hold (frozen surface).

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

interface InspectResult {
  ok?: boolean;
  analyseResult?: {
    supplierGuessedName?: string;
    invoiceNumber?: string;
    total?: number | string;
    purchasedItemIntelligence?: {
      items?: Array<{
        description?: string;
        manufacturer?: string | null;
        model?: string | null;
        sku?: string | null;
        serialNumber?: string | null;
        completeness?: string;
        completenessConfidence?: number;
        evidenceQuality?: string;
      }>;
      capitalDecision?: string;
      capitalConfidence?: number;
      capitalDiagnostic?: string;
      departmentLeaderKey?: string | null;
      departmentLeaderName?: string | null;
      departmentIsDefensible?: boolean;
      founderFacingCategory?: string | null;
    };
    allocations?: { cardCategory?: string | null };
    glRecommendationWinner?: { accountName?: string; accountNumber?: string };
  };
}

async function probe(page: Page, suffix4: string): Promise<InspectResult> {
  const res = await page.request.post(
    `${availability.baseURL}/api/ap-intelligence/inspect-wi`,
    { data: { wiIdSuffix4: suffix4, positionalTrace: true } },
  );
  expect(res.status(), `inspect-wi ${suffix4} HTTP`).toBe(200);
  return await res.json();
}

test.describe("Slice 5.3 · purchased-item authority — real staging cards", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");
  test.setTimeout(120_000);

  test("every real card returns purchasedItemIntelligence", async ({ context }) => {
    const page = await loginAsFounder(context);
    const cases = [
      { label: "DMM", suffix: "8fk9" },
      { label: "Oakcreek 1091559", suffix: "vkbm" },
      { label: "Oakcreek 1087769", suffix: "7b0b" },
      { label: "OXIO", suffix: "73n5" },
      { label: "CPA", suffix: "w3bz" },
    ];
    for (const { label, suffix } of cases) {
      const r = await probe(page, suffix);
      const pi = r.analyseResult?.purchasedItemIntelligence;
      expect(pi, `${label} has purchasedItemIntelligence`).toBeTruthy();
      // Every card produces a capital decision — even UNRESOLVED counts.
      expect(pi?.capitalDecision, `${label} has capitalDecision`).toMatch(
        /^(CAPITAL_CANDIDATE|OPERATING|REPAIR_MAINTENANCE|UNRESOLVED)$/,
      );
      // Diagnostic string always present.
      expect(typeof pi?.capitalDiagnostic).toBe("string");
    }
  });

  test("line-item-rich invoices produce ≥1 purchased-item identity", async ({ context }) => {
    const page = await loginAsFounder(context);
    // The Oakcreek 1091559 invoice has multiple structured line items.
    // We expect at least one purchased-item to be recovered.
    const r = await probe(page, "vkbm");
    const items = r.analyseResult?.purchasedItemIntelligence?.items ?? [];
    expect(items.length, "Oakcreek 1091559 recovers ≥1 purchased item").toBeGreaterThanOrEqual(1);
    for (const it of items) {
      expect(it.completeness, "each item has a completeness classification").toMatch(
        /^(COMPLETE_ASSET|COMPONENT|CONSUMABLE|SERVICE|UNKNOWN)$/,
      );
    }
  });

  test("capital decision does not depend on amount (invariant)", async ({ context }) => {
    // Confirm the diagnostic string does not surface a "amount" or
    // "extension" token. Amount is prohibited as capital evidence
    // per §8. This is a machine-checkable invariant on the shape of
    // the diagnostic emitted by evaluateCapitalEvidence.
    const page = await loginAsFounder(context);
    const cases = ["8fk9", "vkbm", "7b0b", "73n5", "w3bz"];
    for (const suffix of cases) {
      const r = await probe(page, suffix);
      const diag = r.analyseResult?.purchasedItemIntelligence?.capitalDiagnostic ?? "";
      expect(diag, `${suffix} diagnostic does not mention amount`).not.toMatch(/\b(amount|extension|total)\b/i);
    }
  });

  test("Slice 4-reopen supplier + total frozen surface", async ({ context }) => {
    const page = await loginAsFounder(context);
    const cases = [
      { label: "DMM", suffix: "8fk9", supplier: /DMM/i, total: 2532.92 },
      { label: "Oakcreek 1091559", suffix: "vkbm", supplier: /Oakcreek/i, total: 77833.35 },
      { label: "Oakcreek 1087769", suffix: "7b0b", supplier: /Oakcreek/i, total: 1056.22 },
      { label: "OXIO", suffix: "73n5", supplier: /OXIO/, total: 40.32 },
      { label: "CPA", suffix: "w3bz", supplier: /CPA/i, total: 1420.50 },
    ];
    for (const { label, suffix, supplier, total } of cases) {
      const r = await probe(page, suffix);
      expect(r.analyseResult?.supplierGuessedName, `${label} supplier`).toMatch(supplier);
      expect(Number(r.analyseResult?.total), `${label} total`).toBe(total);
    }
  });

  test("Slice 5.2 negative controls hold (OXIO telecom, CPA multiple)", async ({ context }) => {
    const page = await loginAsFounder(context);
    // OXIO is telecom — a Slice 5.2 negative control per §14.
    const oxio = await probe(page, "73n5");
    const oxioCat = (oxio.analyseResult?.allocations?.cardCategory ?? "")
      + " " + (oxio.analyseResult?.glRecommendationWinner?.accountName ?? "");
    expect(oxioCat, "OXIO stays telecom").toMatch(/telephone|internet/i);
    // CPA has multiple allocations — Slice 5.2 §13 control.
    const cpa = await probe(page, "w3bz");
    expect(cpa.analyseResult?.allocations?.cardCategory).toBe("Multiple");
  });
});
