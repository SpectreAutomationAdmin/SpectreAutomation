// Phase 4R · single-GL-authority refactor · Phase 3.2 (2026-08-11).
//
// Canonical runtime facade — projects `CanonicalRankerResult` into
// the existing `GlRecommendation` shape so analyse.ts orchestration
// can consume canonical selection authority without a big-bang shape
// change.
//
// FOUNDER §11 · PURE PROJECTION ONLY:
//   * RECOMMEND → gl.accountNumber = canonical.candidates[0].accountNumber
//   * ABSTAIN → gl.accountNumber = null BUT gl.candidates preserved
//     (winner still recoverable via canonical.candidates[0])
//   * No business logic. No account selection. No candidate reordering.
//
// This facade replaces the initial `recommendGlAccount` output at
// analyse.ts:1076 AND eliminates the Group A override chain
// (lines 1425-1606 of the pre-migration file).

import { prisma } from "@/lib/prisma";
import { filterEligibleAccounts } from "@/lib/accounting/eligibility";
import type { AccountingTransactionContext } from "@/lib/accounting/eligibility/types";
import type { AccountView } from "./gl-account-concepts";
import type { GlRecommendation, GlCandidate, PostingBlocker } from "./gl-recommend";
import { extractQueryConcepts } from "./gl-query-concepts";
import type { CanonicalLineItem } from "./evidence/canonical-line-item";
import type { PurposeCandidate } from "./economic-purpose";
import type { EconomicPurposeDecision } from "./economic-purpose-authority";
import { rankCanonical, type CanonicalRankerInput, type CanonicalRankerResult, type NormalisedTransactionInterpretation } from "./canonical-ranker";
import type { LineItem } from "./line-items-extract";
import type { CapitalVsOperatingRecommendation } from "./capital-vs-operating";
import type { CapitalVsOperatingState, ExtractedInvoice } from "./types";
import type { VendorResolveResult } from "./vendor-resolve";

// Local mirror — the ranker's expected debit role vocabulary.
export type ExpectedDebitRoleLocal = "CAPITAL_ASSET" | "OPERATING_EXPENSE" | "UNKNOWN";

// The purpose→nature vocabulary used by canonical scoring.
function purposeConceptToNature(concept: string | null, capitalState: CapitalVsOperatingState): string {
  if (concept === "CAPITAL_EQUIPMENT") return "CAPITAL_ASSET";
  if (concept === "REPAIR_MAINTENANCE" || concept === "BUILDING_MAINTENANCE" || concept === "COURSE_MAINTENANCE") return "REPAIR_MAINTENANCE";
  if (concept === "FOOD" || concept === "BEVERAGE") return "COST_OF_SALES";
  if (concept === "PROFESSIONAL_SERVICES") return "PROFESSIONAL_SERVICE";
  if (concept === "TELECOMMUNICATIONS" || concept === "INTERNET_CONNECTIVITY") return "UTILITY_OR_RECURRING_SERVICE";
  if (capitalState === "CAPITAL") return "CAPITAL_ASSET";
  if (capitalState === "OPERATING") return "OPERATING_EXPENSE";
  return "UNKNOWN";
}

function capitalDecisionFromState(state: CapitalVsOperatingState): "CAPITAL_CANDIDATE" | "OPERATING" | "REPAIR_MAINTENANCE" | "UNRESOLVED" | null {
  if (state === "CAPITAL") return "CAPITAL_CANDIDATE";
  if (state === "OPERATING") return "OPERATING";
  return "UNRESOLVED";
}

/**
 * Inputs for the canonical facade. All fields are already computed
 * upstream in analyse.ts — this function ONLY consolidates them
 * into a `CanonicalRankerInput` and runs the ranker.
 */
export interface CanonicalFacadeArgs {
  clubId: string;
  extraction: ExtractedInvoice;
  vendor: VendorResolveResult;
  capital: CapitalVsOperatingRecommendation;
  economicPurposeCandidates: PurposeCandidate[] | null;
  purposeDecision: EconomicPurposeDecision | null;
  purposeQuality: "HIGH" | "MEDIUM" | "LOW" | "NONE";
  canonicalLineItems: CanonicalLineItem[];
  lineItemsExtracted: LineItem[];
  fullDocumentText: string | null;
  expectedDebitRole: ExpectedDebitRoleLocal;
  hasPayrollEvidence: boolean;
  departmentKey: string | null;
  departmentAccountNamePatterns: ReadonlyArray<RegExp>;
  vendorHistoryConceptIds: string[];
  vendorHistoryPreferredAccountNumbers: string[];
}

