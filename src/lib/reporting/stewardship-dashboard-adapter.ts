// Stewardship Dashboard — BS + IS snapshot adapter.
//
// Translates a BalanceSheetSnapshot + IncomeStatementSnapshot pair
// into the typed atoms `buildOperatingScorecardSnapshotFromAccounting`
// and `buildCapitalScorecardSnapshotFromAccounting` expect. Same
// dual-read pattern as the prior migrations:
//
//   1. If a TB exists in the ledger for (clubId, asOf), self-heal
//      project BS + IS (idempotent via payload hash) and build
//      scorecards + summary cards from those snapshots.
//   2. Else, fall back to the demo scorecard factories so dev
//      environments keep rendering correctly.
//
// THE EXISTING RAG ENGINE (in operating-scorecard-service.ts +
// capital-scorecard-service.ts) is reused unchanged — its NOI / equity
// status classifiers automatically derive RED / AMBER / GREEN from the
// snapshot numerics this adapter supplies.

import type {
  BalanceSheetSnapshot,
  IncomeStatementSnapshot,
} from "@/lib/reporting/ledger/contracts";
import type { ReportingLedger } from "@/lib/reporting/ledger/read-api";
import type { ReportingLedgerWriter } from "@/lib/reporting/ledger/write-api";
import { BalanceSheetProjection } from "@/lib/reporting/ledger/projections/balance-sheet-projection";
import { IncomeStatementProjection } from "@/lib/reporting/ledger/projections/income-statement-projection";
import type { ReportingPeriod } from "@/lib/reporting/reporting-period";
import type { MonthlyAccountingDataSource } from "@/lib/reporting/monthly-accounting-contract";
import type { KpiTone, StewardshipKpi } from "@/lib/reporting/monthly-package";
import {
  buildCapitalScorecardSnapshotFromAccounting,
  type AccountingCapitalScorecardAtoms,
  type CapitalScorecardSnapshot,
} from "@/lib/reporting/capital-scorecard-service";
import {
  buildOperatingScorecardSnapshotFromAccounting,
  type AccountingOperatingScorecardAtoms,
  type OperatingScorecardSnapshot,
} from "@/lib/reporting/operating-scorecard-service";

// ---------------------------------------------------------------------------
// Auxiliary inputs — typed and documented as awaiting their own services
// ---------------------------------------------------------------------------

/**
 * Comparator / config inputs the Stewardship Dashboard needs that
 * are NOT in the BS + IS snapshots. Each entry will move to its own
 * ledger projection in Phase 3.
 */
export type StewardshipAuxiliaryInputs = {
  /** Budget comparators (awaiting Budget importer). */
  budget: {
    duesRevenueYtd: number;
    totalOperatingRevenueYtd: number;
    initiationFeeSubsidyYtd: number;
    payrollBenefitsYtd: number;
    totalCapitalIncomeYtd: number;
  };
  /** Policy + study config (config-driven; not GL-derived). */
  policies: {
    equityToAssetsGoal: number;
    capitalReserveGoal: number;
    netAvailableCapitalGoal: number;
    netPPEGoal: number;
    /** ClubBenchmarking break-even corridor. */
    breakEvenLowerPct: number;
    breakEvenUpperPct: number;
  };
  /** Operational counts — awaiting POS / tee-sheet aggregate
   *  projection. */
  operational: {
    golfRoundsActual: number;
    golfRoundsBudget: number;
    fbCoversActual: number;
    fbCoversBudget: number;
    /** F&B subsidy — null suppresses the row. */
    fbSubsidy: { actual: number; duesForRatio: number } | null;
  };
  /** Reserve study + capital tracker inputs (awaiting Reserve
   *  Study + Capital Project importers). */
  capitalSupporting: {
    capitalReserveBalance: number;
    netAvailableCapital: number;
    netCapital: number;
    depreciation: number;
    longTermDebt: number | null;
    netPPE: number;
    grossPPE: number;
  };
  /** Equity CAGR from `getEquityHistory()`. */
  equity: {
    actualCagrBps: number;
    bestInClassCagrBps: number;
    minimumRequiredCagrBps: number;
  };
  /** Reserve coverage policy (FAC 60% benchmark). */
  reserveCoverage: {
    actualPct: number;
    facBenchmarkPct: number;
    balanceLabel: string; // e.g. "$4.82M balance"
  };
  /** Policy targets + peer-median labels for the 6 BS+IS-derivable
   *  KPI cards. Thresholds drive tone classification; peer medians
   *  are rendered as the card's `benchmark` line. */
  kpiThresholds: {
    duesRevenuePolicyLo: number;          // e.g. 0.38
    duesRevenuePolicyHi: number;          // e.g. 0.44
    duesRevenuePeerMedianLabel: string;   // e.g. "Peer median 39.4%"
    payrollPlan: number;                  // e.g. 0.50
    payrollPeerMedianLabel: string;       // e.g. "Peer median 50.6%"
    noiMarginPlan: number;                // e.g. 0.20
    noiMarginPeerMedianLabel: string;     // e.g. "Peer median 18.5%"
    capitalIncomeVsPlanPeerMedianLabel?: string;
    debtEquityCeiling: number;            // e.g. 0.25
    debtEquityPeerMedianLabel: string;    // e.g. "Peer median 0.18"
    ppeReinvestmentCautionFloor: number;  // e.g. 0.45
    ppeReinvestmentPeerMedianLabel: string;
    workingCapitalPolicyFloor: number;    // e.g. 3_500_000
  };
  /** Pre-built KPI cards for the 10 rows whose values come from
   *  outside BS + IS (POS, AR Aging, Reserve Study, Capital Tracker,
   *  F&B subledger). Each block will become a derived branch when
   *  its respective importer / projection lands. */
  auxiliaryKpiCards: {
    operating: {
      fbSubsidy: StewardshipKpi;        // awaiting F&B subledger
      rounds: StewardshipKpi;           // awaiting POS / tee-sheet
      covers: StewardshipKpi;           // awaiting POS
      arCurrent: StewardshipKpi;        // awaiting AR Aging projection
      initFeeSubsidy: StewardshipKpi;   // awaiting F&B subsidy + init-fees split
    };
    capital: {
      reserveCoverage: StewardshipKpi;  // awaiting Reserve Study
      capitalSpend: StewardshipKpi;     // awaiting Capital Projects
      reserveSufficiency: StewardshipKpi; // awaiting Reserve Study + Capital Tracker
      projectCompletion: StewardshipKpi;  // awaiting Capital Projects
    };
  };
};

