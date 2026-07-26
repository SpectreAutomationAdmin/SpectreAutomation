// Founder rule 2026-07-13 v15.20 — canonical Statement of Financial
// Position row order.
//
// Current-Asset FS Groups must display from MOST LIQUID to LEAST
// LIQUID (Cash → Sales-Tax Receivable → AR → Member AR → Inventory
// → Prepaid). Long-Term Asset FS Groups must display in a stable
// order that keeps Long-term Receivables above Investments held
// long-term above Right-of-Use Assets above Intangibles above Other
// Long-term Assets. Liabilities and Equity groups follow the
// standard order the Chart of Accounts already assigns.
//
// This module owns the LIQUIDITY / STATEMENT-PRESENTATION order.
// It is the single source of truth every reporting surface consumes:
// admin preview, Board view, archived PDF, printed package. When a
// club adds a new FS Group whose key isn't listed here, the caller
// falls back to `FinancialStatementGroup.sortOrder` from the COA
// (persisted) and finally to the FS-Group key's lexicographic order
// — so ordering is always deterministic regardless of database
// insertion order.
//
// Preferred long-term home for these numbers is a
// `FinancialStatementGroup.liquidityOrder` column on the Prisma
// schema. Keeping them here as a centralised constant (rather than
// scattered in the renderer) preserves the founder's separation of
// concerns while a schema migration is scoped in a later slice.

/** Section identity — matches the SoFP builder's category buckets
 *  (see `BalanceSheetCategory` in `contracts.ts`). Each section has
 *  its own canonical order table because ordering is
 *  section-specific: `BS_AR` in a current-asset context sits at 400,
 *  but a current-portion-of-long-term receivable would sit
 *  differently. */
export type BalanceSheetSection =
  | "current-asset"
  | "long-term-asset"
  | "capital-fund-asset"
  | "current-liability"
  | "long-term-liability"
  | "operating-fund-balance"
  | "capital-fund-balance"
  | "ppe-gross"
  | "ppe-accumulated-depreciation"
  | "ytd-net-income";

// Founder-approved presentation orders. Numeric so a new group with
// key ORDER_INSTEAD_MID: 350 slots between two existing groups
// without renumbering.

const CURRENT_ASSET_ORDER: Record<string, number> = {
  BS_CASH_EQUIVALENTS: 100,
  BS_SHORT_TERM_INVESTMENTS: 200,
  BS_SALES_TAX_RECEIVABLE: 300,
  BS_INCOME_TAX_RECEIVABLE: 350,
  BS_AR: 400,
  BS_MEMBER_AR: 500,
  BS_OTHER_RECEIVABLES: 600,
  BS_INVENTORY: 700,
  BS_PREPAID_EXPENSES: 800,
  BS_OTHER_CURRENT_ASSETS: 900,
};

const LONG_TERM_ASSET_ORDER: Record<string, number> = {
  BS_LONG_TERM_RECEIVABLES: 100,
  BS_INVESTMENTS: 200,
  BS_ROU_ASSETS: 300,
  BS_INTANGIBLES: 400,
  BS_OTHER_LONG_TERM_ASSETS: 500,
  BS_OTHER_ASSETS: 500,
};

const CAPITAL_FUND_ASSET_ORDER: Record<string, number> = {
  BS_INVESTMENTS: 100,
  BS_CIP: 200,
};

const CURRENT_LIABILITY_ORDER: Record<string, number> = {
  BS_AP: 100,
  BS_ACCRUED_LIABILITIES: 200,
  BS_PAYROLL_LIABILITIES: 300,
  BS_SALES_TAX_PAYABLE: 400,
  BS_INCOME_TAX_PAYABLE: 450,
  BS_DEFERRED_REVENUE: 500,
  BS_DEPOSITS_PAYABLE: 600,
  BS_LONG_TERM_DEBT_CURRENT: 700,
  BS_OTHER_LIABILITIES: 800,
  BS_LEASE_LIABILITIES: 900,
};

const LONG_TERM_LIABILITY_ORDER: Record<string, number> = {
  BS_LONG_TERM_DEBT: 100,
  BS_DEFERRED_INITIATION_FEES: 200,
  BS_SECTION_FUNDS: 300,
  BS_DEFERRED_CAPITAL_CONTRIBUTIONS: 400,
  BS_OTHER_LONG_TERM_LIABILITIES: 500,
};