/** Runs the canonical ranker and returns a GlRecommendation-shaped
 *  result. This is the single authorised path for GL selection under
 *  Phase 3.2 architecture. */
export async function runCanonicalGlRanking(args: CanonicalFacadeArgs): Promise<GlRecommendation> {
  // 1. Load the tenant COA.
  const accountsRaw = await prisma.account.findMany({
    where: { clubId: args.clubId },
    include: {
      category: { select: { key: true, name: true } },
      fsGroup: { select: { key: true, name: true } },
    },
    orderBy: { accountNumber: "asc" },
  });
  if (accountsRaw.length === 0) {
    return emptyGlRecommendation("No chart of accounts is loaded on this club — cannot recommend a GL account.");
  }

  // 2. Apply Phase-2 accounting eligibility (hard eligibility per §6).
  const eligibilityCtx: AccountingTransactionContext = {
    transactionKind: "AP_INVOICE",
    expectedDebitRole: args.expectedDebitRole,
    departmentHint: args.departmentKey ?? null,
    capitalizationEvidence: {
      supported: args.capital.state === "CAPITAL",
      confidence: args.capital.state === "CAPITAL" ? 80 : 0,
    },
    hasPayrollEvidence: args.hasPayrollEvidence,
  };
  const eligibilityViews = accountsRaw.map((a) => ({
    id: a.id, accountNumber: a.accountNumber, name: a.name,
    type: a.type, normalBalance: a.normalBalance,
    isActive: a.isActive, isHeader: a.isHeader,
    allowManualPosting: a.allowManualPosting,
    isControlAccount: a.isControlAccount,
    isBankAccount: a.isBankAccount, isCashAccount: a.isCashAccount,
    archivedAt: a.archivedAt, fundApplicability: a.fundApplicability,
    categoryKey: a.category?.key ?? null,
    fsGroupKey: a.fsGroup?.key ?? null,
    accountRole: (a as unknown as { accountRole?: string }).accountRole ?? "STANDARD",
  }));
  const filtered = filterEligibleAccounts(eligibilityViews, eligibilityCtx);
  const eligibleAccounts: AccountView[] = filtered.eligible.map((a) => ({
    id: a.id,
    accountNumber: a.accountNumber,
    name: a.name,
    categoryKey: a.categoryKey ?? null,
    categoryName: null,
    fsGroupKey: a.fsGroupKey ?? null,
    fsGroupName: null,
  }));
  // Rehydrate `type` + `accountRole` as loose fields the canonical
  // ranker reads via `as any` (they're not in AccountView but the
  // ranker treats them as best-effort strings).
  for (let i = 0; i < eligibleAccounts.length; i++) {
    const src = filtered.eligible[i];
    Object.assign(eligibleAccounts[i] as unknown as Record<string, unknown>, {
      type: src.type,
      accountRole: src.accountRole,
    });
  }
  if (eligibleAccounts.length === 0) {
    return emptyGlRecommendation("No eligible expense or asset accounts survive Phase-2 eligibility for this transaction.");
  }

  // 3. Extract query concepts using the shared primitive (§4 -
  //    reuse existing scoring primitives; no parallel semantics).
  const queryConcepts = extractQueryConcepts({
    lineItems: args.lineItemsExtracted,
    economicPurposeCandidates: args.economicPurposeCandidates ?? [],
    fullDocumentText: args.fullDocumentText,
    supplierName: args.extraction.vendor.guessedName ?? null,
    vendorHistoryConceptIds: args.vendorHistoryConceptIds,
  });

  // 4. Build NormalisedTransactionInterpretation.
  const purposeConcept = args.purposeDecision?.concept ?? args.economicPurposeCandidates?.[0]?.classificationConcept ?? null;
  const purposeConfidence = args.purposeDecision?.confidence ?? args.economicPurposeCandidates?.[0]?.score ?? 0;
  const transaction: NormalisedTransactionInterpretation = {
    purposeConcept,
    purposeConfidence,
    purposeQuality: args.purposeQuality,
    capitalDecision: capitalDecisionFromState(args.capital.state),
    capitalConfidence: args.capital.state === "CAPITAL" ? 80 : args.capital.state === "OPERATING" ? 80 : 0,
    natureLeader: purposeConceptToNature(purposeConcept, args.capital.state),
    natureConfidence: purposeConfidence,
    natureIsDefensible: args.purposeQuality === "HIGH" || args.purposeQuality === "MEDIUM",
    departmentKey: args.departmentKey,
    departmentAccountNamePatterns: args.departmentAccountNamePatterns,
    canonicalLineItems: args.canonicalLineItems.map((li) => ({
      description: li.description,
      role: li.role,
      extension: li.extension,
    })),
    queryConcepts: queryConcepts.map((qc) => ({
      conceptId: qc.conceptId,
      weight: qc.weight,
      source: qc.source,
      evidenceSnippet: qc.evidenceSnippet,
    })),
    vendor: {
      matchedVendorId: args.vendor.state === "MATCHED" ? args.vendor.candidates[0]?.id ?? null : null,
      defaultAccountId: null,   // Not currently plumbed through analyse.ts args
      priorCodingAccountNumbers: args.vendorHistoryPreferredAccountNumbers,
    },
    documentPhraseText: args.fullDocumentText,
  };

  // 5. Rank canonically.
  const postingBlockersByAccount = new Map<string, PostingBlocker[]>();
  const input: CanonicalRankerInput = {
    transaction,
    eligibleAccounts,
    postingBlockersByAccount,
  };
  const result = rankCanonical(input);
  return projectCanonicalToGl(result, filtered.eligible.length);
}