// ---------------------------------------------------------------------------
// Stewardship dashboard ledger-resolved bundle
// ---------------------------------------------------------------------------

/**
 * The set of values the stewardship dashboard needs from the ledger
 * (plus typed auxiliary inputs). Returned from `getStewardshipForClub`
 * and used by `monthly-package.ts` to populate every stewardship
 * surface.
 */
export type StewardshipLedgerBundle = {
  /** Operating scorecard snapshot — feeds buildOperatingScorecardData. */
  operatingScorecard: OperatingScorecardSnapshot;
  /** Capital scorecard snapshot — feeds buildCapitalScorecardData. */
  capitalScorecard: CapitalScorecardSnapshot;
  /** Chapter III Stewardship KPI Dashboard summary cards — derived
   *  values that previously lived as inline literals on the package
   *  builder (revenue $5.786M, NOI $253K, capital income $1.285M,
   *  reserve coverage 61%). */
  summaryCards: {
    revenue: {
      value: string;
      varianceAmount: string;
      varianceLabel: string;
      varianceTone: "positive" | "negative" | "neutral";
    };
    noiBeforeDep: {
      value: string;
      varianceAmount: string;
      varianceLabel: string;
      varianceTone: "positive" | "negative" | "neutral";
      marginPct: string;
    };
    capitalFundIncome: {
      value: string;
      subtext: string;
    };
    reserveCoverage: {
      value: string;
      balance: string;
      benchmark: string;
    };
  };
  /** Chapter III explanatory KPI panels — Operating roster. 8 rows
   *  in fixed order (dues-rev, payroll-ratio, noi-margin, fb-subsidy,
   *  rounds-vs-plan, covers-vs-plan, ar-current, init-fee-subsidy).
   *  The 3 BS+IS-derivable rows recompute from the snapshot on the
   *  live branch; the remaining 5 flow through from auxiliary input.
   *  buildStewardshipDashboardNotes consumes this array — when a
   *  card tone flips, the dashboard-notes paragraph reacts. */
  operatingKpiCards: StewardshipKpi[];
  /** Capital roster. 8 rows: reserve-coverage, capital-income-vs-plan,
   *  capital-spend-vs-plan, debt-equity, ppe-reinvestment,
   *  reserve-sufficiency, working-capital, project-completion. 3 are
   *  BS/IS-derivable (capital-income-vs-plan, debt-equity,
   *  ppe-reinvestment, working-capital — actually 4); 4 stay
   *  auxiliary pending Reserve Study + Capital Tracker imports. */
  capitalKpiCards: StewardshipKpi[];
  /** Where the data came from — `"live"` when a TB existed; `"demo"`
   *  when the fallback fired. Drives the dataSource pill. */
  dataSource: "live" | "demo";
};

// ---------------------------------------------------------------------------
// Public entry point — DUAL-READ
// ---------------------------------------------------------------------------

/**
 * Dual-read entry point. Returns either ledger-derived scorecard
 * snapshots OR the demo factories' output, plus the chapter III
 * summary-card values.
 *
 * The demoFallback closure receives the AUXILIARY inputs so the
 * caller can keep its existing seed-builder one-liner. The fallback
 * is what monthly-package.ts has been doing all along.
 */
