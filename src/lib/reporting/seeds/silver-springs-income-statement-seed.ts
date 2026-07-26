// Silver Springs income statement — TEMPORARY seed snapshots.
//
// Mirrors the Saguaro-reference numerics that previously lived as
// inline literals in `statement-of-activities.ts`. Two snapshots:
//
//   • CURRENT_MONTH — activity for the current reporting month only
//   • YTD           — cumulative year-to-date through the reporting
//                     period end
//
// These will be REPLACED by real Jonas / Spectre Accounting imports.
// Until then they back the demo branch of the SoA dual-read so
// development environments keep rendering correctly.

import type {
  IncomeStatementLine,
  IncomeStatementSnapshot,
} from "@/lib/reporting/ledger/contracts";
import type { ReportingPeriod } from "@/lib/reporting/reporting-period";

const CLUB_ID = "club_silver_springs";

// ---------------------------------------------------------------------------
// YTD activity (Q1 — Jan through Mar in the Saguaro reference period)
// ---------------------------------------------------------------------------

type SeedLine = Omit<IncomeStatementLine, "amount"> & {
  ytdAmount: number;
  currentMonthAmount: number;
};

const SEED_LINES: ReadonlyArray<SeedLine> = [
  // -- Operating revenue --
  { accountCode: "4010", accountName: "Membership Dues",          category: "revenue", fund: "operating", departmentCode: null,        ytdAmount: 1_169_525, currentMonthAmount: 390_525 },
  { accountCode: "4020", accountName: "Service Assessment",       category: "revenue", fund: "operating", departmentCode: null,        ytdAmount:   300_355, currentMonthAmount: 105_067 },

  // Golf
  { accountCode: "4110", accountName: "Golf — Guest Fees",        category: "revenue", fund: "operating", departmentCode: "GOLF",      ytdAmount:   123_401, currentMonthAmount:  56_832 },
  { accountCode: "4120", accountName: "Golf — Cart Fees",         category: "revenue", fund: "operating", departmentCode: "GOLF",      ytdAmount:   203_497, currentMonthAmount:  75_817 },
  { accountCode: "4130", accountName: "Golf — Merchandise",       category: "revenue", fund: "operating", departmentCode: "GOLF",      ytdAmount:   179_954, currentMonthAmount:  77_786 },
  { accountCode: "4140", accountName: "Golf — Tournaments & Other Income", category: "revenue", fund: "operating", departmentCode: "GOLF", ytdAmount: 266_787, currentMonthAmount: 133_711 },

  // F&B
  { accountCode: "4210", accountName: "F&B — Ala Carte Food",     category: "revenue", fund: "operating", departmentCode: "FB",        ytdAmount:   416_736, currentMonthAmount: 152_760 },
  { accountCode: "4220", accountName: "F&B — Ala Carte Beverage", category: "revenue", fund: "operating", departmentCode: "FB",        ytdAmount:   239_318, currentMonthAmount:  87_657 },
  { accountCode: "4230", accountName: "F&B — Banquet & Private Events", category: "revenue", fund: "operating", departmentCode: "FB",   ytdAmount:    76_439, currentMonthAmount:  10_484 },

  // Amenities
  { accountCode: "4410", accountName: "Fitness Center",           category: "revenue", fund: "operating", departmentCode: "AMENITY",   ytdAmount:   115_525, currentMonthAmount:  43_210 },
  { accountCode: "4420", accountName: "Racquet Operations",       category: "revenue", fund: "operating", departmentCode: "AMENITY",   ytdAmount:    71_027, currentMonthAmount:  21_705 },
  { accountCode: "4430", accountName: "Aquatics & Pool",          category: "revenue", fund: "operating", departmentCode: "AMENITY",   ytdAmount:    41_850, currentMonthAmount:  14_200 },
  { accountCode: "4440", accountName: "Locker & Member Services", category: "revenue", fund: "operating", departmentCode: "AMENITY",   ytdAmount:    14_985, currentMonthAmount:   5_245 },
  { accountCode: "4450", accountName: "Other Income",             category: "revenue", fund: "operating", departmentCode: null,        ytdAmount:    52_308, currentMonthAmount:  22_402 },

  // -- Operating expense --
  // Cost of sales
  { accountCode: "5110", accountName: "Cost of Sales — Golf Merchandise", category: "expense", fund: "operating", departmentCode: "GOLF", ytdAmount: 128_505, currentMonthAmount:  51_917 },
  { accountCode: "5210", accountName: "Cost of Sales — Food",     category: "expense", fund: "operating", departmentCode: "FB",        ytdAmount:   219_479, currentMonthAmount:  90_217 },
  { accountCode: "5220", accountName: "Cost of Sales — Beverage & Retail", category: "expense", fund: "operating", departmentCode: "FB", ytdAmount: 118_838, currentMonthAmount:  38_794 },
  { accountCode: "5290", accountName: "Cost of Sales — Other",    category: "expense", fund: "operating", departmentCode: null,        ytdAmount:    10_364, currentMonthAmount:   2_269 },

  // Payroll
  { accountCode: "5400", accountName: "Payroll — All Departments", category: "expense", fund: "operating", departmentCode: null,       ytdAmount: 3_050_304, currentMonthAmount: 1_043_640 },
  { accountCode: "5500", accountName: "Benefits & Payroll-Related", category: "expense", fund: "operating", departmentCode: null,      ytdAmount:   501_717, currentMonthAmount: 165_047 },

  // Other operating
  { accountCode: "6110", accountName: "Golf Operations — Other Expenses", category: "expense", fund: "operating", departmentCode: "GOLF", ytdAmount: 289_833, currentMonthAmount: 141_303 },
  { accountCode: "6210", accountName: "F&B — Other Expenses",     category: "expense", fund: "operating", departmentCode: "FB",        ytdAmount:   120_350, currentMonthAmount:  42_630 },
  { accountCode: "6310", accountName: "Course & Grounds Maintenance", category: "expense", fund: "operating", departmentCode: null,    ytdAmount:   265_949, currentMonthAmount: 100_075 },
  { accountCode: "6410", accountName: "Facilities & Maintenance", category: "expense", fund: "operating", departmentCode: null,        ytdAmount:   266_067, currentMonthAmount:  92_161 },
  { accountCode: "6510_GA", accountName: "General & Administrative", category: "expense", fund: "operating", departmentCode: null,     ytdAmount:   275_768, currentMonthAmount:  96_354 },
  { accountCode: "6710", accountName: "Amenities — Other Expenses", category: "expense", fund: "operating", departmentCode: "AMENITY", ytdAmount:   196_294, currentMonthAmount:  79_539 },

  { accountCode: "6810", accountName: "Fixed Expenses — Insurance, Taxes & Other", category: "expense", fund: "operating", departmentCode: null, ytdAmount: 85_595, currentMonthAmount: 28_513 },

  // Depreciation — split out so the projection's `depreciation`
  // roll-up populates and the SoA can render it as a separate line.
  { accountCode: "6510", accountName: "Depreciation",             category: "expense", fund: "operating", departmentCode: null,        ytdAmount: 1_029_122, currentMonthAmount: 345_274 },

  // -- Capital fund (below the line) --
  { accountCode: "9010", accountName: "Initiation Fees — New Members", category: "revenue", fund: "capital", departmentCode: null,      ytdAmount:   480_000, currentMonthAmount: 240_000 },
  { accountCode: "9020", accountName: "Capital Dues — Monthly Assessment", category: "revenue", fund: "capital", departmentCode: null,  ytdAmount:   480_000, currentMonthAmount: 160_000 },
  { accountCode: "9030", accountName: "Investment Income — Reserve Fund", category: "revenue", fund: "capital", departmentCode: null,   ytdAmount:    46_200, currentMonthAmount:  16_124 },
  { accountCode: "9040", accountName: "Gain on Asset Disposals", category: "revenue", fund: "capital", departmentCode: null,            ytdAmount:     6_700, currentMonthAmount:       0 },
  { accountCode: "9510", accountName: "Interest Expense — Long-Term Debt", category: "expense", fund: "capital", departmentCode: null,  ytdAmount:    12_888, currentMonthAmount:   3_895 },
];

