// Sprint 3 · Post-16H Phase 2 (2026-08-06) — structural eligibility
// rules. Every rule reads only real Account schema fields.
//
// Coulee Ridge inventory (2026-08-06, 237 active accounts):
//   type + normalBalance    100% populated
//   category + fsGroup      100% populated
//   isHeader                0 populated (feature reliable but zero-hit)
//   isControlAccount        0
//   allowManualPosting=false 0
//   isBankAccount / isCashAccount 0
//   fundApplicability       0    ← treated as posting-readiness, not
//                                    eligibility (founder §1)
//   defaultDepartment       0
//   ASSET/CREDIT contras    0    ← Coulee Ridge stores accumulated
//                                    depreciation as ASSET/DEBIT
//                                    (Jonas convention). Structural
//                                    CONTRA_ASSET rule cannot fire
//                                    against this convention — a real
//                                    deficiency to be closed by Phase 6
//                                    schema addition (Account.accountRole).
//
// This module implements only the rules that use fields the schema
// currently guarantees. Every rule is idempotent, pure, and emits a
// machine-readable reason from AccountingEligibilityReason.

import type {
  AccountEligibilityView, AccountingEligibilityReason,
  AccountingPostingBlocker, AccountingTransactionContext,
} from "./types";

// ---------------------------------------------------------------------------
// Individual rule primitives — each returns null when the rule does not
// fire, a reason code when it does. Kept small so unit tests exercise
// each one in isolation.
// ---------------------------------------------------------------------------

export function ruleInactive(a: AccountEligibilityView): AccountingEligibilityReason | null {
  return a.isActive ? null : "INACTIVE";
}

export function ruleArchived(a: AccountEligibilityView): AccountingEligibilityReason | null {
  return a.archivedAt != null ? "ARCHIVED" : null;
}

export function ruleHeader(a: AccountEligibilityView): AccountingEligibilityReason | null {
  return a.isHeader ? "HEADER_ACCOUNT" : null;
}

export function ruleControl(a: AccountEligibilityView): AccountingEligibilityReason | null {
  return a.isControlAccount ? "CONTROL_ACCOUNT" : null;
}

export function ruleManualPostingProhibited(a: AccountEligibilityView): AccountingEligibilityReason | null {
  return a.allowManualPosting ? null : "MANUAL_POSTING_PROHIBITED";
}

export function ruleBank(a: AccountEligibilityView): AccountingEligibilityReason | null {
  return a.isBankAccount ? "BANK_ACCOUNT_NOT_VALID_FOR_AP_ALLOCATION" : null;
}

export function ruleCash(a: AccountEligibilityView): AccountingEligibilityReason | null {
  return a.isCashAccount ? "CASH_ACCOUNT_NOT_VALID_FOR_AP_ALLOCATION" : null;
}

export function ruleRevenue(a: AccountEligibilityView): AccountingEligibilityReason | null {
  return a.type === "REVENUE" ? "REVENUE_NOT_VALID_FOR_AP_DEBIT" : null;
}

export function ruleEquity(a: AccountEligibilityView): AccountingEligibilityReason | null {
  return a.type === "EQUITY" ? "EQUITY_NOT_VALID_FOR_AP_DEBIT" : null;
}

/** Ordinary liabilities are never an AP-invoice debit. The AP-
 *  subledger control account is caught by ruleControl above. Rare
 *  exceptions (accrued-expense reversal) require workflow support
 *  — Phase 6 schema `allowedForAPDebit` opt-in. */
export function ruleLiability(a: AccountEligibilityView): AccountingEligibilityReason | null {
  return a.type === "LIABILITY" ? "LIABILITY_NOT_VALID_FOR_AP_DEBIT" : null;
}

/** Textbook contra-asset detection. Fires when the tenant COA
 *  records accumulated depreciation with a CREDIT normal balance.
 *  Kept as a secondary generic rule for tenants using conventional
 *  normal-balance configuration. */
export function ruleContraAsset(a: AccountEligibilityView): AccountingEligibilityReason | null {
  return a.type === "ASSET" && a.normalBalance === "CREDIT"
    ? "CONTRA_ASSET_NOT_VALID_FOR_PURCHASE"
    : null;
}

/** Phase 2.1 (2026-08-06) — durable contra-asset identification via
 *  `Account.accountRole`. Closes the Jonas-convention gap where
 *  accumulated-depreciation accounts are stored as ASSET/DEBIT and
 *  cannot be caught by the type+normalBalance rule alone. Backfill
 *  populated by scripts/backfill-account-role.ts from the reporting-
 *  side `isAccumulatedDepreciationLine` helper; runtime consults ONLY
 *  this field. Applies under EVERY nature — including CAPITAL_ASSET,
 *  INVENTORY, PREPAID_EXPENSE — because a contra-asset is never a
 *  valid AP debit regardless of transaction type. */
export function ruleAccountRoleContraAsset(a: AccountEligibilityView): AccountingEligibilityReason | null {
  return a.accountRole === "CONTRA_ASSET" ? "CONTRA_ASSET_NOT_VALID_FOR_PURCHASE" : null;
}

/** Phase 2.1 — every other structural role that must never be an AP
 *  debit target. `CONTROL` / `BANK` / `CASH` overlap the boolean
 *  flags above; `accountRole` is the durable authority once
 *  backfilled but the boolean flags remain valid for legacy paths.
 *  `CONTRA_REVENUE` / `CONTRA_LIABILITY` / `CLEARING` are Phase 6
 *  refinements — currently rejected via `TRANSACTION_NATURE_
 *  INCOMPATIBLE` when reached (no dedicated reason yet). */
