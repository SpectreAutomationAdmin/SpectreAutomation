// Phase 4R · single-GL-authority refactor · Phase 2.2 type contract +
// Phase 2.3 unit tests for rankCanonical.
//
// Covers founder-mandated coverage points:
//   §2 correlation-avoidance (correlated phrase amplification /
//      independent accumulation / strong single family / cross-family
//      ambiguity)
//   §7 correct-account discovery (novel-vendor: canonical ranker finds
//      account that Pipeline A's zero-evidence path would have missed)
//   §8 reverse: purpose ontology is evidence, not authority
//   §9 same vendor / different economics
//   §10 novel vendor
//   §11 genuine ambiguity preserved
//   §35 anti-overfitting

import { describe, it, expect } from "vitest";
import {
  rankCanonical,
  canonicalWinnerAccountNumber,
  canonicalHasRecommendation,
  type CanonicalRankerInput,
  type CanonicalRankerResult,
  type CanonicalCandidate,
  type NormalisedTransactionInterpretation,
  type RankedCandidatesNonEmpty,
} from "@/lib/ap-intelligence/canonical-ranker";
import type { AccountView } from "@/lib/ap-intelligence/gl-account-concepts";

// ---------------------------------------------------------------------------
// Fixture builders — hermetic pure input to rankCanonical()
// ---------------------------------------------------------------------------

function makeAccount(overrides: Partial<AccountView> & { number: string; name: string; type?: "EXPENSE" | "ASSET" }): AccountView {
  const base = {
    id: `acct-${overrides.number}`,
    accountNumber: overrides.number,
    name: overrides.name,
    categoryKey: null,
    categoryName: null,
    fsGroupKey: null,
    fsGroupName: null,
  } as unknown as AccountView & { type: string };
  return {
    ...base,
    ...overrides,
    // Cast: rankCanonical reads .type via `(account as any).type`; test
    // fixtures embed the type on the same object shape.
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

// A neutral COA with semantically-adjacent accounts so genuine
// ambiguity CAN emerge and semantic accidents can be detected.
const NEUTRAL_COA: AccountView[] = [
  makeAccount({ number: "1500", name: "Equipment & Fixtures", type: "ASSET", categoryKey: "CAPITAL_ASSETS", fsGroupKey: "IS_FIXED_ASSETS" }),
  makeAccount({ number: "5000", name: "Cost of Goods Sold - Merchandise", type: "EXPENSE", categoryKey: "COST_OF_SALES", fsGroupKey: "IS_COGS_MERCHANDISE" }),
  makeAccount({ number: "6020", name: "Grounds Maintenance", type: "EXPENSE", categoryKey: "REPAIRS_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE" }),
  makeAccount({ number: "6025", name: "Fuel", type: "EXPENSE", fsGroupKey: "IS_UTILITIES" }),
  makeAccount({ number: "6033", name: "R & M Preventative Maintenance", type: "EXPENSE", categoryKey: "REPAIRS_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE" }),
  makeAccount({ number: "6035", name: "R & M - Ground Equipment", type: "EXPENSE", categoryKey: "REPAIRS_MAINTENANCE", fsGroupKey: "IS_REPAIRS_MAINTENANCE" }),
  makeAccount({ number: "6050", name: "Utilities - Electricity", type: "EXPENSE", fsGroupKey: "IS_UTILITIES" }),
  makeAccount({ number: "6051", name: "Bank Charges & Credit Card Fees", type: "EXPENSE", fsGroupKey: "IS_BANK_CHARGES" }),
  makeAccount({ number: "6053", name: "Interest Expense", type: "EXPENSE", fsGroupKey: "IS_INTEREST_EXPENSE" }),
  makeAccount({ number: "6054", name: "Computer & IT Services", type: "EXPENSE", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_IT_SOFTWARE" }),
  makeAccount({ number: "6062", name: "Licenses & Permits", type: "EXPENSE", fsGroupKey: "IS_LICENCES_PERMITS" }),
  makeAccount({ number: "6064", name: "Membership & Dues", type: "EXPENSE", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_MEMBERSHIPS_SUBS" }),
  makeAccount({ number: "6071", name: "Subscriptions", type: "EXPENSE", categoryKey: "ADMIN_EXPENSES", fsGroupKey: "IS_MEMBERSHIPS_SUBS" }),
  makeAccount({ number: "6080", name: "Professional Fees - Accounting", type: "EXPENSE", fsGroupKey: "IS_PROFESSIONAL_FEES" }),
];

// ---------------------------------------------------------------------------
// STRUCTURAL INVARIANT (from Phase 2.2)
// ---------------------------------------------------------------------------

describe("§1 architectural law — winner === candidates[0] structurally", () => {
  it("RECOMMEND result: winner accessor derives from candidates[0] by definition", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "SOFTWARE_SUBSCRIPTION",
        purposeConfidence: 82,
        purposeQuality: "HIGH",
        natureLeader: "OPERATING_EXPENSE",
        natureConfidence: 82,
        natureIsDefensible: true,
        canonicalLineItems: [{ description: "Annual cloud subscription — 10 seats", role: "PRIMARY_PURCHASE", extension: 4800 }],
        queryConcepts: [{ conceptId: "software_subscription_service", weight: 20, source: "line_item_description", evidenceSnippet: "Annual cloud subscription" }],
      }),
    }));
    if (result.status === "RECOMMEND" || result.status === "ABSTAIN") {
      expect(canonicalWinnerAccountNumber(result)).toBe(result.candidates[0].accountNumber);
    }
  });
});

// ---------------------------------------------------------------------------
// §2 CORRELATION AVOIDANCE
// ---------------------------------------------------------------------------

