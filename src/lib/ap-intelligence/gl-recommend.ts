// Sprint 3 · Checkpoint 15U (2026-07-28) — GL-account recommendation
// rebuilt as a deterministic, full-tenant Chart of Accounts ranking
// problem.
//
// Stage A — eligibility: every active, non-header, EXPENSE or ASSET
// account on the current tenant enters the ranking. Fund-applicability
// and other config issues remain SEPARATE posting blockers.
//
// Stage B — semantic ranking: every eligible account receives a
// score built from the same normalized evidence model:
//
//   Reconstructed invoice line-item descriptions       strongest
//   Dominant economic-purpose concept                   strong
//   Account-name semantic similarity                    strong
//   FS-group and category taxonomy                      supporting
//   Document section and recurring-service context      medium
//   Vendor-specific historical coding                   supporting
//   Tenant-wide posting frequency                       weak tie-break only
//   Supplier identity                                   weak context only
//   Filename / sender / email subject                   ZERO
//
// Deterministic sort:
//   1. semanticScore descending
//   2. specificityScore descending
//   3. directLineMatch descending
//   4. taxonomySimilarity descending
//   5. historicalVendorScore descending
//   6. accountNumber ascending (final deterministic tie-break;
//      does NOT influence semantic scoring)
//
// No score caps that collapse materially different evidence. No
// hand-authored SEMANTIC_GROUPS gating whether an account enters
// meaningful scoring. Every account is scored uniformly.

import { prisma } from "@/lib/prisma";
import type { CapitalClass, CapitalVsOperatingState, ExtractedInvoice } from "./types";
import type { PurposeCandidate } from "./economic-purpose";
import type { LineItem } from "./line-items-extract";
import {
  extractQueryConcepts,
  dominantQueryConcept,
  type QueryConcept,
} from "./gl-query-concepts";
import {
  extractConceptsForAccount,
  type AccountView,
  type AccountConceptMatch,
} from "./gl-account-concepts";
import { conceptRelatedness, isContradiction, CONCEPT_BY_ID } from "./gl-concepts";
import {
  applyPhase0SafetyContainment,
  isPhase0SafetyEnabled,
  type AccountSafetyView,
} from "./eligibility/phase0-safety";
import {
  filterEligibleAccounts,
  isPhase2EligibilityEnabled,
  type AccountEligibilityView,
  type AccountEligibilityResult,
  type AccountingTransactionContext,
} from "@/lib/accounting/eligibility";

const RULE_VERSION = 3;

// ---------------------------------------------------------------------------
// Public shape (kept compatible with pre-15U callers)
// ---------------------------------------------------------------------------

export interface GlEvidence {
  kind:
    | "VENDOR_DEFAULT"
    | "PRIOR_CODING"
    | "NAME_KEYWORD"
    | "CATEGORY_MATCH"
    | "FS_GROUP_MATCH"
    | "CAPITAL_CLASS_MAP"
    | "ECONOMIC_PURPOSE"
    | "DOCUMENT_PHRASE"
    | "LINE_ITEM_MATCH"
    | "SPECIFICITY_BOOST"
    | "CONTRADICTION_PENALTY";
  description: string;
  score: number;
}

export interface GlCandidate {
  accountId: string;
  accountNumber: string;
  accountName: string;
  categoryKey: string | null;
  fsGroupKey: string | null;
  confidence: number;
  evidence: GlEvidence[];
  postable: boolean;
  postingBlockers: PostingBlocker[];
}

export type PostingBlocker =
  | "INACTIVE"
  | "HEADER_ACCOUNT"
  | "MANUAL_POSTING_DISALLOWED"
  | "FUND_APPLICABILITY_UNMAPPED";

// Sprint 3 · Checkpoint 15U — structured rationale (§12). Kept on
// the analyser output for tests, diagnostics and auditability.
export interface GlRationale {
  selectedAccountId: string | null;
  selectedConcept: string | null;             // dominant query concept id
  supportingDocumentEvidence: string[];       // human-readable evidence snippets
  supportingTaxonomyEvidence: string[];       // account-side taxonomy hits
  contradictedAccountConcepts: string[];      // concept ids present on the account that CONTRADICT the query
  alternativeAccounts: Array<{
    accountId: string;
    accountNumber: string;
    accountName: string;
    semanticScore: number;
    reason: string;
  }>;
  requiresReview: boolean;
  minRelevanceThreshold: number;
}

// Sprint 3 · Checkpoint 15U — split-account readiness (§13). Optional
// group-level recommendations for future multi-debit-leg AP posting.
export interface SplitRecommendation {
  groupLabel: string;                         // e.g. "Membership fees"
  lineItemDescriptions: string[];
  accountId: string;
  accountNumber: string;
  accountName: string;
  amount: number;
}

export interface GlRecommendation {
  ruleVersion: number;
  accountNumber: string | null;
  accountName: string | null;
  categoryKey: string | null;
  fsGroupKey: string | null;
  confidence: number | null;
  reason: string;
  source: "CAPITAL_CLASS_MAP" | "VENDOR_DEFAULT" | "PRIOR_CODING" | "NAME_KEYWORD" | "ECONOMIC_PURPOSE" | "SEMANTIC_MATCH" | "NONE";
  candidates: GlCandidate[];
  leaderIsPostable: boolean;
  leaderPostingBlockers: PostingBlocker[];
  autoApprovalEligible: boolean;
  // 15U additions:
  rationale: GlRationale;
  totalAccountsEvaluated: number;
  requiresReview: boolean;
  splitRecommendations: SplitRecommendation[];
}

