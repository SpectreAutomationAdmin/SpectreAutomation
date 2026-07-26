// Founder rule 2026-07-13 v15.15 — Chart-of-Accounts classification
// resolver for the Balance Sheet reporting path.
//
// Purpose
// -------
// The Reporting Ledger's `TrialBalanceSnapshot` + `BalanceSheetSnapshot`
// carry a coarse `LedgerAccountCategory` ("asset"/"liability"/"equity"/
// "revenue"/"expense") that was historically the only classification
// the projection cared about. With v15.14, the Statement of Financial
// Position now aggregates every line by its
// `FinancialStatementGroup.key` (e.g. "BS_INVENTORY",
// "BS_CASH_EQUIVALENTS"), which lives on the ChartAccount record —
// NOT on the ledger snapshot.
//
// This helper closes that gap. It performs ONE bounded Prisma query
// per invocation, joining `Account → AccountCategory` and
// `Account → FinancialStatementGroup`, and returns a Map keyed by
// `Account.accountNumber` (matching the projection's `accountCode`
// on each `BalanceSheetLine`).
//
// Callers use it in two places:
//
//   1. `BalanceSheetProjection.getBalanceSheetSnapshot()` — after
//      building the raw balance-sheet lines from the trial balance,
//      enrich each line with its ChartAccount classification so the
//      WRITTEN snapshot carries `fsGroupKey` / `fsGroupName` /
//      `categoryKey` / `accountType`. Future reads render straight
//      from the snapshot without needing another Prisma lookup.
//
//   2. `getStatementOfFinancialPositionForClub()` — for legacy
//      pre-v15.15 snapshots that were written before enrichment
//      existed, enrich lines at read time. This is the "unpublished
//      preview" behavior the founder authorized: preview always
//      reflects the CURRENT Chart of Accounts. A later publish
//      freezes the resolved snapshot into `MonthlyPackage.
//      packagePayloadJson`, giving the archive point-in-time
//      immunity.
//
// Point-in-Time Integrity
// -----------------------
// The founder's rule: a May 2026 archived package must remain
// unchanged after a July 2026 CoA edit. This architecture satisfies
// that guarantee because:
//
//   - Published `MonthlyPackage.packagePayloadJson` freezes the
//     BUILT Statement of Financial Position — including every
//     FS-Group summary row's frozen label + accountsPresent
//     ordering. A later CoA rename or fsGroupId swap CANNOT change
//     the archived JSON.
//   - Only newly-built (unpublished) SOFPs consult this resolver,
//     and they reflect the current CoA as of the query time.
//
// No effective-dated classification history table is required for
// this guarantee; the package-level frozen snapshot is the
// point-in-time boundary the founder's spec identified as the
// preferred approach.
//
// Fund Applicability
// ------------------
// Balance-sheet accounts (`Account.type` in {ASSET, LIABILITY,
// EQUITY}) may leave `Account.fundApplicability` blank — that field
// is populated only for P&L accounts (see the Prisma schema comment
// on `Account.fundApplicability`, prisma/schema.prisma:1673). Blank
// `fundApplicability` on a balance-sheet account is EXPECTED and
// MUST NOT flag the account as unmapped. The resolver leaves it
// alone; the SoFP builder splits current-fund / capital-fund
// visually via `BalanceSheetCategory`, not via `fundApplicability`.

import { prisma } from "@/lib/prisma";

import type { BalanceSheetCategory } from "@/lib/reporting/ledger/contracts";

// ---------------------------------------------------------------------------
// Founder rule 2026-07-13 v15.16 — Statement of Financial Position must
// reconcile to the balanced Trial Balance.
//
// Root cause of the previous $26.6M mismatch: the Balance Sheet
// projection assigned the 9-value `BalanceSheetCategory` (which drives
// which SECTION each line renders in — current assets, ppe-gross,
// current liabilities, operating-fund-balance, etc.) via account-code
// range mapping. Live Silver Springs account numbers fall outside the
// standard ranges, so:
//
//   • PP&E accounts (e.g. numbered outside 1900-1999) were being
//     misclassified as `current-asset`, inflating Total Current
//     Assets (and Total Assets) while leaving Net PP&E blank.
//   • Equity FS Groups outside the 3000-3999 range never made it
//     into Members' Equity — the balance sheet shows only Retained
//     Earnings while ~$26M of other equity accounts are missing.
//
// v15.16 makes the section classification derive from the Chart of
// Accounts classification (accountType + categoryKey + fsGroupKey)
// rather than account-number ranges. This is the founder's explicit
// spec: "Do not use hard-coded account ranges." Range-based mapping
// remains available only as a legacy fallback for the demo seeds and
// tests written before v15.16.
// ---------------------------------------------------------------------------

