// Shared accounting types used by services and UI.

export const ACCOUNT_TYPES = ["ASSET", "LIABILITY", "EQUITY", "REVENUE", "EXPENSE"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

export const NORMAL_BALANCES = ["DEBIT", "CREDIT"] as const;
export type NormalBalance = (typeof NORMAL_BALANCES)[number];

// Each account type has an implied normal balance — used to render the
// "natural" balance sign in reports.
export function normalBalanceFor(type: AccountType): NormalBalance {
  switch (type) {
    case "ASSET":
    case "EXPENSE":
      return "DEBIT";
    case "LIABILITY":
    case "EQUITY":
    case "REVENUE":
      return "CREDIT";
  }
}

export const JE_STATUSES = ["DRAFT", "APPROVED", "POSTED", "VOIDED", "REVERSED"] as const;
export type JournalStatus = (typeof JE_STATUSES)[number];

export const JE_SOURCES = [
  "MANUAL", "AR_CHARGE", "AR_PAYMENT", "AR_ADJUSTMENT", "AR_REVERSAL",
  "FINANCING_PAYMENT",
  "AP_INVOICE", "AP_PAYMENT", "AP_REVERSAL",
  "PAYROLL", "RECURRING", "SYSTEM_REVERSAL",
] as const;
export type JournalSource = (typeof JE_SOURCES)[number];

export const PERIOD_STATUSES = ["OPEN", "SOFT_LOCKED", "HARD_LOCKED", "CLOSED"] as const;
export type PeriodStatus = (typeof PERIOD_STATUSES)[number];

export const FS_STATEMENTS = ["BALANCE_SHEET", "INCOME_STATEMENT", "CASH_FLOW"] as const;
export type FSStatement = (typeof FS_STATEMENTS)[number];
