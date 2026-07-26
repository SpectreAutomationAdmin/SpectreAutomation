// Silver Springs balance sheet — TEMPORARY seed snapshot.
//
// These values previously lived as inline literals in
// `statement-of-financial-position.ts`. They are now expressed as
// `BalanceSheetSnapshot` objects so the Statement of Financial
// Position section can be fully driven by the Reporting Ledger
// projection contract. The values are still demo seeds — they will
// be replaced by real Jonas / Spectre Accounting imports.
//
// `dataSource: "demo"` is the provenance pill the UI surfaces; a
// real import would carry `"accounting"` or `"derived"`.

import type {
  BalanceSheetLine,
  BalanceSheetSnapshot,
} from "@/lib/reporting/ledger/contracts";
import type { ReportingPeriod } from "@/lib/reporting/reporting-period";

// ---------------------------------------------------------------------------
// Shared seed metadata
// ---------------------------------------------------------------------------

const CLUB_ID = "club_silver_springs";
const FISCAL_YEAR_LABEL_PREFIX = "FY";

// Stable snapshotIds keep these seeds idempotent across re-renders.
const CURRENT_SNAPSHOT_ID = "bs_seed_silver_springs_current";
const PRIOR_YEAR_SNAPSHOT_ID = "bs_seed_silver_springs_prior_year";

// ---------------------------------------------------------------------------
// Current-period seed values
// ---------------------------------------------------------------------------

// Founder rule 2026-07-13 v15.14 — every seed line carries its
// FS-Group classification (`fsGroupKey` + `fsGroupName` +
// `fsGroupSortOrder`) so the summarised Statement of Financial
// Position renders one line per FS Group even when multiple
// accounts roll up to the same group. The Inventory bucket below
// intentionally shows this behaviour: nine separate inventory
// accounts (Food / Liquor / Beer / Draught Beer / Wine / Pop /
// Pro-Shop Clothes / Pro-Shop Balls / Pro-Shop Clubs) that all
// classify under FS Group `BS_INVENTORY` — the SOFP summarises
// them into ONE line labelled "Inventory".
const CURRENT_LINES: ReadonlyArray<
  Omit<BalanceSheetLine, "priorYearSameDateAmount">