export async function getStewardshipForClub(args: {
  clubId: string;
  period: ReportingPeriod;
  ledger: ReportingLedger & ReportingLedgerWriter;
  auxiliaryInputs: StewardshipAuxiliaryInputs;
  demoFallback: () => Pick<
    StewardshipLedgerBundle,
    "operatingScorecard" | "capitalScorecard" | "summaryCards" | "operatingKpiCards" | "capitalKpiCards"
  >;
}): Promise<StewardshipLedgerBundle> {
  const snapshots = await resolveBsAndIs({
    ledger: args.ledger,
    clubId: args.clubId,
    period: args.period,
  });

  if (!snapshots) {
    const fallback = args.demoFallback();
    return { ...fallback, dataSource: "demo" };
  }

  const { bs, is } = snapshots;
  const provenance: MonthlyAccountingDataSource =
    is.dataSource === "demo" ? "demo" : "accounting";
  const derivedProvenance: MonthlyAccountingDataSource =
    bs.dataSource === "demo" ? "demo" : "derived";
  void provenance;
  void derivedProvenance;

  return {
    operatingScorecard: buildOperatingScorecardSnapshotFromAccounting(
      buildOperatingAtomsFromSnapshots(is, args.auxiliaryInputs, provenance),
    ),
    capitalScorecard: buildCapitalScorecardSnapshotFromAccounting(
      buildCapitalAtomsFromSnapshots(
        bs,
        is,
        args.auxiliaryInputs,
        provenance,
        derivedProvenance,
      ),
    ),
    summaryCards: buildSummaryCards(bs, is, args.auxiliaryInputs),
    operatingKpiCards: buildOperatingKpiCards(is, args.auxiliaryInputs),
    capitalKpiCards: buildCapitalKpiCards(bs, is, args.auxiliaryInputs),
    dataSource: "live",
  };
}

// ---------------------------------------------------------------------------
// Atom adapters — BS + IS snapshot → AccountingScorecardAtoms
// ---------------------------------------------------------------------------

function buildOperatingAtomsFromSnapshots(
  is: IncomeStatementSnapshot,
  aux: StewardshipAuxiliaryInputs,
  provenance: MonthlyAccountingDataSource,
): AccountingOperatingScorecardAtoms {
  // Operating dues = sum of operating revenue lines with no
  // departmentCode (the "general / membership" bucket). Falls back to
  // the first revenue line's amount if the chart of accounts is
  // sparse (e.g. the Jonas test datasets have only 4010 + 4020).
  const duesLines = is.lines.filter(
    (l) => l.category === "revenue" && l.fund === "operating" && !l.departmentCode,
  );
  const dues = duesLines.reduce((s, l) => s + l.amount, 0);

  return {
    dues: {
      actual: dues,
      budget: aux.budget.duesRevenueYtd,
      dataSource: provenance,
    },
    totalOperatingRevenue: {
      actual: is.totalOperatingRevenue,
      budget: aux.budget.totalOperatingRevenueYtd,
      dataSource: provenance,
    },
    initiationFeeSubsidy: {
      // Operating-fund initiation fees — none in the standard chart
      // of accounts (initiation fees are capital-fund). Treat as 0
      // unless an operating-revenue line is named "initiation".
      actual: is.lines
        .filter(
          (l) =>
            l.category === "revenue" &&
            l.fund === "operating" &&
            /initiation/i.test(l.accountName),
        )
        .reduce((s, l) => s + l.amount, 0),
      budget: aux.budget.initiationFeeSubsidyYtd,
      dataSource: provenance,
    },
    payrollBenefits: {
      // Payroll + benefits roll-up — any expense line whose name
      // contains "payroll" or "benefit" or "wages".
      actual: is.lines
        .filter(
          (l) =>
            l.category === "expense" &&
            l.fund === "operating" &&
            /payroll|benefit|wages/i.test(l.accountName),
        )
        .reduce((s, l) => s + l.amount, 0),
      budget: aux.budget.payrollBenefitsYtd,
      dataSource: provenance,
    },
    fbSubsidy: aux.operational.fbSubsidy
      ? {
          actual: aux.operational.fbSubsidy.actual,
          duesForRatio: aux.operational.fbSubsidy.duesForRatio,
          dataSource: "operational",
        }
      : null,
    golfRounds: {
      actual: aux.operational.golfRoundsActual,
      budget: aux.operational.golfRoundsBudget,
      dataSource: "operational",
    },
    fbCovers: {
      actual: aux.operational.fbCoversActual,
      budget: aux.operational.fbCoversBudget,
      dataSource: "operational",
    },
    noi: {
      ytdNoi: is.noiBeforeDepreciation,
      ytdBudgetNoi: aux.budget.totalOperatingRevenueYtd - aux.budget.payrollBenefitsYtd, // rough budget NOI
      ytdRevenue: is.totalOperatingRevenue,
      breakEvenLowerPct: aux.policies.breakEvenLowerPct,
      breakEvenUpperPct: aux.policies.breakEvenUpperPct,
      dataSource: provenance,
    },
  };
}

