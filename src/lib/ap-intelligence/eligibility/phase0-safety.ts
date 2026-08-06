// Sprint 3 · Checkpoint 16H rejection #4 → audit approval (2026-08-06)
// Phase 0 safety containment.
//
// TEMPORARY structural guard while the full eligibility layer
// (Phase 2 of the AP rebuild) is authored + benchmarked. Its ONE
// job: refuse to surface a GL recommendation whose leader is
// accounting-invalid for an ordinary vendor invoice, regardless of
// what the ranker's semantic score says.
//
// The founder's directive: an ineligible leader must NOT be silently
// replaced with the next candidate; the pipeline must ABSTAIN and
// preserve the ranked diagnostics internally.
//
// Structural rules only. Every rule is derived from existing
// `Account` schema fields — no text-pattern parsing. This is
// deliberate: the audit identified text-based exclusions as
// text-fragile (the `Accum Deprec` abbreviation escaped the
// `Accumulated Depreciation` pattern in the nature-scoped ranker).
//
// This module is INTENTIONALLY NARROW. It does not:
//   • filter the candidate pool up front (Phase 2's job)
//   • re-rank based on eligibility (Phase 2's job)
//   • propose the next-eligible-candidate as replacement (founder
//     §0.5 — no silent substitution)
//   • use any account-name text pattern (Phase 2 can add name-based
//     supplemental rules AFTER structural fields prove insufficient
//     for a case)

import type { GlRecommendation, GlCandidate } from "../gl-recommend";

/** The narrow set of Account fields the safety guard reads.  Kept
 *  minimal so the caller can supply them from any source (Prisma
 *  row, view model, test fixture). */
export interface AccountSafetyView {
  accountNumber: string;
  name: string;
  type: string;                    // "ASSET" | "LIABILITY" | "EQUITY" | "REVENUE" | "EXPENSE"
  normalBalance: string;           // "DEBIT" | "CREDIT"
  isActive: boolean;
  isHeader: boolean;
  allowManualPosting: boolean;
  isControlAccount: boolean;
  isBankAccount: boolean;
  isCashAccount: boolean;
}

/** Reasons the leader (or a top-N candidate) was found ineligible.
 *  These are stable identifiers — the runner + downstream telemetry
 *  key on them. */
export type Phase0IneligibilityReason =
  | "INACTIVE"
  | "HEADER_ACCOUNT"
  | "CONTROL_ACCOUNT"
  | "MANUAL_POSTING_DISALLOWED"
  | "CONTRA_ASSET_NOT_VALID_FOR_PURCHASE"
  | "REVENUE_NOT_VALID_FOR_AP_DEBIT"
  | "EQUITY_NOT_VALID_FOR_AP_DEBIT"
  | "BANK_OR_CASH_NOT_VALID_FOR_EXPENSE_ALLOCATION"
  | "NORMAL_BALANCE_CONTRADICTION";

export interface Phase0Verdict {
  eligible: boolean;
  reasons: Phase0IneligibilityReason[];
}

/**
 * Evaluate one account's structural eligibility as an AP-invoice
 * debit line. Returns every triggered reason so telemetry can
 * distinguish, e.g., a bank account that is also inactive from a
 * bank account that is otherwise fine.
 *
 * Rule set — every rule fires from existing schema fields only:
 *
 *   INACTIVE                                  isActive === false
 *   HEADER_ACCOUNT                            isHeader === true
 *   CONTROL_ACCOUNT                           isControlAccount === true
 *   MANUAL_POSTING_DISALLOWED                 allowManualPosting === false
 *   CONTRA_ASSET_NOT_VALID_FOR_PURCHASE       type === "ASSET" && normalBalance === "CREDIT"
 *   REVENUE_NOT_VALID_FOR_AP_DEBIT            type === "REVENUE"
 *   EQUITY_NOT_VALID_FOR_AP_DEBIT             type === "EQUITY"
 *   BANK_OR_CASH_NOT_VALID_FOR_EXPENSE_ALLOCATION
 *                                             (isBankAccount || isCashAccount) === true
 *   NORMAL_BALANCE_CONTRADICTION              type ∈ {EXPENSE,ASSET} && normalBalance === "CREDIT"
 *                                             (already caught for ASSET/CREDIT but the
 *                                             EXPENSE/CREDIT case is a data-quality signal)
 */
export function evaluateAccountForApDebit(a: AccountSafetyView): Phase0Verdict {
  const reasons: Phase0IneligibilityReason[] = [];

  if (!a.isActive) reasons.push("INACTIVE");
  if (a.isHeader) reasons.push("HEADER_ACCOUNT");
  if (a.isControlAccount) reasons.push("CONTROL_ACCOUNT");
  if (!a.allowManualPosting) reasons.push("MANUAL_POSTING_DISALLOWED");

  if (a.type === "ASSET" && a.normalBalance === "CREDIT") {
    reasons.push("CONTRA_ASSET_NOT_VALID_FOR_PURCHASE");
  }
  if (a.type === "REVENUE") reasons.push("REVENUE_NOT_VALID_FOR_AP_DEBIT");
  if (a.type === "EQUITY") reasons.push("EQUITY_NOT_VALID_FOR_AP_DEBIT");
  if (a.isBankAccount || a.isCashAccount) {
    reasons.push("BANK_OR_CASH_NOT_VALID_FOR_EXPENSE_ALLOCATION");
  }
  if ((a.type === "EXPENSE" || a.type === "ASSET") && a.normalBalance === "CREDIT"
      && !reasons.includes("CONTRA_ASSET_NOT_VALID_FOR_PURCHASE")) {
    // Data-quality edge — an EXPENSE with credit normal balance is
    // almost certainly mis-configured.
    reasons.push("NORMAL_BALANCE_CONTRADICTION");
  }

  return { eligible: reasons.length === 0, reasons };
}