export interface GlRecommendationArgs {
  clubId: string;
  vendorId: string | null;
  capitalState: CapitalVsOperatingState;
  capitalClass: CapitalClass | null;
  extraction?: Pick<ExtractedInvoice, "vendor" | "description" | "lineItems"> | null;
  economicPurposeCandidates?: PurposeCandidate[] | null;
  // 15U — full extracted PDF text so the ranker's document-phrase
  // channel can fire. Optional (may be null on non-PDF paths).
  fullDocumentText?: string | null;
  // 15U — extracted line items with tax classification. When
  // supplied, replaces `extraction.lineItems` for query-concept
  // extraction (the extended LineItem shape carries description +
  // amount + tax treatment; ExtractedInvoice.lineItems is a
  // simpler subset).
  extractedLineItems?: LineItem[] | null;
  // Post-16H Phase 2 (2026-08-06) — transaction context handed to
  // the accounting eligibility service. When null the eligibility
  // layer falls back to UNKNOWN and applies conservative operating-
  // AP rules. `capitalizationEvidence` optional; the ranker's
  // existing capital classifier composes it upstream.
  eligibilityContext?: {
    expectedDebitRole: import("@/lib/accounting/eligibility").ExpectedDebitRole;
    departmentHint?: string | null;
    capitalizationEvidence?: { supported: boolean; confidence: number };
  } | null;
}

// ---------------------------------------------------------------------------
// Score-component shape retained on each ranked candidate for diagnostics
// ---------------------------------------------------------------------------

interface ScoreComponents {
  directLineMatch: number;
  economicPurposeMatch: number;
  accountNameSimilarity: number;
  fsGroupTaxonomySimilarity: number;
  categoryTaxonomySimilarity: number;
  documentPhraseScore: number;
  specificityScore: number;
  historicalVendorScore: number;
  supplierContextScore: number;
  contradictionPenalty: number;
  semanticScore: number;
}

interface ScoredAccount {
  account: AccountView;
  components: ScoreComponents;
  matchedAccountConcepts: AccountConceptMatch[];
  strongestQueryEvidence: QueryConcept[];
  contradictedConcepts: string[];
  postable: boolean;
  postingBlockers: PostingBlocker[];
  evidence: GlEvidence[];
}

// ---------------------------------------------------------------------------
// Constants (calibrated against the regression suite — see §10 + §15)
// ---------------------------------------------------------------------------

// Threshold below which no confident recommendation is made. Chosen
// so the "genuine printing invoice" scenario clears it (score ~50)
// but the "OXIO recurring service" scenario CANNOT trigger a
// confident Printing recommendation (score ~10). Verified in
// tests/c15u-recommender-ranking.test.ts.
const MIN_RELEVANCE_THRESHOLD = 40;

const AUTO_APPROVAL_MIN_CONFIDENCE = 85;

// Specificity bonus applied when the query's dominant concept
// matches an account concept at depth >= 2 (a leaf-ish taxonomy
// node like "professional_membership_dues" beats depth-1 parents
// like "memberships_and_subscriptions").
const SPECIFICITY_BONUS_PER_DEPTH = 15;

const CONTRADICTION_PENALTY = 40;

// ---------------------------------------------------------------------------
// Public entrypoint
// ---------------------------------------------------------------------------

