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
import type { CapitalEvidenceDecisionResult } from "./capital-evidence";
import type { ProductIdentityResolution } from "./product-identity-resolution";
import type { PurchasedObjectIdentity } from "./purchased-object-identity";
import type { EligibleAccountView } from "./accounting-nature-compatibility";
import { resolveAccountSemantics } from "./account-semantics";
import { detectCipEvidence } from "./account-semantics/cip-evidence";
import { detectFinancingEvidence } from "./account-semantics/financing-evidence";
import { evaluateCompatibilityGate } from "./account-semantics/compatibility-gate";
import { evaluateRecommendationPolicy, type RecommendationDecision } from "./recommendation-policy";
import { assessCanonicalConfidence, type CanonicalConfidenceAssessment } from "./canonical-confidence";

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
  /** Phase 4R · Phase 3.3 — nature signals folded into canonical input.
   *  Replaces Group B's post-ranking nature_promoted /
   *  nature_scoped_full_coa_search / Phase 2 eligibility recheck
   *  authorities. Nature type compat / mismatch becomes CAPITAL_NATURE
   *  family evidence (soft contradiction) inside canonical scoring. */
  natureLeader?: string;
  natureConfidence?: number;
  natureIsDefensible?: boolean;
  /** Phase 4R · Phase 3.4 (Group C) — capital intelligence signals
   *  used to compute per-account compatibility-gate verdicts BEFORE
   *  canonical ranking. Replaces the Group C capital-aware full-COA
   *  ranker. When all four are provided, the facade runs the gate for
   *  each eligible account and passes PREFERRED / INCOMPATIBLE +
   *  CONTRADICTED verdicts through as per-account scoring evidence
   *  inside the CAPITAL_NATURE family. */
  capitalDecisionFull?: CapitalEvidenceDecisionResult;
  productIdentity?: ProductIdentityResolution;
  purchasedObjects?: ReadonlyArray<PurchasedObjectIdentity>;
  transactionFunctionalSignals?: string[];
  additionalEvidenceTexts?: string[];
  /** Phase 4R · Phase 3.6 (Group E) — field-quality gate result
   *  computed upstream. Consumed by the recommendation-policy
   *  evaluator inside the facade; the facade never selects an account
   *  based on this signal. When true, the canonical winner may be
   *  presented as a recommendation; when false, the projection
   *  returns status ABSTAIN_QUALITY with winner provenance
   *  preserved on `canonicalWinnerAccountNumber` (§4 preservation). */
  fieldQualityEligible?: boolean;
  fieldQualityAbstentionReasons?: readonly string[];
}

/** Runs the canonical ranker and returns a GlRecommendation-shaped
 *  result. This is the single authorised path for GL selection under
 *  Phase 3.2 architecture. */
// Phase 4R · Phase 7 (2026-08-12) — cluster-owned architecture. The
// old `runCanonicalGlRanking` function ran a SECOND canonical
// competition at document scope over the full invoice's queryConcepts
// (including fullDocumentText). The founder's Option A architectural
// correction removes that second competition. Document-level GL
// classification now comes from PROJECTING the per-cluster canonical
// results (see `projectClustersToGlRecommendation` in gl-allocations.ts).
//
// This helper preserves the WHOLE-DOCUMENT contextual signal that the
// old facade computed as a side-effect: the per-account compatibility-
// gate verdict lists (preferred / contradicted). Those verdicts are
// legitimately GLOBAL — the compatibility gate classifies accounts by
// their SEMANTIC ROLE relative to the transaction as a whole (e.g.,
// interest accounts are contradicted when the invoice contains no
// financing evidence anywhere). Fed into every cluster as globalSignals.
//
// The single-authority invariant is preserved: this function does
// NOT run rankCanonical. It only prepares whole-document context.
// Ranking happens per-cluster inside `rankClusterCanonically`.
export interface GlobalContextForClusters {
  totalAccountsEvaluated: number;
  eligibleAccountCount: number;
  hasFinancingEvidence: boolean;
  preferredAccountNumbers: string[];
  contradictedAccountNumbers: string[];
  // Loaded here so callers can reuse the account list for allocation.
  eligibleAccountsForAllocation: ReadonlyArray<{
    id: string; accountNumber: string; name: string;
    categoryKey: string | null; categoryName: string | null;
    fsGroupKey: string | null; fsGroupName: string | null;
    type: string;
  }>;
}

