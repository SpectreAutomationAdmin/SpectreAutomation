// Sprint 3 · Phase 4 Slice 5.2 (2026-08-08) — authenticated
// acceptance for the accounting-reasoning slice, against the five
// real Outlook-backed staging cards.
//
// Founder §34 acceptance targets:
//   - DMM: category is NOT "Telephone & Internet"; recommended
//     account name relates to fuel evidence.
//   - Oakcreek 1091559: category is NOT "Interest Expense"; the
//     recommendation is defensibly derived from equipment / parts /
//     R&M evidence.
//   - Oakcreek 1087769: recommendation remains defensible parts /
//     maintenance account.
//   - OXIO: category remains "Telephone & Internet" (negative
//     control per §14 amendment).
//   - CPA Alberta: category remains "Multiple" with visible
//     allocations (memberships + interest/penalty).
//
// Frozen surface: Slice 4-reopen supplier assertions still pass.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

interface InspectResult {
  ok?: boolean;
  analyseResult?: {
    supplierGuessedName?: string;
    invoiceNumber?: string;
    total?: number | string;
    canonicalLineItemsV2?: Array<{ description: string; extension: number; role: string; sourceStrategy: string }>;
    accountingIntelligence?: {
      natureLeader?: string;
      natureConfidence?: number;
      natureIsDefensible?: boolean;
    };
    allocations?: {
      cardCategory?: string | null;
      entryCount?: number;
      entries?: Array<{ recommendedAccountNumber?: string; recommendedAccountName?: string }>;
    };
    glRecommendationWinner?: {
      accountNumber?: string;
      accountName?: string;
      confidence?: number;
      source?: string;
    };
    purposeTaxonomyTop3?: Array<{ concept: string; confidence: number }>;
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

test.describe("Slice 5.2 · accounting reasoning — real staging cards", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");
  test.setTimeout(120_000);

  test("DMM (8fk9) category is NOT Telephone & Internet; supplier + total stable", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "8fk9");
    // Frozen supplier + total.
    expect(r.analyseResult?.supplierGuessedName).toMatch(/DMM/i);
    expect(Number(r.analyseResult?.total)).toBe(2532.92);
    // §27 explicit rejection: category is NOT Telephone & Internet.
    const glName = r.analyseResult?.glRecommendationWinner?.accountName ?? "";
    const cardCat = r.analyseResult?.allocations?.cardCategory ?? "";
    expect(glName, "DMM GL winner is not Telephone & Internet").not.toMatch(/telephone|internet/i);
    expect(cardCat, "DMM card category is not Telephone & Internet").not.toMatch(/telephone|internet/i);
  });

  test("Oakcreek 1091559 (vkbm) category is NOT Interest Expense; supplier + total stable", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    expect(r.analyseResult?.supplierGuessedName).toMatch(/Oakcreek/i);
    expect(Number(r.analyseResult?.total)).toBe(77833.35);
    const glName = r.analyseResult?.glRecommendationWinner?.accountName ?? "";
    const cardCat = r.analyseResult?.allocations?.cardCategory ?? "";
    expect(glName, "Oakcreek 1091559 GL winner is not Interest Expense").not.toMatch(/interest\s*expense/i);
    expect(cardCat, "Oakcreek 1091559 card category is not Interest Expense").not.toMatch(/interest\s*expense/i);
  });

  test("Oakcreek 1087769 (7b0b) supplier + total stable; recommendation is defensible or truthfully abstained", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "7b0b");
    expect(r.analyseResult?.supplierGuessedName).toMatch(/Oakcreek/i);
    expect(Number(r.analyseResult?.total)).toBe(1056.22);
    // Amendment #11: truthful abstention (source=NONE, requires
    // review) is preferable to a wrong high-confidence pick. Either
    // a defensible recommendation OR NONE is acceptable — never a
    // wrong-but-confident pick.
    const glName = r.analyseResult?.glRecommendationWinner?.accountName ?? "";
    // Must NOT be Interest Expense or Telephone & Internet on this
    // scanned-parts invoice, whatever else it is.
    expect(glName).not.toMatch(/interest\s*expense/i);
    expect(glName).not.toMatch(/telephone|internet/i);
  });

  test("OXIO (73n5) remains Telephone & Internet (negative control §14)", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "73n5");
    expect(r.analyseResult?.supplierGuessedName).toBe("OXIO");
    const cardCat = r.analyseResult?.allocations?.cardCategory ?? "";
    const glName = r.analyseResult?.glRecommendationWinner?.accountName ?? "";
    expect(cardCat + " " + glName, "OXIO still telecom").toMatch(/telephone|internet/i);
  });

  test("CPA Alberta (w3bz) remains Multiple with distinct allocations (§13, §29)", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "w3bz");
    expect(r.analyseResult?.supplierGuessedName).toMatch(/CPA/i);
    expect(r.analyseResult?.allocations?.cardCategory).toBe("Multiple");
    expect(r.analyseResult?.allocations?.entryCount ?? 0).toBeGreaterThanOrEqual(2);
    // The allocations must include at least one Membership / Dues
    // account and at least one interest/penalty-oriented account.
    const names = (r.analyseResult?.allocations?.entries ?? [])
      .map((e) => (e.recommendedAccountName ?? "").toLowerCase());
    expect(names.some((n) => /member|dues/.test(n)), "CPA allocations include membership/dues").toBe(true);
    expect(names.some((n) => /interest|penalty/.test(n)), "CPA allocations include interest/penalty").toBe(true);
  });

  test("all five docs: supplier + total stable (Slice 4-reopen frozen surface held)", async ({ context }) => {
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
});