/**
 * Founder rule 2026-07-13 v15.17 — Contra-asset detection.
 *
 * Some Chart of Accounts don't yet split accumulated depreciation
 * onto its own dedicated FS Group; instead every capital account
 * (Land, Buildings, Accum. Depreciation, etc.) is assigned to a
 * generic `CAPITAL_ASSETS` category or `BS_CAPITAL_ASSETS` FS Group.
 * If the projection then aggregates by FS Group, accumulated
 * depreciation gets summed as a POSITIVE amount and inflates Total
 * Assets by twice the depreciation balance.
 *
 * The founder explicitly allowed a narrowly-scoped pattern-based
 * fallback: "A temporary migration or legacy fallback may use a
 * carefully scoped pattern only to identify existing records that
 * need their metadata corrected."
 *
 * The correct long-term fix is CoA metadata — either splitting
 * accum. depreciation into its own FS Group (`BS_ACCUMULATED_DEPRECIATION`)
 * or adding an `isContra` flag to `FinancialStatementGroup`.
 * This helper serves both cases:
 *
 *   1. Structured metadata: an account whose `fsGroupKey` starts with
 *      `BS_ACCUMULATED_DEPRECIATION` or `BS_ACCUMULATED_AMORTIZATION`
 *      is contra-asset by construction.
 *   2. Legacy pattern: an account whose name matches one of the
 *      canonical accumulated-depreciation / amortization phrases is
 *      recognised as contra-asset regardless of its FS Group.
 *
 * The pattern check is CASE-INSENSITIVE and covers the common name
 * shapes seen across Jonas + Spectre-Accounting imports:
 *   • "Accum Deprec", "Accum. Deprec", "Accumulated Depreciation"
 *   • "Accum Amort", "Accum. Amort", "Accumulated Amortization"
 */