// ---------------------------------------------------------------------------
// Public builders
// ---------------------------------------------------------------------------

export function buildSilverSpringsYtdIncomeStatementSnapshot(
  period: ReportingPeriod,
): IncomeStatementSnapshot {
  return buildSnapshot({
    snapshotId: "is_seed_silver_springs_ytd",
    period,
    pickAmount: (l) => l.ytdAmount,
  });
}

export function buildSilverSpringsCurrentMonthIncomeStatementSnapshot(
  period: ReportingPeriod,
): IncomeStatementSnapshot {
  return buildSnapshot({
    snapshotId: "is_seed_silver_springs_current_month",
    period,
    pickAmount: (l) => l.currentMonthAmount,
  });
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function buildSnapshot(args: {
  snapshotId: string;
  period: ReportingPeriod;
  pickAmount: (l: SeedLine) => number;
}): IncomeStatementSnapshot {
  const lines: IncomeStatementLine[] = SEED_LINES.map((l) => ({
    accountCode: l.accountCode,
    accountName: l.accountName,
    category: l.category,
    fund: l.fund,
    departmentCode: l.departmentCode,
    amount: args.pickAmount(l),
  }));

  let totalOperatingRevenue = 0;
  let totalOperatingExpense = 0;
  let depreciation = 0;
  let totalCapitalIncome = 0;
  let totalCapitalExpense = 0;
  for (const l of lines) {
    if (l.category === "revenue" && l.fund === "operating") totalOperatingRevenue += l.amount;
    else if (l.category === "expense" && l.fund === "operating") {
      totalOperatingExpense += l.amount;
      if (/depreciation/i.test(l.accountName)) depreciation += l.amount;
    } else if (l.category === "revenue" && l.fund === "capital") totalCapitalIncome += l.amount;
    else if (l.category === "expense" && l.fund === "capital") totalCapitalExpense += l.amount;
  }
  const noiBeforeDepreciation =
    totalOperatingRevenue - (totalOperatingExpense - depreciation);

  return {
    snapshotId: args.snapshotId,
    clubId: CLUB_ID,
    capturedAt: new Date(0),
    sourceSystem: "demo-seed",
    importBatchId: null,
    dataSource: "demo",
    notes: "Silver Springs demo IS seed",
    entityKind: "income-statement",
    periodStart: args.period.periodStart,
    periodEnd: args.period.periodEnd,
    fiscalYearLabel: `FY${args.period.year}`,
    fiscalPeriodSequence: args.period.month,
    lines,
    totalOperatingRevenue,
    totalOperatingExpense,
    noiBeforeDepreciation,
    depreciation,
    totalCapitalIncome,
    totalCapitalExpense,
  };
}