// ---------------------------------------------------------------------------
// Wrapper for a GlRecommendation.
// ---------------------------------------------------------------------------

/** Diagnostic payload attached alongside a recommendation when the
 *  Phase 0 guard suppressed the leader.  The caller (harness /
 *  telemetry / logger) can persist it — the projection layer does
 *  NOT render it to the founder-visible card in Phase 0. */
export interface Phase0Diagnostic {
  suppressedLeaderAccountNumber: string | null;
  suppressedLeaderName: string | null;
  suppressedLeaderReasons: Phase0IneligibilityReason[];
  /** Every top-N candidate the ranker produced, annotated with its
   *  own eligibility verdict.  Retained so a reviewer can see WHY
   *  no proposal was made — the founder's §0.1 requirement. */
  candidateAudit: Array<{
    accountNumber: string;
    name: string;
    eligible: boolean;
    reasons: Phase0IneligibilityReason[];
  }>;
}

export interface Phase0Result {
  recommendation: GlRecommendation;
  diagnostic: Phase0Diagnostic | null;
  suppressed: boolean;
}

/**
 * Apply Phase 0 safety containment to a completed GL recommendation.
 *
 * Behaviour:
 *   • If the leader account is eligible → recommendation returned
 *     unchanged, `suppressed=false`, `diagnostic=null`.
 *   • If the leader is ineligible → recommendation is REPLACED with
 *     an empty (abstained) recommendation. The original leader's
 *     account number, name, and every triggered reason are packaged
 *     into the `Phase0Diagnostic` for downstream logging. The next
 *     candidate is NOT promoted (founder §0.5: no silent substitution).
 *
 * The abstained recommendation carries `source: "NONE"`,
 * `confidence: null`, empty `candidates[]`, `autoApprovalEligible=false`,
 * `requiresReview=true`, and a `reason` that names the guard.
 */
export function applyPhase0SafetyContainment(
  recommendation: GlRecommendation,
  accountsByNumber: Map<string, AccountSafetyView>,
): Phase0Result {
  const { accountNumber } = recommendation;
  if (accountNumber == null) {
    // Base ranker already abstained. Nothing to guard.
    return { recommendation, diagnostic: null, suppressed: false };
  }
  const leader = accountsByNumber.get(accountNumber);
  if (!leader) {
    // Leader references an account the caller did not supply — the
    // safe posture is to pass through (no worse than the input).
    return { recommendation, diagnostic: null, suppressed: false };
  }
  const leaderVerdict = evaluateAccountForApDebit(leader);
  if (leaderVerdict.eligible) {
    return { recommendation, diagnostic: null, suppressed: false };
  }

  // Leader is ineligible — abstain, preserve diagnostics.
  const candidateAudit = recommendation.candidates.map((c: GlCandidate) => {
    const view = accountsByNumber.get(c.accountNumber);
    if (!view) {
      return {
        accountNumber: c.accountNumber, name: c.accountName ?? "",
        eligible: false,
        reasons: [] as Phase0IneligibilityReason[],
      };
    }
    const v = evaluateAccountForApDebit(view);
    return { accountNumber: c.accountNumber, name: view.name, eligible: v.eligible, reasons: v.reasons };
  });

  const abstained: GlRecommendation = {
    ruleVersion: recommendation.ruleVersion,
    accountNumber: null,
    accountName: null,
    categoryKey: null,
    fsGroupKey: null,
    confidence: null,
    reason: `Phase 0 safety guard suppressed leader ${accountNumber}: ${leaderVerdict.reasons.join(", ")}. No supported recommendation — review required.`,
    source: "NONE",
    candidates: [],
    leaderIsPostable: false,
    // GlRecommendation.leaderPostingBlockers is a string[] union of a
    // narrow closed enum (INACTIVE / HEADER_ACCOUNT / …). Only the
    // subset that intersects Phase0IneligibilityReason maps cleanly;
    // wider Phase 0 reasons are surfaced via the diagnostic payload
    // and the `reason` string on the recommendation, not by widening
    // the schema-shared union here.
    leaderPostingBlockers: leaderVerdict.reasons
      .filter((r): r is "INACTIVE" | "HEADER_ACCOUNT" | "MANUAL_POSTING_DISALLOWED" =>
        r === "INACTIVE" || r === "HEADER_ACCOUNT" || r === "MANUAL_POSTING_DISALLOWED"),
    autoApprovalEligible: false,
    rationale: recommendation.rationale,
    totalAccountsEvaluated: recommendation.totalAccountsEvaluated,
    requiresReview: true,
    splitRecommendations: [],
  };

  return {
    recommendation: abstained,
    diagnostic: {
      suppressedLeaderAccountNumber: accountNumber,
      suppressedLeaderName: recommendation.accountName ?? leader.name,
      suppressedLeaderReasons: leaderVerdict.reasons,
      candidateAudit,
    },
    suppressed: true,
  };
}

// ---------------------------------------------------------------------------
// Env / flag gate.  The wire-in (see gl-recommend.ts) reads this so
// the harness can toggle containment off for a baseline run and on
// for the post-containment run without a redeploy.
// ---------------------------------------------------------------------------

const ENV_FLAG = "AP_INTELLIGENCE_PHASE0_SAFETY";

export function isPhase0SafetyEnabled(): boolean {
  // Default: ON in every environment. The benchmark harness sets
  // the env var to "0" for its explicit baseline capture only.
  const v = (process.env[ENV_FLAG] ?? "").trim().toLowerCase();
  if (v === "0" || v === "false" || v === "off" || v === "disabled") return false;
  return true;
}