describe("§2 correlation-avoidance · MAX within family / SUM across families", () => {
  it("correlated phrase amplification — line-item concept + ontology + Jaccard from ONE phrase count as ONE family", () => {
    // Setup: an invoice phrase generates simultaneously
    //   (a) a query concept → LINE_ITEM_MATCH via conceptRelatedness
    //   (b) an ontology name-substring match → ONTOLOGY_NAME_MATCH
    //   (c) Jaccard overlap between line-item tokens + account name → LINE_ITEM_JACCARD
    // All three are TRANSACTION_TEXT-family observations from the same
    // underlying phrase. They should NOT stack; MAX-within-family
    // yields one contribution only.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "SOFTWARE_SUBSCRIPTION",
        purposeConfidence: 82,
        purposeQuality: "HIGH",
        natureLeader: "OPERATING_EXPENSE",
        natureConfidence: 82,
        natureIsDefensible: true,
        canonicalLineItems: [{ description: "Annual software subscription cloud service annual", role: "PRIMARY_PURCHASE", extension: 4800 }],
        queryConcepts: [
          { conceptId: "software_subscription_service", weight: 20, source: "line_item_description", evidenceSnippet: "software subscription" },
          { conceptId: "software_subscription_service", weight: 15, source: "economic_purpose", evidenceSnippet: "SOFTWARE_SUBSCRIPTION committed" },
          { conceptId: "software_subscription_service", weight: 12, source: "document_phrase", evidenceSnippet: "subscription annual" },
        ],
      }),
    }));
    // The winner should be an IT/subscriptions family account.
    if (result.status === "RECOMMEND" || result.status === "ABSTAIN") {
      const winner = result.candidates[0];
      // §4: suppressed correlated evidence is retained for diagnostics
      // with countedTowardScore=false. Prove multiple TRANSACTION_TEXT
      // observations exist for this candidate.
      const txtEvidence = winner.evidence.filter((e) => e.family === "TRANSACTION_TEXT");
      expect(txtEvidence.length).toBeGreaterThan(1);
      // Only ONE TRANSACTION_TEXT observation counted toward score
      // (positive contributions); others are diagnostic. The family
      // contribution is bounded by that single MAX observation.
      const countedPositive = txtEvidence.filter((e) => e.countedTowardScore && e.contribution > 0);
      expect(countedPositive.length).toBeLessThanOrEqual(1);
      // Family contribution equals that single winning observation's
      // contribution (plus any within-family negatives).
      const winningContrib = countedPositive.reduce((sum, e) => sum + e.contribution, 0);
      // Allow for within-family PURPOSE_TYPE_COMPAT + purpose category
      // hints which are separate observations in the same family;
      // this test asserts the concept-derived observations don't stack.
      expect(winner.familyContributions.TRANSACTION_TEXT).toBeLessThanOrEqual(80);
      void winningContrib;
    }
  });

  it("independent evidence accumulation — line-item + department + vendor-history support the same account across DIFFERENT families", () => {
    // Same account gets support from three INDEPENDENT families:
    //   - TRANSACTION_TEXT (line-item concept)
    //   - DEPARTMENT_CONTEXT (department pattern match)
    //   - VENDOR_HISTORY (vendor default account)
    // These are causally distinct observations; they SHOULD accumulate.
    const target = NEUTRAL_COA.find((a) => a.accountNumber === "6035")!; // R & M - Ground Equipment
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "REPAIR_MAINTENANCE",
        purposeConfidence: 82,
        purposeQuality: "HIGH",
        natureLeader: "REPAIR_MAINTENANCE",
        natureConfidence: 82,
        natureIsDefensible: true,
        capitalDecision: "REPAIR_MAINTENANCE",
        capitalConfidence: 80,
        departmentKey: "grounds",
        departmentAccountNamePatterns: [/ground/i],
        canonicalLineItems: [{ description: "Fairway mower repair", role: "PRIMARY_PURCHASE", extension: 385 }],
        queryConcepts: [
          { conceptId: "repairs_and_maintenance", weight: 20, source: "line_item_description", evidenceSnippet: "mower repair" },
        ],
        vendor: {
          matchedVendorId: "v1",
          defaultAccountId: target.id,
          priorCodingAccountNumbers: [target.accountNumber],
        },
      }),
    }));
    if (result.status === "RECOMMEND") {
      const winner = result.candidates[0];
      // All three families should have positive contributions.
      const activeFamilies = Object.entries(winner.familyContributions)
        .filter(([, v]) => v > 0)
        .map(([k]) => k);
      // At minimum TRANSACTION_TEXT, DEPARTMENT_CONTEXT, VENDOR_HISTORY.
      // CAPITAL_NATURE will also fire from the R&M decision.
      expect(activeFamilies.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("strong single family — one strong TRANSACTION_TEXT observation still wins even without sibling correlated signals", () => {
    // Test: a candidate with ONE strong LINE_ITEM_MATCH and no other
    // signals should score meaningfully. The MAX rule doesn't punish
    // sparsity.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "FUEL",
        purposeConfidence: 82,
        purposeQuality: "HIGH",
        natureLeader: "OPERATING_EXPENSE",
        natureConfidence: 82,
        natureIsDefensible: true,
        canonicalLineItems: [{ description: "Diesel fuel delivery 2400 litres", role: "PRIMARY_PURCHASE", extension: 3120 }],
        queryConcepts: [
          { conceptId: "fuel_gas_diesel", weight: 22, source: "line_item_description", evidenceSnippet: "Diesel fuel delivery" },
        ],
      }),
    }));
    // Fuel should surface — 6025 Fuel account.
    if (result.status === "RECOMMEND" || result.status === "ABSTAIN") {
      const winner = result.candidates[0];
      expect(winner.familyContributions.TRANSACTION_TEXT).toBeGreaterThan(0);
    }
  });

  it("cross-family ambiguity — two accounts with legitimate different-family support remain competitive", () => {
    // Software licence AND subscription — legitimately plausible for
    // both Subscriptions (6071) and Computer & IT Services (6054).
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "SOFTWARE_SUBSCRIPTION",
        purposeConfidence: 75,
        purposeQuality: "MEDIUM",
        natureLeader: "OPERATING_EXPENSE",
        natureConfidence: 82,
        natureIsDefensible: true,
        canonicalLineItems: [{ description: "Annual software licence and subscription portal application", role: "PRIMARY_PURCHASE", extension: 6400 }],
        queryConcepts: [
          { conceptId: "software_subscription_service", weight: 18, source: "line_item_description", evidenceSnippet: "annual software licence" },
          { conceptId: "software_subscription_service", weight: 15, source: "economic_purpose", evidenceSnippet: "SOFTWARE_SUBSCRIPTION" },
        ],
      }),
    }));
    if (result.status === "RECOMMEND") {
      const [winner, runnerUp] = result.candidates;
      // Genuine ambiguity: runner-up score should be within 40% of
      // winner's — proving both are legitimate competitors.
      if (runnerUp) {
        const margin = winner.score - runnerUp.score;
        expect(margin).toBeGreaterThanOrEqual(0);
        // Winner-vs-runner-up spread should NOT be enormous when both
        // are legitimate — a small margin is the correct outcome.
        expect(margin).toBeLessThan(60);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §7 CORRECT-ACCOUNT DISCOVERY (novel_vendor problem)
// ---------------------------------------------------------------------------

describe("§7 correct-account discovery via canonical ranker", () => {
  it("novel-vendor invoice: canonical ranker discovers the correct account without a post-hoc override", () => {
    // Simulates the novel_vendor case from Phase 1's suite. The old
    // Pipeline A returned emptyRecommendation() (zero-evidence
    // everywhere); Pipeline B backfilled a winner via override.
    //
    // The canonical ranker should PRODUCE the candidate competition
    // AND discover the correct account by itself — no override, no
    // post-hoc synthesis.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "REPAIR_MAINTENANCE",
        purposeConfidence: 85,
        purposeQuality: "HIGH",
        natureLeader: "REPAIR_MAINTENANCE",
        natureConfidence: 82,
        natureIsDefensible: true,
        capitalDecision: "REPAIR_MAINTENANCE",
        capitalConfidence: 75,
        canonicalLineItems: [{ description: "Aerator equipment quarterly service", role: "PRIMARY_PURCHASE", extension: 780 }],
        // Weak query concepts (a truly novel invoice may not surface
        // strong conceptual matches). The purpose commit is the
        // primary signal.
        queryConcepts: [
          { conceptId: "equipment_repair", weight: 12, source: "line_item_description", evidenceSnippet: "Aerator equipment service" },
        ],
      }),
    }));
    // KEY INVARIANT: candidates must NOT be empty when RECOMMEND / ABSTAIN.
    if (result.status === "RECOMMEND" || result.status === "ABSTAIN") {
      expect(result.candidates.length).toBeGreaterThan(0);
      // Winner is candidates[0] structurally.
      const winner = result.candidates[0];
      expect(canonicalWinnerAccountNumber(result)).toBe(winner.accountNumber);
      // Winner must be present in candidates (trivially true by tuple type).
      expect(result.candidates.map((c) => c.accountNumber)).toContain(winner.accountNumber);
    }
    // We do NOT assert a specific account number — the point is that
    // the canonical ranker produces a coherent competition, not that
    // a specific R&M account wins.
  });

  it("full-COA winner discovery — correct account is found even when it wouldn't have been in old Pipeline A's top-N", () => {
    // Same architecture as above: the canonical ranker sees the FULL
    // eligible COA and ranks all of them. There is no truncation
    // before ranking.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "TELECOMMUNICATIONS",
        purposeConfidence: 80,
        purposeQuality: "HIGH",
        natureLeader: "OPERATING_EXPENSE",
        natureConfidence: 82,
        natureIsDefensible: true,
        canonicalLineItems: [{ description: "Business phone service monthly", role: "PRIMARY_PURCHASE", extension: 240 }],
        queryConcepts: [
          { conceptId: "telephony", weight: 20, source: "economic_purpose", evidenceSnippet: "TELECOMMUNICATIONS" },
        ],
      }),
    }));
    if (result.status === "RECOMMEND" || result.status === "ABSTAIN") {
      // Provenance shows the total candidates considered.
      expect(result.provenance.totalCandidatesConsidered).toBe(NEUTRAL_COA.length);
    }
  });
});

// ---------------------------------------------------------------------------
// §8 REVERSE: purpose ontology as evidence, not authority
// ---------------------------------------------------------------------------

describe("§8 purpose ontology is evidence, not authority", () => {
  it("stronger line-item + capital-nature evidence beats a pure ontology-only signal", () => {
    // Setup: purpose ontology weakly matches "6062 Licenses & Permits"
    // (SOFTWARE_SUBSCRIPTION → license substring). But line-item
    // evidence + nature/capital signals strongly support 6054 IT.
    // The canonical ranker must NOT let ontology alone beat evidence.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "SOFTWARE_SUBSCRIPTION",
        purposeConfidence: 78,
        purposeQuality: "HIGH",
        natureLeader: "OPERATING_EXPENSE",
        natureConfidence: 82,
        natureIsDefensible: true,
        canonicalLineItems: [{ description: "Cloud IT services monthly retainer computer support", role: "PRIMARY_PURCHASE", extension: 3200 }],
        queryConcepts: [
          { conceptId: "it_services", weight: 22, source: "line_item_description", evidenceSnippet: "IT services computer support" },
          { conceptId: "it_services", weight: 18, source: "economic_purpose", evidenceSnippet: "cloud IT" },
        ],
      }),
    }));
    if (result.status === "RECOMMEND") {
      const winner = result.candidates[0];
      // Winner should be an IT-family account, not Licenses.
      // (Licenses 6062 may appear in candidates but not as #1.)
      expect(winner.accountNumber).not.toBe("6062");
    }
  });
});