export async function computeGlobalContextForClusters(args: {
  clubId: string;
  expectedDebitRole: ExpectedDebitRoleLocal;
  hasPayrollEvidence: boolean;
  departmentKey: string | null;
  capital: CapitalVsOperatingRecommendation;
  capitalDecisionFull?: CapitalEvidenceDecisionResult;
  productIdentity?: ProductIdentityResolution;
  purchasedObjects?: ReadonlyArray<PurchasedObjectIdentity>;
  transactionFunctionalSignals?: string[];
  additionalEvidenceTexts?: string[];
}): Promise<GlobalContextForClusters> {
  const accountsRaw = await prisma.account.findMany({
    where: { clubId: args.clubId },
    include: {
      category: { select: { key: true, name: true } },
      fsGroup: { select: { key: true, name: true } },
    },
    orderBy: { accountNumber: "asc" },
  });
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
  const eligibleAccountsForAllocation = filtered.eligible.map((a) => ({
    id: a.id,
    accountNumber: a.accountNumber,
    name: a.name,
    categoryKey: a.categoryKey ?? null,
    categoryName: null,
    fsGroupKey: a.fsGroupKey ?? null,
    fsGroupName: null,
    type: a.type,
  }));
  // Compatibility-gate evaluation (§4 global context, per founder).
  const preferred: string[] = [];
  const contradicted: string[] = [];
  let hasFinancingEvidence = false;
  if (args.capitalDecisionFull != null && args.purchasedObjects != null && args.productIdentity != null) {
    const cipEvidence = detectCipEvidence(args.purchasedObjects as PurchasedObjectIdentity[], args.additionalEvidenceTexts ?? []);
    const financingEvidence = detectFinancingEvidence(args.purchasedObjects as PurchasedObjectIdentity[], args.additionalEvidenceTexts ?? []);
    hasFinancingEvidence = financingEvidence.found;
    const txFuncSignals = args.transactionFunctionalSignals
      ?? args.purchasedObjects.map((o) => o.description).filter(Boolean);
    const primaryObjectType = args.productIdentity.selected?.objectType ?? null;
    for (const acct of filtered.eligible) {
      const semantics = resolveAccountSemantics(acct as unknown as EligibleAccountView);
      const gate = evaluateCompatibilityGate({
        semantics,
        capitalDecision: args.capitalDecisionFull.decision,
        productObjectType: primaryObjectType,
        transactionDepartment: args.departmentKey,
        transactionFunctionalSignals: txFuncSignals,
        cipEvidence,
        financingEvidence,
      });
      if (gate.finalVerdict === "PREFERRED") preferred.push(acct.accountNumber);
      if (gate.finalVerdict === "INCOMPATIBLE" || gate.finalVerdict === "CONTRADICTED") {
        contradicted.push(acct.accountNumber);
      }
    }
  }
  return {
    totalAccountsEvaluated: filtered.eligible.length,
    eligibleAccountCount: filtered.eligible.length,
    hasFinancingEvidence,
    preferredAccountNumbers: preferred,
    contradictedAccountNumbers: contradicted,
    eligibleAccountsForAllocation,
  };
}