/** Pure projection: CanonicalRankerResult → GlRecommendation.
 *  §11: no business logic, no account selection. */
function projectCanonicalToGl(result: CanonicalRankerResult, totalAccountsEvaluated: number): GlRecommendation {
  const glCandidates: GlCandidate[] = result.status === "RECOMMEND" || result.status === "ABSTAIN"
    ? result.candidates.map((c) => ({
        accountId: c.accountId,
        accountNumber: c.accountNumber,
        accountName: c.accountName,
        categoryKey: c.categoryKey,
        fsGroupKey: c.fsGroupKey,
        confidence: c.score,
        // Map canonical evidence → the legacy GlEvidence shape.
        // Only counted evidence surfaces to consumers; suppressed
        // (correlated) observations remain diagnostic-only.
        evidence: c.evidence
          .filter((e) => e.countedTowardScore)
          .slice(0, 6)
          .map((e) => ({
            kind: (mapEvidenceKindToLegacy(e.kind)) as GlCandidate["evidence"][number]["kind"],
            description: e.description,
            score: e.contribution,
          })),
        postable: c.postable,
        postingBlockers: [...c.postingBlockers] as PostingBlocker[],
      }))
    : [];
  if (result.status === "RECOMMEND") {
    const winner = result.candidates[0];
    return {
      ruleVersion: 2,
      accountNumber: winner.accountNumber,
      accountName: winner.accountName,
      categoryKey: winner.categoryKey,
      fsGroupKey: winner.fsGroupKey,
      confidence: winner.score,
      reason: `canonical_ranker:${result.candidates.length}candidates:winner=${winner.accountNumber}(score=${winner.score},margin=${result.separation.marginToRunnerUp}${result.separation.isDeterministicTieBreak ? ",tie" : ""})`,
      source: "SEMANTIC_MATCH",
      candidates: glCandidates,
      leaderIsPostable: winner.postable,
      leaderPostingBlockers: [...winner.postingBlockers] as PostingBlocker[],
      autoApprovalEligible: false,
      rationale: {
        selectedAccountId: winner.accountId,
        selectedConcept: null,
        supportingDocumentEvidence: winner.evidence.filter((e) => e.countedTowardScore).map((e) => e.description),
        supportingTaxonomyEvidence: [],
        contradictedAccountConcepts: winner.contradictions.map((c) => c.code),
        alternativeAccounts: result.candidates.slice(1, 5).map((c) => ({
          accountId: c.accountId,
          accountNumber: c.accountNumber,
          accountName: c.accountName,
          semanticScore: c.score,
          reason: `runner-up score ${c.score}`,
        })),
        requiresReview: false,
        minRelevanceThreshold: 30,
      },
      totalAccountsEvaluated,
      requiresReview: false,
      splitRecommendations: [],
    };
  }
  if (result.status === "ABSTAIN") {
    // §8: ABSTAIN preserves candidates + winner-recoverable state.
    // gl.accountNumber is null (compat with legacy nullable shape),
    // BUT gl.candidates still holds the canonical competition so
    // downstream code can inspect candidates[0] for the winner.
    const winner = result.candidates[0];
    return {
      ruleVersion: 2,
      accountNumber: null,
      accountName: null,
      categoryKey: null,
      fsGroupKey: null,
      confidence: null,
      reason: `canonical_ranker_abstain:${result.abstentionReason} · candidate #0 was ${winner.accountNumber} (score=${winner.score})`,
      source: "NONE",
      candidates: glCandidates,
      leaderIsPostable: false,
      leaderPostingBlockers: [],
      autoApprovalEligible: false,
      rationale: {
        selectedAccountId: null,
        selectedConcept: null,
        supportingDocumentEvidence: [],
        supportingTaxonomyEvidence: [],
        contradictedAccountConcepts: [],
        alternativeAccounts: result.candidates.slice(0, 5).map((c) => ({
          accountId: c.accountId,
          accountNumber: c.accountNumber,
          accountName: c.accountName,
          semanticScore: c.score,
          reason: `abstained candidate score ${c.score}`,
        })),
        requiresReview: true,
        minRelevanceThreshold: 30,
      },
      totalAccountsEvaluated,
      requiresReview: true,
      splitRecommendations: [],
    };
  }
  // NO_ELIGIBLE_CANDIDATES / ANALYSIS_FAILURE — empty.
  return emptyGlRecommendation(result.abstentionReason);
}