function buildCapitalAtomsFromSnapshots(
  bs: BalanceSheetSnapshot,
  is: IncomeStatementSnapshot,
  aux: StewardshipAuxiliaryInputs,
  isProvenance: MonthlyAccountingDataSource,
  bsProvenance: MonthlyAccountingDataSource,
): AccountingCapitalScorecardAtoms {
  return {
    totalEquity: { value: bs.totalEquity, dataSource: bsProvenance },
    totalAssets: { value: bs.totalAssets, dataSource: bsProvenance },
    capitalReserveBalance: {
      value: aux.capitalSupporting.capitalReserveBalance,
      dataSource: "demo",
    },
    netAvailableCapital: {
      value: aux.capitalSupporting.netAvailableCapital,
      dataSource: "demo",
    },
    operatingRevenueForCapital: {
      value: is.totalOperatingRevenue,
      dataSource: isProvenance,
    },
    netCapital: {
      value: aux.capitalSupporting.netCapital,
      dataSource: "demo",
    },
    depreciation: {
      value: is.depreciation > 0 ? is.depreciation : aux.capitalSupporting.depreciation,
      dataSource: is.depreciation > 0 ? isProvenance : "demo",
    },
    longTermDebt: {
      value: aux.capitalSupporting.longTermDebt,
      dataSource: "demo",
    },
    netPPE: {
      value: aux.capitalSupporting.netPPE,
      dataSource: "demo",
    },
    grossPPE: {
      value: aux.capitalSupporting.grossPPE,
      dataSource: "demo",
    },
    totalCapitalIncome: {
      actual: is.totalCapitalIncome,
      budget: aux.budget.totalCapitalIncomeYtd,
      dataSource: isProvenance,
    },
    goals: {
      equityToAssets: aux.policies.equityToAssetsGoal,
      capitalReserve: aux.policies.capitalReserveGoal,
      netAvailableCapital: aux.policies.netAvailableCapitalGoal,
      netPPE: aux.policies.netPPEGoal,
    },
    equity: {
      actualCagrBps: aux.equity.actualCagrBps,
      bestInClassCagrBps: aux.equity.bestInClassCagrBps,
      minimumRequiredCagrBps: aux.equity.minimumRequiredCagrBps,
      dataSource: "accounting",
    },
  };
}

// ---------------------------------------------------------------------------
// Chapter III summary cards — derived from BS + IS
// ---------------------------------------------------------------------------

