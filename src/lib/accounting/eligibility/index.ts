// Sprint 3 · Post-16H Phase 2 (2026-08-06) — canonical accounting
// eligibility service.
//
// Public API. Runs BEFORE semantic ranking. Ineligible accounts are
// removed from the candidate universe; conditionally-eligible
// accounts stay in the pool but carry posting blockers so the
// workflow projection can distinguish "semantically correct + needs
// config" from "semantically correct + auto-postable."
//
// No coupling to Prisma — callers project their COA rows into the
// AccountEligibilityView shape. This lets the module serve every
// posting surface (AP, JE, opening balance, POS clearing) with one
// contract.

import type {
  AccountEligibilityResult,
  AccountEligibilityView,
  AccountingEligibilityReason,
  AccountingPostingBlocker,
  AccountingTransactionContext,
  EligibilityClass,
} from "./types";
import { ELIGIBILITY_RULE_VERSION } from "./types";
import {
  ruleInactive, ruleArchived, ruleHeader, ruleControl,
  ruleManualPostingProhibited, ruleBank, ruleCash,
  ruleRevenue, ruleEquity, ruleLiability,
  ruleContraAsset, ruleNormalBalanceContradiction,
  ruleNatureAssetExcluded,
  ruleAccountRoleContraAsset, ruleAccountRoleForbidden,
  postingBlockerFundApplicability,
} from "./rules-structural";

// ---------------------------------------------------------------------------
// Per-account evaluation
// ---------------------------------------------------------------------------

/** Evaluate one account against every structural + nature rule.
 *  Returns the full verdict — never throws. Deterministic. */
export function evaluateEligibility(
  a: AccountEligibilityView,
  ctx: AccountingTransactionContext,
): AccountEligibilityResult {
  const exclusionReasons: AccountingEligibilityReason[] = [];
  const push = (r: AccountingEligibilityReason | null) => { if (r) exclusionReasons.push(r); };

  // Structural — order does not affect verdict (result is the SET
  // of reasons). Chosen order matches the founder's rule list §4.
  push(ruleInactive(a));
  push(ruleArchived(a));
  push(ruleHeader(a));
  push(ruleControl(a));
  push(ruleManualPostingProhibited(a));
  push(ruleRevenue(a));
  push(ruleEquity(a));
  push(ruleLiability(a));
  push(ruleBank(a));
  push(ruleCash(a));
  push(ruleContraAsset(a));
  push(ruleNormalBalanceContradiction(a));
  // Phase 2.1 — durable accountRole rules. Apply BEFORE the
  // nature-conditioned rule so the contra-asset verdict is stable
  // regardless of transaction nature (a contra-asset is never a
  // valid AP debit under CAPITAL_ASSET, INVENTORY, or PREPAID
  // either — the specific defect Phase 2.1 closes).
  push(ruleAccountRoleContraAsset(a));
  push(ruleAccountRoleForbidden(a));
  // Nature-conditioned — applied last so structural reasons dominate.
  push(ruleNatureAssetExcluded(a, ctx));

  const postingBlockers: AccountingPostingBlocker[] = [];
  const pb = postingBlockerFundApplicability(a, ctx);
  if (pb) postingBlockers.push(pb);

  const warnings: string[] = [];

  const eligible = exclusionReasons.length === 0;
  const eligibilityClass: EligibilityClass = !eligible
    ? "INELIGIBLE"
    : postingBlockers.length > 0
      ? "CONDITIONALLY_ELIGIBLE"
      : "ELIGIBLE";

  return {
    accountId: a.id,
    accountNumber: a.accountNumber,
    eligible,
    eligibilityClass,
    exclusionReasons,
    postingBlockers,
    warnings,
    ruleVersion: ELIGIBILITY_RULE_VERSION,
  };
}

// ---------------------------------------------------------------------------
// Bulk filter — the pre-ranking gate
// ---------------------------------------------------------------------------

export interface FilterEligibleAccountsResult {
  /** Accounts eligible (ELIGIBLE or CONDITIONALLY_ELIGIBLE) for
   *  semantic ranking. Conditionally-eligible accounts retain their
   *  posting blockers on the corresponding verdict — the ranker's
   *  caller must join back to `verdictsByAccountId` when composing
   *  the recommendation's posting-readiness surface. */
  eligible: AccountEligibilityView[];
  /** Accounts removed from ranking with structured reasons. */
  rejected: AccountEligibilityResult[];
  /** Every verdict, keyed by account id, for downstream lookup. */
  verdictsByAccountId: Map<string, AccountEligibilityResult>;
}

