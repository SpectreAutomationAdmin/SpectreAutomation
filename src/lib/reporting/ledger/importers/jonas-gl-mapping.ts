// Jonas GL — account-number → ledger category/fund mapping.
//
// The ledger's normalized `LedgerAccount` shape categorises every
// account into one of `asset` / `liability` / `equity` / `revenue` /
// `expense` and one of `operating` / `capital` / `reserve` /
// `other`. Jonas's own chart of accounts doesn't carry this
// taxonomy directly — accounts are organised by 4-digit numeric
// ranges (the private-club standard chart of accounts) with
// the club's own per-account descriptions.
//
// The mapping below has two layers:
//
//   1. Default range-based rules. Most clubs follow the standard
//      ranges:
//        1000–1999  → asset (operating fund unless tagged)
//        2000–2999  → liability
//        3000–3999  → equity
//        4000–4999  → revenue
//        5000–8999  → expense
//        9000–9999  → capital / non-operating
//      This is the lowest-effort path — a club with a standard
//      chart gets sensible defaults without any configuration.
//
//   2. Per-club overrides. Some clubs depart from the standard
//      (e.g. a numbered "1850 — Reserve Fund Investment" sits in
//      the asset range but belongs to the capital fund). The
//      mapping accepts a per-club table that takes precedence
//      over the range rules.

import type {
  LedgerAccount,
  LedgerAccountCategory,
  LedgerFund,
} from "@/lib/reporting/ledger/contracts";

// ---------------------------------------------------------------------------
// Mapping result + helpers
// ---------------------------------------------------------------------------

/** Outcome of mapping a single account number. */
export type MappedAccount = {
  accountCode: string;
  accountName: string;
  category: LedgerAccountCategory;
  fund: LedgerFund;
  parentAccountCode: string | null;
  /** How the category was determined. */
  source: "explicit-override" | "range-rule" | "jonas-type-hint";
};

/** Per-club override entry. */
export type JonasAccountOverride = {
  /** Account number to match (exact). */
  accountNumber: string;
  category: LedgerAccountCategory;
  fund: LedgerFund;
  /** Optional override of the description (when the Jonas
   *  description is too cryptic for board-pack rendering). */
  normalizedName?: string;
  parentAccountCode?: string;
};

/** Per-club mapping configuration. */
export type JonasAccountMapping = {
  /** Free-form label — e.g. "Silver Springs default". */
  label: string;
  /** Explicit overrides — highest priority. */
  overrides: ReadonlyArray<JonasAccountOverride>;
  /** Optional range overrides (when the club's chart depart from
   *  the private-club standard). When omitted, the default ranges
   *  below apply. */
  ranges?: ReadonlyArray<JonasAccountRangeRule>;
};

/** A numeric range rule. */
export type JonasAccountRangeRule = {
  /** Inclusive lower bound (numeric — account numbers parsed). */
  rangeStart: number;
  /** Inclusive upper bound. */
  rangeEnd: number;
  category: LedgerAccountCategory;
  fund: LedgerFund;
};

// ---------------------------------------------------------------------------
// Standard private-club chart of accounts ranges
// ---------------------------------------------------------------------------

export const STANDARD_PRIVATE_CLUB_RANGES: ReadonlyArray<JonasAccountRangeRule> = [
  { rangeStart: 1000, rangeEnd: 1799, category: "asset",     fund: "operating" },
  { rangeStart: 1800, rangeEnd: 1899, category: "asset",     fund: "reserve" },
  { rangeStart: 1900, rangeEnd: 1999, category: "asset",     fund: "capital" },
  { rangeStart: 2000, rangeEnd: 2999, category: "liability", fund: "operating" },
  { rangeStart: 3000, rangeEnd: 3999, category: "equity",    fund: "operating" },
  { rangeStart: 4000, rangeEnd: 4999, category: "revenue",   fund: "operating" },
  { rangeStart: 5000, rangeEnd: 8999, category: "expense",   fund: "operating" },
  { rangeStart: 9000, rangeEnd: 9499, category: "revenue",   fund: "capital" },
  { rangeStart: 9500, rangeEnd: 9999, category: "expense",   fund: "capital" },
];

export const DEFAULT_JONAS_ACCOUNT_MAPPING: JonasAccountMapping = {
  label: "Standard private-club chart of accounts",
  overrides: [],
  ranges: STANDARD_PRIVATE_CLUB_RANGES,
};

// ---------------------------------------------------------------------------
// Mapper
// ---------------------------------------------------------------------------