function buildSummaryCards(
  bs: BalanceSheetSnapshot,
  is: IncomeStatementSnapshot,
  aux: StewardshipAuxiliaryInputs,
): StewardshipLedgerBundle["summaryCards"] {
  const revenueActual = is.totalOperatingRevenue;
  const revenueBudget = aux.budget.totalOperatingRevenueYtd;
  const revenueVariance = revenueActual - revenueBudget;
  const noiActual = is.noiBeforeDepreciation;
  const noiBudget = revenueBudget - aux.budget.payrollBenefitsYtd;
  const noiVariance = noiActual - noiBudget;
  const noiMarginPct = revenueActual !== 0 ? noiActual / revenueActual : 0;
  // Suppress BS reference lint while the field stays unused by the
  // summary cards (it's already consumed elsewhere in the bundle).
  void bs;

  return {
    revenue: {
      value: formatMoneyShort(revenueActual),
      varianceAmount: formatVarianceMoney(revenueVariance),
      varianceLabel: "vs. budget",
      varianceTone: toneFromVariance(revenueVariance),
    },
    noiBeforeDep: {
      value: formatMoneyShort(noiActual),
      varianceAmount: formatVarianceMoney(noiVariance),
      varianceLabel: "vs. budget",
      varianceTone: toneFromVariance(noiVariance),
      marginPct: `${(noiMarginPct * 100).toFixed(1)}% margin`,
    },
    capitalFundIncome: {
      value: formatMoneyShort(is.totalCapitalIncome),
      subtext: "Initiation fees, capital dues & investment income",
    },
    reserveCoverage: {
      value: `${(aux.reserveCoverage.actualPct * 100).toFixed(0)}%`,
      balance: aux.reserveCoverage.balanceLabel,
      benchmark: `FAC benchmark ≥${(aux.reserveCoverage.facBenchmarkPct * 100).toFixed(0)}%`,
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function resolveBsAndIs(args: {
  ledger: ReportingLedger & ReportingLedgerWriter;
  clubId: string;
  period: ReportingPeriod;
}): Promise<{ bs: BalanceSheetSnapshot; is: IncomeStatementSnapshot } | null> {
  const asOf = endOfDayUtc(args.period.periodEnd);
  const tb = await args.ledger.getTrialBalance(args.clubId, asOf);
  if (!tb) return null;

  // Founder rule 2026-07-01 v14.12 — direct snapshot preference.
  // v14.13 — YTD window uses fiscal-year-start from the TB.
  const directBs = await args.ledger.getBalanceSheet(args.clubId, asOf);
  const directIs = await args.ledger.getIncomeStatement(
    args.clubId,
    tb.periodStart,
    asOf,
  );
  if (directBs && directIs) {
    return { bs: directBs, is: directIs };
  }

  const bsProj = new BalanceSheetProjection({
    ledger: args.ledger,
    writer: args.ledger,
  });
  const bsResult = await bsProj.getBalanceSheetSnapshot({
    clubId: args.clubId,
    asOf,
  });

  const isProj = new IncomeStatementProjection({
    ledger: args.ledger,
    writer: args.ledger,
  });
  const isResult = await isProj.getIncomeStatementSnapshot({
    clubId: args.clubId,
    periodStart: args.period.periodStart,
    periodEnd: asOf,
    fiscalYearLabel: tb.fiscalYearLabel,
    fiscalPeriodSequence: tb.fiscalPeriodSequence,
    mode: "ytd",
  });

  if (bsResult.status !== "succeeded" || isResult.status !== "succeeded") {
    return null;
  }
  return { bs: bsResult.snapshot, is: isResult.snapshot };
}

function endOfDayUtc(d: Date): Date {
  return new Date(
    Date.UTC(
      d.getUTCFullYear(),
      d.getUTCMonth(),
      d.getUTCDate(),
      23, 59, 59, 999,
    ),
  );
}

function formatMoneyShort(amount: number): string {
  const abs = Math.abs(amount);
  if (abs >= 1_000_000) return `${amount < 0 ? "-" : ""}$${(abs / 1_000_000).toFixed(3)}M`;
  if (abs >= 1_000) return `${amount < 0 ? "-" : ""}$${Math.round(abs / 1_000)}K`;
  return `${amount < 0 ? "-" : ""}$${Math.round(abs)}`;
}

function formatVarianceMoney(amount: number): string {
  const sign = amount >= 0 ? "+" : "-";
  return `${sign}${formatMoneyShort(Math.abs(amount))}`;
}

function toneFromVariance(amount: number): "positive" | "negative" | "neutral" {
  if (amount > 1) return "positive";
  if (amount < -1) return "negative";
  return "neutral";
}

// ---------------------------------------------------------------------------
// Silver Springs default auxiliary inputs
// ---------------------------------------------------------------------------

export const SILVER_SPRINGS_STEWARDSHIP_AUX: StewardshipAuxiliaryInputs = {
  budget: {
    duesRevenueYtd: 10_080_000,
    totalOperatingRevenueYtd: 15_000_000,
    initiationFeeSubsidyYtd: 1_040_000,
    payrollBenefitsYtd: 8_730_000,
    totalCapitalIncomeYtd: 6_030_000,
  },
  policies: {
    equityToAssetsGoal: 0.770,
    capitalReserveGoal: 0.140,
    netAvailableCapitalGoal: 0.347,
    netPPEGoal: 0.35,
    breakEvenLowerPct: -0.028,
    breakEvenUpperPct: 0.033,
  },
  operational: {
    golfRoundsActual: 6_483,
    golfRoundsBudget: 5_455,
    fbCoversActual: 24_207,
    fbCoversBudget: 29_310,
    fbSubsidy: null,
  },
  capitalSupporting: {
    capitalReserveBalance: 4_698_000,
    netAvailableCapital: 3_930_000,
    netCapital: 4_700_000,
    depreciation: 4_200_000,
    longTermDebt: null,
    netPPE: 8_060_000,
    grossPPE: 26_000_000,
  },
  equity: {
    actualCagrBps: 740,
    bestInClassCagrBps: 550,
    minimumRequiredCagrBps: 300,
  },
  reserveCoverage: {
    actualPct: 0.61,
    facBenchmarkPct: 0.60,
    balanceLabel: "$4.82M balance",
  },
  kpiThresholds: {
    duesRevenuePolicyLo: 0.38,
    duesRevenuePolicyHi: 0.44,
    duesRevenuePeerMedianLabel: "Peer median 39.4%",
    payrollPlan: 0.50,
    payrollPeerMedianLabel: "Peer median 50.6%",
    noiMarginPlan: 0.20,
    noiMarginPeerMedianLabel: "Peer median 18.5%",
    debtEquityCeiling: 0.25,
    debtEquityPeerMedianLabel: "Peer median 0.18",
    ppeReinvestmentCautionFloor: 0.45,
    ppeReinvestmentPeerMedianLabel: "Peer median 0.49",
    workingCapitalPolicyFloor: 3_500_000,
  },
  // Pre-built auxiliary KPI cards — the values that haven't moved to
  // ledger reads yet. These flow through verbatim until their
  // respective importers / projections land.
  auxiliaryKpiCards: {
    operating: {
      fbSubsidy: {
        key: "fb-subsidy",
        name: "F&B Subsidy",
        whatIsIt: "Share of dues revenue absorbed by F&B operating losses.",
        whyItMatters: "F&B almost always runs at a loss at a private club; the subsidy size signals whether it is contained or growing.",
        assessment: "Contained, below ceiling",
        actual: "5.1%",
        budget: "Target ≤ 8%",
        benchmark: "Peer median 6.8%",
        tone: "green",
      },
      rounds: {
        key: "rounds-vs-plan",
        name: "Rounds vs Plan",
        whatIsIt: "Year-to-date rounds played against the rounds budget.",
        whyItMatters: "Rounds drive cart, range, and pro-shop revenue; under-run is the earliest signal that activity is weakening.",
        assessment: "Ahead of plan",
        actual: "+6.0%",
        budget: "Plan +0.0%",
        tone: "green",
      },
      covers: {
        key: "covers-vs-plan",
        name: "Covers vs Plan",
        whatIsIt: "Year-to-date F&B covers against the covers budget.",
        whyItMatters: "Covers below plan with check averages holding means traffic is weak even when revenue looks fine.",
        assessment: "Slightly behind; check average holding revenue",
        actual: "-1.4%",
        budget: "Plan +0.0%",
        tone: "amber",
      },
      arCurrent: {
        key: "ar-current",
        name: "AR Current %",
        whatIsIt: "Share of member receivables aged 30 days or less.",
        whyItMatters: "Members carrying old balances eventually become bad debt; a falling current % is the earliest collections signal.",
        assessment: "Below target; collections review recommended",
        actual: "78.4%",
        budget: "Target ≥ 80%",
        benchmark: "Peer median 81.2%",
        tone: "amber",
      },
      initFeeSubsidy: {
        key: "init-fee-subsidy",
        name: "Initiation Fee Operating Subsidy",
        whatIsIt: "Share of operating expense covered by initiation fees rather than dues and activity revenue.",
        whyItMatters: "Operating on the back of initiation fees masks a structurally under-priced membership; the lower the better.",
        assessment: "Within healthy bound",
        actual: "6.4%",
        budget: "Target ≤ 8%",
        benchmark: "Peer median 7.1%",
        tone: "green",
      },
    },
    capital: {
      reserveCoverage: {
        key: "reserve-coverage",
        name: "Reserve Coverage",
        whatIsIt: "Capital reserve balance relative to three-year average capital spend.",
        whyItMatters: "Tells the committee whether the club can fund the next ~year of capital work from reserves without new debt or special assessment.",
        assessment: "Above policy floor",
        actual: "1.42x",
        budget: "Policy ≥ 1.25x",
        tone: "green",
      },
      capitalSpend: {
        key: "capital-spend-vs-plan",
        name: "Capital Spend vs Plan",
        whatIsIt: "Year-to-date capital project spending against the approved capital plan.",
        whyItMatters: "Under-spend may mean deferred maintenance accumulating; over-spend signals scope/cost discipline issues.",
        assessment: "Below plan; irrigation pump deferred to FY27",
        actual: "-16.5%",
        budget: "Plan +0.0%",
        tone: "amber",
      },
      reserveSufficiency: {
        key: "reserve-sufficiency",
        name: "Reserve Sufficiency",
        whatIsIt: "Capital reserve balance relative to annual depreciation expense.",
        whyItMatters: "Indicates whether reserves replenish at least as quickly as the asset base is depreciating.",
        assessment: "Well above 1.0x target",
        actual: "2.49x",
        budget: "Target ≥ 1.0x",
        tone: "green",
      },
      projectCompletion: {
        key: "project-completion",
        name: "Capital Project Completion",
        whatIsIt: "Approved capital projects on track, substantially complete, or complete at period close.",
        whyItMatters: "Execution discipline against board-approved plans is how the club proves it can deploy capital reliably.",
        assessment: "On plan; irrigation pump deferred to FY27",
        actual: "6 of 7",
        budget: "Plan 6 of 7 by month 11",
        tone: "green",
      },
    },
  },
};

// =============================================================================
// KPI card builders — derive each row from snapshot data + thresholds
// =============================================================================

function buildOperatingKpiCards(
  is: IncomeStatementSnapshot,
  aux: StewardshipAuxiliaryInputs,
): StewardshipKpi[] {
  return [
    buildDuesRevenueCard(is, aux),
    buildPayrollRatioCard(is, aux),
    buildNoiMarginCard(is, aux),
    aux.auxiliaryKpiCards.operating.fbSubsidy,
    aux.auxiliaryKpiCards.operating.rounds,
    aux.auxiliaryKpiCards.operating.covers,
    aux.auxiliaryKpiCards.operating.arCurrent,
    aux.auxiliaryKpiCards.operating.initFeeSubsidy,
  ];
}

function buildCapitalKpiCards(
  bs: BalanceSheetSnapshot,
  is: IncomeStatementSnapshot,
  aux: StewardshipAuxiliaryInputs,
): StewardshipKpi[] {
  return [
    aux.auxiliaryKpiCards.capital.reserveCoverage,
    buildCapitalIncomeVsPlanCard(is, aux),
    aux.auxiliaryKpiCards.capital.capitalSpend,
    buildDebtEquityCard(bs, aux),
    buildPpeReinvestmentCard(bs, aux),
    aux.auxiliaryKpiCards.capital.reserveSufficiency,
    buildWorkingCapitalCard(bs, aux),
    aux.auxiliaryKpiCards.capital.projectCompletion,
  ];
}

// ---------------------------------------------------------------------------
// Operating KPI builders
// ---------------------------------------------------------------------------

function buildDuesRevenueCard(
  is: IncomeStatementSnapshot,
  aux: StewardshipAuxiliaryInputs,
): StewardshipKpi {
  // Dues = revenue lines whose accountName mentions "membership" /
  // "dues" / "service assessment" — same heuristic the SoA dues
  // bucket uses.
  const duesActual = is.lines
    .filter(
      (l) =>
        l.category === "revenue" &&
        l.fund === "operating" &&
        /membership|dues|service assessment/i.test(l.accountName),
    )
    .reduce((s, l) => s + l.amount, 0);
  const ratio =
    is.totalOperatingRevenue > 0 ? duesActual / is.totalOperatingRevenue : 0;
  const { tone, assessment } = classifyBand({
    actual: ratio,
    lo: aux.kpiThresholds.duesRevenuePolicyLo,
    hi: aux.kpiThresholds.duesRevenuePolicyHi,
  });
  return {
    key: "dues-rev",
    name: "Dues-to-Revenue Ratio",
    whatIsIt: "Share of total operating revenue coming from membership dues.",
    whyItMatters: "Indicates how much of the operation runs on stable, recurring revenue rather than volatile activity income.",
    assessment,
    actual: formatPct(ratio),
    budget: `Policy ${formatPct(aux.kpiThresholds.duesRevenuePolicyLo)}–${formatPct(aux.kpiThresholds.duesRevenuePolicyHi)}`,
    benchmark: aux.kpiThresholds.duesRevenuePeerMedianLabel,
    tone,
  };
}

function buildPayrollRatioCard(
  is: IncomeStatementSnapshot,
  aux: StewardshipAuxiliaryInputs,
): StewardshipKpi {
  const payrollActual = is.lines
    .filter(
      (l) =>
        l.category === "expense" &&
        l.fund === "operating" &&
        /payroll|benefit|wages/i.test(l.accountName),
    )
    .reduce((s, l) => s + l.amount, 0);
  const ratio =
    is.totalOperatingRevenue > 0 ? payrollActual / is.totalOperatingRevenue : 0;
  const plan = aux.kpiThresholds.payrollPlan;
  // Lower = better for payroll ratio.
  const tone: KpiTone =
    ratio <= plan ? "green" : ratio <= plan * 1.05 ? "amber" : "red";
  const assessment =
    ratio <= plan
      ? "Better than plan"
      : ratio <= plan * 1.05
        ? "Near plan; watch"
        : "Above plan; corrective action";
  return {
    key: "payroll-ratio",
    name: "Payroll Ratio",
    whatIsIt: "Total payroll and benefits as a share of operating revenue.",
    whyItMatters: "Labour is the single largest operating line; sustained excess erodes margin and reserve replenishment.",
    assessment,
    actual: formatPct(ratio),
    budget: `Plan ${formatPct(plan)}`,
    benchmark: aux.kpiThresholds.payrollPeerMedianLabel,
    tone,
  };
}

function buildNoiMarginCard(
  is: IncomeStatementSnapshot,
  aux: StewardshipAuxiliaryInputs,
): StewardshipKpi {
  const margin =
    is.totalOperatingRevenue > 0
      ? is.noiBeforeDepreciation / is.totalOperatingRevenue
      : 0;
  const plan = aux.kpiThresholds.noiMarginPlan;
  // Higher = better for NOI margin.
  const tone: KpiTone =
    margin >= plan ? "green" : margin >= plan * 0.95 ? "amber" : "red";
  const assessment =
    margin >= plan
      ? "Above plan; healthy buffer"
      : margin >= plan * 0.95
        ? "Near plan; monitor"
        : "Below plan; corrective action";
  return {
    key: "noi-margin",
    name: "NOI Margin",
    whatIsIt: "Net operating income as a share of operating revenue.",
    whyItMatters: "Margin discipline is what funds capital and reserves; below-plan margin compounds across fiscal years.",
    assessment,
    actual: formatPct(margin),
    budget: `Plan ${formatPct(plan)}`,
    benchmark: aux.kpiThresholds.noiMarginPeerMedianLabel,
    tone,
  };
}

// ---------------------------------------------------------------------------
// Capital KPI builders
// ---------------------------------------------------------------------------

function buildCapitalIncomeVsPlanCard(
  is: IncomeStatementSnapshot,
  aux: StewardshipAuxiliaryInputs,
): StewardshipKpi {
  const actual = is.totalCapitalIncome;
  const budget = aux.budget.totalCapitalIncomeYtd;
  const pct = budget > 0 ? (actual - budget) / budget : 0;
  const tone: KpiTone = pct >= 0 ? "green" : pct >= -0.05 ? "amber" : "red";
  const assessment =
    pct >= 0
      ? "Ahead of plan"
      : pct >= -0.05
        ? "Near plan; monitor"
        : "Behind plan; capital funding at risk";
  return {
    key: "capital-income-vs-plan",
    name: "Capital Income vs Plan",
    whatIsIt: "Initiation, capital dues, and transfer fees actual versus budget.",
    whyItMatters: "Capital income is the long-term funding engine; persistent shortfall reduces what the club can reinvest in its asset base.",
    assessment,
    actual: formatSignedPct(pct),
    budget: "Plan +0.0%",
    benchmark: aux.kpiThresholds.capitalIncomeVsPlanPeerMedianLabel,
    tone,
  };
}

function buildDebtEquityCard(
  bs: BalanceSheetSnapshot,
  aux: StewardshipAuxiliaryInputs,
): StewardshipKpi {
  // Long-term debt from BS lines categorised as long-term-liability.
  const ltDebt = bs.lines
    .filter((l) => l.category === "long-term-liability")
    .reduce((s, l) => s + l.amount, 0);
  const ratio = bs.totalEquity > 0 ? ltDebt / bs.totalEquity : 0;
  const ceiling = aux.kpiThresholds.debtEquityCeiling;
  const tone: KpiTone =
    ratio <= ceiling
      ? "green"
      : ratio <= ceiling * 1.5
        ? "amber"
        : "red";
  const assessment =
    ratio <= ceiling * 0.5
      ? "Very low leverage"
      : ratio <= ceiling
        ? "Within policy ceiling"
        : "Above policy ceiling; capital structure review";
  return {
    key: "debt-equity",
    name: "Long-Term Debt-to-Equity",
    whatIsIt: "Long-term debt as a share of member equity.",
    whyItMatters: "Conservative leverage protects future members from inheriting today's debt-service obligations.",
    assessment,
    actual: formatRatio(ratio),
    budget: `Policy ≤ ${formatRatio(ceiling)}`,
    benchmark: aux.kpiThresholds.debtEquityPeerMedianLabel,
    tone,
  };
}

function buildPpeReinvestmentCard(
  bs: BalanceSheetSnapshot,
  aux: StewardshipAuxiliaryInputs,
): StewardshipKpi {
  // Net / gross PP&E from BS categories.
  const grossPpe = bs.lines
    .filter((l) => l.category === "ppe-gross")
    .reduce((s, l) => s + l.amount, 0);
  const accumDepr = bs.lines
    .filter((l) => l.category === "ppe-accumulated-depreciation")
    .reduce((s, l) => s + l.amount, 0);
  const netPpe = grossPpe - accumDepr;
  const ratio = grossPpe > 0 ? netPpe / grossPpe : 0;
  const floor = aux.kpiThresholds.ppeReinvestmentCautionFloor;
  // Higher = better (more recently refreshed asset base).
  const tone: KpiTone =
    ratio >= floor ? "green" : ratio >= floor * 0.85 ? "amber" : "red";
  const assessment =
    ratio >= floor
      ? "Healthy reinvestment pace"
      : ratio >= floor * 0.85
        ? "Approaching caution threshold"
        : "Below caution threshold; capital cycle imminent";
  return {
    key: "ppe-reinvestment",
    name: "PPE Reinvestment",
    whatIsIt: "Net property, plant, and equipment as a share of gross PPE — a proxy for how recently the asset base has been refreshed.",
    whyItMatters: "A falling ratio signals an aging facility; sustained below 0.45 typically precedes a major capital cycle.",
    assessment,
    actual: formatRatio(ratio),
    budget: `Caution if < ${formatRatio(floor)}`,
    benchmark: aux.kpiThresholds.ppeReinvestmentPeerMedianLabel,
    tone,
  };
}

function buildWorkingCapitalCard(
  bs: BalanceSheetSnapshot,
  aux: StewardshipAuxiliaryInputs,
): StewardshipKpi {
  let currentAssets = 0;
  let currentLiabilities = 0;
  for (const l of bs.lines) {
    if (l.category === "current-asset") currentAssets += l.amount;
    else if (l.category === "current-liability") currentLiabilities += l.amount;
  }
  const wc = currentAssets - currentLiabilities;
  const floor = aux.kpiThresholds.workingCapitalPolicyFloor;
  const tone: KpiTone = wc >= floor ? "green" : wc >= floor * 0.9 ? "amber" : "red";
  const cushion = wc - floor;
  const assessment =
    wc >= floor
      ? `${formatMoneyShort(cushion)} above policy floor`
      : wc >= floor * 0.9
        ? `${formatMoneyShort(Math.abs(cushion))} short of policy floor; monitor`
        : `${formatMoneyShort(Math.abs(cushion))} short of policy floor; corrective action`;
  return {
    key: "working-capital",
    name: "Working Capital",
    whatIsIt: "Current assets less current liabilities at period end.",
    whyItMatters: "Working capital is the cushion for normal operating swings; below the policy floor and the club starts relying on credit lines.",
    assessment,
    actual: formatMoneyShort(wc),
    budget: `Policy floor ${formatMoneyShort(floor)}`,
    tone,
  };
}

// ---------------------------------------------------------------------------
// Classification + formatting helpers
// ---------------------------------------------------------------------------

function classifyBand(args: {
  actual: number;
  lo: number;
  hi: number;
}): { tone: KpiTone; assessment: string } {
  if (args.actual >= args.lo && args.actual <= args.hi) {
    return { tone: "green", assessment: "Inside policy band" };
  }
  if (args.actual < args.lo) {
    const slack = (args.lo - args.actual) / args.lo;
    return {
      tone: slack <= 0.1 ? "amber" : "red",
      assessment: "Below policy band",
    };
  }
  const overage = (args.actual - args.hi) / args.hi;
  return {
    tone: overage <= 0.1 ? "amber" : "red",
    assessment: "Above policy band",
  };
}

function formatPct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

function formatSignedPct(fraction: number): string {
  const v = fraction * 100;
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function formatRatio(ratio: number): string {
  return ratio.toFixed(2);
}