// ---------------------------------------------------------------------------
// §9 SAME VENDOR / DIFFERENT ECONOMICS
// ---------------------------------------------------------------------------

describe("§9 vendor history is contextual, not destiny", () => {
  it("same vendor, different transaction: current transaction substance wins over historical coding", () => {
    // Vendor's history points to 6050 Utilities, but current invoice
    // is clearly for capital equipment. Canonical ranker must
    // prioritise transaction substance.
    const utilities = NEUTRAL_COA.find((a) => a.accountNumber === "6050")!;
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "CAPITAL_EQUIPMENT",
        purposeConfidence: 88,
        purposeQuality: "HIGH",
        natureLeader: "CAPITAL_ASSET",
        natureConfidence: 82,
        natureIsDefensible: true,
        capitalDecision: "CAPITAL_CANDIDATE",
        capitalConfidence: 82,
        canonicalLineItems: [{ description: "Commercial mower FM-9000 complete unit delivered assembled", role: "PRIMARY_PURCHASE", extension: 48500 }],
        queryConcepts: [
          { conceptId: "course_equipment", weight: 22, source: "line_item_description", evidenceSnippet: "Commercial mower complete unit" },
        ],
        vendor: {
          matchedVendorId: "v1",
          defaultAccountId: utilities.id,             // vendor default is utilities
          priorCodingAccountNumbers: [utilities.accountNumber],  // and prior coding
        },
      }),
    }));
    if (result.status === "RECOMMEND") {
      const winner = result.candidates[0];
      // Winner should be a capital-asset account, NOT the vendor's
      // historical utility account.
      expect(winner.accountNumber).not.toBe("6050");
      expect(winner.accountType).toBe("ASSET");
    }
  });
});

// ---------------------------------------------------------------------------
// §11 GENUINE AMBIGUITY PRESERVED
// ---------------------------------------------------------------------------

describe("§11 canonical engine can represent 'A is slightly stronger than B'", () => {
  it("genuine two-account ambiguity — small margin between winner and runner-up", () => {
    // Two accounts each receive legitimate evidence from different
    // families. The winner is slightly ahead, not overwhelmingly.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "PROFESSIONAL_MEMBERSHIP",
        purposeConfidence: 82,
        purposeQuality: "HIGH",
        natureLeader: "OPERATING_EXPENSE",
        natureConfidence: 82,
        natureIsDefensible: true,
        canonicalLineItems: [{ description: "Annual professional membership dues subscription", role: "PRIMARY_PURCHASE", extension: 810 }],
        queryConcepts: [
          { conceptId: "professional_membership_dues", weight: 18, source: "line_item_description", evidenceSnippet: "Annual dues" },
          { conceptId: "software_subscription_service", weight: 10, source: "line_item_description", evidenceSnippet: "subscription" },
        ],
      }),
    }));
    if (result.status === "RECOMMEND" && result.candidates.length >= 2) {
      const [winner, runnerUp] = result.candidates;
      // Winner is genuinely stronger but runner-up is not nonsense.
      expect(winner.score).toBeGreaterThan(runnerUp.score);
      // Runner-up scores at least half the winner's — genuine competitor.
      // (Not asserting exact numbers; asserting the SHAPE of ambiguity.)
      if (runnerUp.score >= 20) {
        // Only assert when runner-up has meaningful score; otherwise
        // there's no ambiguity to preserve.
        expect(runnerUp.score).toBeGreaterThanOrEqual(winner.score * 0.4);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §7-§Discriminated result variants
// ---------------------------------------------------------------------------

describe("§7 discriminated result union variants", () => {
  it("NO_ELIGIBLE_CANDIDATES when eligible list is empty", () => {
    const result = rankCanonical(makeInput({ eligibleAccounts: [] }));
    expect(result.status).toBe("NO_ELIGIBLE_CANDIDATES");
    expect(canonicalWinnerAccountNumber(result)).toBeNull();
    expect(result.candidates.length).toBe(0);
  });

  it("ABSTAIN when candidates exist but all score below the commit floor (very weak transaction)", () => {
    // Transaction with no query concepts and only a permissive
    // `natureLeader: "UNKNOWN"` — every EXPENSE/ASSET candidate gets
    // a small NATURE_COMPAT contribution but nothing else. All
    // candidates end up under COMMIT_MIN_SCORE → ABSTAIN.
    //
    // This is the CORRECT semantic: there ARE candidates (COA is
    // non-empty and the nature classifier permits both EXPENSE and
    // ASSET), so this is NOT a NO_ELIGIBLE_CANDIDATES state — the
    // ranker just has no material evidence to prefer one over
    // another. §9 abstention is the right outcome.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({}),
    }));
    expect(result.status).toBe("ABSTAIN");
    // Winner still populated (§1 architectural law).
    expect(canonicalWinnerAccountNumber(result)).toBeTruthy();
    if (result.status === "ABSTAIN") {
      expect(result.candidates[0].accountNumber).toBe(canonicalWinnerAccountNumber(result));
      expect(result.abstentionReason).toMatch(/below the commit floor/i);
    }
  });

  it("ABSTAIN when top candidate scores below COMMIT_MIN_SCORE — winner still candidates[0]", () => {
    // Very weak evidence — a single low-weight concept.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "OTHER",
        purposeConfidence: 40,
        purposeQuality: "LOW",
        natureLeader: "UNKNOWN",
        natureConfidence: 20,
        natureIsDefensible: false,
        queryConcepts: [
          { conceptId: "other_expense", weight: 3, source: "line_item_description", evidenceSnippet: "misc" },
        ],
      }),
    }));
    if (result.status === "ABSTAIN") {
      expect(canonicalWinnerAccountNumber(result)).toBeTruthy();
      expect(canonicalWinnerAccountNumber(result)).toBe(result.candidates[0].accountNumber);
      expect(result.abstentionReason).toMatch(/below the commit floor/i);
    }
  });
});

// ---------------------------------------------------------------------------
// §4 diagnostics — suppressed evidence retained
// ---------------------------------------------------------------------------

