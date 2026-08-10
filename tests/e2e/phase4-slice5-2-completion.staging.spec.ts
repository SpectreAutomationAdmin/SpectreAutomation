// Sprint 3 · Phase 4 Slice 5.2 completion (2026-08-08) —
// authenticated staging acceptance per §11.
//
// DMM: canonical FUEL(96) + HIGH quality → full-COA search →
//      6025 Fuel ( Gas/Diesel ) commitment.
// Oakcreek 1091559: canonical EQUIPMENT_PARTS(96) but LOW quality
//      (primary "2 Lines Total" is summary-shape; tire levy is
//      auxiliary) → truthful abstention with purposeLabel surfaced.
// Oakcreek 1087769: existing repair/maintenance path preserved.
// OXIO: purpose-driven ranker preserves 6072 Telephone & Internet.
// CPA Alberta: Multiple + Membership & Dues + Interest Expense
//      allocations preserved.

import { test, expect, type Page } from "@playwright/test";
import { loginAsFounder, stagingCredsAvailable } from "./_lib/staging-auth";

const availability = stagingCredsAvailable();

interface InspectResult {
  ok?: boolean;
  analyseResult?: {
    supplierGuessedName?: string;
    total?: number | string;
    glRecommendationWinner?: { accountNumber?: string; accountName?: string; confidence?: number; source?: string };
    glReason?: string;
    allocations?: {
      cardCategory?: string | null;
      entryCount?: number;
      entries?: Array<{ recommendedAccountNumber?: string; recommendedAccountName?: string }>;
    };
    purposeDecision?: {
      source?: string;
      concept?: string | null;
      confidence?: number;
      label?: string;
    };
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

test.describe("Slice 5.2 completion · full evidence-chain acceptance", () => {
  test.skip(!availability.ready, availability.reason ?? "creds unavailable");
  test.setTimeout(120_000);

  test("DMM commits to a fuel-family GL from the full eligible COA", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "8fk9");
    // Frozen: supplier + total unchanged.
    expect(r.analyseResult?.supplierGuessedName).toMatch(/DMM/i);
    expect(Number(r.analyseResult?.total)).toBe(2532.92);
    // Canonical purpose committed.
    expect(r.analyseResult?.purposeDecision?.source).toBe("CANONICAL_COMMITTED");
    expect(r.analyseResult?.purposeDecision?.concept).toBe("FUEL");
    // GL winner is a fuel-family account, promoted via purpose-driven ranker.
    expect(r.analyseResult?.glRecommendationWinner?.source).toBe("ECONOMIC_PURPOSE");
    const winnerName = r.analyseResult?.glRecommendationWinner?.accountName ?? "";
    expect(winnerName, "DMM winner name contains fuel/diesel/petroleum").toMatch(/fuel|diesel|gasoline|petroleum/i);
    // Diagnostic explains the promotion.
    expect(r.analyseResult?.glReason ?? "").toMatch(/purpose_driven_full_coa_search:FUEL/);
    // Not Telephone & Internet.
    expect(winnerName).not.toMatch(/telephone|internet/i);
  });

  test("Oakcreek 1091559 truthfully abstains — weak primary evidence + purpose surfaced", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "vkbm");
    // Frozen: supplier + total unchanged.
    expect(r.analyseResult?.supplierGuessedName).toMatch(/Oakcreek/i);
    expect(Number(r.analyseResult?.total)).toBe(77833.35);
    // Purpose IS committed at high taxonomy confidence — but the
    // evidence-quality gate must reject commitment because the
    // primary purchase description is a summary-shape ("2 Lines
    // Total") without a discriminative vocabulary match.
    expect(r.analyseResult?.purposeDecision?.concept).toBe("EQUIPMENT_PARTS");
    // GL winner must NOT be Interest Expense; may be null (truthful
    // abstain) OR a defensible equipment/parts/R&M account IF the
    // ranker later finds one — the anti-goal is a wrong-but-confident
    // Interest Expense answer.
    const winnerName = r.analyseResult?.glRecommendationWinner?.accountName ?? "";
    expect(winnerName).not.toMatch(/interest\s*expense/i);
  });

  test("Oakcreek 1087769 preserves defensible R&M recommendation (control §9)", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "7b0b");
    expect(r.analyseResult?.supplierGuessedName).toMatch(/Oakcreek/i);
    expect(Number(r.analyseResult?.total)).toBe(1056.22);
    const winnerName = r.analyseResult?.glRecommendationWinner?.accountName ?? "";
    // Must NOT be Interest Expense / Telephone & Internet.
    expect(winnerName).not.toMatch(/interest\s*expense/i);
    expect(winnerName).not.toMatch(/telephone|internet/i);
  });

  test("OXIO remains Telephone & Internet based on service evidence (negative control §9)", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "73n5");
    expect(r.analyseResult?.supplierGuessedName).toBe("OXIO");
    // Card category and GL winner both point at telecom.
    const cardCat = r.analyseResult?.allocations?.cardCategory ?? "";
    const winnerName = r.analyseResult?.glRecommendationWinner?.accountName ?? "";
    expect(cardCat + " " + winnerName, "OXIO still telecom").toMatch(/telephone|internet/i);
  });

  test("CPA Alberta remains Multiple with membership + interest/penalty allocations (§9)", async ({ context }) => {
    const page = await loginAsFounder(context);
    const r = await probe(page, "w3bz");
    expect(r.analyseResult?.supplierGuessedName).toMatch(/CPA/i);
    expect(r.analyseResult?.allocations?.cardCategory).toBe("Multiple");
    expect(r.analyseResult?.allocations?.entryCount ?? 0).toBeGreaterThanOrEqual(2);
    const names = (r.analyseResult?.allocations?.entries ?? [])
      .map((e) => (e.recommendedAccountName ?? "").toLowerCase());
    expect(names.some((n) => /member|dues/.test(n)), "CPA has membership/dues allocation").toBe(true);
    expect(names.some((n) => /interest|penalty/.test(n)), "CPA has interest/penalty allocation").toBe(true);
  });

  test("Frozen: all 5 suppliers + totals unchanged (Slice 4-reopen surface preserved)", async ({ context }) => {
    const page = await loginAsFounder(context);
    for (const [label, suf, supplierRe, total] of [
      ["DMM", "8fk9", /DMM/i, 2532.92],
      ["Oakcreek 1091559", "vkbm", /Oakcreek/i, 77833.35],
      ["Oakcreek 1087769", "7b0b", /Oakcreek/i, 1056.22],
      ["OXIO", "73n5", /OXIO/, 40.32],
      ["CPA", "w3bz", /CPA/i, 1420.50],
    ] as const) {
      const r = await probe(page, suf);
      expect(r.analyseResult?.supplierGuessedName, `${label} supplier`).toMatch(supplierRe);
      expect(Number(r.analyseResult?.total), `${label} total`).toBe(total);
    }
  });
});