export function ruleAccountRoleForbidden(a: AccountEligibilityView): AccountingEligibilityReason | null {
  switch (a.accountRole) {
    case "CONTRA_REVENUE": return "REVENUE_NOT_VALID_FOR_AP_DEBIT";
    case "CONTRA_LIABILITY": return "LIABILITY_NOT_VALID_FOR_AP_DEBIT";
    case "CONTROL": return "CONTROL_ACCOUNT";
    case "BANK": return "BANK_ACCOUNT_NOT_VALID_FOR_AP_ALLOCATION";
    case "CASH": return "CASH_ACCOUNT_NOT_VALID_FOR_AP_ALLOCATION";
    case "CLEARING": return "SYSTEM_ACCOUNT_NOT_USER_POSTABLE";
    default: return null;
  }
}

/** Data-quality edge: an EXPENSE with CREDIT normal balance is
 *  almost certainly mis-configured. Refuse the recommendation
 *  rather than debit a credit-balance expense. */
export function ruleNormalBalanceContradiction(a: AccountEligibilityView): AccountingEligibilityReason | null {
  if (a.type === "EXPENSE" && a.normalBalance === "CREDIT") return "NORMAL_BALANCE_CONTRADICTION";
  return null;
}

// ---------------------------------------------------------------------------
// Nature-conditioned rules — apply AFTER structural rules. These do
// not fire on obviously-eligible operating expense accounts; they
// exclude accounts whose type is legal for AP debit but not for the
// specific transaction nature at hand.
// ---------------------------------------------------------------------------

/** For an OPERATING_EXPENSE / R&M / PROFESSIONAL / UTILITY / TAX /
 *  INTEREST invoice, ordinary assets are not eligible debits.
 *  Exception: some tenants post recurring vehicle costs to a fixed-
 *  asset sub-ledger; that's a policy call, not a general rule.
 *  Phase 2: strict — ASSET excluded for non-capital natures. */
export function ruleNatureAssetExcluded(
  a: AccountEligibilityView,
  ctx: AccountingTransactionContext,
): AccountingEligibilityReason | null {
  if (a.type !== "ASSET") return null;
  switch (ctx.expectedDebitRole) {
    case "CAPITAL_ASSET":
    case "INVENTORY":
    case "PREPAID_EXPENSE":
      return null;
    case "REPAIR_AND_MAINTENANCE":
      // R&M usually expensed; capitalisation requires separate
      // supported capitalizationEvidence. Without it, asset is
      // ineligible.
      return ctx.capitalizationEvidence?.supported ? null : "TRANSACTION_NATURE_INCOMPATIBLE";
    default:
      return "TRANSACTION_NATURE_INCOMPATIBLE";
  }
}

/** Sprint 3 · 221178 semantics slice (2026-08-10) — payroll-account
 *  compatibility gate. Runs after nature-conditioned rules so the
 *  more-specific asset / nature reasons dominate first.
 *
 *  Founder rule (§4 · §5 · §21): PAYROLL_ONLY accounts must not be
 *  candidates for ordinary third-party AP invoices without
 *  affirmative payroll evidence. Payroll classification is
 *  structural — `fsGroupKey === "IS_PAYROLL"` OR
 *  `categoryKey === "PAYROLL_BENEFITS"` (the canonical taxonomy pair;
 *  populated at import time by src/lib/imports/coa-predictor.ts).
 *
 *  Reverse controls (§11):
 *    - Genuine payroll expense (evidence present) → account remains
 *      candidate.
 *    - Outsourced maintenance / consulting / contractor / janitorial
 *      / equipment-repair with no payroll evidence → PAYROLL_ONLY
 *      accounts excluded.
 *    - Legitimate `Total Care Maintenance Plan`-style line whose
 *      description shares a token with a wage account name → not
 *      affected here (this rule looks at the ACCOUNT's fsGroupKey,
 *      not the line description).
 *
 *  Founder rule (§6): do not depend on Social Insurance Number
 *  detection to establish payroll evidence.
 *
 *  Founder rule (§8): mixed accounts — the tenant may still
 *  legitimately need to post an AP invoice to a payroll-related
 *  account in edge cases. The default is conservative (exclude
 *  without evidence); mixed override remains a future policy call. */
export function rulePayrollAccountExcluded(
  a: AccountEligibilityView,
  ctx: AccountingTransactionContext,
): AccountingEligibilityReason | null {
  const isPayrollAccount =
    a.fsGroupKey === "IS_PAYROLL" || a.categoryKey === "PAYROLL_BENEFITS";
  if (!isPayrollAccount) return null;
  if (ctx.hasPayrollEvidence === true) return null;
  return "PAYROLL_ACCOUNT_REQUIRES_PAYROLL_EVIDENCE";
}

// ---------------------------------------------------------------------------
// Posting-readiness rules — DO NOT remove the account from ranking.
// Surface a blocker so the workflow projection can show "review
// required" instead of "post automatically." Founder §3.
// ---------------------------------------------------------------------------

export function postingBlockerFundApplicability(
  a: AccountEligibilityView,
  ctx: AccountingTransactionContext,
): AccountingPostingBlocker | null {
  // Only P&L accounts require fund applicability (OPERATING/CAPITAL
  // fund tagging). BS accounts don't. Founder rule 2026-07-02 v15.0.
  if (a.type !== "EXPENSE") return null;
  if (ctx.transactionKind !== "AP_INVOICE") return null;
  const v = (a.fundApplicability ?? "").trim();
  return v.length === 0 ? "FUND_APPLICABILITY_UNMAPPED" : null;
}