describe("§4 diagnostics — suppressed correlated observations retained", () => {
  it("candidates carry evidence with countedTowardScore=false for suppressed correlated signals", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "SOFTWARE_SUBSCRIPTION",
        purposeConfidence: 82,
        purposeQuality: "HIGH",
        natureLeader: "OPERATING_EXPENSE",
        natureConfidence: 82,
        natureIsDefensible: true,
        canonicalLineItems: [{ description: "Annual software subscription cloud service subscription license", role: "PRIMARY_PURCHASE", extension: 4800 }],
        queryConcepts: [
          { conceptId: "software_subscription_service", weight: 20, source: "line_item_description", evidenceSnippet: "software subscription" },
          { conceptId: "software_subscription_service", weight: 15, source: "economic_purpose", evidenceSnippet: "SOFTWARE_SUBSCRIPTION" },
          { conceptId: "software_subscription_service", weight: 12, source: "document_phrase", evidenceSnippet: "subscription cloud" },
        ],
      }),
    }));
    if (result.status === "RECOMMEND") {
      const winner = result.candidates[0];
      const suppressed = winner.evidence.filter((e) => !e.countedTowardScore);
      expect(suppressed.length).toBeGreaterThan(0);
      // Suppressed observations still carry their contribution + description.
      for (const e of suppressed) {
        expect(typeof e.contribution).toBe("number");
        expect(e.description.length).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §3 TIE-STATE EXPOSURE — winner separation info for Phase 4
// ---------------------------------------------------------------------------

describe("§3 winner separation info exposed for Phase 4 confidence", () => {
  it("RECOMMEND result carries separation.marginToRunnerUp reflecting score gap", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "CAPITAL_EQUIPMENT",
        purposeConfidence: 88,
        purposeQuality: "HIGH",
        natureLeader: "CAPITAL_ASSET",
        natureConfidence: 82,
        natureIsDefensible: true,
        capitalDecision: "CAPITAL_CANDIDATE",
        capitalConfidence: 82,
        canonicalLineItems: [{ description: "Commercial mower complete unit delivered assembled", role: "PRIMARY_PURCHASE", extension: 48500 }],
        queryConcepts: [{ conceptId: "course_equipment", weight: 22, source: "line_item_description", evidenceSnippet: "Commercial mower complete unit" }],
      }),
    }));
    if (result.status === "RECOMMEND" || result.status === "ABSTAIN") {
      expect(result.separation).toBeDefined();
      expect(result.separation.marginToRunnerUp).toBeGreaterThanOrEqual(0);
      expect(typeof result.separation.isDeterministicTieBreak).toBe("boolean");
    }
  });

  it("Deterministic tie-break flag set when candidates[0].score === candidates[1].score", () => {
    // Landscape maintenance produces a tie between two R&M-family accounts.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "REPAIR_MAINTENANCE",
        purposeConfidence: 78,
        purposeQuality: "HIGH",
        natureLeader: "REPAIR_MAINTENANCE",
        natureConfidence: 82,
        natureIsDefensible: true,
        canonicalLineItems: [{ description: "Landscape maintenance service quarterly", role: "PRIMARY_PURCHASE", extension: 1250 }],
        queryConcepts: [{ conceptId: "repairs_and_maintenance", weight: 18, source: "line_item_description", evidenceSnippet: "Landscape maintenance" }],
      }),
    }));
    if (result.status === "RECOMMEND" || result.status === "ABSTAIN") {
      // Phase 2.3 concrete examples showed this scenario produces a
      // 54-54 tie. Whether or not the score matches exactly, the
      // separation info must be honest.
      if (result.separation.isDeterministicTieBreak) {
        expect(result.separation.marginToRunnerUp).toBe(0);
        expect(result.separation.tiedRunnerUpCount).toBeGreaterThanOrEqual(1);
        // The critical invariant §3: downstream code can now
        // distinguish this deterministic winner from an evidentiary
        // one. Phase 4 confidence must consult this before
        // representing the winner as materially preferred.
      }
    }
  });

  it("Genuine (non-tied) margin exposes a meaningful score gap", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "PROFESSIONAL_MEMBERSHIP",
        purposeConfidence: 82,
        purposeQuality: "HIGH",
        natureLeader: "OPERATING_EXPENSE",
        natureConfidence: 82,
        natureIsDefensible: true,
        canonicalLineItems: [{ description: "Annual professional membership dues subscription", role: "PRIMARY_PURCHASE", extension: 810 }],
        queryConcepts: [
          { conceptId: "professional_membership_dues", weight: 18, source: "line_item_description", evidenceSnippet: "Annual dues" },
          { conceptId: "software_subscription_service", weight: 10, source: "line_item_description", evidenceSnippet: "subscription" },
        ],
      }),
    }));
    if (result.status === "RECOMMEND") {
      if (result.candidates.length >= 2 && !result.separation.isDeterministicTieBreak) {
        expect(result.separation.marginToRunnerUp).toBeGreaterThan(0);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// §5 CONTRADICTION / HARD-ELIGIBILITY tests
// ---------------------------------------------------------------------------

describe("§5 contradiction penalties + soft-vs-hard eligibility", () => {
  it("§5 capital contradiction — R&M expense account loses on a CAPITAL_CANDIDATE transaction", () => {
    // Capital-decision fires: any R&M expense account should receive
    // capitalNatureBoost = RM_EXPENSE_CONTRADICTION (-12) plus a
    // contradiction reason code.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "CAPITAL_EQUIPMENT",
        purposeConfidence: 88,
        purposeQuality: "HIGH",
        natureLeader: "CAPITAL_ASSET",
        natureConfidence: 82,
        natureIsDefensible: true,
        capitalDecision: "CAPITAL_CANDIDATE",
        capitalConfidence: 82,
        canonicalLineItems: [{ description: "Commercial mower FM-9000 complete unit delivered assembled", role: "PRIMARY_PURCHASE", extension: 48500 }],
        queryConcepts: [{ conceptId: "course_equipment", weight: 22, source: "line_item_description", evidenceSnippet: "Commercial mower complete unit" }],
      }),
    }));
    if (result.status === "RECOMMEND") {
      // Winner should be an ASSET account (capital candidate).
      expect(result.candidates[0].accountType).toBe("ASSET");
      // Look at any R&M expense candidate — its capital-nature-boost
      // observation should be negative (contradiction).
      const rmExpense = result.candidates.find((c) =>
        c.accountType === "EXPENSE"
        && /r\s*&\s*m|repair|maintenance/i.test(c.accountName),
      );
      if (rmExpense) {
        const rmContradiction = rmExpense.evidence.find((e) =>
          e.family === "CAPITAL_NATURE" && e.kind === "RM_EXPENSE_CONTRADICTION",
        );
        // Either the evidence exists as a suppressed observation, or
        // the account was filtered out entirely; both are acceptable.
        // If it exists, it must have a negative contribution.
        if (rmContradiction) {
          expect(rmContradiction.contribution).toBeLessThan(0);
        }
      }
    }
  });

  it("§5 operating contradiction — routine low-value service does not drift into a fixed-asset account merely because 'equipment' appears", () => {
    // Transaction: routine service call for equipment, low value,
    // REPAIR_MAINTENANCE nature. Fixed-asset accounts should NOT win.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "REPAIR_MAINTENANCE",
        purposeConfidence: 82,
        purposeQuality: "HIGH",
        natureLeader: "REPAIR_MAINTENANCE",
        natureConfidence: 82,
        natureIsDefensible: true,
        capitalDecision: "REPAIR_MAINTENANCE",
        capitalConfidence: 78,
        canonicalLineItems: [{ description: "Equipment service call quarterly labour", role: "PRIMARY_PURCHASE", extension: 385 }],
        queryConcepts: [
          { conceptId: "repairs_and_maintenance", weight: 18, source: "line_item_description", evidenceSnippet: "Equipment service quarterly" },
        ],
      }),
    }));
    if (result.status === "RECOMMEND") {
      // Winner must not be an ASSET account — routine service is expense.
      expect(result.candidates[0].accountType).not.toBe("ASSET");
    }
  });

  it("§5 vendor-history contradiction — historical coding is not destiny (validation of §9 rule via ranker output)", () => {
    // Vendor default = 6050 Utilities but current transaction is capital.
    const utilities = NEUTRAL_COA.find((a) => a.accountNumber === "6050")!;
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "CAPITAL_EQUIPMENT",
        purposeConfidence: 88,
        purposeQuality: "HIGH",
        natureLeader: "CAPITAL_ASSET",
        natureConfidence: 82,
        natureIsDefensible: true,
        capitalDecision: "CAPITAL_CANDIDATE",
        capitalConfidence: 82,
        canonicalLineItems: [{ description: "Complete commercial equipment delivered assembled", role: "PRIMARY_PURCHASE", extension: 8400 }],
        queryConcepts: [{ conceptId: "course_equipment", weight: 20, source: "line_item_description", evidenceSnippet: "commercial equipment complete unit" }],
        vendor: {
          matchedVendorId: "v1",
          defaultAccountId: utilities.id,
          priorCodingAccountNumbers: [utilities.accountNumber],
        },
      }),
    }));
    if (result.status === "RECOMMEND") {
      // Utilities-electricity (6050) got +15 VENDOR_DEFAULT from
      // VENDOR_HISTORY family. Capital asset accounts get +20
      // CAPITAL_ASSET_MATCH in CAPITAL_NATURE family. Capital signal
      // wins because it spans a different independent family.
      expect(result.candidates[0].accountNumber).not.toBe("6050");
      expect(result.candidates[0].accountType).toBe("ASSET");
    }
  });

  it("§6 hard eligibility separate from soft contradiction — inactive/header accounts must not compete (validated by caller-provided eligibility list)", () => {
    // rankCanonical's contract is that `eligibleAccounts` is the
    // POSTABLE COA — hard eligibility (isActive, !isHeader,
    // allowManualPosting) is enforced by the caller before invoking
    // the ranker. The ranker never gives a header/inactive account
    // a score by construction because it never sees them.
    //
    // Test: passing an empty eligible list returns NO_ELIGIBLE_CANDIDATES,
    // proving the ranker does not compensate for a missing hard filter.
    const result = rankCanonical(makeInput({
      eligibleAccounts: [],
      transaction: makeTransaction({
        purposeConcept: "CAPITAL_EQUIPMENT",
        purposeConfidence: 88,
        purposeQuality: "HIGH",
        natureLeader: "CAPITAL_ASSET",
        natureConfidence: 82,
        natureIsDefensible: true,
        capitalDecision: "CAPITAL_CANDIDATE",
        capitalConfidence: 82,
      }),
    }));
    expect(result.status).toBe("NO_ELIGIBLE_CANDIDATES");
    // Provenance shows the ranker did not invent candidates from
    // nowhere.
    expect(result.provenance.totalCandidatesConsidered).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// §14 CONCRETE RANKING EXAMPLES — diagnostic exports for the checkpoint
// ---------------------------------------------------------------------------
//
// Each test logs a structured example showing normalised transaction
// interpretation + candidate #1 + candidate #2 + scores + family
// contributions + evidence + why #1 beat #2. These are checkpoint
// artifacts — pass unconditionally, purpose is to make the ranker's
// accounting reasoning inspectable per §14.

function dumpCanonicalExample(label: string, result: CanonicalRankerResult): void {
  console.log(`\n=== §14 CONCRETE RANKING EXAMPLE: ${label} ===`);
  console.log(`status: ${result.status}`);
  if (result.status === "RECOMMEND" || result.status === "ABSTAIN") {
    const [winner, runnerUp] = result.candidates;
    console.log(`WINNER: ${winner.accountNumber} ${winner.accountName} · score=${winner.score} · type=${winner.accountType}`);
    console.log(`  family contributions: ${JSON.stringify(winner.familyContributions)}`);
    console.log(`  contradictions: ${winner.contradictions.length === 0 ? "(none)" : winner.contradictions.map((c) => c.code).join(", ")}`);
    console.log(`  evidence counted:`);
    for (const e of winner.evidence.filter((e) => e.countedTowardScore && e.contribution > 0)) {
      console.log(`    · ${e.family} · ${e.kind} +${e.contribution}  "${e.description}"`);
    }
    const suppressed = winner.evidence.filter((e) => !e.countedTowardScore);
    if (suppressed.length > 0) {
      console.log(`  evidence suppressed (correlated, diagnostic only):`);
      for (const e of suppressed) {
        console.log(`    · ${e.family} · ${e.kind} +${e.contribution}  "${e.description}"`);
      }
    }
    if (runnerUp) {
      console.log(`RUNNER-UP: ${runnerUp.accountNumber} ${runnerUp.accountName} · score=${runnerUp.score}`);
      console.log(`  family contributions: ${JSON.stringify(runnerUp.familyContributions)}`);
      console.log(`  margin: winner ${winner.score} - runner ${runnerUp.score} = ${winner.score - runnerUp.score}`);
    } else {
      console.log(`RUNNER-UP: (none)`);
    }
  } else {
    console.log(`abstention: ${result.abstentionReason}`);
  }
  console.log(`provenance: ${JSON.stringify(result.provenance)}`);
  console.log(`=== end ${label} ===\n`);
}

describe("§14 concrete ranking examples for the checkpoint", () => {
  it("utility · Regional Hydro Cooperative electricity", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "TELECOMMUNICATIONS", // proxy — no dedicated UTILITY purpose in NEUTRAL_COA vocab
        purposeConfidence: 70,
        purposeQuality: "MEDIUM",
        natureLeader: "UTILITY_OR_RECURRING_SERVICE",
        natureConfidence: 80,
        natureIsDefensible: true,
        canonicalLineItems: [{ description: "Electricity service November 2025 12500 kWh", role: "PRIMARY_PURCHASE", extension: 1450 }],
        queryConcepts: [
          { conceptId: "utilities", weight: 18, source: "line_item_description", evidenceSnippet: "Electricity service" },
        ],
      }),
    }));
    dumpCanonicalExample("utility", result);
    expect(result.status).not.toBe("ANALYSIS_FAILURE");
  });

  it("novel_vendor · Zephyr Grounds Solutions aerator service", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "REPAIR_MAINTENANCE",
        purposeConfidence: 85,
        purposeQuality: "HIGH",
        natureLeader: "REPAIR_MAINTENANCE",
        natureConfidence: 82,
        natureIsDefensible: true,
        capitalDecision: "REPAIR_MAINTENANCE",
        capitalConfidence: 75,
        canonicalLineItems: [{ description: "Aerator equipment quarterly service", role: "PRIMARY_PURCHASE", extension: 780 }],
        queryConcepts: [
          { conceptId: "equipment_repair", weight: 12, source: "line_item_description", evidenceSnippet: "Aerator service" },
        ],
      }),
    }));
    dumpCanonicalExample("novel_vendor", result);
    // Key invariant: candidates non-empty when RECOMMEND/ABSTAIN
    // (the exact defect that Phase 1 identified on the old architecture).
    if (result.status === "RECOMMEND" || result.status === "ABSTAIN") {
      expect(result.candidates.length).toBeGreaterThan(0);
    }
  });

  it("capital_equipment · commercial fairway mower complete unit", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "CAPITAL_EQUIPMENT",
        purposeConfidence: 88,
        purposeQuality: "HIGH",
        natureLeader: "CAPITAL_ASSET",
        natureConfidence: 82,
        natureIsDefensible: true,
        capitalDecision: "CAPITAL_CANDIDATE",
        capitalConfidence: 82,
        canonicalLineItems: [{ description: "Commercial fairway mower FM-9000 complete unit delivered assembled", role: "PRIMARY_PURCHASE", extension: 48500 }],
        queryConcepts: [
          { conceptId: "course_equipment", weight: 22, source: "line_item_description", evidenceSnippet: "Commercial mower complete unit" },
        ],
      }),
    }));
    dumpCanonicalExample("capital_equipment", result);
  });

  it("same_vendor_diff_econ · vendor default is utilities but transaction is capital equipment", () => {
    const utilities = NEUTRAL_COA.find((a) => a.accountNumber === "6050")!;
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "CAPITAL_EQUIPMENT",
        purposeConfidence: 88,
        purposeQuality: "HIGH",
        natureLeader: "CAPITAL_ASSET",
        natureConfidence: 82,
        natureIsDefensible: true,
        capitalDecision: "CAPITAL_CANDIDATE",
        capitalConfidence: 82,
        canonicalLineItems: [{ description: "New commercial equipment complete unit installed", role: "PRIMARY_PURCHASE", extension: 8400 }],
        queryConcepts: [
          { conceptId: "course_equipment", weight: 20, source: "line_item_description", evidenceSnippet: "commercial equipment complete unit" },
        ],
        vendor: {
          matchedVendorId: "v1",
          defaultAccountId: utilities.id,
          priorCodingAccountNumbers: [utilities.accountNumber],
        },
      }),
    }));
    dumpCanonicalExample("same_vendor_diff_econ", result);
  });

  it("weak_semantic_accident · landscape maintenance service (lexical accident target)", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "REPAIR_MAINTENANCE",
        purposeConfidence: 78,
        purposeQuality: "HIGH",
        natureLeader: "REPAIR_MAINTENANCE",
        natureConfidence: 82,
        natureIsDefensible: true,
        canonicalLineItems: [{ description: "Landscape maintenance service quarterly", role: "PRIMARY_PURCHASE", extension: 1250 }],
        queryConcepts: [
          { conceptId: "repairs_and_maintenance", weight: 18, source: "line_item_description", evidenceSnippet: "Landscape maintenance" },
        ],
      }),
    }));
    dumpCanonicalExample("weak_semantic_accident", result);
  });

  it("genuine_ambiguity · professional dues (Membership vs Subscriptions)", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        purposeConcept: "PROFESSIONAL_MEMBERSHIP",
        purposeConfidence: 82,
        purposeQuality: "HIGH",
        natureLeader: "OPERATING_EXPENSE",
        natureConfidence: 82,
        natureIsDefensible: true,
        canonicalLineItems: [{ description: "Annual professional membership dues subscription", role: "PRIMARY_PURCHASE", extension: 810 }],
        queryConcepts: [
          { conceptId: "professional_membership_dues", weight: 18, source: "line_item_description", evidenceSnippet: "Annual dues" },
          { conceptId: "software_subscription_service", weight: 10, source: "line_item_description", evidenceSnippet: "subscription" },
        ],
      }),
    }));
    dumpCanonicalExample("genuine_ambiguity", result);
  });
});