/**
 * @deprecated Phase 4R · Phase 7 (2026-08-12) — the document-level
 * canonical run has been removed. `analyseIngestedInvoice` no longer
 * calls this function. The cluster-owned architecture in
 * gl-allocations.ts is the sole GL classification path. This function
 * remains as a compat export for callers we haven't migrated yet
 * (none in `src/` at time of Phase 7). Delete after external
 * callers are migrated.
 */
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
    return {
      ...emptyGlRecommendation("No chart of accounts is loaded on this club — cannot recommend a GL account."),
      recommendationStatus: "ABSTAIN_NO_CANDIDATES",
      abstentionCategory: "NO_CANDIDATES",
      abstentionReasons: ["no_chart_of_accounts_loaded"],
      canonicalWinnerAccountNumber: null,
    };
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
    return {
      ...emptyGlRecommendation("No eligible expense or asset accounts survive Phase-2 eligibility for this transaction."),
      recommendationStatus: "ABSTAIN_NO_CANDIDATES",
      abstentionCategory: "NO_CANDIDATES",
      abstentionReasons: ["no_eligible_accounts_after_phase2_filter"],
      canonicalWinnerAccountNumber: null,
    };
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
  // Phase 4R · Phase 3.3 — prefer the nature classifier's authoritative
  // output when the caller provides it (analyse.ts computes
  // classifyAccountingNature BEFORE the canonical call in the Phase 3.3
  // migration). Fall back to the coarse purpose-derived nature for
  // callers that don't feed nature signals directly.
  const natureLeader = args.natureLeader ?? purposeConceptToNature(purposeConcept, args.capital.state);
  const natureConfidence = args.natureConfidence ?? purposeConfidence;
  const natureIsDefensible = args.natureIsDefensible
    ?? (args.purposeQuality === "HIGH" || args.purposeQuality === "MEDIUM");
  // Phase 4R · Phase 3.3 — when the accounting-nature classifier
  // commits to REPAIR_AND_MAINTENANCE (defensibly), promote the
  // canonical-ranker capitalDecision to REPAIR_MAINTENANCE so the
  // RM_EXPENSE_MATCH / CAPITAL_ACCOUNT_CONTRADICTION observations
  // fire. This replaces Group B's post-ranking rm/asset steering
  // with pre-ranking scoring evidence — no post-ranking selector.
  const capitalDecisionResolved: "CAPITAL_CANDIDATE" | "OPERATING" | "REPAIR_MAINTENANCE" | "UNRESOLVED" | null =
    (natureIsDefensible && (natureLeader === "REPAIR_AND_MAINTENANCE" || natureLeader === "REPAIR_MAINTENANCE"))
      ? "REPAIR_MAINTENANCE"
      : capitalDecisionFromState(args.capital.state);
  const capitalConfidenceResolved =
    args.capital.state === "CAPITAL" ? 80
    : args.capital.state === "OPERATING" ? 80
    : (capitalDecisionResolved === "REPAIR_MAINTENANCE" ? natureConfidence : 0);
  // Phase 4R · Phase 3.5 (Group D) — durable-asset context signal
  // computed from purchased-object evidence. Same rule the deleted
  // Slice 5.3 object-authority guard used, moved here so it becomes
  // pre-ranking scoring evidence via NormalisedTransactionInterpretation.
  let hasHighQualityDurableAssetContext = false;
  let hasFinancingEvidenceForRanker = false;
  if (args.purchasedObjects != null && args.purchasedObjects.length > 0) {
    const primary = [...args.purchasedObjects]
      .sort((a, b) => (b.extension ?? 0) - (a.extension ?? 0))[0];
    hasHighQualityDurableAssetContext = !!primary
      && primary.evidenceQuality === "HIGH"
      && (
        primary.objectRole === "COMPLETE_MACHINE"
        || primary.objectRole === "SERIALIZED_COMPONENT"
        || (primary.objectRole === "UNKNOWN"
            && primary.brandCandidates.length > 0
            && primary.modelCandidates.length > 0)
      );
  }
  // Phase 4R · Phase 3.4 (Group C) — pre-ranking compatibility-gate
  // evaluation. Runs the founder-approved compatibility gate for every
  // eligible account against the capital decision + product identity +
  // purchased-object context + CIP/financing evidence + department
  // functional signals. Emits two lists (preferred + contradicted)
  // that the canonical ranker consumes as CAPITAL_NATURE-family
  // observations. This REPLACES the Group C capital-aware full-COA
  // ranker whose winner-selection role was a second competition; the
  // gate here does not select an account, only scores per-account
  // features.
  let preferredAccountNumbers: string[] | undefined;
  let contradictedAccountNumbers: string[] | undefined;
  if (args.capitalDecisionFull != null && args.purchasedObjects != null && args.productIdentity != null) {
    const cipEvidence = detectCipEvidence(args.purchasedObjects as PurchasedObjectIdentity[], args.additionalEvidenceTexts ?? []);
    const financingEvidence = detectFinancingEvidence(args.purchasedObjects as PurchasedObjectIdentity[], args.additionalEvidenceTexts ?? []);
    hasFinancingEvidenceForRanker = financingEvidence.found;
    const txFuncSignals = args.transactionFunctionalSignals
      ?? args.purchasedObjects.map((o) => o.description).filter(Boolean);
    const primaryObjectType = args.productIdentity.selected?.objectType ?? null;
    const preferred: string[] = [];
    const contradicted: string[] = [];
    for (const acct of filtered.eligible) {
      // filtered.eligible has the full EligibleAccountView shape that
      // resolveAccountSemantics + evaluateCompatibilityGate consume.
      const semantics = resolveAccountSemantics(acct as unknown as EligibleAccountView);
      const gate = evaluateCompatibilityGate({
        semantics,
        capitalDecision: args.capitalDecisionFull.decision,
        productObjectType: primaryObjectType,
        transactionDepartment: args.departmentKey,
        transactionFunctionalSignals: txFuncSignals,
        cipEvidence,
        financingEvidence,
      });
      if (gate.finalVerdict === "PREFERRED") preferred.push(acct.accountNumber);
      if (gate.finalVerdict === "INCOMPATIBLE" || gate.finalVerdict === "CONTRADICTED") {
        contradicted.push(acct.accountNumber);
      }
    }
    preferredAccountNumbers = preferred;
    contradictedAccountNumbers = contradicted;
  }
  const transaction: NormalisedTransactionInterpretation = {
    purposeConcept,
    purposeConfidence,
    purposeQuality: args.purposeQuality,
    capitalDecision: capitalDecisionResolved,
    capitalConfidence: capitalConfidenceResolved,
    natureLeader,
    natureConfidence,
    natureIsDefensible,
    preferredAccountNumbers,
    contradictedAccountNumbers,
    hasHighQualityDurableAssetContext,
    hasFinancingEvidence: hasFinancingEvidenceForRanker,
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

  // Phase 4R · Phase 3.6 (Group E) — recommendation-quality policy.
  // Evaluated AFTER canonical ranking but BEFORE projection so the
  // projected GlRecommendation carries an explicit recommendation
  // status. This module never selects an account; it only reads
  // canonical status + field-quality gate result and decides whether
  // the canonical winner may be presented as an automated
  // recommendation. Winner provenance is preserved on
  // `canonicalWinnerAccountNumber` regardless of ABSTAIN reason (§4).
  const canonicalStatus = result.status;
  const canonicalWinnerAccountNumber = (canonicalStatus === "RECOMMEND" || canonicalStatus === "ABSTAIN")
    ? result.candidates[0]?.accountNumber ?? null
    : null;
  const canonicalAbstentionReason = canonicalStatus === "ABSTAIN"
    ? result.abstentionReason
    : canonicalStatus === "NO_ELIGIBLE_CANDIDATES" || canonicalStatus === "ANALYSIS_FAILURE"
      ? result.abstentionReason
      : null;
  const recommendation = evaluateRecommendationPolicy({
    canonicalStatus,
    canonicalWinnerAccountNumber,
    canonicalAbstentionReason,
    fieldQualityEligible: args.fieldQualityEligible ?? true,
    fieldQualityAbstentionReasons: args.fieldQualityAbstentionReasons ?? [],
  });

  // Phase 4R · Phase 4 (2026-08-11) — canonical confidence assessment.
  // Derives HIGH/MODERATE/LOW/REVIEW_REQUIRED from the same canonical
  // competition + recommendation decision. Genuine competitors are
  // qualified from candidates only — no parallel alternate pool.
  const confidence = assessCanonicalConfidence({ canonical: result, recommendation });

  return projectCanonicalToGl(result, filtered.eligible.length, recommendation, confidence);
}

