// DIM-2 (2026-09-29) — Accounting-semantic policy proposals for
// departmentPolicy and fundPolicy per Account.
//
// The predictor and the COA import preview call these helpers so the
// operator sees a starting-point policy per row that they can override
// before commit. Policies are ACCOUNTING SEMANTICS, not applicability
// counts — adding or removing AccountDepartment / AccountFund rows
// must NOT implicitly change the policy on the account.
//
// Predicted values are proposals, not truth. The operator's final
// override is what the COA importer persists on Account.

import type { AccountType } from "./types";

export type DimensionPolicy = "REQUIRED" | "OPTIONAL" | "NOT_APPLICABLE";

// ---------------------------------------------------------------------------
// departmentPolicy proposal rules
// ---------------------------------------------------------------------------
// Accounting principle: departmental attribution is meaningful for an
// account when different operational units of the club can consume the
// same account. Control accounts (cash, AR, AP, retained earnings)
// operate at the club level and do NOT accept a department; operating
// revenue + expense accounts almost always do.
//
// The default fallback is OPTIONAL so a policy proposal that we do not
// have an explicit accounting rationale for stays open to operator
// judgement rather than forcing a value.

/** FS Group keys where department attribution has no operational meaning. */
const DEPT_NOT_APPLICABLE_FS_GROUPS: ReadonlySet<string> = new Set([
  // Balance-sheet control accounts operating at club level.
  "BS_CASH_EQUIVALENTS",
  "BS_CASH",
  "BS_AR",
  "BS_MEMBER_AR",
  "BS_AP",
  "BS_SALES_TAX_PAYABLE",
  "BS_RETAINED_EARNINGS",
  "BS_CURRENT_YEAR_EARNINGS",
  "BS_PRIOR_YEAR_EARNINGS",
  "BS_LONG_TERM_DEBT",
  "BS_CAPITAL_LEASE",
  "BS_LONG_TERM_RECEIVABLES",
  "BS_SECTION_FUNDS",
  "BS_DEPOSITS_PAYABLE",
  "BS_CAPITAL_ASSETS",
  "BS_ACCUMULATED_DEPRECIATION",
  "BS_CAPITAL_RESERVE",
  "BS_LOAN_PAYABLE",
  "BS_INTERCOMPANY",
  "BS_PREPAID_EXPENSES",
  "BS_ACCRUED_LIABILITIES",
  // Equity operates at club level.
  "EQ_INITIATION_FEES",
  "EQ_SHARE_CAPITAL",
  "EQ_CONTRIBUTED_SURPLUS",
  "EQ_MEMBER_EQUITY",
]);

/** FS Group keys where department applicability is NOT sensible even on P&L. */
const DEPT_OPTIONAL_ON_PL_FS_GROUPS: ReadonlySet<string> = new Set([
  // Non-operational P&L that does not usually attribute to a department.
  "IS_INTEREST_INCOME",
  "IS_INTEREST_EXPENSE",
  "IS_OTHER_INCOME",
  "IS_OTHER_EXPENSE",
  "IS_INCOME_TAX",
  "IS_GAIN_LOSS_ON_SALE",
]);

/**
 * Propose an Account.departmentPolicy from accounting semantics.
 *
 * Rules (in order):
 *   1. Header accounts             → NOT_APPLICABLE (they never post).
 *   2. FS Group is a club-level    → NOT_APPLICABLE.
 *      control account
 *   3. Type is EQUITY              → NOT_APPLICABLE.
 *   4. Non-operational P&L         → OPTIONAL (interest, other income/expense).
 *   5. Type is REVENUE or EXPENSE  → REQUIRED (operating P&L).
 *   6. Anything else               → OPTIONAL (conservative fallback).
 */