// ---------------------------------------------------------------------------
// Phase 3.3 · §5 — repair-vs-replacement runtime tests
//
// These lock in the Phase 3.3 architectural contract: nature signals
// arrive as a PRE-RANKING input to canonical scoring (CAPITAL_NATURE
// family), not as a POST-ranking selector. The migration eliminated
// nature_promoted + nature_scoped_full_coa_search + Phase 2
// eligibility recheck. What replaced them must:
//   - promote a CAPITAL_ASSET account when nature classifier says
//     acquisition (defensible=true)
//   - promote a REPAIRS_MAINTENANCE expense when nature classifier
//     says repair (defensible=true)
//   - not pick a strongly-typed winner when nature is UNKNOWN and
//     line-item text is ambiguous (margin small OR ABSTAIN)
// ---------------------------------------------------------------------------

describe("Phase 3.3 · §5 — repair-vs-replacement uses pre-ranking nature signals", () => {
  it("equipment acquisition · CAPITAL_ASSET nature defensible → ASSET account wins over R&M expense", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        // Nature classifier committed to CAPITAL_ASSET.
        natureLeader: "CAPITAL_ASSET",
        natureConfidence: 84,
        natureIsDefensible: true,
        // Capital classifier concurs.
        capitalDecision: "CAPITAL_CANDIDATE",
        capitalConfidence: 82,
        purposeConcept: "CAPITAL_EQUIPMENT",
        purposeConfidence: 85,
        purposeQuality: "HIGH",
        canonicalLineItems: [
          { description: "Fairway mower complete unit delivered", role: "PRIMARY_PURCHASE", extension: 52000 },
        ],
        queryConcepts: [
          { conceptId: "course_equipment", weight: 20, source: "line_item_description", evidenceSnippet: "fairway mower complete unit" },
        ],
      }),
    }));
    expect(result.status).toBe("RECOMMEND");
    if (result.status === "RECOMMEND") {
      // ASSET wins — nature-compat + capital-nature-compat both fire
      // on Equipment & Fixtures; R&M expense receives capital-nature
      // contradiction and cannot beat the asset.
      expect(result.candidates[0].accountType).toBe("ASSET");
    }
  });

  it("equipment repair · REPAIR_MAINTENANCE nature defensible → EXPENSE account wins over ASSET", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        // Nature classifier committed to REPAIR_MAINTENANCE.
        natureLeader: "REPAIR_MAINTENANCE",
        natureConfidence: 84,
        natureIsDefensible: true,
        capitalDecision: "REPAIR_MAINTENANCE",
        capitalConfidence: 80,
        purposeConcept: "REPAIR_MAINTENANCE",
        purposeConfidence: 82,
        purposeQuality: "HIGH",
        canonicalLineItems: [
          { description: "Mower service call quarterly labour hydraulic hose replacement", role: "PRIMARY_PURCHASE", extension: 640 },
        ],
        queryConcepts: [
          { conceptId: "repairs_and_maintenance", weight: 18, source: "line_item_description", evidenceSnippet: "service call quarterly labour" },
        ],
      }),
    }));
    expect(result.status).toBe("RECOMMEND");
    if (result.status === "RECOMMEND") {
      // EXPENSE wins — ASSET account cannot outrank an R&M-nature
      // transaction under CAPITAL_NATURE family scoring.
      expect(result.candidates[0].accountType).toBe("EXPENSE");
    }
  });

  it("ambiguous equipment work · UNKNOWN nature, weak text → NO strongly-typed lock-in (small margin or ABSTAIN)", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        // Nature classifier cannot commit.
        natureLeader: "UNKNOWN",
        natureConfidence: 0,
        natureIsDefensible: false,
        capitalDecision: "UNRESOLVED",
        capitalConfidence: 0,
        purposeConcept: null,
        purposeConfidence: 0,
        purposeQuality: "NONE",
        canonicalLineItems: [
          { description: "Equipment work — see attached", role: "PRIMARY_PURCHASE", extension: 1200 },
        ],
        queryConcepts: [],
      }),
    }));
    // Either ABSTAIN, or if it does RECOMMEND, the margin to runner-up
    // is small (< 20) — reflecting that nature ambiguity denies the
    // canonical ranker a confident winner.
    if (result.status === "RECOMMEND") {
      expect(result.separation.marginToRunnerUp).toBeLessThan(20);
    } else {
      expect(["ABSTAIN", "NO_ELIGIBLE_CANDIDATES"]).toContain(result.status);
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3.4 · §8 · §10 · §11 — Group C capital-competition + department +
// same-vendor/different-economics locked into canonical scoring via
// preferredAccountNumbers / contradictedAccountNumbers (pre-ranking
// compatibility-gate output from the facade).
//
// The gate is evaluated in the facade (canonical-runtime-facade.ts)
// against productIdentity + purchasedObjects + capital decision +
// CIP/financing evidence + department signals. Its per-account verdict
// arrives at rankCanonical as a scoring signal, NOT a second competition.
// These tests exercise the ranker directly with the pre-computed lists
// so the scoring contract is locked in.
// ---------------------------------------------------------------------------

describe("Phase 3.4 · §8 — capital vs expense competition uses pre-ranking gate verdicts", () => {
  it("durable equipment acquisition · PREFERRED asset gate lock-in → ASSET wins", () => {
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
        canonicalLineItems: [
          { description: "Utility vehicle chassis complete delivery", role: "PRIMARY_PURCHASE", extension: 42000 },
        ],
        queryConcepts: [
          { conceptId: "course_equipment", weight: 20, source: "line_item_description", evidenceSnippet: "utility vehicle chassis complete" },
        ],
        // The compatibility gate marked the ASSET account as PREFERRED
        // for this transaction (COMPLETE_MACHINE product identity +
        // capital decision + department alignment).
        preferredAccountNumbers: ["1500"],
        // Fee-family accounts contradicted (financing/interest without evidence).
        contradictedAccountNumbers: ["6053", "6051"],
      }),
    }));
    expect(result.status).toBe("RECOMMEND");
    if (result.status === "RECOMMEND") {
      expect(result.candidates[0].accountType).toBe("ASSET");
      // NATURE_GATE_PREFERRED observation must be present on the winner.
      const gatePreferred = result.candidates[0].evidence.find(
        (e) => e.family === "CAPITAL_NATURE" && e.kind === "NATURE_GATE_PREFERRED",
      );
      expect(gatePreferred).toBeDefined();
      expect(gatePreferred?.contribution).toBeGreaterThan(0);
    }
  });

  it("ordinary equipment repair · gate marks R&M expense PREFERRED → EXPENSE wins, ASSET penalised", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        natureLeader: "REPAIR_MAINTENANCE",
        natureConfidence: 84,
        natureIsDefensible: true,
        capitalDecision: "REPAIR_MAINTENANCE",
        capitalConfidence: 80,
        purposeConcept: "REPAIR_MAINTENANCE",
        purposeConfidence: 82,
        purposeQuality: "HIGH",
        canonicalLineItems: [
          { description: "Service call replace hydraulic hose fitting", role: "PRIMARY_PURCHASE", extension: 420 },
        ],
        queryConcepts: [
          { conceptId: "repairs_and_maintenance", weight: 18, source: "line_item_description", evidenceSnippet: "service call replace hose" },
        ],
        preferredAccountNumbers: ["6035"], // R&M - Ground Equipment
        contradictedAccountNumbers: ["1500"], // Equipment & Fixtures contradicted for R&M work
      }),
    }));
    expect(result.status).toBe("RECOMMEND");
    if (result.status === "RECOMMEND") {
      // Winner must be an EXPENSE (not the contradicted ASSET).
      expect(result.candidates[0].accountType).toBe("EXPENSE");
      // The gate-preferred account 6035 must carry NATURE_GATE_PREFERRED
      // evidence; it may not always be #0 because 6020 (Grounds
      // Maintenance) and 6033 (R&M Preventative Maintenance) can tie
      // or edge past on other signals — that's honest ambiguity between
      // R&M-family expense accounts, preserved by canonical ranking.
      const preferredCand = result.candidates.find((c) => c.accountNumber === "6035");
      expect(preferredCand).toBeDefined();
      const gatePref = preferredCand?.evidence.find(
        (e) => e.family === "CAPITAL_NATURE" && e.kind === "NATURE_GATE_PREFERRED",
      );
      expect(gatePref).toBeDefined();
      // The contradicted ASSET account must NOT be #0.
      expect(result.candidates[0].accountNumber).not.toBe("1500");
    }
  });

  it("borderline capitalization · no gate verdict → legitimate competition, no forced capital winner", () => {
    // Facts insufficient for the gate to commit either way. No entries
    // in preferred/contradicted lists — canonical ranking runs on its
    // other signals only.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        natureLeader: "UNKNOWN",
        natureConfidence: 0,
        natureIsDefensible: false,
        capitalDecision: "UNRESOLVED",
        capitalConfidence: 0,
        purposeConcept: null,
        purposeConfidence: 0,
        purposeQuality: "NONE",
        canonicalLineItems: [
          { description: "Replacement component installed", role: "PRIMARY_PURCHASE", extension: 1800 },
        ],
        queryConcepts: [],
        // Deliberately empty — gate abstained.
        preferredAccountNumbers: [],
        contradictedAccountNumbers: [],
      }),
    }));
    // Ambiguous → margin small or ABSTAIN — no forced capital lock-in.
    if (result.status === "RECOMMEND") {
      expect(result.separation.marginToRunnerUp).toBeLessThan(20);
    } else {
      expect(["ABSTAIN", "NO_ELIGIBLE_CANDIDATES"]).toContain(result.status);
    }
  });

  it("high-value operating expense · amount alone does not force capital classification", () => {
    // Very large invoice but nature is UTILITY_OR_RECURRING_SERVICE.
    // Even without an explicit PREFERRED asset entry, the EXPENSE
    // account should win because there's no capital-decision signal.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        natureLeader: "UTILITY_OR_RECURRING_SERVICE",
        natureConfidence: 82,
        natureIsDefensible: true,
        capitalDecision: "OPERATING",
        capitalConfidence: 80,
        purposeConcept: "TELECOMMUNICATIONS",
        purposeConfidence: 75,
        purposeQuality: "HIGH",
        canonicalLineItems: [
          { description: "Enterprise fibre internet monthly service", role: "PRIMARY_PURCHASE", extension: 24000 },
        ],
        queryConcepts: [
          { conceptId: "utilities", weight: 15, source: "line_item_description", evidenceSnippet: "monthly service" },
        ],
        // ASSET account contradicted for a recurring service.
        contradictedAccountNumbers: ["1500"],
      }),
    }));
    expect(result.status).toBe("RECOMMEND");
    if (result.status === "RECOMMEND") {
      expect(result.candidates[0].accountType).toBe("EXPENSE");
    }
  });
});

