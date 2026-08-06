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

/** Textbook contra-asset detection. ONLY fires when the tenant COA
 *  actually records accumulated depreciation with a CREDIT normal
 *  balance. Jonas-convention tenants (Coulee Ridge) store these as
 *  ASSET/DEBIT — Phase 6 `accountRole` field is required to close
 *  that gap. */
export function ruleContraAsset(a: AccountEligibilityView): AccountingEligibilityReason | null {
  return a.type === "ASSET" && a.normalBalance === "CREDIT"
    ? "CONTRA_ASSET_NOT_VALID_FOR_PURCHASE"
    : null;
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