> = [
  // Current Assets — Operating Fund
  { accountCode: "1010", accountName: "Cash — Operating Account", category: "current-asset", fund: "operating", amount: 1_896_328, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
  { accountCode: "1100", accountName: "Accounts Receivable, Net",  category: "current-asset", fund: "operating", amount:   984_200, fsGroupKey: "BS_AR", fsGroupName: "Accounts Receivable", fsGroupSortOrder: 20 },

  // Inventory — nine underlying accounts that all roll up to one
  // "Inventory" FS-Group summary line. The founder's example.
  { accountCode: "1300", accountName: "Inventory — Food",           category: "current-asset", fund: "operating", amount:  31_400, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  { accountCode: "1301", accountName: "Inventory — Liquor",         category: "current-asset", fund: "operating", amount:  11_650, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  { accountCode: "1302", accountName: "Inventory — Beer",           category: "current-asset", fund: "operating", amount:  10_343, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  { accountCode: "1303", accountName: "Inventory — Draught Beer",   category: "current-asset", fund: "operating", amount:   4_490, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  { accountCode: "1304", accountName: "Inventory — Wine",           category: "current-asset", fund: "operating", amount:  23_514, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  { accountCode: "1305", accountName: "Inventory — Pop",            category: "current-asset", fund: "operating", amount:   5_209, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  { accountCode: "1306", accountName: "Inventory — Pro-Shop Clothes", category: "current-asset", fund: "operating", amount:  81_625, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  { accountCode: "1307", accountName: "Inventory — Pro-Shop Balls", category: "current-asset", fund: "operating", amount:  41_900, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  { accountCode: "1308", accountName: "Inventory — Pro-Shop Clubs", category: "current-asset", fund: "operating", amount: 123_914, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },

  { accountCode: "1400", accountName: "Prepaid Expenses & Other",  category: "current-asset", fund: "operating", amount:   142_600, fsGroupKey: "BS_PREPAID_EXPENSES", fsGroupName: "Prepaid Expenses", fsGroupSortOrder: 40 },

  // Capital & Reserve Assets — Capital Fund
  { accountCode: "1810", accountName: "Reserve Fund — Separate Account", category: "capital-fund-asset", fund: "reserve", amount: 4_820_000, fsGroupKey: "BS_INVESTMENTS", fsGroupName: "Reserve Investments", fsGroupSortOrder: 110 },
  { accountCode: "1820", accountName: "Capital Projects in Progress",    category: "capital-fund-asset", fund: "capital", amount:   620_000, fsGroupKey: "BS_CIP", fsGroupName: "Capital Projects in Progress", fsGroupSortOrder: 120 },

  // PP&E Gross — four accounts roll into "Capital Assets, Gross".
  { accountCode: "1910", accountName: "Land",                           category: "ppe-gross", fund: "capital", amount:  6_200_000, fsGroupKey: "BS_LAND", fsGroupName: "Land", fsGroupSortOrder: 200 },
  { accountCode: "1920", accountName: "Buildings & Improvements",       category: "ppe-gross", fund: "capital", amount: 22_400_000, fsGroupKey: "BS_BUILDINGS", fsGroupName: "Buildings", fsGroupSortOrder: 210 },
  { accountCode: "1930", accountName: "Equipment & Fixtures",           category: "ppe-gross", fund: "capital", amount:  4_820_000, fsGroupKey: "BS_EQUIPMENT", fsGroupName: "Furniture & Equipment", fsGroupSortOrder: 220 },
  { accountCode: "1940", accountName: "Course & Grounds",               category: "ppe-gross", fund: "capital", amount:  8_600_000, fsGroupKey: "BS_COURSE_IMPROVEMENTS", fsGroupName: "Course Improvements", fsGroupSortOrder: 230 },

  // Accumulated Depreciation (positive amount, negated by presenter).
  { accountCode: "1990", accountName: "Accumulated Depreciation",       category: "ppe-accumulated-depreciation", fund: "capital", amount: 20_480_000, fsGroupKey: "BS_ACCUMULATED_DEPRECIATION", fsGroupName: "Accumulated Depreciation", fsGroupSortOrder: 300 },

  // Current Liabilities
  { accountCode: "2010", accountName: "Accounts Payable",               category: "current-liability", fund: "operating", amount:   284_600, fsGroupKey: "BS_AP", fsGroupName: "Accounts Payable", fsGroupSortOrder: 500 },
  { accountCode: "2020", accountName: "Accrued Payroll & Benefits",     category: "current-liability", fund: "operating", amount:   420_800, fsGroupKey: "BS_PAYROLL_LIABILITIES", fsGroupName: "Accrued Payroll & Benefits", fsGroupSortOrder: 510 },
  { accountCode: "2030", accountName: "Accrued Expenses",               category: "current-liability", fund: "operating", amount:    86_400, fsGroupKey: "BS_ACCRUED_LIABILITIES", fsGroupName: "Accrued Expenses", fsGroupSortOrder: 520 },
  { accountCode: "2040", accountName: "Deferred Dues & Revenue",        category: "current-liability", fund: "operating", amount:   682_000, fsGroupKey: "BS_DEFERRED_REVENUE", fsGroupName: "Deferred Dues & Revenue", fsGroupSortOrder: 530 },
  { accountCode: "2050", accountName: "Current Maturities — Long-Term Debt", category: "current-liability", fund: "operating", amount: 180_000, fsGroupKey: "BS_LONG_TERM_DEBT_CURRENT", fsGroupName: "Current Maturities — Long-Term Debt", fsGroupSortOrder: 540 },

  // Long-Term Liabilities
  { accountCode: "2510", accountName: "Long-Term Debt, Net of Current", category: "long-term-liability", fund: "operating", amount: 1_260_000, fsGroupKey: "BS_LONG_TERM_DEBT", fsGroupName: "Long-Term Debt", fsGroupSortOrder: 600 },
  { accountCode: "2520", accountName: "Deferred Initiation Fees — Refundable", category: "long-term-liability", fund: "operating", amount: 820_000, fsGroupKey: "BS_DEFERRED_INITIATION_FEES", fsGroupName: "Deferred Initiation Fees", fsGroupSortOrder: 610 },

  // Members' Equity
  // Founder rule 2026-07-13 v15.14 — the operating fund balance
  // has been bumped by $135,645 relative to pre-v15.14 so the
  // enriched Silver Springs seed still reconciles after the
  // Inventory FS Group was broken out into nine underlying
  // accounts totalling $334,045 (up from a single $198,400 line).
  { accountCode: "3010", accountName: "Operating Fund Balance",         category: "operating-fund-balance", fund: "operating", amount: 18_420_445, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Operating Fund Balance", fsGroupSortOrder: 800 },
  { accountCode: "3510", accountName: "Capital Reserve Fund Balance",   category: "capital-fund-balance",   fund: "capital",   amount:  7_929_578, fsGroupKey: "BS_CAPITAL_RESERVE", fsGroupName: "Capital Reserve Fund Balance", fsGroupSortOrder: 810 },
  { accountCode: "__YTD_NET_INCOME__", accountName: "Current-Year Earnings to Date", category: "ytd-net-income", fund: "operating", amount:    253_350, fsGroupKey: "BS_CURRENT_YEAR_EARNINGS", fsGroupName: "Current-Year Earnings to Date", fsGroupSortOrder: 820 },
];

// ---------------------------------------------------------------------------
// Prior-year seed values (same accounts, comparative balances)
// ---------------------------------------------------------------------------

const PRIOR_YEAR_LINES: ReadonlyArray<
  Omit<BalanceSheetLine, "priorYearSameDateAmount">
> = [
  { accountCode: "1010", accountName: "Cash — Operating Account",        category: "current-asset", fund: "operating", amount: 1_842_100, fsGroupKey: "BS_CASH_EQUIVALENTS", fsGroupName: "Cash & Cash Equivalents", fsGroupSortOrder: 10 },
  { accountCode: "1100", accountName: "Accounts Receivable, Net",        category: "current-asset", fund: "operating", amount:   921_400, fsGroupKey: "BS_AR", fsGroupName: "Accounts Receivable", fsGroupSortOrder: 20 },

  // Prior-year inventory: same nine underlying accounts, aggregated
  // to the same "BS_INVENTORY" FS-Group summary line so comparatives
  // aggregate under identical group identity.
  { accountCode: "1300", accountName: "Inventory — Food",                category: "current-asset", fund: "operating", amount:  28_600, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  { accountCode: "1301", accountName: "Inventory — Liquor",              category: "current-asset", fund: "operating", amount:  10_800, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  { accountCode: "1302", accountName: "Inventory — Beer",                category: "current-asset", fund: "operating", amount:   9_200, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  { accountCode: "1303", accountName: "Inventory — Draught Beer",        category: "current-asset", fund: "operating", amount:   4_100, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  { accountCode: "1304", accountName: "Inventory — Wine",                category: "current-asset", fund: "operating", amount:  20_800, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  { accountCode: "1305", accountName: "Inventory — Pop",                 category: "current-asset", fund: "operating", amount:   4_800, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  { accountCode: "1306", accountName: "Inventory — Pro-Shop Clothes",    category: "current-asset", fund: "operating", amount:  67_500, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  { accountCode: "1307", accountName: "Inventory — Pro-Shop Balls",      category: "current-asset", fund: "operating", amount:  33_800, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },
  { accountCode: "1308", accountName: "Inventory — Pro-Shop Clubs",      category: "current-asset", fund: "operating", amount: 104_500, fsGroupKey: "BS_INVENTORY", fsGroupName: "Inventory", fsGroupSortOrder: 30 },

  { accountCode: "1400", accountName: "Prepaid Expenses & Other",        category: "current-asset", fund: "operating", amount:   138_200, fsGroupKey: "BS_PREPAID_EXPENSES", fsGroupName: "Prepaid Expenses", fsGroupSortOrder: 40 },

  { accountCode: "1810", accountName: "Reserve Fund — Separate Account", category: "capital-fund-asset", fund: "reserve", amount: 4_280_000, fsGroupKey: "BS_INVESTMENTS", fsGroupName: "Reserve Investments", fsGroupSortOrder: 110 },
  { accountCode: "1820", accountName: "Capital Projects in Progress",    category: "capital-fund-asset", fund: "capital", amount:   284_000, fsGroupKey: "BS_CIP", fsGroupName: "Capital Projects in Progress", fsGroupSortOrder: 120 },

  { accountCode: "1910", accountName: "Land",                            category: "ppe-gross", fund: "capital", amount:  6_200_000, fsGroupKey: "BS_LAND", fsGroupName: "Land", fsGroupSortOrder: 200 },
  { accountCode: "1920", accountName: "Buildings & Improvements",        category: "ppe-gross", fund: "capital", amount: 21_800_000, fsGroupKey: "BS_BUILDINGS", fsGroupName: "Buildings", fsGroupSortOrder: 210 },
  { accountCode: "1930", accountName: "Equipment & Fixtures",            category: "ppe-gross", fund: "capital", amount:  4_640_000, fsGroupKey: "BS_EQUIPMENT", fsGroupName: "Furniture & Equipment", fsGroupSortOrder: 220 },
  { accountCode: "1940", accountName: "Course & Grounds",                category: "ppe-gross", fund: "capital", amount:  8_400_000, fsGroupKey: "BS_COURSE_IMPROVEMENTS", fsGroupName: "Course Improvements", fsGroupSortOrder: 230 },

  { accountCode: "1990", accountName: "Accumulated Depreciation",        category: "ppe-accumulated-depreciation", fund: "capital", amount: 19_450_000, fsGroupKey: "BS_ACCUMULATED_DEPRECIATION", fsGroupName: "Accumulated Depreciation", fsGroupSortOrder: 300 },

  { accountCode: "2010", accountName: "Accounts Payable",                category: "current-liability", fund: "operating", amount: 312_400, fsGroupKey: "BS_AP", fsGroupName: "Accounts Payable", fsGroupSortOrder: 500 },
  { accountCode: "2020", accountName: "Accrued Payroll & Benefits",      category: "current-liability", fund: "operating", amount: 398_200, fsGroupKey: "BS_PAYROLL_LIABILITIES", fsGroupName: "Accrued Payroll & Benefits", fsGroupSortOrder: 510 },
  { accountCode: "2030", accountName: "Accrued Expenses",                category: "current-liability", fund: "operating", amount:  74_800, fsGroupKey: "BS_ACCRUED_LIABILITIES", fsGroupName: "Accrued Expenses", fsGroupSortOrder: 520 },
  { accountCode: "2040", accountName: "Deferred Dues & Revenue",         category: "current-liability", fund: "operating", amount: 648_000, fsGroupKey: "BS_DEFERRED_REVENUE", fsGroupName: "Deferred Dues & Revenue", fsGroupSortOrder: 530 },
  { accountCode: "2050", accountName: "Current Maturities — Long-Term Debt", category: "current-liability", fund: "operating", amount: 180_000, fsGroupKey: "BS_LONG_TERM_DEBT_CURRENT", fsGroupName: "Current Maturities — Long-Term Debt", fsGroupSortOrder: 540 },

  { accountCode: "2510", accountName: "Long-Term Debt, Net of Current",  category: "long-term-liability", fund: "operating", amount: 1_440_000, fsGroupKey: "BS_LONG_TERM_DEBT", fsGroupName: "Long-Term Debt", fsGroupSortOrder: 600 },
  { accountCode: "2520", accountName: "Deferred Initiation Fees — Refundable", category: "long-term-liability", fund: "operating", amount: 780_000, fsGroupKey: "BS_DEFERRED_INITIATION_FEES", fsGroupName: "Deferred Initiation Fees", fsGroupSortOrder: 610 },

  // v15.14 — bumped by $121,300 vs. pre-v15.14 to reconcile the
  // enriched prior-year inventory breakout ($284,100 total across
  // nine accounts, up from $162,800 single line).
  { accountCode: "3010", accountName: "Operating Fund Balance",          category: "operating-fund-balance", fund: "operating", amount: 17_543_900, fsGroupKey: "BS_RETAINED_EARNINGS", fsGroupName: "Operating Fund Balance", fsGroupSortOrder: 800 },
  { accountCode: "3510", accountName: "Capital Reserve Fund Balance",    category: "capital-fund-balance",   fund: "capital",   amount:  7_709_100, fsGroupKey: "BS_CAPITAL_RESERVE", fsGroupName: "Capital Reserve Fund Balance", fsGroupSortOrder: 810 },
  { accountCode: "__YTD_NET_INCOME__", accountName: "Year-to-Date Net Income", category: "ytd-net-income", fund: "operating", amount:    253_400, fsGroupKey: "BS_CURRENT_YEAR_EARNINGS", fsGroupName: "Year-to-Date Net Income", fsGroupSortOrder: 820 },
];

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

/** Build the Silver Springs current-period BS snapshot for a given
 *  reporting period. */
export function buildSilverSpringsBalanceSheetSnapshot(
  period: ReportingPeriod,
): BalanceSheetSnapshot {
  return buildSnapshot({
    snapshotId: CURRENT_SNAPSHOT_ID,
    asOf: period.periodEnd,
    fiscalYearLabel: `${FISCAL_YEAR_LABEL_PREFIX}${period.year}`,
    rawLines: CURRENT_LINES,
    priorYearLookup: indexByCode(PRIOR_YEAR_LINES),
  });
}

/** Build the Silver Springs prior-year-same-date BS snapshot. */
export function buildSilverSpringsPriorYearBalanceSheetSnapshot(
  period: ReportingPeriod,
): BalanceSheetSnapshot {
  const priorYearEnd = new Date(period.periodEnd);
  priorYearEnd.setUTCFullYear(priorYearEnd.getUTCFullYear() - 1);
  return buildSnapshot({
    snapshotId: PRIOR_YEAR_SNAPSHOT_ID,
    asOf: priorYearEnd,
    fiscalYearLabel: `${FISCAL_YEAR_LABEL_PREFIX}${period.year - 1}`,
    rawLines: PRIOR_YEAR_LINES,
    priorYearLookup: null,
  });
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildSnapshot(args: {
  snapshotId: string;
  asOf: Date;
  fiscalYearLabel: string;
  rawLines: ReadonlyArray<Omit<BalanceSheetLine, "priorYearSameDateAmount">>;
  priorYearLookup: Map<string, number> | null;
}): BalanceSheetSnapshot {
  // Founder rule 2026-07-13 v15.22 — every seed line MUST carry
  // `rawSignedAmount` (the Jonas debit-positive / credit-negative
  // convention) so downstream `normaliseSign` never sees a missing
  // sign and refuses to fall back to unsigned magnitude. For seed
  // categories the convention is:
  //   • debit-normal categories (assets)  → rawSignedAmount = +amount
  //   • credit-normal categories (liab,
  //     equity, ytd earnings)             → rawSignedAmount = -amount
  //   • ppe-accumulated-depreciation      → credit-normal contra:
  //                                          rawSignedAmount = -amount
  const seedRawSign = (category: BalanceSheetLine["category"], amount: number): number => {
    switch (category) {
      case "current-asset":
      case "capital-fund-asset":
      case "long-term-asset":
      case "ppe-gross":
        return amount;
      case "ppe-accumulated-depreciation":
      case "current-liability":
      case "long-term-liability":
      case "operating-fund-balance":
      case "capital-fund-balance":
      case "ytd-net-income":
        return -amount;
    }
  };
  const lines: BalanceSheetLine[] = args.rawLines.map((l) => ({
    ...l,
    rawSignedAmount: l.rawSignedAmount ?? seedRawSign(l.category, l.amount),
    priorYearSameDateAmount: args.priorYearLookup?.get(l.accountCode) ?? null,
  }));

  let currentAssets = 0;
  let capitalFundAssets = 0;
  let ppeGross = 0;
  let accumDepr = 0;
  let currentLiab = 0;
  let longTermLiab = 0;
  let operatingFund = 0;
  let capitalFund = 0;
  let ytdNetIncome = 0;
  for (const l of lines) {
    switch (l.category) {
      case "current-asset": currentAssets += l.amount; break;
      case "capital-fund-asset": capitalFundAssets += l.amount; break;
      case "ppe-gross": ppeGross += l.amount; break;
      case "ppe-accumulated-depreciation": accumDepr += l.amount; break;
      case "current-liability": currentLiab += l.amount; break;
      case "long-term-liability": longTermLiab += l.amount; break;
      case "operating-fund-balance": operatingFund += l.amount; break;
      case "capital-fund-balance": capitalFund += l.amount; break;
      case "ytd-net-income": ytdNetIncome += l.amount; break;
    }
  }
  const totalAssets = currentAssets + capitalFundAssets + ppeGross - accumDepr;
  const totalLiabilities = currentLiab + longTermLiab;
  const totalEquity = operatingFund + capitalFund + ytdNetIncome;

  return {
    snapshotId: args.snapshotId,
    clubId: CLUB_ID,
    capturedAt: new Date(0), // deterministic for seeds
    sourceSystem: "demo-seed",
    importBatchId: null,
    dataSource: "demo",
    notes: "Silver Springs demo seed",
    entityKind: "balance-sheet",
    asOf: args.asOf,
    fiscalYearLabel: args.fiscalYearLabel,
    lines,
    totalAssets,
    totalLiabilities,
    totalEquity,
    isReconciled: Math.abs(totalAssets - (totalLiabilities + totalEquity)) < 1,
  };
}

function indexByCode(
  lines: ReadonlyArray<Omit<BalanceSheetLine, "priorYearSameDateAmount">>,
): Map<string, number> {
  const map = new Map<string, number>();
  for (const l of lines) map.set(l.accountCode, l.amount);
  return map;
}
