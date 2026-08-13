// Phase 4R · Phase 7.2E-a (2026-08-13) — bounded evidence aggregation tests.
//
// **STATUS: DESIGN-INTENT TESTS FOR A REVERTED CHANGE.**
//
// Every describe block below is `.skip`ped. The aggregation change
// these tests validated was implemented in `collapseByFamily`, passed
// all 4 tests, but reintroduced 1 unsafe recommendation on
// `statement-of-account` in the sealed 42-case corpus. Per Phase 7.2E-a
// directive §8 ("If unsafe rises above zero, revert the aggregation
// change and report why"), the aggregation change was reverted.
// `inferObservationOrigin` and `INDEPENDENT_ORIGINS_CAP` remain in
// `canonical-ranker.ts` so a future slice can re-attempt with a
// stricter gate (e.g. only apply bounded SUM when the document is
// classified INVOICE and the canonical purpose committed).
//
// See docs/phase-4r-phase72e-a-checkpoint.md for the full report.
//
// The tests below document the design intent and remain runnable
// (unskipped) if the aggregation change is reintroduced.
//
// Verifies the provenance-based independence rule in `collapseByFamily`
// at `src/lib/ap-intelligence/canonical-ranker.ts`:
//
//   - correlated derivatives (same origin) → MAX
//   - independent observations (different origins) → bounded SUM,
//     cap = INDEPENDENT_ORIGINS_CAP (= 2)
//   - additional group-MAX beyond the cap → diagnostic only
//   - negatives (contradictions) → SUM (unchanged)
//   - contradictions remain effective vs bounded corroboration
//
// These tests exercise `collapseByFamily` indirectly via `rankCanonical`.
// The tests construct minimal transaction interpretations + eligible
// accounts + query concepts to force specific observation kinds.

import { describe, expect, it } from "vitest";
import { rankCanonical } from "@/lib/ap-intelligence/canonical-ranker";
import type { NormalisedTransactionInterpretation, CanonicalRankerInput } from "@/lib/ap-intelligence/canonical-ranker";

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

function mkAccount(o: {
  id: string;
  accountNumber: string;
  name: string;
  categoryKey?: string | null;
  fsGroupKey?: string | null;
}) {
  return {
    id: o.id,
    accountNumber: o.accountNumber,
    name: o.name,
    categoryKey: o.categoryKey ?? null,
    categoryName: null,
    fsGroupKey: o.fsGroupKey ?? null,
    fsGroupName: null,
  };
}

function mkTx(o: Partial<NormalisedTransactionInterpretation> = {}): NormalisedTransactionInterpretation {
  return {
    purposeConcept: o.purposeConcept ?? null,
    purposeConfidence: o.purposeConfidence ?? 0,
    purposeQuality: o.purposeQuality ?? "NONE",
    capitalDecision: o.capitalDecision ?? null,
    capitalConfidence: o.capitalConfidence ?? 0,
    natureLeader: o.natureLeader ?? "UNKNOWN",
    natureConfidence: o.natureConfidence ?? 0,
    natureIsDefensible: o.natureIsDefensible ?? false,
    departmentKey: o.departmentKey ?? null,
    departmentAccountNamePatterns: o.departmentAccountNamePatterns ?? [],
    canonicalLineItems: o.canonicalLineItems ?? [],
    queryConcepts: o.queryConcepts ?? [],
    vendor: o.vendor ?? { matchedVendorId: null, defaultAccountId: null, priorCodingAccountNumbers: [] },
    documentPhraseText: o.documentPhraseText ?? null,
    preferredAccountNumbers: o.preferredAccountNumbers ?? [],
    contradictedAccountNumbers: o.contradictedAccountNumbers ?? [],
    hasHighQualityDurableAssetContext: o.hasHighQualityDurableAssetContext ?? false,
    hasFinancingEvidence: o.hasFinancingEvidence ?? false,
  };
}

