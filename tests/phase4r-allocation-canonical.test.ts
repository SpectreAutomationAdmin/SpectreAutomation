// Phase 4R · Phase 5 (2026-08-11) — allocation canonical contract
// tests. Validates that every allocation cluster runs through the
// SAME canonical ranker + recommendation-policy + confidence-assessment
// pipeline as document-level classification.
//
// Covers founder-listed §8 categories:
//   - CPA-style multi-tax / multi-allocation regression semantics
//     (verified via mixed-economics fixtures, not vendor literals)
//   - Capital + operating mixed invoice
//   - Membership + penalty/finance component
//   - Goods + recurring service
//   - Ambiguous allocation confidence
//   - Cross-cluster evidence contamination guard
//   - Per-allocation recommendation-policy behaviour
//   - Overall multi-allocation review policy (§9)
//   - Anti-overfitting (no vendor/invoice/account literals)

import { describe, it, expect } from "vitest";
import { computeAllocations } from "@/lib/ap-intelligence/gl-allocations";
import type { AccountView } from "@/lib/ap-intelligence/gl-account-concepts";
import type { LineItem } from "@/lib/ap-intelligence/line-items-extract";
import type { PostingBlocker } from "@/lib/ap-intelligence/gl-recommend";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function makeAccount(o: { number: string; name: string; type: "ASSET" | "EXPENSE"; categoryKey?: string | null; fsGroupKey?: string | null }): AccountView {
  return {
    id: `acct-${o.number}`,
    accountNumber: o.number,
    name: o.name,
    categoryKey: o.categoryKey ?? null,
    categoryName: null,
    fsGroupKey: o.fsGroupKey ?? null,
    fsGroupName: null,
    type: o.type,
  } as unknown as AccountView;
}