/** Pure projection: CanonicalRankerResult → GlRecommendation.
 *  §11: no business logic, no account selection.
 *  Phase 3.6: accepts a RecommendationDecision from the policy
 *  evaluator so recommendationStatus/abstentionCategory/reasons +
 *  winner-provenance are projected consistently. */
function projectCanonicalToGl(
  result: CanonicalRankerResult,
  totalAccountsEvaluated: number,
  recommendation: RecommendationDecision,
  confidence: CanonicalConfidenceAssessment,
): GlRecommendation {
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
    // Phase 4R · Phase 3.6 (Group E): even though canonical returned
    // RECOMMEND, the recommendation-policy may downgrade to
    // ABSTAIN_QUALITY when upstream extraction is too weak. Legacy
    // compat: project accountNumber = null in that case while
    // preserving candidates + winner-provenance (§10). The policy
    // NEVER selects a different account — it only decides whether
    // to expose the canonical winner as an automated recommendation.
    const projectAccount = recommendation.status === "RECOMMEND";
    return {
      ruleVersion: 2,
      accountNumber: projectAccount ? winner.accountNumber : null,
      accountName: projectAccount ? winner.accountName : null,
      categoryKey: projectAccount ? winner.categoryKey : null,
      fsGroupKey: projectAccount ? winner.fsGroupKey : null,
      confidence: projectAccount ? winner.score : null,
      reason: projectAccount
        ? `canonical_ranker:${result.candidates.length}candidates:winner=${winner.accountNumber}(score=${winner.score},margin=${result.separation.marginToRunnerUp}${result.separation.isDeterministicTieBreak ? ",tie" : ""})`
        : recommendation.reason,
      source: projectAccount ? "SEMANTIC_MATCH" : "NONE",
      candidates: glCandidates,
      leaderIsPostable: projectAccount ? winner.postable : false,
      leaderPostingBlockers: projectAccount ? [...winner.postingBlockers] as PostingBlocker[] : [],
      autoApprovalEligible: recommendation.autoApprovalEligible && projectAccount,
      recommendationStatus: recommendation.status,
      abstentionCategory: recommendation.abstentionCategory,
      abstentionReasons: recommendation.abstentionReasons,
      canonicalWinnerAccountNumber: recommendation.canonicalWinnerAccountNumber,
      canonicalConfidence: confidence,
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
    // Phase 3.6: recommendation status is either ABSTAIN_QUALITY
    // (field-quality gate rejected) or ABSTAIN_AMBIGUITY (canonical
    // itself abstained). Both preserve candidates + canonicalWinner.
    const winner = result.candidates[0];
    return {
      ruleVersion: 2,
      accountNumber: null,
      accountName: null,
      categoryKey: null,
      fsGroupKey: null,
      confidence: null,
      reason: recommendation.status === "ABSTAIN_QUALITY"
        ? recommendation.reason
        : `canonical_ranker_abstain:${result.abstentionReason} · candidate #0 was ${winner.accountNumber} (score=${winner.score})`,
      source: "NONE",
      candidates: glCandidates,
      leaderIsPostable: false,
      leaderPostingBlockers: [],
      autoApprovalEligible: false,
      recommendationStatus: recommendation.status,
      abstentionCategory: recommendation.abstentionCategory,
      abstentionReasons: recommendation.abstentionReasons,
      canonicalWinnerAccountNumber: recommendation.canonicalWinnerAccountNumber,
      canonicalConfidence: confidence,
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
  return {
    ...emptyGlRecommendation(recommendation.reason),
    recommendationStatus: recommendation.status,
    abstentionCategory: recommendation.abstentionCategory,
    abstentionReasons: recommendation.abstentionReasons,
    canonicalWinnerAccountNumber: recommendation.canonicalWinnerAccountNumber,
    canonicalConfidence: confidence,
  };
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
    case "NATURE_GATE_PREFERRED":
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
    case "NATURE_GATE_CONTRADICTED":
    case "OBJECT_ROLE_CONTRADICTION":
      return "CONTRADICTION_PENALTY";
    case "DEPARTMENT_AFFINITY":
    case "ACCOUNT_ROLE_MATCH":
      return "NAME_KEYWORD";
    default:
      return "NAME_KEYWORD";
  }
}