export async function recommendGlAccount(args: GlRecommendationArgs): Promise<GlRecommendation> {
  // Load the tenant COA once. `orderBy: { accountNumber: 'asc' }` is
  // COSMETIC only — semantic scoring is independent of order; the
  // deterministic sort below re-orders anyway. See regression test
  // c15u-recommender-determinism for proof.
  const accountsRaw = await prisma.account.findMany({
    where: { clubId: args.clubId },
    include: {
      category: { select: { key: true, name: true } },
      fsGroup: { select: { key: true, name: true } },
    },
    orderBy: { accountNumber: "asc" },
  });
  if (accountsRaw.length === 0) {
    return emptyRecommendation("No chart of accounts is loaded on this club — cannot recommend a GL account.", 0);
  }

  // Stage A — Post-16H Phase 2 (2026-08-06) — permanent accounting
  // eligibility gate. Replaces the pre-Phase-2 three-field filter
  // (isActive && !isHeader && type in {EXPENSE,ASSET}) with the
  // canonical `filterEligibleAccounts` service. The service applies
  // structural rules (control / bank / cash / revenue / equity /
  // liability / contra-asset / normal-balance contradiction / etc.)
  // AND nature-conditioned rules (asset excluded from ordinary
  // operating AP unless capitalizationEvidence supports it), then
  // returns the eligible candidate pool + a rejected list with
  // machine-readable reasons.
  //
  // The pre-Phase-2 filter shape is preserved WHEN the
  // AP_INTELLIGENCE_PHASE2_ELIGIBILITY env flag is disabled so the
  // benchmark harness can capture a Phase-2-off baseline for the
  // shadow-comparison measurement.
  const phase2Enabled = isPhase2EligibilityEnabled();
  const eligibilityCtx: AccountingTransactionContext = {
    transactionKind: "AP_INVOICE",
    expectedDebitRole: args.eligibilityContext?.expectedDebitRole ?? "UNKNOWN",
    departmentHint: args.eligibilityContext?.departmentHint ?? null,
    capitalizationEvidence: args.eligibilityContext?.capitalizationEvidence,
  };

  let eligibilityRejected: AccountEligibilityResult[] = [];
  let eligibilityVerdicts: Map<string, AccountEligibilityResult> = new Map();
  const eligibleAccounts: AccountView[] = (phase2Enabled
    ? (() => {
        const views: AccountEligibilityView[] = accountsRaw.map((a) => ({
          id: a.id, accountNumber: a.accountNumber, name: a.name,
          type: a.type, normalBalance: a.normalBalance,
          isActive: a.isActive, isHeader: a.isHeader,
          allowManualPosting: a.allowManualPosting,
          isControlAccount: a.isControlAccount,
          isBankAccount: a.isBankAccount, isCashAccount: a.isCashAccount,
          archivedAt: a.archivedAt, fundApplicability: a.fundApplicability,
          categoryKey: a.category?.key ?? null,
          fsGroupKey: a.fsGroup?.key ?? null,
        }));
        const res = filterEligibleAccounts(views, eligibilityCtx);
        eligibilityRejected = res.rejected;
        eligibilityVerdicts = res.verdictsByAccountId;
        return res.eligible;
      })()
    : accountsRaw
        .filter((a) => a.isActive && !a.isHeader && (a.type === "EXPENSE" || a.type === "ASSET"))
  ).map((a) => ({
    id: a.id,
    accountNumber: a.accountNumber,
    name: a.name,
    categoryKey: (a as any).category?.key ?? (a as any).categoryKey ?? null,
    categoryName: (a as any).category?.name ?? null,
    fsGroupKey: (a as any).fsGroup?.key ?? (a as any).fsGroupKey ?? null,
    fsGroupName: (a as any).fsGroup?.name ?? null,
  }));

  const totalAccountsEvaluated = eligibleAccounts.length;
  // Reserved for downstream inspection — future callers can read
  // the Phase 2 verdicts via the returned recommendation's
  // rationale to explain WHY an account was excluded.
  void eligibilityRejected; void eligibilityVerdicts;

  // Look up vendor history — for a matched vendor with prior coding
  // or a default expense account, gather the CONCEPTS observed and
  // pass them as supporting-tier evidence (§11). New vendors → empty.
  const { vendorHistoryConceptIds, vendorDefaultAccountId } = await loadVendorHistory(
    args.clubId,
    args.vendorId,
    accountsRaw,
  );

  // Sprint 3 · Checkpoint 15W §5+§6 — if the analyser handed us
  // nothing (no vendor, no line items, no extraction description,
  // no full document text, no supplied purpose candidates), the
  // ranker MUST NOT invent a recommendation. Returning the smallest
  // account number as a deterministic tie-break was producing
  // "1000 Petty Cash" for image-only PDFs — a fabricated GL with
  // ZERO document evidence. Abstain cleanly instead.
  const noEvidenceProvided =
    (!args.extraction?.vendor?.guessedName || args.extraction.vendor.guessedName.trim() === "")
    && (!args.extraction?.description)
    && (args.extractedLineItems == null || args.extractedLineItems.length === 0)
    && (args.extraction?.lineItems == null || args.extraction.lineItems.length === 0)
    && (!args.fullDocumentText || args.fullDocumentText.trim().length === 0)
    && (args.economicPurposeCandidates == null || args.economicPurposeCandidates.length === 0)
    && !args.vendorId;
  if (noEvidenceProvided) {
    return emptyRecommendation(
      "No document evidence available — extraction produced no vendor name, line items, or descriptive text. No GL recommendation can be supported.",
      totalAccountsEvaluated,
    );
  }

  // Extract query concepts (weighted by evidence hierarchy §4).
  // When callers don't supply the richer LineItem[] (with tax
  // classification etc.) fall back to `extraction.lineItems` — the
  // description alone is enough for the query-concept token match.
  const lineItemsForQuery = args.extractedLineItems
    ?? (args.extraction?.lineItems ?? []).map((l, idx) => ({
      description: l.description ?? "",
      quantity: null,
      unitPrice: null,
      amount: Number(l.amount ?? "0"),
      taxRate: null,
      taxAmount: null,
      taxTreatment: "unknown" as const,
      evidence: ["amount_only" as const],
      confidence: 40,
      lineNo: idx,
    }));
  const queryConcepts = extractQueryConcepts({
    lineItems: lineItemsForQuery,
    economicPurposeCandidates: args.economicPurposeCandidates ?? null,
    fullDocumentText: args.fullDocumentText ?? null,
    supplierName: args.extraction?.vendor?.guessedName ?? null,
    vendorHistoryConceptIds,
  });
  const dominant = dominantQueryConcept(queryConcepts);

  // Stage B — score every eligible account.
  const scored: ScoredAccount[] = eligibleAccounts.map((account) => {
    const acctRaw = accountsRaw.find((a) => a.id === account.id);
    return scoreAccount({
      account,
      queryConcepts,
      dominant,
      vendorDefaultAccountId,
      capitalState: args.capitalState,
      postingBlockers: acctRaw ? accountPostingBlockers(acctRaw) : [],
    });
  });

  // Deterministic sort — six-tier tie-break sequence.
  scored.sort(deterministicCompare);

  const top = scored[0] ?? null;
  const requiresReview = !top || top.components.semanticScore < MIN_RELEVANCE_THRESHOLD;
  const topCandidates = scored.slice(0, 5);

  // Sprint 3 · Checkpoint 15W §5 — when NO account has any semantic
  // score, the deterministic accountNumber tie-break was surfacing
  // "1000 Petty Cash" as a confident recommendation. That is
  // fabrication. When the ranker cannot support ANY account with
  // positive evidence, return an empty recommendation rather than
  // let the leading candidate become the projection's category.
  const zeroEvidenceEverywhere = queryConcepts.length === 0
    || scored.every((s) => s.components.semanticScore === 0);
  if (zeroEvidenceEverywhere) {
    return emptyRecommendation(
      "Ranker found no account with supporting evidence — no GL recommendation can be made from this document.",
      totalAccountsEvaluated,
    );
  }

  const rationale = buildRationale({
    scored,
    dominant,
    queryConcepts,
    requiresReview,
  });

  const splitRecommendations = buildSplitRecommendations({
    lineItems: args.extractedLineItems ?? [],
    accounts: eligibleAccounts,
    accountsRaw,
    queryConcepts,
  });

  if (!top) {
    return emptyRecommendation(
      "No eligible expense or asset accounts on this club's chart of accounts.",
      totalAccountsEvaluated,
    );
  }

  const finalRec = finaliseRecommendation({
    top,
    topCandidates,
    rationale,
    totalAccountsEvaluated,
    requiresReview,
    splitRecommendations,
  });

  // Sprint 3 · Checkpoint 16H rejection #4 → audit approval
  // (2026-08-06) — Phase 0 safety containment. Runs AFTER the
  // ranker has produced its answer; refuses to surface a leader
  // that is accounting-invalid for an ordinary AP debit. Uses
  // structural schema fields only; does NOT substitute the next
  // candidate. When suppressed, returns an abstained
  // recommendation. The env flag AP_INTELLIGENCE_PHASE0_SAFETY=0
  // is available so the benchmark harness can capture a baseline
  // WITHOUT this guard for measurement — the flag is not a
  // production posture. See src/lib/ap-intelligence/eligibility/
  // phase0-safety.ts for the rule set.
  if (isPhase0SafetyEnabled()) {
    const accountsByNumber = new Map<string, AccountSafetyView>(
      accountsRaw.map((a) => [a.accountNumber, {
        accountNumber: a.accountNumber,
        name: a.name,
        type: a.type,
        normalBalance: a.normalBalance,
        isActive: a.isActive,
        isHeader: a.isHeader,
        allowManualPosting: a.allowManualPosting,
        isControlAccount: a.isControlAccount,
        isBankAccount: a.isBankAccount,
        isCashAccount: a.isCashAccount,
      }]),
    );
    const guarded = applyPhase0SafetyContainment(finalRec, accountsByNumber);
    return guarded.recommendation;
  }
  return finalRec;
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

interface ScoreAccountArgs {
  account: AccountView;
  queryConcepts: QueryConcept[];
  dominant: QueryConcept | null;
  vendorDefaultAccountId: string | null;
  capitalState: CapitalVsOperatingState;
  postingBlockers: PostingBlocker[];
}

function scoreAccount(args: ScoreAccountArgs): ScoredAccount {
  const { account, queryConcepts, dominant, vendorDefaultAccountId, postingBlockers } = args;

  // Extract the concepts this account SHAPES to (based on its name +
  // FS group + category). Every account gets a list (may be empty).
  const accountConcepts = extractConceptsForAccount(account);

  const components: ScoreComponents = {
    directLineMatch: 0,
    economicPurposeMatch: 0,
    accountNameSimilarity: 0,
    fsGroupTaxonomySimilarity: 0,
    categoryTaxonomySimilarity: 0,
    documentPhraseScore: 0,
    specificityScore: 0,
    historicalVendorScore: 0,
    supplierContextScore: 0,
    contradictionPenalty: 0,
    semanticScore: 0,
  };
  const evidence: GlEvidence[] = [];
  const contradictedConcepts: string[] = [];
  const strongestQueryEvidence: QueryConcept[] = [];

  // For each (query concept, account concept) pair, compute a
  // relatedness score + weight by evidence source. Aggregate into
  // per-component buckets so diagnostics can explain WHY.
  for (const qc of queryConcepts) {
    let bestContribution = 0;
    let bestAccountConcept: AccountConceptMatch | null = null;

    for (const ac of accountConcepts) {
      const rel = conceptRelatedness(qc.conceptId, ac.conceptId);
      if (rel === 0) continue;
      // Account-side match strength (0..100) × query-side weight
      // (source-weighted 0..30) × relatedness (0..1). Scaled so a
      // perfect line-item ↔ account-name match on a specific concept
      // produces ~90 (from 30 × 100 × 1.0 / 33).
      const contribution = (qc.weight * ac.totalMatchStrength * rel) / (100 * 33);
      if (contribution > bestContribution) {
        bestContribution = contribution;
        bestAccountConcept = ac;
      }
    }

    if (bestContribution > 0 && bestAccountConcept) {
      // Attribute contribution to the right component bucket.
      switch (qc.source) {
        case "line_item_description":
          components.directLineMatch += bestContribution;
          break;
        case "economic_purpose":
          components.economicPurposeMatch += bestContribution;
          break;
        case "document_phrase":
          components.documentPhraseScore += bestContribution;
          break;
        case "vendor_history":
          components.historicalVendorScore += bestContribution;
          break;
        case "supplier_identity":
          components.supplierContextScore += bestContribution;
          break;
      }
      evidence.push({
        kind: qc.source === "line_item_description" ? "LINE_ITEM_MATCH"
          : qc.source === "economic_purpose" ? "ECONOMIC_PURPOSE"
          : qc.source === "document_phrase" ? "DOCUMENT_PHRASE"
          : qc.source === "vendor_history" ? "PRIOR_CODING"
          : "NAME_KEYWORD",
        description: `${qc.evidenceSnippet} → account concept "${bestAccountConcept.concept.canonicalName}" (relatedness ${Math.round(bestContribution)}).`,
        score: Math.round(bestContribution),
      });
      if (bestContribution >= 8) strongestQueryEvidence.push(qc);
    }
  }

  // Account-name + taxonomy similarity to the dominant query concept
  // (separate from the per-query bucket above so a strong ACCOUNT-side
  // match still counts even when the query has weaker per-source
  // matches).
  if (dominant) {
    for (const ac of accountConcepts) {
      const rel = conceptRelatedness(dominant.conceptId, ac.conceptId);
      if (rel === 0) continue;
      const contribution = (ac.totalMatchStrength * rel) / 100;
      components.accountNameSimilarity += ac.nameMatchStrength * rel / 100;
      components.fsGroupTaxonomySimilarity += ac.fsGroupMatchStrength * rel / 100;
      components.categoryTaxonomySimilarity += ac.categoryMatchStrength * rel / 100;

      // Specificity bonus — deeper concepts win over parents.
      if (rel === 100 && ac.concept.depth >= 2) {
        components.specificityScore += SPECIFICITY_BONUS_PER_DEPTH * (ac.concept.depth - 1);
      }
    }
  }

  // Contradiction penalty — if any account concept contradicts a
  // strongly-supported query concept, subtract a penalty. Prevents
  // e.g. Score Cards & Printing (contradicts connectivity/utility)
  // from winning when the invoice supports connectivity.
  for (const ac of accountConcepts) {
    for (const qc of queryConcepts) {
      if (qc.weight < 6) continue; // ignore weak query signals
      if (isContradiction(qc.conceptId, ac.conceptId)) {
        components.contradictionPenalty += CONTRADICTION_PENALTY;
        contradictedConcepts.push(ac.conceptId);
        evidence.push({
          kind: "CONTRADICTION_PENALTY",
          description: `Account is "${ac.concept.canonicalName}" but invoice supports "${qc.concept.canonicalName}" — subtracting penalty.`,
          score: -CONTRADICTION_PENALTY,
        });
        break;
      }
    }
  }

  // Historical vendor default — applied as a SUPPORTING boost on the
  // specific historical account. Cap so current invoice evidence can
  // overcome a contradictory history (§11).
  if (vendorDefaultAccountId && account.id === vendorDefaultAccountId) {
    const boost = 15;
    components.historicalVendorScore += boost;
    evidence.push({
      kind: "VENDOR_DEFAULT",
      description: "Vendor has this GL as its default expense account.",
      score: boost,
    });
  }

  // Capital-class hint (asset-side only, applies only when the
  // analyser classified this invoice as CAPITAL).
  if (args.capitalState === "CAPITAL") {
    // Historical hint retained as a small supporting boost on ASSET
    // accounts whose names hint at capital vocabulary. Deliberately
    // conservative — capital classification is a separate signal
    // handled by classifyCapitalVsOperating.
    // (No specific implementation this checkpoint — placeholder for
    // the capital-class role integration.)
  }

  // Final semantic score — sum of positive components minus the
  // contradiction penalty. NOT capped at 95 (§2). Reported verbatim
  // so diagnostics can distinguish materially different candidates.
  components.semanticScore = Math.max(0, Math.round(
    components.directLineMatch
    + components.economicPurposeMatch
    + components.accountNameSimilarity
    + components.fsGroupTaxonomySimilarity * 0.5
    + components.categoryTaxonomySimilarity * 0.3
    + components.documentPhraseScore
    + components.specificityScore
    + components.historicalVendorScore
    + components.supplierContextScore
    - components.contradictionPenalty,
  ));

  return {
    account,
    components,
    matchedAccountConcepts: accountConcepts,
    strongestQueryEvidence,
    contradictedConcepts,
    postable: postingBlockers.length === 0,
    postingBlockers,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Deterministic sort — six-tier tie-break sequence (§1)
// ---------------------------------------------------------------------------

function deterministicCompare(a: ScoredAccount, b: ScoredAccount): number {
  if (b.components.semanticScore !== a.components.semanticScore)
    return b.components.semanticScore - a.components.semanticScore;
  if (b.components.specificityScore !== a.components.specificityScore)
    return b.components.specificityScore - a.components.specificityScore;
  if (b.components.directLineMatch !== a.components.directLineMatch)
    return b.components.directLineMatch - a.components.directLineMatch;
  const bTaxonomy = b.components.fsGroupTaxonomySimilarity + b.components.categoryTaxonomySimilarity;
  const aTaxonomy = a.components.fsGroupTaxonomySimilarity + a.components.categoryTaxonomySimilarity;
  if (bTaxonomy !== aTaxonomy) return bTaxonomy - aTaxonomy;
  if (b.components.historicalVendorScore !== a.components.historicalVendorScore)
    return b.components.historicalVendorScore - a.components.historicalVendorScore;
  return a.account.accountNumber.localeCompare(b.account.accountNumber);
}

// ---------------------------------------------------------------------------
// Vendor history — load prior coding as SUPPORTING evidence (§11)
// ---------------------------------------------------------------------------

async function loadVendorHistory(
  clubId: string,
  vendorId: string | null,
  accountsRaw: Array<{ id: string; category: { key: string } | null; fsGroup: { key: string } | null; name: string }>,
): Promise<{ vendorHistoryConceptIds: string[]; vendorDefaultAccountId: string | null }> {
  if (!vendorId) return { vendorHistoryConceptIds: [], vendorDefaultAccountId: null };
  const vendor = await prisma.vendor.findFirst({
    where: { id: vendorId, clubId },
    select: { defaultExpenseAccountId: true },
  });
  const vendorDefaultAccountId = vendor?.defaultExpenseAccountId ?? null;

  // Also read up to 50 prior invoice lines to gather account CONCEPTS
  // this vendor has historically been coded to.
  const priorHistory = await prisma.aPInvoiceLine.findMany({
    where: { clubId, invoice: { vendorId } },
    select: { expenseAccountId: true },
    take: 50,
  });
  const conceptIds = new Set<string>();
  const historicalAccountIds = new Set<string>();
  if (vendorDefaultAccountId) historicalAccountIds.add(vendorDefaultAccountId);
  for (const l of priorHistory) historicalAccountIds.add(l.expenseAccountId);
  for (const accountId of historicalAccountIds) {
    const raw = accountsRaw.find((a) => a.id === accountId);
    if (!raw) continue;
    const av: AccountView = {
      id: raw.id,
      accountNumber: "",
      name: raw.name,
      categoryKey: raw.category?.key ?? null,
      categoryName: null,
      fsGroupKey: raw.fsGroup?.key ?? null,
      fsGroupName: null,
    };
    for (const ac of extractConceptsForAccount(av)) {
      conceptIds.add(ac.conceptId);
    }
  }
  return { vendorHistoryConceptIds: [...conceptIds], vendorDefaultAccountId };
}

// ---------------------------------------------------------------------------
// Structured rationale (§12)
// ---------------------------------------------------------------------------

function buildRationale(args: {
  scored: ScoredAccount[];
  dominant: QueryConcept | null;
  queryConcepts: QueryConcept[];
  requiresReview: boolean;
}): GlRationale {
  const { scored, dominant, queryConcepts, requiresReview } = args;
  const top = scored[0] ?? null;
  const alternatives = scored.slice(1, 6).map((s) => ({
    accountId: s.account.id,
    accountNumber: s.account.accountNumber,
    accountName: s.account.name,
    semanticScore: s.components.semanticScore,
    reason: alternativeReason(s),
  }));
  return {
    selectedAccountId: top?.account.id ?? null,
    selectedConcept: dominant?.conceptId ?? null,
    supportingDocumentEvidence: queryConcepts
      .filter((q) => q.source === "line_item_description" || q.source === "economic_purpose" || q.source === "document_phrase")
      .slice(0, 8)
      .map((q) => q.evidenceSnippet),
    supportingTaxonomyEvidence: top
      ? top.matchedAccountConcepts.slice(0, 5).map((ac) => `${ac.concept.canonicalName} (name ${ac.nameMatchStrength}, fs ${ac.fsGroupMatchStrength}, cat ${ac.categoryMatchStrength})`)
      : [],
    contradictedAccountConcepts: top?.contradictedConcepts ?? [],
    alternativeAccounts: alternatives,
    requiresReview,
    minRelevanceThreshold: MIN_RELEVANCE_THRESHOLD,
  };
}

function alternativeReason(s: ScoredAccount): string {
  const primary = s.matchedAccountConcepts[0];
  return primary
    ? `${primary.concept.canonicalName} (score ${s.components.semanticScore})`
    : `Score ${s.components.semanticScore}`;
}

// ---------------------------------------------------------------------------
// Split-account readiness (§13) — canonical analysis only; no auto-post
// ---------------------------------------------------------------------------

function buildSplitRecommendations(args: {
  lineItems: LineItem[];
  accounts: AccountView[];
  accountsRaw: Array<{ id: string; accountNumber: string; name: string; category: { key: string } | null; fsGroup: { key: string } | null }>;
  queryConcepts: QueryConcept[];
}): SplitRecommendation[] {
  const { lineItems } = args;
  if (lineItems.length < 2) return [];
  // Group lines by the STRONGEST query-concept match on each line's
  // description. If all lines resolve to the same concept, no split.
  const lineConcepts = lineItems.map((l) => ({
    line: l,
    qc: args.queryConcepts.find((q) => q.source === "line_item_description" && q.evidenceSnippet.startsWith(`Line "${l.description.slice(0, 60)}"`)) ?? null,
  }));
  const distinct = new Set(lineConcepts.map((lc) => lc.qc?.conceptId ?? "unknown"));
  if (distinct.size < 2) return [];

  const groups = new Map<string, { concept: string; lines: LineItem[]; amount: number }>();
  for (const { line, qc } of lineConcepts) {
    const key = qc?.conceptId ?? "unknown";
    let g = groups.get(key);
    if (!g) {
      g = { concept: key, lines: [], amount: 0 };
      groups.set(key, g);
    }
    g.lines.push(line);
    g.amount += Math.abs(line.amount);
  }

  const out: SplitRecommendation[] = [];
  for (const [conceptId, group] of groups) {
    if (conceptId === "unknown") continue;
    // Find the best account for this concept using the same
    // extractConceptsForAccount function.
    let bestAccount: { id: string; number: string; name: string } | null = null;
    let bestStrength = 0;
    for (const a of args.accounts) {
      const matches = extractConceptsForAccount(a);
      const hit = matches.find((m) => m.conceptId === conceptId);
      if (hit && hit.totalMatchStrength > bestStrength) {
        bestStrength = hit.totalMatchStrength;
        bestAccount = { id: a.id, number: a.accountNumber, name: a.name };
      }
    }
    if (!bestAccount) continue;
    const concept = CONCEPT_BY_ID[conceptId];
    out.push({
      groupLabel: concept?.canonicalName ?? conceptId,
      lineItemDescriptions: group.lines.map((l) => l.description),
      accountId: bestAccount.id,
      accountNumber: bestAccount.number,
      accountName: bestAccount.name,
      amount: Math.round(group.amount * 100) / 100,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Finalisation
// ---------------------------------------------------------------------------

function finaliseRecommendation(args: {
  top: ScoredAccount;
  topCandidates: ScoredAccount[];
  rationale: GlRationale;
  totalAccountsEvaluated: number;
  requiresReview: boolean;
  splitRecommendations: SplitRecommendation[];
}): GlRecommendation {
  const { top, topCandidates, rationale, totalAccountsEvaluated, requiresReview, splitRecommendations } = args;
  const candidates: GlCandidate[] = topCandidates.map((s) => ({
    accountId: s.account.id,
    accountNumber: s.account.accountNumber,
    accountName: s.account.name,
    categoryKey: s.account.categoryKey,
    fsGroupKey: s.account.fsGroupKey,
    confidence: Math.min(95, s.components.semanticScore),
    evidence: s.evidence.slice(0, 6),
    postable: s.postable,
    postingBlockers: s.postingBlockers,
  }));

  const leader = candidates[0];
  const leaderIsPostable = leader.postable;
  const leaderPostingBlockers = leader.postingBlockers;
  const autoApprovalEligible =
    !requiresReview
    && leaderIsPostable
    && leader.confidence >= AUTO_APPROVAL_MIN_CONFIDENCE;

  const source: GlRecommendation["source"] = leader.evidence.some((e) => e.kind === "CAPITAL_CLASS_MAP")
    ? "CAPITAL_CLASS_MAP"
    : leader.evidence.some((e) => e.kind === "VENDOR_DEFAULT")
      ? "VENDOR_DEFAULT"
      : leader.evidence.some((e) => e.kind === "PRIOR_CODING")
        ? "PRIOR_CODING"
        : leader.evidence.some((e) => e.kind === "ECONOMIC_PURPOSE" || e.kind === "LINE_ITEM_MATCH" || e.kind === "DOCUMENT_PHRASE" || e.kind === "SPECIFICITY_BOOST")
          ? "SEMANTIC_MATCH"
          : "NAME_KEYWORD";

  const reason = requiresReview
    ? `No confident recommendation — top candidate ${leader.accountNumber} — ${leader.accountName} scored ${top.components.semanticScore}, below the minimum-relevance threshold. Review required.`
    : leaderIsPostable
      ? `Draft coding: ${leader.accountNumber} — ${leader.accountName} (confidence ${leader.confidence}%). ${rationale.selectedConcept ? `Concept: ${rationale.selectedConcept}.` : ""}`
      : `Draft coding: ${leader.accountNumber} — ${leader.accountName} (confidence ${leader.confidence}%). Leader account is not currently postable — resolve ${leaderPostingBlockers.join(", ")} before posting.`;

  return {
    ruleVersion: RULE_VERSION,
    accountNumber: leader.accountNumber,
    accountName: leader.accountName,
    categoryKey: leader.categoryKey,
    fsGroupKey: leader.fsGroupKey,
    confidence: leader.confidence,
    reason,
    source,
    candidates,
    leaderIsPostable,
    leaderPostingBlockers,
    autoApprovalEligible,
    rationale,
    totalAccountsEvaluated,
    requiresReview,
    splitRecommendations,
  };
}

function emptyRecommendation(reason: string, totalAccountsEvaluated: number): GlRecommendation {
  return {
    ruleVersion: RULE_VERSION,
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
      minRelevanceThreshold: MIN_RELEVANCE_THRESHOLD,
    },
    totalAccountsEvaluated,
    requiresReview: true,
    splitRecommendations: [],
  };
}

// ---------------------------------------------------------------------------
// Posting-blocker derivation (unchanged from pre-15U)
// ---------------------------------------------------------------------------

function accountPostingBlockers(a: {
  type: string;
  isActive: boolean;
  isHeader: boolean;
  allowManualPosting: boolean;
  fundApplicability: string | null;
}): PostingBlocker[] {
  const blockers: PostingBlocker[] = [];
  if (!a.isActive) blockers.push("INACTIVE");
  if (a.isHeader) blockers.push("HEADER_ACCOUNT");
  if (!a.allowManualPosting) blockers.push("MANUAL_POSTING_DISALLOWED");
  const isPL = a.type === "REVENUE" || a.type === "EXPENSE";
  if (isPL && (!a.fundApplicability || a.fundApplicability.trim() === "")) {
    blockers.push("FUND_APPLICABILITY_UNMAPPED");
  }
  return blockers;
}

// ---------------------------------------------------------------------------
// Diagnostic export — exposed so staging + regression tests can dump
// the full ranking without re-implementing the recommender.
// ---------------------------------------------------------------------------

export interface RankedAccountDiagnostic {
  accountNumber: string;
  accountName: string;
  categoryKey: string | null;
  categoryName: string | null;
  fsGroupKey: string | null;
  fsGroupName: string | null;
  directLineMatch: number;
  economicPurposeMatch: number;
  accountNameSimilarity: number;
  fsGroupTaxonomySimilarity: number;
  categoryTaxonomySimilarity: number;
  documentPhraseScore: number;
  specificityScore: number;
  historicalVendorScore: number;
  supplierContextScore: number;
  contradictionPenalty: number;
  semanticScore: number;
  postingBlockers: PostingBlocker[];
  matchedConcepts: string[];
  rank: number;
}

export async function diagnosticRankTenantAccounts(args: GlRecommendationArgs): Promise<RankedAccountDiagnostic[]> {
  const accountsRaw = await prisma.account.findMany({
    where: { clubId: args.clubId },
    include: {
      category: { select: { key: true, name: true } },
      fsGroup: { select: { key: true, name: true } },
    },
    orderBy: { accountNumber: "asc" },
  });
  const eligibleAccounts: AccountView[] = accountsRaw
    .filter((a) => a.isActive && !a.isHeader && (a.type === "EXPENSE" || a.type === "ASSET"))
    .map((a) => ({
      id: a.id,
      accountNumber: a.accountNumber,
      name: a.name,
      categoryKey: a.category?.key ?? null,
      categoryName: a.category?.name ?? null,
      fsGroupKey: a.fsGroup?.key ?? null,
      fsGroupName: a.fsGroup?.name ?? null,
    }));

  const { vendorHistoryConceptIds, vendorDefaultAccountId } = await loadVendorHistory(
    args.clubId,
    args.vendorId,
    accountsRaw,
  );
  const queryConcepts = extractQueryConcepts({
    lineItems: args.extractedLineItems ?? [],
    economicPurposeCandidates: args.economicPurposeCandidates ?? null,
    fullDocumentText: args.fullDocumentText ?? null,
    supplierName: args.extraction?.vendor?.guessedName ?? null,
    vendorHistoryConceptIds,
  });
  const dominant = dominantQueryConcept(queryConcepts);

  const scored: ScoredAccount[] = eligibleAccounts.map((account) => {
    const acctRaw = accountsRaw.find((a) => a.id === account.id);
    return scoreAccount({
      account,
      queryConcepts,
      dominant,
      vendorDefaultAccountId,
      capitalState: args.capitalState,
      postingBlockers: acctRaw ? accountPostingBlockers(acctRaw) : [],
    });
  });
  scored.sort(deterministicCompare);

  return scored.map((s, idx) => ({
    accountNumber: s.account.accountNumber,
    accountName: s.account.name,
    categoryKey: s.account.categoryKey,
    categoryName: s.account.categoryName,
    fsGroupKey: s.account.fsGroupKey,
    fsGroupName: s.account.fsGroupName,
    directLineMatch: Math.round(s.components.directLineMatch),
    economicPurposeMatch: Math.round(s.components.economicPurposeMatch),
    accountNameSimilarity: Math.round(s.components.accountNameSimilarity),
    fsGroupTaxonomySimilarity: Math.round(s.components.fsGroupTaxonomySimilarity),
    categoryTaxonomySimilarity: Math.round(s.components.categoryTaxonomySimilarity),
    documentPhraseScore: Math.round(s.components.documentPhraseScore),
    specificityScore: Math.round(s.components.specificityScore),
    historicalVendorScore: Math.round(s.components.historicalVendorScore),
    supplierContextScore: Math.round(s.components.supplierContextScore),
    contradictionPenalty: Math.round(s.components.contradictionPenalty),
    semanticScore: s.components.semanticScore,
    postingBlockers: s.postingBlockers,
    matchedConcepts: s.matchedAccountConcepts.slice(0, 3).map((ac) => ac.conceptId),
    rank: idx + 1,
  }));
}

// Sprint 3 · Checkpoint 15U — pure-function ranker for regression
// tests. Takes AccountView[] + QueryConcept[] directly (no Prisma)
// so tests can shuffle input order without touching the DB.
export function rankAccountsPure(args: {
  accounts: AccountView[];
  queryConcepts: QueryConcept[];
  vendorDefaultAccountId?: string | null;
  capitalState?: CapitalVsOperatingState;
  postingBlockersByAccount?: Map<string, PostingBlocker[]>;
}): Array<{ accountNumber: string; accountName: string; semanticScore: number; rank: number; components: ScoreComponents; postingBlockers: PostingBlocker[] }> {
  const dominant = dominantQueryConcept(args.queryConcepts);
  const scored = args.accounts.map((account) =>
    scoreAccount({
      account,
      queryConcepts: args.queryConcepts,
      dominant,
      vendorDefaultAccountId: args.vendorDefaultAccountId ?? null,
      capitalState: args.capitalState ?? "OPERATING",
      postingBlockers: args.postingBlockersByAccount?.get(account.id) ?? [],
    }),
  );
  scored.sort(deterministicCompare);
  return scored.map((s, idx) => ({
    accountNumber: s.account.accountNumber,
    accountName: s.account.name,
    semanticScore: s.components.semanticScore,
    rank: idx + 1,
    components: s.components,
    postingBlockers: s.postingBlockers,
  }));
}
