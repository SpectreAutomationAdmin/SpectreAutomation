// Sprint 3 · Phase 4 Slice 5.7A (2026-08-09) — authenticated
// staging acceptance for capital account role semantics + compat gate.
//
// §21 requires the acceptance to answer per-account:
//   Why is 1502 no longer competitive?
//   Why is 1505 no longer equally competitive?
//   Why is 1507 no longer equally competitive?
//   Why does 1508 not win without financing evidence?
//   Why does the eventual winner win?
//
// The tests below assert the reasoning (semantic verdicts +
// rejection reasons), not just the winning account number.

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

test.describe("Slice 5.7A · capital account role semantics — 1091559 acceptance", () => {
  test.skip(!availability.ready, availability.reason ?? "");
  test.setTimeout(180_000);

  test("1091559 winner has PREFERRED verdict + separated by >= ABSTAIN_GAP_MIN", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    const cap = r.analyseResult?.capitalAwareRanking;
    expect(cap.abstained).toBe(false);
    expect(cap.winnerAccountNumber).toBeTruthy();
    const winner = cap.compatiblePool.find((c: any) => c.accountNumber === cap.winnerAccountNumber);
    expect(winner.finalVerdict).toBe("PREFERRED");
    // gap must be >= 10 (ABSTAIN_GAP_MIN unchanged)
    const second = cap.compatiblePool[1];
    if (second) {
      expect(winner.totalScore - second.totalScore).toBeGreaterThanOrEqual(10);
    }
  });

  test("CIP accounts contradicted with specialCondition=CIP-evidence-required reason", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    const cap = r.analyseResult?.capitalAwareRanking;
    const cipAccounts = (cap.contradictedPool ?? []).filter((c: any) => c.capitalAccountRole === "CONSTRUCTION_IN_PROGRESS");
    expect(cipAccounts.length).toBeGreaterThanOrEqual(1);
    for (const c of cipAccounts) {
      expect(c.finalVerdict).toBe("CONTRADICTED");
      const cipReason = (c.rejectionReasons ?? []).some((r: string) => /CIP account requires project/i.test(r));
      expect(cipReason, `CIP account ${c.accountNumber} rejection reason cites CIP evidence`).toBe(true);
    }
  });

  test("wrong-functional-department accounts (Clubhouse / Computer) contradicted", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    const cap = r.analyseResult?.capitalAwareRanking;
    const wrongDept = (cap.contradictedPool ?? []).filter((c: any) =>
      c.accountFunctionalRole === "CLUBHOUSE_EQUIPMENT" || c.accountFunctionalRole === "COMPUTER_EQUIPMENT"
    );
    expect(wrongDept.length).toBeGreaterThanOrEqual(2);
    for (const c of wrongDept) {
      // Both CONTRADICTED and INCOMPATIBLE are exclusion verdicts.
      // INCOMPATIBLE fires when the account is also not-capital
      // (e.g. Prepaid - Computers). Both prevent winning.
      expect(["CONTRADICTED", "INCOMPATIBLE"]).toContain(c.finalVerdict);
    }
  });

  test("financing account contradicted absent financing evidence", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    const cap = r.analyseResult?.capitalAwareRanking;
    // Find the CAPITAL_ASSETS financing account specifically (not a
    // non-capital "Financed Prepaid Expenses" or similar).
    const financing = (cap.contradictedPool ?? []).find((c: any) =>
      c.accountFunctionalRole === "FINANCED_EQUIPMENT" && c.capitalAccountRole === "EQUIPMENT_ASSET"
    );
    expect(financing).toBeTruthy();
    expect(["CONTRADICTED", "INCOMPATIBLE"]).toContain(financing.finalVerdict);
    const financingReason = (financing.rejectionReasons ?? []).some((r: string) => /financing account requires affirmative financing evidence/i.test(r));
    expect(financingReason).toBe(true);
  });

  test("land / building accounts contradicted (complete-machine cannot be land / building)", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    const cap = r.analyseResult?.capitalAwareRanking;
    const land = (cap.contradictedPool ?? []).find((c: any) => c.capitalAccountRole === "LAND_ASSET");
    const building = (cap.contradictedPool ?? []).find((c: any) => c.capitalAccountRole === "BUILDING_ASSET");
    expect(land?.finalVerdict).toBe("CONTRADICTED");
    expect(building?.finalVerdict).toBe("CONTRADICTED");
  });

  test("§13 preservation: DMM stays fuel, controls unchanged, zero external calls", async ({ context }) => {
    const page = await loginAsFounder(context);
    for (const suffix of ["8fk9", "7b0b", "73n5", "w3bz"]) {
      const r = await probe(page, suffix);
      expect(r.analyseResult?.externalResearchTrace?.externalLookupCount ?? 0).toBe(0);
    }
    // DMM stays fuel
    const dmm = await probe(page, "8fk9");
    expect(dmm.analyseResult?.glRecommendationWinner?.accountName ?? "").toMatch(/fuel/i);
    // OXIO stays telecom
    const oxio = await probe(page, "73n5");
    const oxioBits = (oxio.analyseResult?.glRecommendationWinner?.accountName ?? "")
      + " " + (oxio.analyseResult?.allocations?.cardCategory ?? "");
    expect(oxioBits).toMatch(/telephone|internet/i);
    // CPA stays Multiple
    const cpa = await probe(page, "w3bz");
    expect(cpa.analyseResult?.allocations?.cardCategory).toBe("Multiple");
  });
});