function emptyGlRecommendation(reason: string): GlRecommendation {
  return {
    ruleVersion: 2,
    accountNumber: null,
    accountName: null,
    categoryKey: null,
    fsGroupKey: null,
    confidence: null,
    reason,
    source: "NONE",
    candidates: [],
    leaderIsPostable: false,
    leaderPostingBlockers: [],
    autoApprovalEligible: false,
    rationale: {
      selectedAccountId: null,
      selectedConcept: null,
      supportingDocumentEvidence: [],
      supportingTaxonomyEvidence: [],
      contradictedAccountConcepts: [],
      alternativeAccounts: [],
      requiresReview: true,
      minRelevanceThreshold: 30,
    },
    totalAccountsEvaluated: 0,
    requiresReview: true,
    splitRecommendations: [],
  };
}

/** Map canonical evidence kind names into the closest legacy GlEvidence kind
 *  names so the compat shape looks reasonable to existing consumers. Phase 4
 *  will replace this with the DECISION/DIAGNOSTIC role model. */
function mapEvidenceKindToLegacy(kind: string): string {
  switch (kind) {
    case "LINE_ITEM_MATCH":
    case "PURPOSE_TYPE_COMPAT":
    case "PURPOSE_TYPE_MISMATCH":
    case "PURPOSE_CATEGORY_HINT":
    case "LINE_ITEM_JACCARD":
      return "LINE_ITEM_MATCH";
    case "ECONOMIC_PURPOSE":
    case "ONTOLOGY_NAME_MATCH":
      return "ECONOMIC_PURPOSE";
    case "DOCUMENT_PHRASE":
      return "DOCUMENT_PHRASE";
    case "PRIOR_CODING":
    case "SUPPLIER_CONTEXT":
      return "PRIOR_CODING";
    case "VENDOR_DEFAULT":
      return "VENDOR_DEFAULT";
    case "CAPITAL_CLASS_MAP":
    case "CAPITAL_ASSET_MATCH":
    case "CAPITAL_ASSET_CATEGORY_BONUS":
    case "RM_EXPENSE_MATCH":
    case "NATURE_COMPAT":
      return "CAPITAL_CLASS_MAP";
    case "ACCOUNT_NAME_SIMILARITY":
    case "FS_GROUP_TAXONOMY":
    case "CATEGORY_TAXONOMY":
      return "NAME_KEYWORD";
    case "SPECIFICITY_BONUS":
      return "SPECIFICITY_BOOST";
    case "NATURE_INCOMPATIBLE":
    case "RM_EXPENSE_CONTRADICTION":
    case "CAPITAL_ACCOUNT_CONTRADICTION":
      return "CONTRADICTION_PENALTY";
    case "DEPARTMENT_AFFINITY":
    case "ACCOUNT_ROLE_MATCH":
      return "NAME_KEYWORD";
    default:
      return "NAME_KEYWORD";
  }
}