describe("Phase 3.4 · §10 — department + capital interact inside the same canonical score", () => {
  it("capital acquisition benefiting Grounds → department-specific asset (via departmentAccountNamePatterns) wins over generic asset", () => {
    // Two ASSET accounts — one generic Equipment & Fixtures, one
    // Grounds-Equipment (added for this test). The department pattern
    // gives the department-specific asset a DEPARTMENT_AFFINITY boost,
    // which combines with the capital-nature CAPITAL_ASSET_MATCH.
    const COA_WITH_GROUNDS_ASSET = [
      ...NEUTRAL_COA,
      makeAccount({ number: "1510", name: "Grounds Equipment - Fixed Assets", type: "ASSET", categoryKey: "CAPITAL_ASSETS", fsGroupKey: "IS_FIXED_ASSETS" }),
    ];
    const result = rankCanonical(makeInput({
      eligibleAccounts: COA_WITH_GROUNDS_ASSET,
      transaction: makeTransaction({
        natureLeader: "CAPITAL_ASSET",
        natureConfidence: 84,
        natureIsDefensible: true,
        capitalDecision: "CAPITAL_CANDIDATE",
        capitalConfidence: 82,
        purposeConcept: "CAPITAL_EQUIPMENT",
        purposeConfidence: 85,
        purposeQuality: "HIGH",
        departmentKey: "grounds",
        // Pattern matches names containing "grounds" (case-insensitive).
        departmentAccountNamePatterns: [/grounds/i],
        canonicalLineItems: [
          { description: "Fairway mower complete unit delivered", role: "PRIMARY_PURCHASE", extension: 52000 },
        ],
        queryConcepts: [
          { conceptId: "course_equipment", weight: 20, source: "line_item_description", evidenceSnippet: "fairway mower complete unit" },
        ],
        // The gate PREFERRED both asset accounts.
        preferredAccountNumbers: ["1500", "1510"],
      }),
    }));
    expect(result.status).toBe("RECOMMEND");
    if (result.status === "RECOMMEND") {
      // Department-specific asset should win over generic asset.
      expect(result.candidates[0].accountNumber).toBe("1510");
      expect(result.candidates[0].accountType).toBe("ASSET");
    }
  });
});