const EQUITY_ORDER: Record<string, number> = {
  BS_SHARE_CAPITAL: 100,
  BS_CONTRIBUTED_CAPITAL: 200,
  BS_RETAINED_EARNINGS: 300,
  BS_CURRENT_YEAR_EARNINGS: 400,
  BS_CAPITAL_RESERVE: 500,
  BS_ACCUMULATED_OCI: 600,
  BS_OTHER_EQUITY: 700,
};

const PPE_GROSS_ORDER: Record<string, number> = {
  BS_LAND: 100,
  BS_CIP: 150,
  BS_BUILDINGS: 200,
  BS_CAPITAL_IMPROVEMENTS: 250,
  BS_COURSE_IMPROVEMENTS: 300,
  BS_EQUIPMENT: 400,
  BS_VEHICLES: 500,
  BS_OTHER_PPE: 900,
};

const PPE_ACCUM_DEPR_ORDER: Record<string, number> = {
  BS_ACCUMULATED_DEPRECIATION: 100,
  BS_ACCUMULATED_AMORTIZATION: 200,
};

const SECTION_ORDER_TABLES: Record<
  BalanceSheetSection,
  Record<string, number>
> = {
  "current-asset":                CURRENT_ASSET_ORDER,
  "long-term-asset":              LONG_TERM_ASSET_ORDER,
  "capital-fund-asset":           CAPITAL_FUND_ASSET_ORDER,
  "current-liability":            CURRENT_LIABILITY_ORDER,
  "long-term-liability":          LONG_TERM_LIABILITY_ORDER,
  "operating-fund-balance":       EQUITY_ORDER,
  "capital-fund-balance":         EQUITY_ORDER,
  "ppe-gross":                    PPE_GROSS_ORDER,
  "ppe-accumulated-depreciation": PPE_ACCUM_DEPR_ORDER,
  "ytd-net-income":               EQUITY_ORDER,
};

/**
 * Resolve the presentation-order for an FS-Group summary row within
 * a given section. Precedence:
 *
 *   1. Founder-approved canonical order table for the section.
 *   2. The FS Group's own `sortOrder` (persisted on the CoA).
 *   3. Deterministic lexicographic tie-break on the FS-Group key.
 *
 * Callers pass whichever of `fsGroupSortOrder` they can produce; the
 * function guarantees a total ordering for any pair of inputs.
 */
export function resolvePresentationOrder(args: {
  section: BalanceSheetSection;
  fsGroupKey: string | null | undefined;
  fsGroupSortOrder?: number | null;
}): number {
  const table = SECTION_ORDER_TABLES[args.section];
  const key = args.fsGroupKey?.toUpperCase() ?? "";
  if (key && table[key] !== undefined) return table[key];
  if (typeof args.fsGroupSortOrder === "number") return args.fsGroupSortOrder;
  return Number.MAX_SAFE_INTEGER;
}

/**
 * Comparator for two rows within the same section. Deterministic:
 * canonical order > sortOrder > key lexicographic. Ties on both
 * numeric levels fall through to the string comparison so the same
 * input always produces the same output regardless of Map insertion
 * order or Prisma row order.
 */
export function comparePresentationOrder(
  a: { fsGroupKey?: string | null; fsGroupSortOrder?: number | null },
  b: { fsGroupKey?: string | null; fsGroupSortOrder?: number | null },
  section: BalanceSheetSection,
): number {
  const oa = resolvePresentationOrder({
    section,
    fsGroupKey: a.fsGroupKey ?? null,
    fsGroupSortOrder: a.fsGroupSortOrder ?? null,
  });
  const ob = resolvePresentationOrder({
    section,
    fsGroupKey: b.fsGroupKey ?? null,
    fsGroupSortOrder: b.fsGroupSortOrder ?? null,
  });
  if (oa !== ob) return oa - ob;
  const ka = a.fsGroupKey ?? "";
  const kb = b.fsGroupKey ?? "";
  return ka.localeCompare(kb);
}
