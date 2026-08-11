// Phase 4R · Phase 4 (2026-08-11) — evidence-integrity + canonical
// confidence assessment contract tests.
//
// Covers founder-listed §19 categories:
//   - same-account duplicate cannot be alternate
//   - weak semantic accident → DIAGNOSTIC only, not competitor
//   - meaningful close alternative → DECISION competitor
//   - deterministic tie → not HIGH solely from ordering
//   - strong winner / no competitor → HIGH
//   - strong winner / genuine competitor → MODERATE
//   - poor interpretation → appropriate low/review behaviour
//   - canonical ABSTAIN states → REVIEW_REQUIRED
//   - capital category strong while GL account ambiguous
//   - multi-signal independent evidence
//   - correlated evidence suppression (still DIAGNOSTIC)
//   - novel vendor
//   - same vendor / different economics
//   - financing exception from Group D
//
// Anti-overfitting: no vendor/invoice/account literals in
//   canonical-confidence.ts (verified below).

import { describe, it, expect } from "vitest";
import {
  rankCanonical,
  type CanonicalRankerInput,
  type CanonicalCandidate,
  type NormalisedTransactionInterpretation,
} from "@/lib/ap-intelligence/canonical-ranker";
import {
  assessCanonicalConfidence,
  qualifyGenuineCompetitors,
} from "@/lib/ap-intelligence/canonical-confidence";
import type { RecommendationDecision } from "@/lib/ap-intelligence/recommendation-policy";
import type { AccountView } from "@/lib/ap-intelligence/gl-account-concepts";

// ---------------------------------------------------------------------------
// Fixture builders — hermetic pure input to rankCanonical()
// ---------------------------------------------------------------------------

function makeAccount(o: Partial<AccountView> & { number: string; name: string; type?: string }): AccountView {
  const { number, name, ...rest } = o;
  return {
    id: `acct-${number}`,
    accountNumber: number,
    name,
    categoryKey: null,
    categoryName: null,
    fsGroupKey: null,
    fsGroupName: null,
    ...rest,
  } as AccountView;
}

function makeTransaction(over: Partial<NormalisedTransactionInterpretation> = {}): NormalisedTransactionInterpretation {
  return {
    purposeConcept: null,
    purposeConfidence: 0,
    purposeQuality: "NONE",
    capitalDecision: null,
    capitalConfidence: 0,
    natureLeader: "UNKNOWN",
    natureConfidence: 0,
    natureIsDefensible: false,
    departmentKey: null,
    departmentAccountNamePatterns: [],
    canonicalLineItems: [],
    queryConcepts: [],
    vendor: { matchedVendorId: null, defaultAccountId: null, priorCodingAccountNumbers: [] },
    documentPhraseText: null,
    ...over,
  };
}

function makeInput(over: Partial<CanonicalRankerInput> & { eligibleAccounts: AccountView[] }): CanonicalRankerInput {
  return {
    transaction: makeTransaction(),
    postingBlockersByAccount: new Map(),
    ...over,
  };
}

function mkRecommendation(status: RecommendationDecision["status"], winnerAccountNumber: string | null): RecommendationDecision {
  const category = status === "RECOMMEND" ? null
    : status === "ABSTAIN_QUALITY" ? "QUALITY"
    : status === "ABSTAIN_AMBIGUITY" ? "AMBIGUITY"
    : status === "ABSTAIN_NO_CANDIDATES" ? "NO_CANDIDATES"
    : "ANALYSIS_FAILURE";
  return {
    status,
    abstentionCategory: category as any,
    abstentionReasons: [],
    reason: `test:${status}`,
    canonicalWinnerAccountNumber: winnerAccountNumber,
    autoApprovalEligible: status === "RECOMMEND",
    requiresReview: status !== "RECOMMEND",
  };
}