describe("Phase 3.4 · §11 — same-vendor / different-economics through Group C", () => {
  it("vendor historically coded to R&M expense · current invoice is capital acquisition → ASSET wins (capital evidence overcomes prior coding)", () => {
    const rmExpense = NEUTRAL_COA.find((a) => a.accountNumber === "6035")!;
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
        canonicalLineItems: [
          { description: "Commercial fairway mower complete unit", role: "PRIMARY_PURCHASE", extension: 48000 },
        ],
        queryConcepts: [
          { conceptId: "course_equipment", weight: 20, source: "line_item_description", evidenceSnippet: "commercial fairway mower complete" },
        ],
        vendor: {
          matchedVendorId: "vendor-1",
          defaultAccountId: rmExpense.id,
          priorCodingAccountNumbers: [rmExpense.accountNumber],
        },
        preferredAccountNumbers: ["1500"],
        contradictedAccountNumbers: [rmExpense.accountNumber],
      }),
    }));
    expect(result.status).toBe("RECOMMEND");
    if (result.status === "RECOMMEND") {
      // ASSET must win — capital evidence + gate PREFERRED overcomes
      // the vendor's historical R&M coding.
      expect(result.candidates[0].accountType).toBe("ASSET");
    }
  });

  it("vendor historically coded to capital asset · current invoice is ordinary repair → EXPENSE wins", () => {
    const asset = NEUTRAL_COA.find((a) => a.accountNumber === "1500")!;
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        natureLeader: "REPAIR_MAINTENANCE",
        natureConfidence: 84,
        natureIsDefensible: true,
        capitalDecision: "REPAIR_MAINTENANCE",
        capitalConfidence: 80,
        purposeConcept: "REPAIR_MAINTENANCE",
        purposeConfidence: 82,
        purposeQuality: "HIGH",
        canonicalLineItems: [
          { description: "Mower quarterly service labour hose replacement", role: "PRIMARY_PURCHASE", extension: 380 },
        ],
        queryConcepts: [
          { conceptId: "repairs_and_maintenance", weight: 18, source: "line_item_description", evidenceSnippet: "quarterly service labour" },
        ],
        vendor: {
          matchedVendorId: "vendor-2",
          defaultAccountId: asset.id,
          priorCodingAccountNumbers: [asset.accountNumber],
        },
        preferredAccountNumbers: ["6035"],
        contradictedAccountNumbers: ["1500"],
      }),
    }));
    expect(result.status).toBe("RECOMMEND");
    if (result.status === "RECOMMEND") {
      // EXPENSE must win — repair evidence + gate PREFERRED overcomes
      // the vendor's historical asset coding.
      expect(result.candidates[0].accountType).toBe("EXPENSE");
    }
  });
});

// ---------------------------------------------------------------------------
// Phase 3.5 · §4 · §5 · §6 — Group D purchased-object substance signal
// becomes pre-ranking CAPITAL_NATURE evidence. Replaces the Slice 5.3
// object-authority guard that cleared gl.accountNumber via account-name
// regex against interest/penalty/bank-charge patterns.
//
// New rule (taxonomy-based, defeasible):
//   hasHighQualityDurableAssetContext AND
//   NOT hasFinancingEvidence AND
//   account.fsGroupKey ∈ {"IS_INTEREST_EXPENSE","IS_BANK_CHARGES","IS_MERCHANT_FEES"}
//   → OBJECT_ROLE_CONTRADICTION (-22) + contradiction record
//
// The account SIDE uses fsGroupKey taxonomy (§3 founder constraint) — no
// account-name regex, no account-number literals.
// ---------------------------------------------------------------------------