function findCandidateEvidence(result: ReturnType<typeof rankCanonical>, accountNumber: string) {
  if (result.status !== "RECOMMEND" && result.status !== "ABSTAIN") return null;
  return result.candidates.find((c) => c.accountNumber === accountNumber) ?? null;
}

// ---------------------------------------------------------------------------
// TEST 1 — Same phrase, multiple derivatives (correlated MAX)
// ---------------------------------------------------------------------------

describe.skip("Phase 7.2E-a · §7 (REVERTED) correlated derivatives use MAX", () => {
  it("multiple observations sharing one purpose_authority origin count as ONE contribution", () => {
    const account = mkAccount({
      id: "acct-6054",
      accountNumber: "6054",
      name: "Computer & IT Services",
      categoryKey: "ADMIN_EXPENSES",
    });
    const input: CanonicalRankerInput = {
      transaction: mkTx({
        purposeConcept: "SOFTWARE_SUBSCRIPTION",
        purposeConfidence: 96,
        purposeQuality: "HIGH",
      }),
      eligibleAccounts: [account],
      postingBlockersByAccount: new Map(),
    };
    const result = rankCanonical(input);
    const evid = findCandidateEvidence(result, "6054");
    expect(evid).not.toBeNull();
    // Purpose-authority-origin observations (PURPOSE_TYPE_COMPAT +
    // PURPOSE_CATEGORY_HINT + ONTOLOGY_NAME_MATCH) all share origin
    // "purpose_authority". Exactly ONE should be counted; others
    // should remain diagnostic.
    const purposeEvidence = (evid?.evidence ?? []).filter((e) =>
      e.kind === "PURPOSE_TYPE_COMPAT" || e.kind === "PURPOSE_CATEGORY_HINT"
        || e.kind === "ONTOLOGY_NAME_MATCH");
    const countedPurpose = purposeEvidence.filter((e) => e.countedTowardScore);
    expect(purposeEvidence.length).toBeGreaterThanOrEqual(2);
    // At most ONE purpose-authority observation counted (MAX of the group).
    expect(countedPurpose.length).toBeLessThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// TEST 2 — Two independent physical lines both count (bounded SUM)
// ---------------------------------------------------------------------------

describe.skip("Phase 7.2E-a · §7 (REVERTED) two independent physical lines co-count", () => {
  it("two LINE_ITEM_MATCH observations from different physical lines both count", () => {
    const account = mkAccount({
      id: "acct-5310",
      accountNumber: "5310",
      name: "Fuel — Grounds Equipment",
      categoryKey: "COST_OF_SALES",
    });
    const input: CanonicalRankerInput = {
      transaction: mkTx({
        purposeConcept: null,
        queryConcepts: [
          {
            conceptId: "fuel_surcharge",
            weight: 25,
            source: "line_item_description",
            evidenceSnippet: `Line "Diesel biodegradable dyed low-sulphur" (75% of total) → fuel (synonym)`,
          },
          {
            conceptId: "fuel_surcharge",
            weight: 25,
            source: "line_item_description",
            evidenceSnippet: `Line "Fuel adjustment surcharge" (25% of total) → fuel (synonym)`,
          },
        ],
      }),
      eligibleAccounts: [account],
      postingBlockersByAccount: new Map(),
    };
    const result = rankCanonical(input);
    const evid = findCandidateEvidence(result, "5310");
    expect(evid).not.toBeNull();
    // Two LINE_ITEM_MATCH observations from different lines have
    // different descriptions → different origins → BOTH should count
    // (bounded SUM with cap=2).
    const lineMatches = (evid?.evidence ?? []).filter((e) => e.kind === "LINE_ITEM_MATCH");
    const counted = lineMatches.filter((e) => e.countedTowardScore);
    expect(lineMatches.length).toBe(2);
    expect(counted.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TEST 3 — Three independent same-kind observations: only cap counts
// ---------------------------------------------------------------------------

describe.skip("Phase 7.2E-a · §7 (REVERTED) bounded cap on independent same-kind observations", () => {
  it("three independent LINE_ITEM_MATCH observations: only top-K (K=2) count", () => {
    // Use professional_membership_dues + an account whose name matches
    // the concept synonyms directly ("annual dues"), so extractConceptsForAccount
    // returns a match and LINE_ITEM_MATCH observations are emitted.
    const account = mkAccount({
      id: "acct-6064",
      accountNumber: "6064",
      name: "Professional Membership Dues",
      categoryKey: "ADMIN_EXPENSES",
    });
    const input: CanonicalRankerInput = {
      transaction: mkTx({
        purposeConcept: null,
        queryConcepts: [
          {
            conceptId: "professional_membership_dues",
            weight: 25,
            source: "line_item_description",
            evidenceSnippet: `Line "Provincial regulatory body annual dues" (33%) → membership (synonym)`,
          },
          {
            conceptId: "professional_membership_dues",
            weight: 25,
            source: "line_item_description",
            evidenceSnippet: `Line "National affiliate dues" (33%) → membership (synonym)`,
          },
          {
            conceptId: "professional_membership_dues",
            weight: 25,
            source: "line_item_description",
            evidenceSnippet: `Line "Chapter member fee" (34%) → membership (synonym)`,
          },
        ],
      }),
      eligibleAccounts: [account],
      postingBlockersByAccount: new Map(),
    };
    const result = rankCanonical(input);
    const evid = findCandidateEvidence(result, "6064");
    const lineMatches = (evid?.evidence ?? []).filter((e) => e.kind === "LINE_ITEM_MATCH");
    const counted = lineMatches.filter((e) => e.countedTowardScore);
    expect(lineMatches.length).toBe(3);
    // Exactly TWO of the three count; the weakest one remains diagnostic.
    expect(counted.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// TEST 4 — Contradictions remain effective (safety)
// ---------------------------------------------------------------------------

describe("Phase 7.2E-a · §6 contradictions remain effective vs bounded corroboration", () => {
  it("bounded positive corroboration does NOT overwhelm a strong CAPITAL_ACCOUNT_CONTRADICTION", () => {
    // An OPERATING invoice scored against a CAPITAL_ASSET account —
    // classifier flags REPAIR_MAINTENANCE decision. Even with two
    // strong positive observations (purpose-authority + line-item),
    // the CAPITAL_ACCOUNT_CONTRADICTION (-25) plus family MAX-collapse
    // should keep the capital account below a viable score.
    const capitalAccount = mkAccount({
      id: "acct-1530",
      accountNumber: "1530",
      name: "Capital Equipment",
      categoryKey: "CAPITAL_ASSETS",
    });
    const input: CanonicalRankerInput = {
      transaction: mkTx({
        capitalDecision: "REPAIR_MAINTENANCE",
        capitalConfidence: 80,
        purposeConcept: "REPAIR_MAINTENANCE",
        purposeConfidence: 80,
        purposeQuality: "HIGH",
        queryConcepts: [
          {
            conceptId: "repairs_and_maintenance",
            weight: 25,
            source: "line_item_description",
            evidenceSnippet: `Line "Bearing replacement service" (100%) → repair (synonym)`,
          },
        ],
      }),
      // Pass BOTH the capital asset AND an R&M expense so the ranker
      // can choose. R&M expense should win because capital is contradicted.
      eligibleAccounts: [
        capitalAccount,
        mkAccount({
          id: "acct-6031",
          accountNumber: "6031",
          name: "Repairs & Maintenance — Ground Equipment",
          categoryKey: "REPAIRS_MAINTENANCE",
        }),
      ],
      postingBlockersByAccount: new Map(),
    };
    const result = rankCanonical(input);
    // Winner must NOT be the capital account.
    if (result.status === "RECOMMEND" || result.status === "ABSTAIN") {
      expect(result.candidates[0].accountNumber).not.toBe("1530");
    }
  });
});