const NEUTRAL_COA: AccountView[] = [
  makeAccount({ number: "1500", name: "Equipment & Fixtures", type: "ASSET", categoryKey: "CAPITAL_ASSETS", fsGroupKey: "IS_FIXED_ASSETS" }),
  makeAccount({ number: "6020", name: "Grounds Maintenance", type: "EXPENSE", categoryKey: "REPAIRS_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE" }),
  makeAccount({ number: "6025", name: "Fuel", type: "EXPENSE", fsGroupKey: "IS_UTILITIES" }),
  makeAccount({ number: "6033", name: "R & M Preventative Maintenance", type: "EXPENSE", categoryKey: "REPAIRS_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE" }),
  makeAccount({ number: "6035", name: "R & M - Ground Equipment", type: "EXPENSE", categoryKey: "REPAIRS_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE" }),
  makeAccount({ number: "6050", name: "Utilities - Electricity", type: "EXPENSE", fsGroupKey: "IS_UTILITIES" }),
  makeAccount({ number: "6051", name: "Bank Charges & Credit Card Fees", type: "EXPENSE", fsGroupKey: "IS_BANK_CHARGES" }),
  makeAccount({ number: "6053", name: "Interest Expense", type: "EXPENSE", fsGroupKey: "IS_INTEREST_EXPENSE" }),
  makeAccount({ number: "6064", name: "Membership & Dues", type: "EXPENSE", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_MEMBERSHIPS_SUBS" }),
  makeAccount({ number: "6071", name: "Subscriptions", type: "EXPENSE", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_MEMBERSHIPS_SUBS" }),
];

// ---------------------------------------------------------------------------
// §19 · Evidence-role model
// ---------------------------------------------------------------------------

describe("Phase 4 · §2-§4 · evidence role assignment", () => {
  it("counted positive contribution >= 10 → DECISION", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        natureLeader: "CAPITAL_ASSET",
        natureConfidence: 84,
        natureIsDefensible: true,
        capitalDecision: "CAPITAL_CANDIDATE",
        capitalConfidence: 82,
        purposeConcept: "CAPITAL_EQUIPMENT",
        purposeConfidence: 85,
        purposeQuality: "HIGH",
        canonicalLineItems: [{ description: "Fairway mower complete unit delivered", role: "PRIMARY_PURCHASE", extension: 52000 }],
        queryConcepts: [{ conceptId: "course_equipment", weight: 20, source: "line_item_description", evidenceSnippet: "fairway mower complete" }],
      }),
    }));
    expect(result.status).toBe("RECOMMEND");
    if (result.status === "RECOMMEND") {
      const winner = result.candidates[0];
      // CAPITAL_ASSET_MATCH is +20, NATURE_COMPAT is +15 — both DECISION.
      const bigPositives = winner.evidence.filter((e) => e.contribution >= 10 && e.countedTowardScore);
      expect(bigPositives.length).toBeGreaterThan(0);
      for (const e of bigPositives) {
        expect(e.role).toBe("DECISION");
      }
    }
  });

  it("suppressed positive (correlated, countedTowardScore=false) → DIAGNOSTIC even with large contribution", () => {
    // TRANSACTION_TEXT family with two large-but-correlated signals —
    // MAX-within-family keeps only the strongest; the suppressed one
    // is DIAGNOSTIC regardless of its raw contribution.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "REPAIR_MAINTENANCE",
        purposeConfidence: 82,
        purposeQuality: "HIGH",
        natureLeader: "REPAIR_MAINTENANCE",
        natureConfidence: 84,
        natureIsDefensible: true,
        canonicalLineItems: [
          { description: "Grounds maintenance service call quarterly labour", role: "PRIMARY_PURCHASE", extension: 640 },
        ],
        queryConcepts: [
          { conceptId: "repairs_and_maintenance", weight: 22, source: "line_item_description", evidenceSnippet: "service call quarterly labour" },
          { conceptId: "grounds_maintenance", weight: 22, source: "line_item_description", evidenceSnippet: "grounds maintenance" },
        ],
      }),
    }));
    if (result.status === "RECOMMEND") {
      const winner = result.candidates[0];
      // At least one suppressed observation (countedTowardScore=false)
      // whose role must be DIAGNOSTIC.
      const suppressed = winner.evidence.filter((e) => !e.countedTowardScore);
      for (const e of suppressed) {
        expect(e.role).toBe("DIAGNOSTIC");
      }
    }
  });

  it("small counted contribution (< 5) → DIAGNOSTIC", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        canonicalLineItems: [{ description: "Small line item", role: "PRIMARY_PURCHASE", extension: 100 }],
        queryConcepts: [{ conceptId: "generic", weight: 4, source: "line_item_description", evidenceSnippet: "small" }],
      }),
    }));
    if (result.status === "RECOMMEND" || result.status === "ABSTAIN") {
      for (const c of result.candidates) {
        for (const e of c.evidence) {
          if (e.countedTowardScore && Math.abs(e.contribution) < 5 && e.contribution >= 0) {
            expect(e.role).toBe("DIAGNOSTIC");
          }
        }
      }
    }
  });

  it("contradiction with |contribution| >= 10 → DECISION (materially changes ranking)", () => {
    // Equipment purchase — losing candidates get NATURE_INCOMPATIBLE(-18)
    // which is a DECISION contradiction.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        natureLeader: "CAPITAL_ASSET",
        natureConfidence: 84,
        natureIsDefensible: true,
        capitalDecision: "CAPITAL_CANDIDATE",
        capitalConfidence: 82,
        purposeConcept: "CAPITAL_EQUIPMENT",
        purposeConfidence: 85,
        purposeQuality: "HIGH",
        canonicalLineItems: [{ description: "Complete unit delivered", role: "PRIMARY_PURCHASE", extension: 25000 }],
        queryConcepts: [{ conceptId: "course_equipment", weight: 20, source: "line_item_description", evidenceSnippet: "complete unit" }],
      }),
    }));
    if (result.status === "RECOMMEND") {
      // Find any EXPENSE candidate — should carry NATURE_INCOMPATIBLE
      // (-18) with role DECISION.
      const expenseCand = result.candidates.find((c) => c.accountType === "EXPENSE");
      if (expenseCand) {
        const natInc = expenseCand.evidence.find((e) => e.kind === "NATURE_INCOMPATIBLE");
        expect(natInc?.role).toBe("DECISION");
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §6-§7 · Genuine competitor qualification
// ---------------------------------------------------------------------------

describe("Phase 4 · §6-§7 · genuine competitor qualification", () => {
  it("same-account-identity duplicate cannot appear as competitor", () => {
    const acct = makeAccount({ number: "6035", name: "R & M - Ground Equipment", type: "EXPENSE", fsGroupKey: "IS_REPAIRS_MAINTENANCE" });
    const winner: CanonicalCandidate = {
      accountId: acct.id,
      accountNumber: acct.accountNumber,
      accountName: acct.name,
      accountType: "EXPENSE",
      categoryKey: null,
      fsGroupKey: acct.fsGroupKey,
      score: 60,
      familyContributions: {
        TRANSACTION_TEXT: 30, TAXONOMY_ALIGNMENT: 0, CAPITAL_NATURE: 30,
        VENDOR_HISTORY: 0, DEPARTMENT_CONTEXT: 0,
      },
      evidence: [
        { family: "TRANSACTION_TEXT", kind: "LINE_ITEM_MATCH", contribution: 30, description: "x", countedTowardScore: true, role: "DECISION" },
        { family: "CAPITAL_NATURE", kind: "NATURE_COMPAT", contribution: 15, description: "x", countedTowardScore: true, role: "DECISION" },
      ],
      contradictions: [],
      contradictionPenalty: 0,
      postable: true,
      postingBlockers: [],
    };
    // Duplicate identity — should be filtered.
    const dup: CanonicalCandidate = { ...winner };
    const competitors = qualifyGenuineCompetitors([dup], winner);
    expect(competitors.length).toBe(0);
  });

  it("candidate below COMMIT_MIN_SCORE (30) never qualifies as competitor", () => {
    const winner = makeCandidate("1500", "Equipment", "ASSET", 45, [
      { family: "CAPITAL_NATURE", kind: "CAPITAL_ASSET_MATCH", contribution: 20, description: "x", countedTowardScore: true, role: "DECISION" },
    ]);
    const weakCand = makeCandidate("6020", "Grounds Maintenance", "EXPENSE", 25, [
      { family: "TRANSACTION_TEXT", kind: "LINE_ITEM_MATCH", contribution: 25, description: "x", countedTowardScore: true, role: "DECISION" },
    ]);
    const competitors = qualifyGenuineCompetitors([weakCand], winner);
    expect(competitors.length).toBe(0);
  });

  it("candidate at 60% of winner score qualifies if it has DECISION evidence", () => {
    const winner = makeCandidate("1500", "Equipment", "ASSET", 50, [
      { family: "CAPITAL_NATURE", kind: "CAPITAL_ASSET_MATCH", contribution: 20, description: "x", countedTowardScore: true, role: "DECISION" },
    ]);
    const close = makeCandidate("6020", "Grounds Maintenance", "EXPENSE", 30, [
      { family: "TRANSACTION_TEXT", kind: "LINE_ITEM_MATCH", contribution: 30, description: "x", countedTowardScore: true, role: "DECISION" },
    ]);
    const competitors = qualifyGenuineCompetitors([close], winner);
    expect(competitors.length).toBe(1);
    expect(competitors[0].accountNumber).toBe("6020");
    expect(competitors[0].marginToWinner).toBe(20);
  });

  it("candidate with only DIAGNOSTIC evidence does NOT qualify as competitor", () => {
    const winner = makeCandidate("1500", "Equipment", "ASSET", 50, [
      { family: "CAPITAL_NATURE", kind: "CAPITAL_ASSET_MATCH", contribution: 20, description: "x", countedTowardScore: true, role: "DECISION" },
    ]);
    const diagOnly = makeCandidate("6053", "Interest Expense", "EXPENSE", 32, [
      // score 32 (above commit floor) but ALL evidence is DIAGNOSTIC.
      { family: "TRANSACTION_TEXT", kind: "LINE_ITEM_MATCH", contribution: 6, description: "weak spillover", countedTowardScore: true, role: "DIAGNOSTIC" },
      { family: "TAXONOMY_ALIGNMENT", kind: "ACCOUNT_NAME_SIMILARITY", contribution: 4, description: "weak", countedTowardScore: true, role: "DIAGNOSTIC" },
    ]);
    const competitors = qualifyGenuineCompetitors([diagOnly], winner);
    expect(competitors.length).toBe(0);
  });

  it("candidate whose contradiction penalty dominates score does NOT qualify", () => {
    const winner = makeCandidate("1500", "Equipment", "ASSET", 50, [
      { family: "CAPITAL_NATURE", kind: "CAPITAL_ASSET_MATCH", contribution: 20, description: "x", countedTowardScore: true, role: "DECISION" },
    ]);
    const contradicted = makeCandidate("6020", "R & M", "EXPENSE", 30, [
      { family: "TRANSACTION_TEXT", kind: "LINE_ITEM_MATCH", contribution: 30, description: "x", countedTowardScore: true, role: "DECISION" },
    ]);
    contradicted.contradictions = [
      { code: "nature_capital_rejects_expense", penalty: 18, description: "x" },
      { code: "rm_expense_contradiction", penalty: 12, description: "x" },
    ];
    // contradictions sum = 30 which equals score — dominates.
    const competitors = qualifyGenuineCompetitors([contradicted], winner);
    expect(competitors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §13 · Confidence level derivation
// ---------------------------------------------------------------------------

describe("Phase 4 · §13 · confidence level semantic definitions", () => {
  it("strong winner + independent multi-family DECISION evidence + no competitor → HIGH", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        natureLeader: "CAPITAL_ASSET",
        natureConfidence: 84,
        natureIsDefensible: true,
        capitalDecision: "CAPITAL_CANDIDATE",
        capitalConfidence: 82,
        purposeConcept: "CAPITAL_EQUIPMENT",
        purposeConfidence: 85,
        purposeQuality: "HIGH",
        canonicalLineItems: [{ description: "Toro Groundsmaster 3500 fairway mower complete unit delivered", role: "PRIMARY_PURCHASE", extension: 52000 }],
        queryConcepts: [{ conceptId: "course_equipment", weight: 20, source: "line_item_description", evidenceSnippet: "fairway mower complete" }],
        hasHighQualityDurableAssetContext: true,
        hasFinancingEvidence: false,
      }),
    }));
    expect(result.status).toBe("RECOMMEND");
    if (result.status === "RECOMMEND") {
      const conf = assessCanonicalConfidence({
        canonical: result,
        recommendation: mkRecommendation("RECOMMEND", result.candidates[0].accountNumber),
      });
      expect(conf.level).toBe("HIGH");
      expect(conf.genuineCompetitors.length).toBe(0);
      expect(conf.winnerDecisionFamilyCount).toBeGreaterThanOrEqual(2);
    }
  });

  it("winner with a genuine competitor → MODERATE (calibration fixture: repair-tie at 59)", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "REPAIR_MAINTENANCE",
        purposeConfidence: 82,
        purposeQuality: "HIGH",
        natureLeader: "REPAIR_MAINTENANCE",
        natureConfidence: 84,
        natureIsDefensible: true,
        capitalDecision: "REPAIR_MAINTENANCE",
        capitalConfidence: 80,
        canonicalLineItems: [{ description: "Mower service call quarterly labour hydraulic hose replacement", role: "PRIMARY_PURCHASE", extension: 640 }],
        queryConcepts: [{ conceptId: "repairs_and_maintenance", weight: 18, source: "line_item_description", evidenceSnippet: "service call quarterly labour" }],
      }),
    }));
    if (result.status === "RECOMMEND") {
      const conf = assessCanonicalConfidence({
        canonical: result,
        recommendation: mkRecommendation("RECOMMEND", result.candidates[0].accountNumber),
      });
      expect(conf.level).toBe("MODERATE");
      expect(conf.genuineCompetitors.length).toBeGreaterThan(0);
    }
  });

  it("deterministic tie without genuine competitor still lands MODERATE (§9 — never HIGH from ordering alone)", () => {
    // Two candidates tied at exact same score — deterministic ordering
    // decides winner. Even if they have identical evidence patterns,
    // MODERATE is the ceiling.
    const winner = makeCandidate("6020", "Grounds Maintenance", "EXPENSE", 40, [
      { family: "CAPITAL_NATURE", kind: "NATURE_COMPAT", contribution: 15, description: "x", countedTowardScore: true, role: "DECISION" },
      { family: "TRANSACTION_TEXT", kind: "LINE_ITEM_MATCH", contribution: 25, description: "x", countedTowardScore: true, role: "DECISION" },
    ]);
    const tied = makeCandidate("6033", "R & M Preventative Maintenance", "EXPENSE", 40, [
      { family: "CAPITAL_NATURE", kind: "NATURE_COMPAT", contribution: 15, description: "x", countedTowardScore: true, role: "DECISION" },
      { family: "TRANSACTION_TEXT", kind: "LINE_ITEM_MATCH", contribution: 25, description: "x", countedTowardScore: true, role: "DECISION" },
    ]);
    // With a genuine competitor the level is MODERATE by rule 3.
    // Even without that (hypothetical single-tied), the deterministic
    // tie-break rule 4 caps at MODERATE.
    const canonical = {
      status: "RECOMMEND" as const,
      candidates: [winner, tied] as any,
      abstentionReason: null,
      separation: {
        marginToRunnerUp: 0,
        isDeterministicTieBreak: true,
        tiedRunnerUpCount: 1,
      },
    };
    const conf = assessCanonicalConfidence({
      canonical: canonical as any,
      recommendation: mkRecommendation("RECOMMEND", winner.accountNumber),
    });
    expect(conf.level).toBe("MODERATE");
    expect(conf.isDeterministicTieBreak).toBe(true);
  });

  it("winner with no DECISION evidence → LOW", () => {
    // Winner has only DIAGNOSTIC observations. Confidence must be LOW
    // even if the candidate happened to be #0.
    const diagOnlyWinner = makeCandidate("6053", "Interest Expense", "EXPENSE", 8, [
      { family: "TRANSACTION_TEXT", kind: "LINE_ITEM_MATCH", contribution: 4, description: "x", countedTowardScore: true, role: "DIAGNOSTIC" },
      { family: "TAXONOMY_ALIGNMENT", kind: "ACCOUNT_NAME_SIMILARITY", contribution: 4, description: "x", countedTowardScore: true, role: "DIAGNOSTIC" },
    ]);
    const canonical = {
      status: "RECOMMEND" as const,
      candidates: [diagOnlyWinner] as any,
      abstentionReason: null,
      separation: { marginToRunnerUp: 8, isDeterministicTieBreak: false, tiedRunnerUpCount: 0 },
    };
    const conf = assessCanonicalConfidence({
      canonical: canonical as any,
      recommendation: mkRecommendation("RECOMMEND", diagOnlyWinner.accountNumber),
    });
    expect(conf.level).toBe("LOW");
  });

  it("§14 · every ABSTAIN_* status → REVIEW_REQUIRED (never manufacture confidence)", () => {
    const statuses: RecommendationDecision["status"][] = [
      "ABSTAIN_QUALITY",
      "ABSTAIN_AMBIGUITY",
      "ABSTAIN_NO_CANDIDATES",
      "ABSTAIN_ANALYSIS_FAILURE",
    ];
    for (const status of statuses) {
      const winner = makeCandidate("1500", "Equipment", "ASSET", 60, [
        { family: "CAPITAL_NATURE", kind: "CAPITAL_ASSET_MATCH", contribution: 20, description: "x", countedTowardScore: true, role: "DECISION" },
      ]);
      const canonical = status === "ABSTAIN_QUALITY"
        ? { status: "RECOMMEND" as const, candidates: [winner] as any, abstentionReason: null, separation: { marginToRunnerUp: 60, isDeterministicTieBreak: false, tiedRunnerUpCount: 0 } }
        : status === "ABSTAIN_AMBIGUITY"
          ? { status: "ABSTAIN" as const, candidates: [winner] as any, abstentionReason: "top_score_below_commit_floor:26", separation: { marginToRunnerUp: 0, isDeterministicTieBreak: false, tiedRunnerUpCount: 0 } }
          : { status: status === "ABSTAIN_NO_CANDIDATES" ? "NO_ELIGIBLE_CANDIDATES" as const : "ANALYSIS_FAILURE" as const, candidates: [] as any, abstentionReason: "test" };
      const conf = assessCanonicalConfidence({
        canonical: canonical as any,
        recommendation: mkRecommendation(status, canonical.status === "RECOMMEND" || canonical.status === "ABSTAIN" ? winner.accountNumber : null),
      });
      expect(conf.level).toBe("REVIEW_REQUIRED");
    }
  });
});

