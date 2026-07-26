import { isCapitalAccount } from "@/lib/accounting/fund-applicability";

// Income Statement projection — account-code → IS-bucket mapping.
//
// The Trial Balance Snapshot carries every account in the chart with
// the 5-value `LedgerAccountCategory` taxonomy (asset / liability /
// equity / revenue / expense). The Income Statement Snapshot uses
// the 3-field `IncomeStatementLine` shape (`category` ∈ revenue /
// expense, `fund` ∈ operating / capital, optional `departmentCode`).
//
// The Statement of Activities / Executive Opening / Stewardship
// Dashboard surfaces want a richer taxonomy than the contract's 3
// fields can express directly — they need to render lines as
//
//   • revenue                  (general / membership)
//   • departmental revenue     (golf, F&B, retail, amenity …)
//   • payroll                  (sub-bucket of operating expense)
//   • operating expenses       (non-payroll, non-depreciation)
//   • depreciation             (rolls into snapshot.depreciation)
//   • capital income           (capital fund revenue)
//   • capital expense          (capital fund expense)
//   • unmapped-fund            (P&L account with null fundApplicability —
//                               surfaced as a reporting diagnostic;
//                               excluded from every roll-up until an
//                               operator sets the field)
//
// (NOI is a CALCULATED roll-up — operating revenue minus operating
// expense — not a line bucket.)
//
// Founder rule 2026-07-02 v15.0 — Fund is now sourced from the
// account's `fundApplicability` CoA property (single source of
// truth). The old 9xxx number-range capital detection is RETIRED
// — Spectre no longer infers fund from the account name or
// number. This file's range rules still drive OPERATING sub-
// bucketing (payroll vs operating-expense vs depreciation, and
// revenue vs departmental-revenue), but CAPITAL vs OPERATING
// comes from the account itself.

// ---------------------------------------------------------------------------
// User-facing IS buckets
// ---------------------------------------------------------------------------

export type IncomeStatementBucket =
  | "revenue"                  // general (non-departmental) revenue
  | "departmental-revenue"     // revenue tagged with a departmentCode
  | "payroll"                  // operating expense, payroll/benefits sub-bucket
  | "operating-expense"        // operating expense (non-payroll, non-depr)
  | "depreciation"             // depreciation expense (rolls into snapshot.depreciation)
  | "capital-income"           // capital fund revenue (rolls into totalCapitalIncome)
  | "capital-expense"          // capital fund expense (rolls into totalCapitalExpense)
  // Founder rule 2026-07-02 v15.0 — a P&L account without a
  // Fund Applicability value is a CONFIGURATION ERROR, not a
  // silent fallback. The reporting engine surfaces it as a
  // diagnostic ("N accounts have no Fund Applicability
  // assigned") and excludes those lines from Operating AND
  // Capital totals until an operator sets the field. Not silently
  // classified as Operating; not silently classified as Capital.
  | "unmapped-fund";

// ---------------------------------------------------------------------------
// Mapping shape
// ---------------------------------------------------------------------------

export type IncomeStatementAccountRangeRule = {
  rangeStart: number;
  rangeEnd: number;
  bucket: IncomeStatementBucket;
  /** Optional department tag — applied to every line that matches
   *  this range (e.g. 4200–4299 → bucket "departmental-revenue",
   *  departmentCode "FB"). */
  departmentCode?: string;
};

export type IncomeStatementAccountOverride = {
  accountNumber: string;
  bucket: IncomeStatementBucket;
  departmentCode?: string;
  /** Optional override for the rendered line label. */
  normalizedName?: string;
};

export type IncomeStatementMapping = {
  label: string;
  overrides: ReadonlyArray<IncomeStatementAccountOverride>;
  ranges?: ReadonlyArray<IncomeStatementAccountRangeRule>;
};

export type MappedIncomeStatementAccount = {
  accountCode: string;
  accountName: string;
  bucket: IncomeStatementBucket;
  departmentCode: string | null;
  source: "explicit-override" | "range-rule";
};

