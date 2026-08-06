// Sprint 3 · Post-16H Phase 2 (2026-08-06) — canonical accounting
// eligibility contract.
//
// Provider-neutral. Lives under `src/lib/accounting/` — NOT under
// `src/lib/ap-intelligence/` — because eligibility is an accounting
// property of an account, not a property of the AP semantic ranker.
// The ranker CONSUMES this module; other posting surfaces (JE line
// validation, manual entry, opening-balance import) will consume
// the same module in later phases.

/** The nature of the debit-side allocation being proposed. Comes
 *  from the analyser's `accountingNature` classifier. `UNKNOWN` is
 *  the conservative fallback and eligibility applies ordinary
 *  operating-AP rules. */
export type ExpectedDebitRole =
  | "OPERATING_EXPENSE"
  | "CAPITAL_ASSET"
  | "INVENTORY"
  | "COST_OF_SALES"
  | "PREPAID_EXPENSE"
  | "REPAIR_AND_MAINTENANCE"
  | "PROFESSIONAL_SERVICE"
  | "UTILITY_OR_RECURRING_SERVICE"
  | "TAX_OR_REGULATORY"
  | "INTEREST_OR_PENALTY"
  | "UNKNOWN";

export interface AccountingTransactionContext {
  transactionKind: "AP_INVOICE";
  expectedDebitRole: ExpectedDebitRole;
  departmentHint?: string | null;
  capitalizationEvidence?: {
    supported: boolean;
    confidence: number;
  };
}

/** Structured, machine-readable exclusion reasons. Every rule
 *  emits one of these — never a free-form string. */
export type AccountingEligibilityReason =
  | "INACTIVE"
  | "HEADER_ACCOUNT"
  | "CONTROL_ACCOUNT"
  | "MANUAL_POSTING_PROHIBITED"
  | "REVENUE_NOT_VALID_FOR_AP_DEBIT"
  | "EQUITY_NOT_VALID_FOR_AP_DEBIT"
  | "LIABILITY_NOT_VALID_FOR_AP_DEBIT"
  | "BANK_ACCOUNT_NOT_VALID_FOR_AP_ALLOCATION"
  | "CASH_ACCOUNT_NOT_VALID_FOR_AP_ALLOCATION"
  | "CONTRA_ASSET_NOT_VALID_FOR_PURCHASE"
  | "NORMAL_BALANCE_CONTRADICTION"
  | "TRANSACTION_NATURE_INCOMPATIBLE"
  | "SYSTEM_ACCOUNT_NOT_USER_POSTABLE"
  | "ARCHIVED";

/** Posting-readiness blockers. An account can be semantically the
 *  correct choice and still fail to auto-post if it needs config.
 *  These do NOT remove the account from ranking. */
export type AccountingPostingBlocker =
  | "FUND_APPLICABILITY_UNMAPPED"
  | "DEPARTMENT_ASSIGNMENT_MISSING"
  | "TENANT_POLICY_INCOMPLETE";

export type EligibilityClass = "ELIGIBLE" | "CONDITIONALLY_ELIGIBLE" | "INELIGIBLE";

export interface AccountEligibilityResult {
  accountId: string;
  accountNumber: string;
  eligible: boolean;
  eligibilityClass: EligibilityClass;
  exclusionReasons: AccountingEligibilityReason[];
  postingBlockers: AccountingPostingBlocker[];
  warnings: string[];
  ruleVersion: number;
}

/** Closed set of `Account.accountRole` values. Runtime eligibility
 *  reads this field STRUCTURALLY — no text-pattern parsing. See
 *  scripts/backfill-account-role.ts for the one-time migration input. */
export type AccountRole =
  | "STANDARD"
  | "CONTRA_ASSET"
  | "CONTRA_REVENUE"
  | "CONTRA_LIABILITY"
  | "CONTROL"
  | "CLEARING"
  | "BANK"
  | "CASH";

/** The narrow shape the eligibility service needs from a COA row.
 *  Callers project their Prisma rows into this shape so the module
 *  is not coupled to Prisma. */
export interface AccountEligibilityView {
  id: string;
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
  archivedAt: Date | null;
  fundApplicability: string | null;
  categoryKey: string | null;
  fsGroupKey: string | null;
  // Phase 2.1 (2026-08-06) — durable account role. Defaults to
  // "STANDARD" so pre-backfill callers behave as before.
  accountRole?: AccountRole | string;
}

// Phase 2.1 (2026-08-06) — bumped to 2 for accountRole rule.
export const ELIGIBILITY_RULE_VERSION = 2;