export function filterEligibleAccounts(
  accounts: ReadonlyArray<AccountEligibilityView>,
  ctx: AccountingTransactionContext,
): FilterEligibleAccountsResult {
  const eligible: AccountEligibilityView[] = [];
  const rejected: AccountEligibilityResult[] = [];
  const verdictsByAccountId = new Map<string, AccountEligibilityResult>();
  for (const a of accounts) {
    const v = evaluateEligibility(a, ctx);
    verdictsByAccountId.set(a.id, v);
    if (v.eligible) eligible.push(a);
    else rejected.push(v);
  }
  return { eligible, rejected, verdictsByAccountId };
}

// ---------------------------------------------------------------------------
// Diagnostic surface — what the caller stores alongside the ranker's
// output when eligibility caused a leader replacement. Founder §8.
// ---------------------------------------------------------------------------

export interface EligibilityDiagnostic {
  /** The account the raw semantic ranker preferred, if it was
   *  removed by eligibility. Null when the raw leader was itself
   *  eligible. */
  rejectedSemanticLeader: {
    accountId: string;
    accountNumber: string;
    accountName: string;
    reasons: AccountingEligibilityReason[];
    semanticScore: number;
  } | null;
  /** The eligible leader chosen by re-ranking the eligible set.
   *  Null when no eligible account cleared the minimum-relevance
   *  threshold (→ abstention). */
  eligibleLeader: {
    accountId: string;
    accountNumber: string;
    accountName: string;
    semanticScore: number;
    eligibility: AccountEligibilityResult;
  } | null;
  /** Non-null when abstention was chosen. Names the reason: raw
   *  leader ineligible AND no eligible account cleared threshold. */
  abstentionReason: string | null;
  /** Rule version applied. */
  ruleVersion: number;
}

// ---------------------------------------------------------------------------
// Shadow comparison — measure Phase 0 vs Phase 2 disagreement.
// Runs BOTH pipelines and reports whether the pre-ranking gate
// produces the same visible outcome as the post-ranking guard.
// ---------------------------------------------------------------------------

export interface ShadowComparisonInput {
  phase0Suppressed: boolean;
  phase0SuppressedLeaderAccountNumber: string | null;
  phase2LeaderAccountNumber: string | null;
  phase2AbstentionReason: string | null;
}

export type ShadowComparisonVerdict =
  | "AGREE_BOTH_SURFACED_SAME"      // no suppression, same leader
  | "AGREE_BOTH_ABSTAINED"          // both abstained
  | "AGREE_BOTH_SUPPRESSED_SAME"    // Phase 0 suppressed + Phase 2 abstained on same leader
  | "DISAGREE_PHASE0_ONLY"          // Phase 0 caught, Phase 2 missed
  | "DISAGREE_PHASE2_ONLY"          // Phase 2 caught, Phase 0 missed
  | "DISAGREE_DIFFERENT_LEADERS";   // Phase 2 picked a different eligible leader than Phase 0 kept

export function compareShadow(input: ShadowComparisonInput): ShadowComparisonVerdict {
  const p0 = input.phase0Suppressed;
  const p2Abs = input.phase2LeaderAccountNumber == null && input.phase2AbstentionReason != null;
  if (p0 && p2Abs) return "AGREE_BOTH_SUPPRESSED_SAME";
  if (!p0 && !p2Abs && input.phase2LeaderAccountNumber != null) {
    return "AGREE_BOTH_SURFACED_SAME";
  }
  if (!p0 && p2Abs) return "DISAGREE_PHASE2_ONLY";
  if (p0 && !p2Abs) return "DISAGREE_PHASE0_ONLY";
  if (!p0 && !p2Abs && input.phase2LeaderAccountNumber == null) return "AGREE_BOTH_ABSTAINED";
  return "DISAGREE_DIFFERENT_LEADERS";
}

// Re-export types + rule surface for consumers.
export type {
  AccountEligibilityResult,
  AccountEligibilityView,
  AccountingEligibilityReason,
  AccountingPostingBlocker,
  AccountingTransactionContext,
  EligibilityClass,
  ExpectedDebitRole,
} from "./types";
export { ELIGIBILITY_RULE_VERSION } from "./types";

// Env flag — kept parallel to Phase 0 so the benchmark can compare
// the two systems side by side.
const ENV_FLAG = "AP_INTELLIGENCE_PHASE2_ELIGIBILITY";
export function isPhase2EligibilityEnabled(): boolean {
  const v = (process.env[ENV_FLAG] ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "disabled") return false;
  return true;
}