// ---------------------------------------------------------------------------
// Standard private-club ranges
// ---------------------------------------------------------------------------
//
// 4xxx revenue (operating):
//   4000–4099  Membership dues       → revenue
//   4100–4199  Golf                  → departmental-revenue (GOLF)
//   4200–4299  F&B                   → departmental-revenue (FB)
//   4300–4399  Retail / pro shop     → departmental-revenue (RETAIL)
//   4400–4499  Amenity / events      → departmental-revenue (AMENITY)
//   4500–4999  Other operating       → revenue
//
// 5xxx–8xxx expense (operating):
//   5000–5499  Payroll               → payroll
//   5500–5999  Benefits / taxes      → payroll
//   6000–6499  Operating expense     → operating-expense
//   6500–6599  Depreciation          → depreciation
//   6600–8999  Operating expense     → operating-expense
//
// Founder rule 2026-07-02 v15.0 — 9xxx range rules RETIRED.
// Capital vs operating is now sourced from the account's
// `fundApplicability` CoA property, not from account-number
// heuristics. 9xxx accounts still fall through to the operating
// sub-bucketing here (revenue vs operating-expense), and the
// mapper below promotes them to capital-income / capital-expense
// only when the account itself is tagged CAPITAL.

export const STANDARD_PRIVATE_CLUB_IS_RANGES: ReadonlyArray<IncomeStatementAccountRangeRule> = [
  { rangeStart: 4000, rangeEnd: 4099, bucket: "revenue" },
  { rangeStart: 4100, rangeEnd: 4199, bucket: "departmental-revenue", departmentCode: "GOLF" },
  { rangeStart: 4200, rangeEnd: 4299, bucket: "departmental-revenue", departmentCode: "FB" },
  { rangeStart: 4300, rangeEnd: 4399, bucket: "departmental-revenue", departmentCode: "RETAIL" },
  { rangeStart: 4400, rangeEnd: 4499, bucket: "departmental-revenue", departmentCode: "AMENITY" },
  { rangeStart: 4500, rangeEnd: 4999, bucket: "revenue" },
  { rangeStart: 5000, rangeEnd: 5499, bucket: "payroll" },
  { rangeStart: 5500, rangeEnd: 5999, bucket: "payroll" },
  { rangeStart: 6000, rangeEnd: 6499, bucket: "operating-expense" },
  { rangeStart: 6500, rangeEnd: 6599, bucket: "depreciation" },
  { rangeStart: 6600, rangeEnd: 8999, bucket: "operating-expense" },
  // 9xxx revenue AND expense both fall through to the operating
  // buckets here — actual capital promotion is driven by the
  // account's fundApplicability tag, applied in the mapper below.
  { rangeStart: 9000, rangeEnd: 9499, bucket: "revenue" },
  { rangeStart: 9500, rangeEnd: 9999, bucket: "operating-expense" },
];

export const DEFAULT_INCOME_STATEMENT_MAPPING: IncomeStatementMapping = {
  label: "Standard private-club income statement mapping",
  overrides: [],
  ranges: STANDARD_PRIVATE_CLUB_IS_RANGES,
};

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

/**
 * Map a single revenue/expense account to one of the IS buckets.
 *
 * Precedence:
 *   1. Explicit per-account override (`mapping.overrides`).
 *   2. Range rule (`mapping.ranges`) — picks the OPERATING
 *      sub-bucket (revenue / departmental-revenue / payroll /
 *      operating-expense / depreciation).
 *   3. Fund-applicability promotion — if the account is tagged
 *      CAPITAL (via `accountCategory` + `accountFundApplicability`),
 *      the operating bucket is promoted to `capital-income` or
 *      `capital-expense` as appropriate.
 *   4. Unmapped-fund path — if the account is a P&L account with
 *      NULL fundApplicability, returns bucket = "unmapped-fund".
 *      The projection layer treats these as diagnostics — they
 *      count in `unmappedFundLineCount` and are excluded from
 *      every operating/capital roll-up.
 *
 * The `accountCategory` parameter is used ONLY to know whether
 * to promote to capital-income (revenue) or capital-expense
 * (expense) — never to infer the fund itself.
 */