export function isAccumulatedDepreciationLine(args: {
  accountName?: string | null;
  fsGroupKey?: string | null;
  fsGroupName?: string | null;
}): boolean {
  const fsKey = args.fsGroupKey?.toUpperCase() ?? "";
  if (
    fsKey.startsWith("BS_ACCUMULATED_DEPRECIATION") ||
    fsKey.startsWith("BS_ACCUMULATED_AMORTIZATION")
  ) {
    return true;
  }
  const name = args.accountName?.toLowerCase() ?? "";
  const fsName = args.fsGroupName?.toLowerCase() ?? "";
  const contraPatterns = [
    /\baccum(?:ulated)?\.?\s+deprec(?:iation)?\b/,
    /\baccum(?:ulated)?\.?\s+amort(?:i[zs]ation)?\b/,
    /^accum\.?\s+depr\b/,
    /^accum\.?\s+amort\b/,
    /\bless\s*:\s*accumulated\b/,
  ];
  for (const re of contraPatterns) {
    if (re.test(name) || re.test(fsName)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Founder rule 2026-07-13 v15.18 — Tax-family net settlement.
//
// Tax control accounts represent ONE net settlement position with
// the taxation authority. The Statement of Financial Position must
// display each tax family as a single row on the side (asset or
// liability) determined by its ALGEBRAIC net — not by summing the
// absolute values of every underlying account.
//
// Root cause of the founder-observed defect:
//   Account 2005 "GST Collected"       had amount $31,625 (from |credit|)
//   Account 2006 "GST Paid (ITCs)"     had amount $31,403 (from  debit )
//   Account 2007 "GST Suspense"        had amount  $9,135 (from  debit )
//   Standard aggregation summed |31,625| + |31,403| + |9,135| = $72,163
//   and presented "Sales Tax Payable $72,164". Correct algebraic
//   net = -31,625 + 31,403 + 9,135 = +$8,913 (net debit → Sales Tax
//   RECEIVABLE, not payable).
//
// v15.18 detects tax-family lines by FS-Group key or account-name
// pattern, extracts them from the standard aggregation, computes
// the algebraic net per family per period, and emits ONE dynamic
// row on the correct side. Signs are inferred from the account's
// natural balance (Collected/Payable → CREDIT; Paid/ITC/Recoverable/
// Refund/Suspense/Instalment → DEBIT).
//
// The same mechanism applies to corporate income tax. Both families
// share a stable FS-Group identity (BS_SALES_TAX / BS_INCOME_TAX)
// so packagePayloadJson freezes the net + side for point-in-time
// integrity.
// ---------------------------------------------------------------------------

export type TaxFamily = "SALES_TAX" | "CORPORATE_TAX";

/** Return the tax family a line belongs to, or `null` when it isn't
 *  a tax control account. Consults both structured metadata
 *  (fsGroupKey) and a founder-authorised name-pattern fallback for
 *  COAs that haven't yet split tax accounts onto a dedicated
 *  FS Group. */
export function getTaxFamily(args: {
  accountName?: string | null;
  fsGroupKey?: string | null;
  fsGroupName?: string | null;
}): TaxFamily | null {
  const fs = args.fsGroupKey?.toUpperCase() ?? "";
  const fsName = args.fsGroupName?.toLowerCase() ?? "";
  const name = args.accountName?.toLowerCase() ?? "";

  // Structured FS-Group metadata (preferred). Any FS-Group key
  // containing "SALES_TAX" / "GST" / "HST" / "PST" is a sales-tax
  // family member; any containing "INCOME_TAX" / "CORPORATE_TAX"
  // is a corporate-tax family member.
  if (/SALES_TAX|_GST|_HST|_PST|\bGST\b|\bHST\b|\bPST\b/.test(fs)) return "SALES_TAX";
  if (/INCOME_TAX|CORPORATE_TAX/.test(fs)) return "CORPORATE_TAX";

  // Pattern fallback for founder-observed name shapes.
  if (
    /\bgst\b|\bhst\b|\bpst\b|\bqst\b|sales\s*tax|value[-\s]?added\s*tax/.test(name) ||
    /sales\s*tax|\bgst\b|\bhst\b/.test(fsName)
  ) {
    return "SALES_TAX";
  }
  if (
    /(corporate|income)\s+tax|tax\s+provision|tax\s+instal?ment|tax\s+refund|income\s+tax\s+(receivable|payable)/.test(name) ||
    /(corporate|income)\s+tax/.test(fsName)
  ) {
    return "CORPORATE_TAX";
  }
  return null;
}

/** Infer the natural side of a tax control account from its name.
 *  Returns "CREDIT" (liability-side contribution — subtracted from
 *  net), "DEBIT" (asset-side contribution — added to net), or
 *  `null` when the direction can't be inferred. */
export type TaxAccountDirection = "CREDIT" | "DEBIT";
export function getTaxAccountDirection(
  accountName: string | null | undefined,
): TaxAccountDirection | null {
  const name = (accountName ?? "").toLowerCase();
  if (!name) return null;

  // CREDIT side — the tax was collected from customers / owed to
  // the authority. Adds to the net LIABILITY position.
  if (/\bcollected\b/.test(name)) return "CREDIT";
  if (/\bcharged\b/.test(name)) return "CREDIT";
  if (/output\s*tax/.test(name)) return "CREDIT";
  if (/\bpayable\b/.test(name)) return "CREDIT";
  if (/\bprovision\b/.test(name)) return "CREDIT";
  if (/\bowing\b/.test(name)) return "CREDIT";

  // DEBIT side — the tax was paid to suppliers / owed by the
  // authority. Adds to the net ASSET position.
  if (/\bpaid\b|\binput\b|\bitcs?\b|itc[s]?/.test(name)) return "DEBIT";
  if (/\brecoverable\b/.test(name)) return "DEBIT";
  if (/\brefund/.test(name)) return "DEBIT";
  if (/\breceivable\b/.test(name)) return "DEBIT";
  if (/\binstal?ment/.test(name)) return "DEBIT";
  if (/\bsuspense\b/.test(name)) return "DEBIT";
  if (/\bprepaid\b/.test(name)) return "DEBIT";
  if (/\bdeposit\b/.test(name)) return "DEBIT";
  // v15.19 — "GST Filed" fallback. Post-filing clearing accounts
  // typically carry a debit balance representing the tax refund
  // due from the authority. Only reached when `rawSignedAmount`
  // is absent (legacy pre-v15.19 snapshots).
  if (/\bfiled\b/.test(name)) return "DEBIT";
  return null;
}

/**
 * Derive the 9-value `BalanceSheetCategory` from the Chart of Accounts
 * classification. Returns `null` when no reliable derivation exists —
 * caller falls back to the legacy range-based mapping or surfaces the
 * account through the unmapped band.
 *
 * Rules (in evaluation order):
 *
 *   FS-Group override             → for a small set of well-known
 *                                   BS FS-Group keys the section is
 *                                   determined by the group alone.
 *   Accumulated depreciation      → ppe-accumulated-depreciation
 *                                   (independent of category — some
 *                                   COAs put accum. depreciation in
 *                                   `CURRENT_ASSETS`, others in
 *                                   `CAPITAL_ASSETS`).
 *   BS_CURRENT_YEAR_EARNINGS      → ytd-net-income
 *   BS_CAPITAL_RESERVE            → capital-fund-balance
 *
 *   accountType = ASSET
 *     categoryKey = CURRENT_ASSETS  → current-asset
 *     categoryKey = INVESTMENTS     → capital-fund-asset
 *     categoryKey = CAPITAL_ASSETS  → ppe-gross
 *     categoryKey = OTHER_ASSETS    → current-asset  (default asset section)
 *
 *   accountType = LIABILITY
 *     categoryKey = CURRENT_LIABILITIES     → current-liability
 *     categoryKey = LONG_TERM_LIABILITIES   → long-term-liability
 *
 *   accountType = EQUITY  → operating-fund-balance (the default equity
 *                            section — capital-reserve is handled above
 *                            via FS Group).
 */
export function deriveBalanceSheetCategoryFromCoa(args: {
  accountType: string | null | undefined;
  categoryKey: string | null | undefined;
  fsGroupKey: string | null | undefined;
  /** v15.17 — optional account name for contra-asset pattern detection.
   *  Founder-authorised legacy fallback for COAs that haven't yet
   *  split accumulated depreciation onto its own FS Group. */
  accountName?: string | null;
  fsGroupName?: string | null;
}): BalanceSheetCategory | null {
  const type = args.accountType?.toUpperCase() ?? null;
  const category = args.categoryKey?.toUpperCase() ?? null;
  const fsGroup = args.fsGroupKey?.toUpperCase() ?? null;

  // v15.17 — contra-asset detection ALWAYS runs first. Accumulated
  // depreciation / amortization accounts pin to
  // `ppe-accumulated-depreciation` regardless of their FS Group so
  // an inflated Total Assets from a positive-summed contra can never
  // happen.
  if (
    isAccumulatedDepreciationLine({
      accountName: args.accountName ?? null,
      fsGroupKey: args.fsGroupKey ?? null,
      fsGroupName: args.fsGroupName ?? null,
    })
  ) {
    return "ppe-accumulated-depreciation";
  }

  // FS-Group overrides — these keys pin the section regardless of the
  // account's Category.
  if (fsGroup === "BS_CURRENT_YEAR_EARNINGS") {
    return "ytd-net-income";
  }
  if (fsGroup === "BS_CAPITAL_RESERVE") {
    return "capital-fund-balance";
  }
  // v15.20 — Long-Term Asset FS Groups pin to the non-current
  // section regardless of the account's Category. Anything the
  // Chart of Accounts explicitly classifies as a long-term asset
  // (Long-term Receivables, Right-of-Use Assets, Intangibles) is
  // excluded from Total Current Assets.
  if (
    fsGroup === "BS_LONG_TERM_RECEIVABLES" ||
    fsGroup === "BS_ROU_ASSETS" ||
    fsGroup === "BS_INTANGIBLES" ||
    fsGroup === "BS_OTHER_LONG_TERM_ASSETS"
  ) {
    return "long-term-asset";
  }

  // v15.16 — the derivation is STRICT. We only return a section
  // when the CoA has enough data (accountType + either categoryKey
  // or a known FS-Group override) to make a confident routing.
  // When CoA data is thin the caller falls back to the legacy
  // range-based mapping — this preserves the pre-v15.16 behaviour
  // for test fixtures + legacy TBs that haven't seeded the CoA
  // side yet, while still routing correctly for any account whose
  // Chart of Accounts record IS populated.

  if (type === "ASSET" && category !== null) {
    switch (category) {
      case "CURRENT_ASSETS":     return "current-asset";
      case "INVESTMENTS":        return "capital-fund-asset";
      case "CAPITAL_ASSETS":     return "ppe-gross";
      // v15.20 — explicit Long-Term Assets category. Founder rule:
      // "A receivable classified in the COA as long-term must appear
      // in a non-current asset category." Anything the CoA labels
      // as LONG_TERM_ASSETS routes to the dedicated non-current
      // section, never Current Assets.
      case "LONG_TERM_ASSETS":   return "long-term-asset";
      case "NON_CURRENT_ASSETS": return "long-term-asset";
      // OTHER_ASSETS is ambiguous in some COAs. When explicit
      // LONG_TERM_ASSETS isn't used, treat OTHER_ASSETS as
      // long-term (safer: excluded from current assets by default;
      // if a club needs it inside current assets they configure
      // CURRENT_ASSETS explicitly).
      case "OTHER_ASSETS":       return "long-term-asset";
      default:                   return null; // unknown asset category — defer to range mapping
    }
  }

  if (type === "LIABILITY" && category !== null) {
    switch (category) {
      case "CURRENT_LIABILITIES":   return "current-liability";
      case "LONG_TERM_LIABILITIES": return "long-term-liability";
      default:                      return null;
    }
  }

  if (type === "EQUITY" && category !== null) {
    // Explicit FS-Group signals above already routed retained earnings +
    // capital reserve. Anything else on the equity side (share capital,
    // contributed capital, opening equity, member deposits classified
    // as equity) still needs a section. `operating-fund-balance`
    // renders under Members' Equity — the same visual section a
    // typical private-club balance sheet uses for share-capital-style
    // equity accounts.
    return "operating-fund-balance";
  }

  return null;
}

/** The classification metadata the resolver returns per account. */
export type BalanceSheetLineClassification = {
  /** Stable ChartAccount id (cuid). */
  accountId: string;
  /** `Account.type` — "ASSET" | "LIABILITY" | "EQUITY". Revenue /
   *  expense accounts are aggregated into the ytd-net-income line
   *  before this resolver runs, so they never appear here. */
  accountType: string;
  /** `AccountCategory.key` — e.g. "CURRENT_ASSETS", "CAPITAL_ASSETS". */
  categoryKey: string | null;
  categoryName: string | null;
  categorySortOrder: number | null;
  /** `FinancialStatementGroup.key` — e.g. "BS_INVENTORY". `null`
   *  when the account has no FS-Group assignment — the SoFP renders
   *  it in the Unmapped Balance Sheet Accounts band. */
  fsGroupKey: string | null;
  fsGroupName: string | null;
  fsGroupSortOrder: number | null;
  /** Raw `Account.fundApplicability` string — CSV of "OPERATING" /
   *  "CAPITAL". Balance-sheet accounts commonly leave this blank
   *  (per the Prisma schema comment); blank is NOT unmapped. */
  fundApplicability: string | null;
};

/**
 * Resolve the CoA classification for a set of account numbers under
 * a specific club. Performs exactly ONE Prisma query (bounded by
 * the `accountNumber IN (...)` clause), so N+1 access is
 * architecturally impossible.
 *
 * Missing accounts (an accountCode that has no corresponding
 * `Account` row for this `clubId`) are simply omitted from the
 * returned Map. The caller decides whether to surface them as
 * unmapped or fall back to another classifier.
 */
export async function resolveBalanceSheetLineClassifications(args: {
  clubId: string;
  accountCodes: ReadonlyArray<string>;
}): Promise<Map<string, BalanceSheetLineClassification>> {
  const { clubId, accountCodes } = args;
  const result = new Map<string, BalanceSheetLineClassification>();
  if (accountCodes.length === 0) return result;

  const accounts = await prisma.account.findMany({
    where: {
      clubId,
      // Distinct set — a snapshot may have duplicates only if the
      // trial balance had multiple lines per account, but the
      // resolver still returns one classification per account.
      accountNumber: { in: Array.from(new Set(accountCodes)) },
    },
    select: {
      id: true,
      accountNumber: true,
      type: true,
      fundApplicability: true,
      category: {
        select: {
          key: true,
          name: true,
          sortOrder: true,
        },
      },
      fsGroup: {
        select: {
          key: true,
          name: true,
          sortOrder: true,
        },
      },
    },
  });

  for (const account of accounts) {
    result.set(account.accountNumber, {
      accountId: account.id,
      accountType: account.type,
      categoryKey: account.category?.key ?? null,
      categoryName: account.category?.name ?? null,
      categorySortOrder: account.category?.sortOrder ?? null,
      fsGroupKey: account.fsGroup?.key ?? null,
      fsGroupName: account.fsGroup?.name ?? null,
      fsGroupSortOrder: account.fsGroup?.sortOrder ?? null,
      fundApplicability: account.fundApplicability ?? null,
    });
  }
  return result;
}