/**
 * Map a single Jonas account number to a normalized
 * `MappedAccount`. Precedence: explicit override > range rule >
 * Jonas-side type hint > error.
 *
 * Returns `null` when no rule matches (caller surfaces as an
 * import diagnostic — the club operator must add an override).
 */
export function mapJonasAccount(
  input: {
    accountNumber: string;
    accountDescription: string;
    jonasAccountType: string | null;
  },
  mapping: JonasAccountMapping,
): MappedAccount | null {
  // 1. Explicit override.
  const override = mapping.overrides.find(
    (o) => o.accountNumber === input.accountNumber,
  );
  if (override) {
    return {
      accountCode: input.accountNumber,
      accountName: override.normalizedName ?? input.accountDescription,
      category: override.category,
      fund: override.fund,
      parentAccountCode: override.parentAccountCode ?? null,
      source: "explicit-override",
    };
  }

  // 2. Range rule.
  const numeric = Number(input.accountNumber);
  if (Number.isFinite(numeric)) {
    const ranges = mapping.ranges ?? STANDARD_PRIVATE_CLUB_RANGES;
    const range = ranges.find(
      (r) => numeric >= r.rangeStart && numeric <= r.rangeEnd,
    );
    if (range) {
      return {
        accountCode: input.accountNumber,
        accountName: input.accountDescription,
        category: range.category,
        fund: range.fund,
        parentAccountCode: null,
        source: "range-rule",
      };
    }
  }

  // 3. Jonas-side hint (best-effort fallback).
  if (input.jonasAccountType) {
    const hint = input.jonasAccountType.toLowerCase().trim();
    const category = jonasTypeHintToCategory(hint);
    if (category) {
      return {
        accountCode: input.accountNumber,
        accountName: input.accountDescription,
        category,
        fund: "operating",
        parentAccountCode: null,
        source: "jonas-type-hint",
      };
    }
  }

  // 4. No mapping found.
  return null;
}

function jonasTypeHintToCategory(
  hint: string,
): LedgerAccountCategory | null {
  if (hint.includes("asset")) return "asset";
  if (hint.includes("liab")) return "liability";
  if (hint.includes("equity") || hint.includes("fund balance")) return "equity";
  if (hint.includes("rev") || hint.includes("inc")) return "revenue";
  if (hint.includes("exp") || hint.includes("cost")) return "expense";
  return null;
}

/**
 * Map a batch of CSV rows to normalized accounts. Returns a parallel
 * array — each entry is either a `MappedAccount` or null (no
 * mapping found). Callers (the importer) inspect for null entries
 * and surface them as diagnostics.
 */
export function mapJonasAccountsBatch(
  inputs: ReadonlyArray<{
    accountNumber: string;
    accountDescription: string;
    jonasAccountType: string | null;
  }>,
  mapping: JonasAccountMapping = DEFAULT_JONAS_ACCOUNT_MAPPING,
): Array<MappedAccount | null> {
  return inputs.map((row) => mapJonasAccount(row, mapping));
}

/**
 * Convert a `MappedAccount` to the ledger's `LedgerAccount` shape
 * (suitable for embedding in a `TrialBalanceSnapshot.accounts` array).
 *
 * Founder rule 2026-07-02 v15.0 — legacy Jonas imports don't
 * carry a Fund Applicability column, so the P&L fund is derived
 * from the account-level fund tag the mapping produces (via the
 * range rules or per-club overrides). The mapping already
 * classifies revenue + expense accounts as operating vs capital
 * for reporting purposes; propagating that decision to the new
 * `fundApplicability` field keeps the projection layer happy
 * without asking Jonas operators to re-populate the CoA.
 * Balance-sheet accounts keep `fundApplicability: null`.
 */
export function toLedgerAccount(mapped: MappedAccount): LedgerAccount {
  const isPL = mapped.category === "revenue" || mapped.category === "expense";
  let fundApplicability: string | null = null;
  if (isPL) {
    // Reserve fund → CAPITAL; other → OPERATING (safe default).
    if (mapped.fund === "capital" || mapped.fund === "reserve") {
      fundApplicability = "CAPITAL";
    } else {
      fundApplicability = "OPERATING";
    }
  }
  return {
    accountCode: mapped.accountCode,
    accountName: mapped.accountName,
    category: mapped.category,
    fund: mapped.fund,
    parentAccountCode: mapped.parentAccountCode,
    fundApplicability,
  };
}