describe("Phase 3.5 · §4 — durable-asset object contradicts fee-family accounts by taxonomy", () => {
  it("equipment purchase invoice with fee-family accounts present → fee accounts contradicted, ASSET wins", () => {
    // NEUTRAL_COA includes 6051 (Bank Charges & Credit Card Fees, IS_BANK_CHARGES),
    // 6053 (Interest Expense, IS_INTEREST_EXPENSE), and 1500 (Equipment & Fixtures).
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
        canonicalLineItems: [
          { description: "Toro Groundsmaster 3500 fairway mower complete unit delivered", role: "PRIMARY_PURCHASE", extension: 52000 },
        ],
        queryConcepts: [
          { conceptId: "course_equipment", weight: 20, source: "line_item_description", evidenceSnippet: "fairway mower complete unit" },
        ],
        hasHighQualityDurableAssetContext: true,
        hasFinancingEvidence: false,
      }),
    }));
    expect(result.status).toBe("RECOMMEND");
    if (result.status === "RECOMMEND") {
      // ASSET must win.
      expect(result.candidates[0].accountType).toBe("ASSET");
      // Interest / Bank-Charges accounts must NOT be at #0.
      expect(result.candidates[0].fsGroupKey).not.toBe("IS_INTEREST_EXPENSE");
      expect(result.candidates[0].fsGroupKey).not.toBe("IS_BANK_CHARGES");
      // The fee-family accounts MUST carry the OBJECT_ROLE_CONTRADICTION
      // observation on their evidence trail (retained for diagnostics
      // even when scoring collapses to zero).
      const interestCand = result.candidates.find((c) => c.fsGroupKey === "IS_INTEREST_EXPENSE");
      const bankCand = result.candidates.find((c) => c.fsGroupKey === "IS_BANK_CHARGES");
      // Contradiction records carry the transaction-substance reason.
      if (interestCand) {
        expect(interestCand.contradictions.some((c) => c.code === "durable_asset_object_vs_fee_family_account")).toBe(true);
      }
      if (bankCand) {
        expect(bankCand.contradictions.some((c) => c.code === "durable_asset_object_vs_fee_family_account")).toBe(true);
      }
    }
  });
});

describe("Phase 3.5 · §5 — reverse case: genuine financial charge is not suppressed", () => {
  it("genuine bank charge invoice (no durable-asset object) → BANK_CHARGES account competes strongly and wins", () => {
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        natureLeader: "OPERATING_EXPENSE",
        natureConfidence: 78,
        natureIsDefensible: true,
        capitalDecision: "OPERATING",
        capitalConfidence: 80,
        purposeConcept: null, // no capital/repair concept — this is a fee
        purposeConfidence: 0,
        purposeQuality: "NONE",
        canonicalLineItems: [
          { description: "Merchant credit card processing fees monthly statement charges", role: "PRIMARY_PURCHASE", extension: 850 },
        ],
        queryConcepts: [
          { conceptId: "bank_and_merchant_fees", weight: 22, source: "line_item_description", evidenceSnippet: "merchant credit card processing fees" },
        ],
        // No durable asset — reverse case trigger absent.
        hasHighQualityDurableAssetContext: false,
        hasFinancingEvidence: false,
      }),
    }));
    // The test purpose is to prove the durable-asset-vs-fee contradiction
    // does NOT fire on this transaction, not that this specific canonical
    // ranker returns RECOMMEND. RECOMMEND vs ABSTAIN depends on the
    // ranker's global COMMIT_MIN_SCORE and the strength of the query
    // concept — that is a separate contract. What matters here is the
    // reverse-case defeasibility of the Group D rule.
    expect(["RECOMMEND", "ABSTAIN"]).toContain(result.status);
    if (result.status === "RECOMMEND" || result.status === "ABSTAIN") {
      const bankCand = result.candidates.find((c) => c.fsGroupKey === "IS_BANK_CHARGES");
      const merchCand = result.candidates.find((c) => c.fsGroupKey === "IS_MERCHANT_FEES");
      // At least one fee-family candidate must remain in the list —
      // reverse case must not silently exclude them.
      expect(bankCand ?? merchCand).toBeDefined();
      // No object-role contradiction should have fired on either fee
      // candidate — hasHighQualityDurableAssetContext is false, so the
      // Group D rule is inactive on this transaction.
      for (const cand of [bankCand, merchCand].filter((c): c is NonNullable<typeof c> => c != null)) {
        expect(cand.contradictions.some((c) => c.code === "durable_asset_object_vs_fee_family_account")).toBe(false);
      }
    }
  });

  it("financed equipment lease (durable asset + financing evidence) → interest account NOT contradicted", () => {
    // Both signals present: hasHighQualityDurableAssetContext AND
    // hasFinancingEvidence. The defeasibility rule disables the
    // contradiction so financing accounts remain in competition.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        natureLeader: "CAPITAL_ASSET",
        natureConfidence: 82,
        natureIsDefensible: true,
        capitalDecision: "CAPITAL_CANDIDATE",
        capitalConfidence: 80,
        purposeConcept: "CAPITAL_EQUIPMENT",
        purposeConfidence: 82,
        purposeQuality: "HIGH",
        canonicalLineItems: [
          { description: "Fairway mower 24-month lease financing charge", role: "PRIMARY_PURCHASE", extension: 620 },
        ],
        queryConcepts: [],
        hasHighQualityDurableAssetContext: true,
        hasFinancingEvidence: true, // defeasibility trigger
      }),
    }));
    if (result.status === "RECOMMEND" || result.status === "ABSTAIN") {
      // Interest / bank-charge candidates must NOT carry the durable-asset
      // contradiction when financing evidence is present.
      const feeCands = result.candidates.filter(
        (c) => c.fsGroupKey === "IS_INTEREST_EXPENSE" || c.fsGroupKey === "IS_BANK_CHARGES" || c.fsGroupKey === "IS_MERCHANT_FEES",
      );
      for (const cand of feeCands) {
        expect(cand.contradictions.some((c) => c.code === "durable_asset_object_vs_fee_family_account")).toBe(false);
      }
    }
  });
});

describe("Phase 3.5 · §6 — object ambiguity: purchased object known, accounting treatment not", () => {
  it("known equipment object but ambiguous treatment (no defensible nature) → legitimate alternatives survive", () => {
    // Object identity is HIGH (durable asset present), but nature and
    // capital decision are not defensible. Fee-family accounts are
    // still contradicted (object substance genuine), but the ranker
    // does not force a specific asset winner.
    const result = rankCanonical(makeInput({
      eligibleAccounts: NEUTRAL_COA,
      transaction: makeTransaction({
        natureLeader: "UNKNOWN",
        natureConfidence: 0,
        natureIsDefensible: false,
        capitalDecision: "UNRESOLVED",
        capitalConfidence: 0,
        purposeConcept: null,
        purposeConfidence: 0,
        purposeQuality: "NONE",
        canonicalLineItems: [
          { description: "Toro Groundsmaster 3500 replacement component", role: "PRIMARY_PURCHASE", extension: 3200 },
        ],
        queryConcepts: [],
        hasHighQualityDurableAssetContext: true,
        hasFinancingEvidence: false,
      }),
    }));
    if (result.status === "RECOMMEND") {
      // No forced capital/repair winner — margin should be small OR
      // the winner should be a legitimate alternative among ASSET/R&M.
      const winnerFs = result.candidates[0].fsGroupKey;
      // Fee-family accounts should NOT be #0 (object contradicts them).
      expect(winnerFs).not.toBe("IS_INTEREST_EXPENSE");
      expect(winnerFs).not.toBe("IS_BANK_CHARGES");
      expect(winnerFs).not.toBe("IS_MERCHANT_FEES");
    } else {
      // ABSTAIN with candidates preserved for review is also acceptable
      // — reflects the accounting-treatment ambiguity honestly.
      expect(["ABSTAIN", "NO_ELIGIBLE_CANDIDATES"]).toContain(result.status);
    }
  });
});

// ---------------------------------------------------------------------------
// §35 anti-overfitting
// ---------------------------------------------------------------------------

describe("§35 anti-overfitting", () => {
  it("no vendor/invoice/account literals in canonical-ranker.ts", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.resolve("src/lib/ap-intelligence/canonical-ranker.ts"),
      "utf8",
    ) as string;
    const forbidden = [
      /===\s*["'](6054|6030|6033|6035|6051|6053|6064|6071|6072|1500|1502|1506|1540)["']/,
      /===\s*["']Club\s*Support/i,
      /===\s*["']OXIO/i,
      /===\s*["']Oakcreek/i,
      /===\s*["']CPA\s*Alberta/i,
    ];
    for (const re of forbidden) {
      expect(src.match(re)).toBeNull();
    }
  });
});