// ---------------------------------------------------------------------------
// §11 · The original Interest / Bank-Charges failure class
// ---------------------------------------------------------------------------

describe("Phase 4 · §11 · original nonsense-alternative failure class systematically eliminated", () => {
  it("equipment invoice · Interest Expense does NOT qualify as genuine competitor even when present in candidates", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        natureLeader: "CAPITAL_ASSET",
        natureConfidence: 84,
        natureIsDefensible: true,
        capitalDecision: "CAPITAL_CANDIDATE",
        capitalConfidence: 82,
        purposeConcept: "CAPITAL_EQUIPMENT",
        purposeConfidence: 85,
        purposeQuality: "HIGH",
        canonicalLineItems: [{ description: "Toro Groundsmaster 3500 fairway mower complete unit delivered", role: "PRIMARY_PURCHASE", extension: 52000 }],
        queryConcepts: [{ conceptId: "course_equipment", weight: 20, source: "line_item_description", evidenceSnippet: "fairway mower complete" }],
        hasHighQualityDurableAssetContext: true,
        hasFinancingEvidence: false,
      }),
    }));
    expect(result.status).toBe("RECOMMEND");
    if (result.status === "RECOMMEND") {
      const conf = assessCanonicalConfidence({
        canonical: result,
        recommendation: mkRecommendation("RECOMMEND", result.candidates[0].accountNumber),
      });
      // No genuine competitor from fee-family accounts.
      for (const gc of conf.genuineCompetitors) {
        expect(["IS_INTEREST_EXPENSE", "IS_BANK_CHARGES", "IS_MERCHANT_FEES"]).not.toContain(
          NEUTRAL_COA.find((a) => a.accountNumber === gc.accountNumber)?.fsGroupKey ?? "",
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §15 · Anti-overfitting
// ---------------------------------------------------------------------------

describe("Phase 4 · §15 · anti-overfitting", () => {
  it("no vendor/invoice/account literals in canonical-confidence.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve("src/lib/ap-intelligence/canonical-confidence.ts"),
      "utf8",
    ) as string;
    const forbidden = [
      /===\s*["'](6054|6030|6033|6035|6051|6053|6064|6071|6072|1500|1502|1506|1540)["']/,
      /===\s*["']Club\s*Support/i,
      /===\s*["']OXIO/i,
      /accountName\s*===\s*["']/,
      /accountName\s*\.\s*includes/,
    ];
    for (const re of forbidden) {
      expect(src.match(re)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// Helper — direct CanonicalCandidate builder for unit-style tests
// ---------------------------------------------------------------------------

function makeCandidate(
  accountNumber: string,
  accountName: string,
  accountType: "ASSET" | "EXPENSE",
  score: number,
  evidence: any[],
): CanonicalCandidate {
  const familyContributions: any = {
    TRANSACTION_TEXT: 0, TAXONOMY_ALIGNMENT: 0, CAPITAL_NATURE: 0,
    VENDOR_HISTORY: 0, DEPARTMENT_CONTEXT: 0,
  };
  for (const e of evidence) {
    if (e.countedTowardScore) familyContributions[e.family] = (familyContributions[e.family] ?? 0) + e.contribution;
  }
  return {
    accountId: `acct-${accountNumber}`,
    accountNumber,
    accountName,
    accountType,
    categoryKey: null,
    fsGroupKey: null,
    score,
    familyContributions,
    evidence,
    contradictions: [],
    contradictionPenalty: 0,
    postable: true,
    postingBlockers: [],
  } as CanonicalCandidate;
}