export function proposeDepartmentPolicy(input: {
  type: AccountType;
  fsGroupKey: string | null;
  isHeader?: boolean;
}): DimensionPolicy {
  if (input.isHeader) return "NOT_APPLICABLE";
  if (input.fsGroupKey && DEPT_NOT_APPLICABLE_FS_GROUPS.has(input.fsGroupKey)) {
    return "NOT_APPLICABLE";
  }
  if (input.type === "EQUITY") return "NOT_APPLICABLE";
  if (input.fsGroupKey && DEPT_OPTIONAL_ON_PL_FS_GROUPS.has(input.fsGroupKey)) {
    return "OPTIONAL";
  }
  if (input.type === "REVENUE" || input.type === "EXPENSE") return "REQUIRED";
  return "OPTIONAL";
}

// ---------------------------------------------------------------------------
// fundPolicy proposal rules
// ---------------------------------------------------------------------------
// Accounting principle: Fund (Operating vs Capital vs Restricted vs …)
// classifies WHICH pool the transaction is drawing from or contributing
// to. Every posted P&L line ideally identifies a fund; balance-sheet
// controls (cash, AR, AP) do not — they represent the club-wide asset
// / liability position, not a specific fund's activity.

/** FS Group keys where Fund attribution has no operational meaning. */
const FUND_NOT_APPLICABLE_FS_GROUPS: ReadonlySet<string> = new Set([
  "BS_CASH_EQUIVALENTS",
  "BS_CASH",
  "BS_AR",
  "BS_MEMBER_AR",
  "BS_AP",
  "BS_SALES_TAX_PAYABLE",
  "BS_LONG_TERM_DEBT",
  "BS_CAPITAL_LEASE",
  "BS_ACCRUED_LIABILITIES",
  "BS_PREPAID_EXPENSES",
  "BS_INTERCOMPANY",
]);

/**
 * Propose an Account.fundPolicy from accounting semantics.
 *
 * Rules (in order):
 *   1. Header accounts                                → NOT_APPLICABLE.
 *   2. Predicted `fundApplicability` non-null AND
 *      type is REVENUE / EXPENSE                      → REQUIRED.
 *   3. FS Group is a control account                  → NOT_APPLICABLE.
 *   4. Type is EQUITY (typically single-pool)         → NOT_APPLICABLE.
 *   5. Type is REVENUE / EXPENSE                      → REQUIRED.
 *   6. Predicted `fundApplicability` non-null on BS   → OPTIONAL.
 *   7. Anything else                                  → OPTIONAL.
 */
export function proposeFundPolicy(input: {
  type: AccountType;
  fsGroupKey: string | null;
  fundApplicability: string | null;
  isHeader?: boolean;
}): DimensionPolicy {
  if (input.isHeader) return "NOT_APPLICABLE";
  if (
    input.fundApplicability &&
    input.fundApplicability.length > 0 &&
    (input.type === "REVENUE" || input.type === "EXPENSE")
  ) {
    return "REQUIRED";
  }
  if (input.fsGroupKey && FUND_NOT_APPLICABLE_FS_GROUPS.has(input.fsGroupKey)) {
    return "NOT_APPLICABLE";
  }
  if (input.type === "EQUITY") return "NOT_APPLICABLE";
  if (input.type === "REVENUE" || input.type === "EXPENSE") return "REQUIRED";
  if (input.fundApplicability && input.fundApplicability.length > 0) return "OPTIONAL";
  return "OPTIONAL";
}

/**
 * Parse the legacy CSV `fundApplicability` string into an array of
 * canonical fund keys. Returns [] for null/empty input.
 * Duplicates are removed and the output is deterministic (sorted
 * alphabetically) so upsert diffs are stable.
 */
export function parseFundApplicabilityKeys(csv: string | null | undefined): string[] {
  if (!csv || csv.length === 0) return [];
  const set = new Set<string>();
  for (const token of csv.split(",")) {
    const key = token.trim().toUpperCase();
    if (key.length > 0) set.add(key);
  }
  return Array.from(set).sort();
}
