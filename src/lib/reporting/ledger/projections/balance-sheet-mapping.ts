// Balance Sheet projection — account-code → BalanceSheetCategory mapping.
//
// The Trial Balance Snapshot carries raw GL accounts (with the
// 5-value `LedgerAccountCategory` taxonomy: asset / liability /
// equity / revenue / expense). The Balance Sheet Snapshot uses a
// 9-value `BalanceSheetCategory` taxonomy that splits assets into
// current / capital-fund / PP&E / accumulated-depreciation, splits
// liabilities into current / long-term, and splits equity into
// operating-fund / capital-fund / YTD net income.
//
// This mapping bridges the two taxonomies. Same pattern as the Jonas
// GL account-mapping: ranges + explicit per-account overrides, both
// driven by configuration so no Silver Springs literals appear in
// code.
//
// Default ranges follow the private-club standard chart of accounts:
//
//   1000–1199  Cash / AR / Inventory / Prepaid  → current-asset
//   1200–1799  Other current assets             → current-asset
//   1800–1899  Reserve fund investments         → capital-fund-asset
//   1900–1989  Property Plant & Equipment       → ppe-gross
//   1990–1999  Accumulated depreciation         → ppe-accumulated-depreciation
//   2000–2199  AP / accrued / current portion   → current-liability
//   2200–2999  Long-term debt / deferred        → long-term-liability
//   3000–3499  Operating fund balance           → operating-fund-balance
//   3500–3999  Capital fund balance             → capital-fund-balance
//
// Revenue (4xxx) and expense (5xxx–8xxx) accounts are NOT directly
// mapped — they aggregate into a single `ytd-net-income` line under
// equity, computed by the projection.

import type { BalanceSheetCategory } from "@/lib/reporting/ledger/contracts";

// ---------------------------------------------------------------------------
// Mapping shape
// ---------------------------------------------------------------------------

/** A numeric range rule. */
export type BalanceSheetAccountRangeRule = {
  /** Inclusive lower bound (numeric — account numbers parsed). */
  rangeStart: number;
  /** Inclusive upper bound. */
  rangeEnd: number;
  category: BalanceSheetCategory;
};

/** A per-account override — highest priority. */
export type BalanceSheetAccountOverride = {
  accountNumber: string;
  category: BalanceSheetCategory;
  /** Optional override for the line's display name. */
  normalizedName?: string;
};

/** Per-club mapping configuration. */
export type BalanceSheetMapping = {
  /** Free-form label — e.g. "Silver Springs default". */
  label: string;
  /** Explicit per-account overrides — highest priority. */
  overrides: ReadonlyArray<BalanceSheetAccountOverride>;
  /** Optional range overrides. When omitted, the default ranges
   *  below apply. */
  ranges?: ReadonlyArray<BalanceSheetAccountRangeRule>;
};

/** Mapping result for a single account. */
export type MappedBalanceSheetAccount = {
  accountCode: string;
  accountName: string;
  category: BalanceSheetCategory;
  source: "explicit-override" | "range-rule";
};

// ---------------------------------------------------------------------------
// Standard private-club ranges
// ---------------------------------------------------------------------------

export const STANDARD_PRIVATE_CLUB_BALANCE_SHEET_RANGES: ReadonlyArray<BalanceSheetAccountRangeRule> = [
  { rangeStart: 1000, rangeEnd: 1799, category: "current-asset" },
  { rangeStart: 1800, rangeEnd: 1899, category: "capital-fund-asset" },
  { rangeStart: 1900, rangeEnd: 1989, category: "ppe-gross" },
  { rangeStart: 1990, rangeEnd: 1999, category: "ppe-accumulated-depreciation" },
  { rangeStart: 2000, rangeEnd: 2199, category: "current-liability" },
  { rangeStart: 2200, rangeEnd: 2999, category: "long-term-liability" },
  { rangeStart: 3000, rangeEnd: 3499, category: "operating-fund-balance" },
  { rangeStart: 3500, rangeEnd: 3999, category: "capital-fund-balance" },
];

export const DEFAULT_BALANCE_SHEET_MAPPING: BalanceSheetMapping = {
  label: "Standard private-club balance sheet mapping",
  overrides: [],
  ranges: STANDARD_PRIVATE_CLUB_BALANCE_SHEET_RANGES,
};

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

/**
 * Map a single account number to a balance-sheet category.
 * Precedence: explicit override > range rule > null (caller surfaces
 * as a mapping diagnostic).
 *
 * Revenue and expense accounts return `null` by design — they are
 * not directly mapped, they aggregate into the projection's
 * `ytd-net-income` line.
 */
export function mapBalanceSheetAccount(
  input: { accountNumber: string; accountName: string },
  mapping: BalanceSheetMapping,
): MappedBalanceSheetAccount | null {
  const override = mapping.overrides.find(
    (o) => o.accountNumber === input.accountNumber,
  );
  if (override) {
    return {
      accountCode: input.accountNumber,
      accountName: override.normalizedName ?? input.accountName,
      category: override.category,
      source: "explicit-override",
    };
  }

  const numeric = Number(input.accountNumber);
  if (Number.isFinite(numeric)) {
    const ranges = mapping.ranges ?? STANDARD_PRIVATE_CLUB_BALANCE_SHEET_RANGES;
    const range = ranges.find(
      (r) => numeric >= r.rangeStart && numeric <= r.rangeEnd,
    );
    if (range) {
      return {
        accountCode: input.accountNumber,
        accountName: input.accountName,
        category: range.category,
        source: "range-rule",
      };
    }
  }

  return null;
}