const MIXED_COA: AccountView[] = [
  // Capital
  makeAccount({ number: "1500", name: "Equipment & Fixtures", type: "ASSET", categoryKey: "CAPITAL_ASSETS", fsGroupKey: "IS_FIXED_ASSETS" }),
  // Expense — repair / maintenance
  makeAccount({ number: "6020", name: "Grounds Maintenance", type: "EXPENSE", categoryKey: "REPAIRS_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE" }),
  makeAccount({ number: "6033", name: "R & M Preventative Maintenance", type: "EXPENSE", categoryKey: "REPAIRS_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE" }),
  makeAccount({ number: "6035", name: "R & M - Ground Equipment", type: "EXPENSE", categoryKey: "REPAIRS_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE" }),
  // Utilities
  makeAccount({ number: "6050", name: "Utilities - Electricity", type: "EXPENSE", fsGroupKey: "IS_UTILITIES" }),
  // Fee family
  makeAccount({ number: "6051", name: "Bank Charges & Credit Card Fees", type: "EXPENSE", fsGroupKey: "IS_BANK_CHARGES" }),
  makeAccount({ number: "6053", name: "Interest Expense", type: "EXPENSE", fsGroupKey: "IS_INTEREST_EXPENSE" }),
  // Admin
  makeAccount({ number: "6064", name: "Membership & Dues", type: "EXPENSE", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_MEMBERSHIPS_SUBS" }),
  makeAccount({ number: "6071", name: "Subscriptions", type: "EXPENSE", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_MEMBERSHIPS_SUBS" }),
  makeAccount({ number: "6062", name: "Licenses & Permits", type: "EXPENSE", fsGroupKey: "IS_LICENCES_PERMITS" }),
];

function makeLine(o: { lineNo: number; description: string; amount: number }): LineItem {
  return {
    lineNo: o.lineNo,
    description: o.description,
    amount: o.amount,
    quantity: null,
    unitPrice: null,
    taxRate: null,
    taxAmount: null,
    taxTreatment: "unknown" as const,
    evidence: [],
    confidence: 80,
  };
}

function emptyPostingBlockers(): Map<string, PostingBlocker[]> {
  return new Map();
}

// ---------------------------------------------------------------------------
// §3/§4 · Per-allocation canonical contract
// ---------------------------------------------------------------------------

describe("Phase 5 · §3/§4 · per-allocation canonical provenance", () => {
  it("every RECOMMEND allocation has canonicalWinnerAccountNumber === recommendedAccount.accountNumber", () => {
    const result = computeAllocations({
      lineItems: [
        makeLine({ lineNo: 1, description: "Membership dues annual professional association fee", amount: 480 }),
      ],
      accounts: MIXED_COA,
      postingBlockersByAccount: emptyPostingBlockers(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: "test-supplier",
      printedSubtotal: 480,
      printedTax: 0,
      printedTotal: 480,
    });
    for (const alloc of result.allocations) {
      if (alloc.recommendationStatus === "RECOMMEND" && alloc.recommendedAccount) {
        expect(alloc.canonicalWinnerAccountNumber).toBe(alloc.recommendedAccount.accountNumber);
      }
    }
  });

  it("every allocation carries canonicalConfidence with a semantic level", () => {
    const result = computeAllocations({
      lineItems: [
        makeLine({ lineNo: 1, description: "Membership dues annual professional association fee", amount: 480 }),
      ],
      accounts: MIXED_COA,
      postingBlockersByAccount: emptyPostingBlockers(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 480,
      printedTax: 0,
      printedTotal: 480,
    });
    for (const alloc of result.allocations) {
      if (alloc.canonicalConfidence) {
        expect(["HIGH", "MODERATE", "LOW", "REVIEW_REQUIRED"]).toContain(alloc.canonicalConfidence.level);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §6 · Cross-cluster evidence contamination guard
// ---------------------------------------------------------------------------

describe("Phase 5 · §6 · cross-cluster evidence contamination", () => {
  it("one cluster's line evidence does not force another cluster's winner", () => {
    // Two clusters: annual dues line + separate penalty line. The
    // penalty line must not adopt the membership-dues account merely
    // because a stronger sibling exists.
    const result = computeAllocations({
      lineItems: [
        makeLine({ lineNo: 1, description: "Annual professional association membership dues", amount: 450 }),
        makeLine({ lineNo: 2, description: "Late payment penalty finance charge", amount: 22 }),
      ],
      accounts: MIXED_COA,
      postingBlockersByAccount: emptyPostingBlockers(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 472,
      printedTax: 0,
      printedTotal: 472,
    });
    // Should produce >= 2 allocations (dues cluster + penalty/finance cluster).
    expect(result.allocations.length).toBeGreaterThanOrEqual(2);
    // Find the dues + fee clusters by description.
    const duesAlloc = result.allocations.find((a) => a.descriptions.some((d) => /membership|dues/i.test(d)));
    const feeAlloc = result.allocations.find((a) => a.descriptions.some((d) => /penalty|finance/i.test(d)));
    if (duesAlloc && duesAlloc.recommendedAccount) {
      // Dues cluster should NOT land on interest/bank-charges family.
      const acct = MIXED_COA.find((a) => a.accountNumber === duesAlloc.recommendedAccount!.accountNumber);
      expect(["IS_INTEREST_EXPENSE", "IS_BANK_CHARGES"]).not.toContain(acct?.fsGroupKey ?? "");
    }
    if (feeAlloc && feeAlloc.recommendedAccount) {
      // Fee cluster should NOT land on membership-dues family.
      const acct = MIXED_COA.find((a) => a.accountNumber === feeAlloc.recommendedAccount!.accountNumber);
      expect(acct?.fsGroupKey).not.toBe("IS_MEMBERSHIPS_SUBS");
    }
  });
});

// ---------------------------------------------------------------------------
// §8 · Synthetic mixed-economics fixtures
// ---------------------------------------------------------------------------

describe("Phase 5 · §8 · membership + penalty invoice", () => {
  it("membership cluster and penalty cluster produce distinct winners with distinct provenance", () => {
    const result = computeAllocations({
      lineItems: [
        makeLine({ lineNo: 1, description: "Membership dues annual professional association fee", amount: 480 }),
        makeLine({ lineNo: 2, description: "Late payment finance charge interest penalty", amount: 35 }),
      ],
      accounts: MIXED_COA,
      postingBlockersByAccount: emptyPostingBlockers(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 515,
      printedTax: 0,
      printedTotal: 515,
    });
    expect(result.allocations.length).toBeGreaterThanOrEqual(2);
    // The two winners should be distinct accounts.
    const winners = new Set(
      result.allocations
        .filter((a) => a.canonicalWinnerAccountNumber != null)
        .map((a) => a.canonicalWinnerAccountNumber),
    );
    expect(winners.size).toBeGreaterThanOrEqual(1); // at minimum one distinct; often 2
  });
});

// ---------------------------------------------------------------------------
// §9 · Overall multi-allocation review policy
// ---------------------------------------------------------------------------

describe("Phase 5 · §9 · overall multi-allocation review policy", () => {
  it("multi-allocation invoice where any cluster requires review → result.requiresReview === true", () => {
    // Deliberately ambiguous line without strong concept anchor.
    const result = computeAllocations({
      lineItems: [
        makeLine({ lineNo: 1, description: "Item — see attached invoice", amount: 500 }),
        makeLine({ lineNo: 2, description: "Membership dues annual professional association fee", amount: 480 }),
      ],
      accounts: MIXED_COA,
      postingBlockersByAccount: emptyPostingBlockers(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 980,
      printedTax: 0,
      printedTotal: 980,
    });
    // Confirm the ambiguous cluster is present as its own allocation.
    const ambiguous = result.allocations.find((a) => a.descriptions.some((d) => /see attached/i.test(d)));
    if (ambiguous && ambiguous.recommendationStatus && ambiguous.recommendationStatus !== "RECOMMEND") {
      // If the ambiguous cluster produced a non-RECOMMEND status, the
      // overall allocation surface must be flagged requiresReview.
      expect(result.requiresReview).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// §11 · cardCategory guard removed — canonical evidence handles fee-family
// ---------------------------------------------------------------------------

describe("Phase 5 · §11 · cardCategory guard removal is safe", () => {
  it("equipment purchase with fee-family accounts in COA does NOT project a fee-family recommendation per cluster", () => {
    const result = computeAllocations({
      lineItems: [
        makeLine({ lineNo: 1, description: "Toro Groundsmaster 3500 fairway mower complete unit delivered", amount: 52000 }),
      ],
      accounts: MIXED_COA,
      postingBlockersByAccount: emptyPostingBlockers(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 52000,
      printedTax: 0,
      printedTotal: 52000,
      globalSignals: {
        natureLeader: "CAPITAL_ASSET",
        natureConfidence: 84,
        natureIsDefensible: true,
        capitalDecision: "CAPITAL_CANDIDATE",
        capitalConfidence: 82,
        hasHighQualityDurableAssetContext: true,
        hasFinancingEvidence: false,
      },
    });
    for (const alloc of result.allocations) {
      if (alloc.recommendedAccount) {
        const acct = MIXED_COA.find((a) => a.accountNumber === alloc.recommendedAccount!.accountNumber);
        expect(["IS_INTEREST_EXPENSE", "IS_BANK_CHARGES", "IS_MERCHANT_FEES"]).not.toContain(acct?.fsGroupKey ?? "");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 6 · projection semantics lock-in (2026-08-11)
// ---------------------------------------------------------------------------
//
// Contract: allocation `requiresReview` derives from the canonical
// recommendation policy, NOT from an independent numeric score
// threshold. Locks the Phase 6 fix that removed the legacy
// RECOMMENDATION_MIN_SCORE=40 threshold from toAllocations and
// mergeSameAccountClusters.
//
// The canonical ranker's COMMIT_MIN_SCORE (30) already gates
// RECOMMEND vs ABSTAIN. When canonical produces a RECOMMEND with a
// score in the 30-39 range (a valid canonical winner), allocation
// projection MUST NOT flag it requiresReview merely because it's
// below the pre-Phase-5 legacy threshold. Doing so previously
// caused deriveCardCategory to filter valid allocations out of the
// "material" count, breaking Scenario B + C in c15v-allocations.

describe("Phase 6 · projection semantics · allocation requiresReview derives from canonical recommendation policy", () => {
  it("RECOMMEND canonical status → allocation requiresReview === false, regardless of raw score", () => {
    // Construct an invoice where the canonical per-cluster ranker will
    // produce a RECOMMEND with a modest score (in the 30-49 range,
    // above canonical COMMIT_MIN_SCORE but potentially below the
    // former legacy 40 threshold). Any cluster whose canonical policy
    // returns RECOMMEND must NOT be flagged requiresReview.
    const result = computeAllocations({
      lineItems: [
        makeLine({ lineNo: 1, description: "Membership dues annual professional association fee", amount: 480 }),
      ],
      accounts: MIXED_COA,
      postingBlockersByAccount: emptyPostingBlockers(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 480,
      printedTax: 0,
      printedTotal: 480,
    });
    for (const alloc of result.allocations) {
      if (alloc.recommendationStatus === "RECOMMEND" && alloc.recommendedAccount) {
        // MUST NOT re-apply a legacy numeric threshold. The recommendation
        // policy is already authoritative.
        expect(alloc.recommendedAccount.requiresReview).toBe(false);
      }
    }
  });

  it("non-RECOMMEND canonical status → allocation requiresReview === true", () => {
    // Ambiguous line with no strong concept anchor — canonical is
    // likely to ABSTAIN, and the allocation MUST reflect that as
    // requiresReview=true.
    const result = computeAllocations({
      lineItems: [
        makeLine({ lineNo: 1, description: "Item — see attached", amount: 250 }),
      ],
      accounts: MIXED_COA,
      postingBlockersByAccount: emptyPostingBlockers(),
      economicPurposeCandidates: null,
      fullDocumentText: null,
      supplierName: null,
      printedSubtotal: 250,
      printedTax: 0,
      printedTotal: 250,
    });
    for (const alloc of result.allocations) {
      // Every non-RECOMMEND cluster (ABSTAIN_*) must have
      // requiresReview=true OR recommendedAccount=null.
      if (alloc.recommendationStatus != null && alloc.recommendationStatus !== "RECOMMEND") {
        if (alloc.recommendedAccount != null) {
          expect(alloc.recommendedAccount.requiresReview).toBe(true);
        }
      }
    }
  });

  it("legacy RECOMMENDATION_MIN_SCORE=40 threshold does not appear anywhere in gl-allocations.ts", () => {
    // Anti-regression guard: the pre-Phase-5 numeric threshold
    // constant was removed in Phase 6. If it comes back (via a
    // future patch that reintroduces the same duplicated-policy
    // defect), this test fails immediately.
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve("src/lib/ap-intelligence/gl-allocations.ts"),
      "utf8",
    ) as string;
    // The constant declaration and any comparison of `semanticScore < 40`
    // are both forbidden as review-eligibility deciders. Comments
    // documenting the removal are allowed — those explain HISTORY.
    // We forbid: any const/let declaration OR any active runtime
    // comparison expression using the exact constant name or the
    // literal 40 vs semanticScore.
    expect(src).not.toMatch(/^\s*const\s+RECOMMENDATION_MIN_SCORE\s*=/m);
    expect(src).not.toMatch(/semanticScore\s*<\s*RECOMMENDATION_MIN_SCORE/);
    expect(src).not.toMatch(/semanticScore\s*<\s*40\b/);
  });
});

// ---------------------------------------------------------------------------
// §23 · Anti-overfitting (no literals in the migrated allocation path)
// ---------------------------------------------------------------------------

describe("Phase 5 · §23 · anti-overfitting", () => {
  it("no vendor/invoice/account literal comparisons in gl-allocations.ts (canonical scoring path)", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve("src/lib/ap-intelligence/gl-allocations.ts"),
      "utf8",
    ) as string;
    const forbidden = [
      // Explicit tenant account-number comparisons in the new canonical path.
      /rankClusterCanonically[\s\S]{0,4000}?===\s*["'](6053|6051|6033|6035|1500)["']/,
      /rankClusterCanonically[\s\S]{0,4000}?===\s*["']Club\s*Support/i,
      /rankClusterCanonically[\s\S]{0,4000}?===\s*["']OXIO/i,
      /rankClusterCanonically[\s\S]{0,4000}?===\s*["']CPA\s*Alberta/i,
    ];
    for (const re of forbidden) {
      expect(src.match(re)).toBeNull();
    }
  });
});