export function mapIncomeStatementAccount(
  input: {
    accountNumber: string;
    accountName: string;
    /**
     * P&L category from the ledger snapshot. Required so a CAPITAL-
     * tagged account promotes to the right kind of bucket
     * (revenue → capital-income; expense → capital-expense).
     */
    accountCategory: "revenue" | "expense";
    /**
     * Founder rule 2026-07-02 v15.0 — the CoA's Fund Applicability
     * CSV. `null` triggers the unmapped-fund diagnostic. See
     * `src/lib/accounting/fund-applicability.ts`.
     */
    accountFundApplicability: string | null;
  },
  mapping: IncomeStatementMapping,
): MappedIncomeStatementAccount | null {
  const override = mapping.overrides.find(
    (o) => o.accountNumber === input.accountNumber,
  );
  const promoteForCapital = (bucket: IncomeStatementBucket): IncomeStatementBucket => {
    // Only P&L brackets get promoted. Explicit override buckets
    // that are already capital-flavoured pass through unchanged.
    if (bucket === "capital-income" || bucket === "capital-expense" || bucket === "unmapped-fund") {
      return bucket;
    }
    if (!isCapitalAccount(input.accountFundApplicability)) return bucket;
    return input.accountCategory === "revenue" ? "capital-income" : "capital-expense";
  };
  const flaggedUnmapped = (): boolean => {
    // Configuration-error path: a P&L account with no
    // fundApplicability. `hasFund(null, "OPERATING")` returns
    // false, so a null value on a revenue/expense account fails
    // both fund checks and produces the diagnostic bucket.
    if (input.accountFundApplicability != null && input.accountFundApplicability.length > 0) return false;
    return true;
  };

  if (override) {
    // Founder rule 2026-07-02 v15.0 — even an explicit-override
    // account still requires a Fund Applicability, so
    // configuration errors surface in the diagnostic count.
    // Overrides that already target capital-income/capital-expense
    // are trusted (that override wouldn't exist without an
    // operator setting fund; the migration backfills the field).
    if (flaggedUnmapped() && override.bucket !== "capital-income" && override.bucket !== "capital-expense") {
      return {
        accountCode: input.accountNumber,
        accountName: override.normalizedName ?? input.accountName,
        bucket: "unmapped-fund",
        departmentCode: override.departmentCode ?? null,
        source: "explicit-override",
      };
    }
    return {
      accountCode: input.accountNumber,
      accountName: override.normalizedName ?? input.accountName,
      bucket: promoteForCapital(override.bucket),
      departmentCode: override.departmentCode ?? null,
      source: "explicit-override",
    };
  }

  const numeric = Number(input.accountNumber);
  if (Number.isFinite(numeric)) {
    const ranges = mapping.ranges ?? STANDARD_PRIVATE_CLUB_IS_RANGES;
    const range = ranges.find(
      (r) => numeric >= r.rangeStart && numeric <= r.rangeEnd,
    );
    if (range) {
      if (flaggedUnmapped()) {
        return {
          accountCode: input.accountNumber,
          accountName: input.accountName,
          bucket: "unmapped-fund",
          departmentCode: range.departmentCode ?? null,
          source: "range-rule",
        };
      }
      // Guard against pathological data — an OPERATING-only
      // account inside the legacy 9xxx range should stay
      // operating (the range default is now revenue /
      // operating-expense, not capital); capital promotion
      // only fires when the account itself is tagged CAPITAL.
      const promoted = promoteForCapital(range.bucket);
      return {
        accountCode: input.accountNumber,
        accountName: input.accountName,
        bucket: promoted,
        departmentCode: range.departmentCode ?? null,
        source: "range-rule",
      };
    }
  }

  return null;
}

/**
 * Translate a user-facing bucket to the IS line `category` field
 * (the contract's 2-value taxonomy).
 *
 * `unmapped-fund` requires the caller to know whether the source
 * account was revenue or expense — pass that through explicitly.
 */
export function bucketToCategory(
  bucket: IncomeStatementBucket,
  fallback?: "revenue" | "expense",
): "revenue" | "expense" {
  switch (bucket) {
    case "revenue":
    case "departmental-revenue":
    case "capital-income":
      return "revenue";
    case "payroll":
    case "operating-expense":
    case "depreciation":
    case "capital-expense":
      return "expense";
    case "unmapped-fund":
      // Fund tag is missing, but the category is known — the
      // caller passed it in from the ledger snapshot. Guard
      // against a bad caller with a safe default.
      return fallback ?? "expense";
  }
}

/**
 * Translate a user-facing bucket to the IS line `fund` field.
 *
 * Founder rule 2026-07-02 v15.0 — `unmapped-fund` returns null:
 * the reporting engine must NOT silently classify null-fund
 * accounts as either operating or capital.
 */
export function bucketToFund(
  bucket: IncomeStatementBucket,
): "operating" | "capital" | null {
  switch (bucket) {
    case "capital-income":
    case "capital-expense":
      return "capital";
    case "revenue":
    case "departmental-revenue":
    case "payroll":
    case "operating-expense":
    case "depreciation":
      return "operating";
    case "unmapped-fund":
      return null;
  }
}
