// Capital Fund — BS + IS snapshot adapter.
//
// Same dual-read pattern as SoFP / SoA / Executive Summary /
// Stewardship Dashboard:
//
//   1. If a TB exists in the ledger for (clubId, asOf), self-heal
//      project BS + IS (idempotent via payload hash) and build the
//      Capital Fund chapter from those snapshots + typed auxiliary
//      inputs.
//   2. Else, fall back to the existing Silver Springs demo seed.
//
// LEDGER-DERIVED (from BS + IS snapshots):
//   • Capital dues YTD               ← IS capital-revenue lines matching /capital dues/
//   • Initiation fees YTD            ← IS capital-revenue lines matching /initiation/
//   • Investment income YTD          ← IS capital-revenue lines matching /investment/
//   • Other capital income YTD       ← IS capital-revenue lines not matched above
//   • Total Capital Sources YTD      ← IS.totalCapitalIncome
//   • Debt service YTD               ← IS capital-expense lines matching /interest|debt/
//   • Reserve fund balance           ← BS capital-fund-asset lines (e.g. 1850)
//   • Net-to-Gross PP&E ratio        ← BS ppe-gross + ppe-accumulated-depreciation
//   • Reserve coverage ratio         ← reserveBalance ÷ aux.totalAssetReplacementCost
//   • Reserve adequacy tones         ← derived from snapshot ratios vs policy thresholds
//
// AUXILIARY (typed; awaiting their own ledger services):
//   • Annual budgets for every source/use row (Budget importer)
//   • Capital deployed actuals — replacements / improvements /
//     enhancements (Capital Projects importer)
//   • Total Asset Replacement Cost (Reserve Study)
//   • Deferred Capital Liability (Reserve Study)
//   • Annual + YTD reserve contribution targets (Reserve Study)
//   • FAC benchmark + 3-year goal labels (config / policy)
//   • Stress-test assumption (initiation-fee decline %) (config)

import type {
  BalanceSheetSnapshot,
  IncomeStatementLine,
  IncomeStatementSnapshot,
} from "@/lib/reporting/ledger/contracts";
import type { ReportingLedger } from "@/lib/reporting/ledger/read-api";
import type { ReportingLedgerWriter } from "@/lib/reporting/ledger/write-api";
import { BalanceSheetProjection } from "@/lib/reporting/ledger/projections/balance-sheet-projection";
import { IncomeStatementProjection } from "@/lib/reporting/ledger/projections/income-statement-projection";
import type { ReportingPeriod } from "@/lib/reporting/reporting-period";
import {
  buildCapitalStressTestCommentary,
  type CapitalFundAdequacyRow,
  type CapitalFundAdequacyTone,
  type CapitalFundReserveCoverage,
  type CapitalFundRow,
  type CapitalFundStatement,
  type CapitalFundStatementValues,
  type CapitalFundStressTest,
} from "@/lib/reporting/capital-fund-statement";

// ---------------------------------------------------------------------------
// Auxiliary inputs
// ---------------------------------------------------------------------------

export type CapitalFundAuxiliaryInputs = {
  /** Annual budgets — feed every row's `annualBudget` column. */
  annualBudgets: {
    capitalDues: number;
    initiationFees: number;
    investmentIncome: number;
    transferFromOps: number | null;
    replacements: number;
    improvements: number;
    enhancements: number;
    debtService: number;
  };
  /** Capital Projects actuals — feed the Capital Deployed YTD column
   *  for replacements / improvements / enhancements. Awaiting
   *  Capital Project importer. */
  deployedYtd: {
    replacements: number;
    improvements: number;
    enhancements: number;
  };
  /** Total asset replacement cost from the most recent Reserve
   *  Study. Awaiting Reserve Study importer. */
  totalAssetReplacementCost: number;
  /** Deferred capital liability from the Reserve Study. */
  deferredCapitalLiability: number;
  /** Annual + YTD reserve-contribution targets. */
  contribution: {
    annual: number;
    ytdTarget: number;
    /** YTD contribution actually made. Awaiting cash-flow / GL
     *  classification of reserve transfers. */
    ytdActual: number;
  };
  /** Policy labels — pure config. */
  labels: {
    facBenchmark: string;        // e.g. "FAC Benchmark: 60%+"
    threeYearGoal: string;       // e.g. "3-Year Goal: 75%"
  };
  /** Stress-test assumption — config-driven board policy. */
  stressTest: {
    initiationFeeDeclinePct: number; // e.g. 0.50
  };
  /** Inline commentary copy (e.g. "7 memberships Q1. 28 forecast
   *  annually.") — config / governance copy, not accounting. */
  inlineCommentary: {
    initiationFees: string;
  };
};

// ---------------------------------------------------------------------------
// Bundle returned by the adapter (just the section itself for symmetry
// with other adapters' bundles)
// ---------------------------------------------------------------------------

export type CapitalFundLedgerBundle = {
  capitalFundStatement: CapitalFundStatement;
  dataSource: "live" | "demo";
};

// ---------------------------------------------------------------------------
// Dual-read entry point
// ---------------------------------------------------------------------------

export async function getCapitalFundForClub(args: {
  clubId: string;
  clubName: string;
  period: ReportingPeriod;
  ledger: ReportingLedger & ReportingLedgerWriter;
  auxiliaryInputs: CapitalFundAuxiliaryInputs;
  demoFallback: () => CapitalFundStatement;
}): Promise<CapitalFundLedgerBundle> {
  const snapshots = await resolveBsAndIs({
    ledger: args.ledger,
    clubId: args.clubId,
    period: args.period,
  });

  if (!snapshots) {
    return {
      capitalFundStatement: args.demoFallback(),
      dataSource: "demo",
    };
  }

  return {
    capitalFundStatement: buildCapitalFundFromSnapshots({
      clubName: args.clubName,
      period: args.period,
      bs: snapshots.bs,
      is: snapshots.is,
      auxiliaryInputs: args.auxiliaryInputs,
    }),
    dataSource: "live",
  };
}

// ---------------------------------------------------------------------------
// Pure builder — snapshots + auxiliary inputs → CapitalFundStatement
// ---------------------------------------------------------------------------

export function buildCapitalFundFromSnapshots(args: {
  clubName: string;
  period: ReportingPeriod;
  bs: BalanceSheetSnapshot;
  is: IncomeStatementSnapshot;
  auxiliaryInputs: CapitalFundAuxiliaryInputs;
}): CapitalFundStatement {
  const { bs, is, auxiliaryInputs: aux } = args;

  // ---- Sources of Capital — derive YTD from IS capital-revenue lines ----
  const capitalRevLines = is.lines.filter(
    (l) => l.category === "revenue" && l.fund === "capital",
  );
  const capitalDuesYtd = sumByPattern(capitalRevLines, /capital dues/i);
  const initiationFeesYtd = sumByPattern(capitalRevLines, /initiation/i);
  const investmentIncomeYtd = sumByPattern(capitalRevLines, /investment/i);
  const otherCapitalYtd = capitalRevLines
    .filter(
      (l) =>
        !/capital dues/i.test(l.accountName) &&
        !/initiation/i.test(l.accountName) &&
        !/investment/i.test(l.accountName),
    )
    .reduce((s, l) => s + l.amount, 0);
  const transferFromOpsYtd = otherCapitalYtd > 0 ? otherCapitalYtd : null;
  const totalCapitalSourcesYtd =
    capitalDuesYtd +
    initiationFeesYtd +
    investmentIncomeYtd +
    (transferFromOpsYtd ?? 0);

  // ---- Capital Deployed — debt service from IS; rest from aux ----
  const capitalExpLines = is.lines.filter(
    (l) => l.category === "expense" && l.fund === "capital",
  );
  const debtServiceYtd = sumByPattern(capitalExpLines, /interest|debt/i);
  const totalCapitalDeployedYtd =
    aux.deployedYtd.replacements +
    aux.deployedYtd.improvements +
    aux.deployedYtd.enhancements +
    debtServiceYtd;

  // ---- Annual totals (auxiliary budgets) ----
  const totalCapitalSourcesAnnual =
    aux.annualBudgets.capitalDues +
    aux.annualBudgets.initiationFees +
    aux.annualBudgets.investmentIncome +
    (aux.annualBudgets.transferFromOps ?? 0);
  const totalCapitalDeployedAnnual =
    aux.annualBudgets.replacements +
    aux.annualBudgets.improvements +
    aux.annualBudgets.enhancements +
    aux.annualBudgets.debtService;

  const netPositionAnnual = totalCapitalSourcesAnnual - totalCapitalDeployedAnnual;
  const netPositionYtd = totalCapitalSourcesYtd - totalCapitalDeployedYtd;
  const netCapitalIncomeAnnual = totalCapitalSourcesAnnual - aux.annualBudgets.debtService;
  const netCapitalIncomeYtd = totalCapitalSourcesYtd - debtServiceYtd;

  const rows: CapitalFundRow[] = [
    { key: "band-sources", kind: "section-band", label: "Sources of Capital" },
    {
      key: "capital-dues",
      kind: "detail",
      label: "Capital Dues — Monthly Assessment",
      values: rowValues(aux.annualBudgets.capitalDues, capitalDuesYtd),
    },
    {
      key: "initiation-fees",
      kind: "detail",
      label: "Initiation Fees — New Memberships",
      values: rowValues(aux.annualBudgets.initiationFees, initiationFeesYtd),
    },
    {
      key: "initiation-fees-comment",
      kind: "commentary",
      text: aux.inlineCommentary.initiationFees,
    },
    {
      key: "investment-income",
      kind: "detail",
      label: "Investment Income on Reserve Fund",
      values: rowValues(aux.annualBudgets.investmentIncome, investmentIncomeYtd),
    },
    {
      key: "transfer-from-ops",
      kind: "detail",
      label: "Transfer from Operations (Surplus)",
      values: rowValues(aux.annualBudgets.transferFromOps ?? null, transferFromOpsYtd),
    },
    {
      key: "total-sources",
      kind: "subtotal",
      label: "Total Capital Sources",
      values: rowValues(totalCapitalSourcesAnnual, totalCapitalSourcesYtd),
    },

    { key: "band-deployed", kind: "section-band", label: "Capital Deployed — Approved Projects" },
    {
      key: "replacements",
      kind: "detail",
      label: "Replacements — Facilities & Equipment",
      values: rowValues(aux.annualBudgets.replacements, aux.deployedYtd.replacements),
    },
    {
      key: "improvements",
      kind: "detail",
      label: "Improvements — Facility Upgrades",
      values: rowValues(aux.annualBudgets.improvements, aux.deployedYtd.improvements),
    },
    {
      key: "enhancements",
      kind: "detail",
      label: "Enhancements — Committee Projects",
      values: rowValues(aux.annualBudgets.enhancements, aux.deployedYtd.enhancements),
    },
    {
      key: "debt-service",
      kind: "detail",
      label: "Debt Service — Long-Term Note",
      values: rowValues(aux.annualBudgets.debtService, debtServiceYtd),
    },
    {
      key: "total-deployed",
      kind: "subtotal",
      label: "Total Capital Deployed",
      values: rowValues(totalCapitalDeployedAnnual, totalCapitalDeployedYtd),
    },

    {
      key: "net-position",
      kind: "summary-band",
      label: "Net Capital Position Change (YTD)",
      values: rowValues(netPositionAnnual, netPositionYtd),
    },

    { key: "band-analysis", kind: "analysis-band", label: "Net Capital Income Analysis" },
    {
      key: "analysis-total-sources",
      kind: "detail",
      label: "Total Capital Sources",
      values: {
        annualBudget: totalCapitalSourcesAnnual,
        ytdActual: totalCapitalSourcesYtd,
        remaining: null,
      },
    },
    {
      key: "analysis-less-debt",
      kind: "detail",
      label: "Less: Debt Service",
      values: {
        annualBudget: -aux.annualBudgets.debtService,
        ytdActual: -debtServiceYtd,
        remaining: null,
      },
    },
    {
      key: "analysis-net-income",
      kind: "net-line",
      label: "Net Capital Income",
      values: {
        annualBudget: netCapitalIncomeAnnual,
        ytdActual: netCapitalIncomeYtd,
        remaining: null,
      },
    },
  ];

  // ---- Reserve fund balance — derived from BS capital-fund-asset
  // lines whose `fund` tag is "reserve" (the actual reserve fund
  // account, not capital-projects-in-progress). Falls back to ALL
  // capital-fund-asset lines when no line carries fund="reserve".
  const reserveLines = bs.lines.filter(
    (l) => l.category === "capital-fund-asset" && l.fund === "reserve",
  );
  const reserveFundBalance =
    reserveLines.length > 0
      ? reserveLines.reduce((s, l) => s + l.amount, 0)
      : bs.lines
          .filter((l) => l.category === "capital-fund-asset")
          .reduce((s, l) => s + l.amount, 0);

  const reserveCoveragePct =
    aux.totalAssetReplacementCost > 0
      ? reserveFundBalance / aux.totalAssetReplacementCost
      : 0;

  const reserveCoverage: CapitalFundReserveCoverage = {
    currentPct: reserveCoveragePct,
    currentPctLabel: `${(reserveCoveragePct * 100).toFixed(0)}%`,
    facBenchmarkLabel: aux.labels.facBenchmark,
    threeYearGoalLabel: aux.labels.threeYearGoal,
    reserveBalanceLabel: `Reserve Balance: $${(reserveFundBalance / 1_000_000).toFixed(2)}M`,
    markers: [
      { pct: 0.00, label: "0%" },
      { pct: 0.30, label: "30%" },
      { pct: 0.60, label: "60% ← target" },
      { pct: 0.75, label: "75% 3yr" },
      { pct: 1.00, label: "100%" },
    ],
  };

  // ---- Reserve adequacy detail rows — mix of BS-derived + aux ----
  // Net-to-Gross PP&E ratio from BS lines (when present).
  const grossPpe = bs.lines
    .filter((l) => l.category === "ppe-gross")
    .reduce((s, l) => s + l.amount, 0);
  const accumDepr = bs.lines
    .filter((l) => l.category === "ppe-accumulated-depreciation")
    .reduce((s, l) => s + l.amount, 0);
  const netToGrossPpe = grossPpe > 0 ? (grossPpe - accumDepr) / grossPpe : 0;

  // YTD contribution on-pace check (live-responsive).
  const ytdContributionOnPace =
    aux.contribution.ytdTarget > 0 &&
    aux.contribution.ytdActual >= aux.contribution.ytdTarget * 0.95;

  const reserveAdequacy: CapitalFundAdequacyRow[] = [
    {
      key: "reserve-balance",
      label: "Reserve Fund Balance",
      valueLabel: `$${Math.round(reserveFundBalance).toLocaleString("en-US")}`,
      tone: "neutral",
    },
    {
      key: "asset-replacement-cost",
      label: "Total Asset Replacement Cost",
      valueLabel: `$${aux.totalAssetReplacementCost.toLocaleString("en-US")}`,
      tone: "neutral",
    },
    {
      key: "coverage-ratio",
      label: "Reserve Coverage Ratio",
      valueLabel: `${(reserveCoveragePct * 100).toFixed(1)}%`,
      tone: classifyCoverageTone(reserveCoveragePct),
    },
    {
      key: "deferred-capital",
      label: "Deferred Capital Liability",
      valueLabel: `$${aux.deferredCapitalLiability.toLocaleString("en-US")}`,
      tone: aux.deferredCapitalLiability > 0 ? "risk" : "neutral",
    },
    {
      key: "net-to-gross-ppe",
      label: "Net-to-Gross PP&E Ratio",
      valueLabel: `${(netToGrossPpe * 100).toFixed(0)}%`,
      tone: classifyNetToGrossPpeTone(netToGrossPpe),
    },
    {
      key: "annual-contribution",
      label: "Annual Reserve Contribution",
      valueLabel: `$${aux.contribution.annual.toLocaleString("en-US")}`,
      tone: "neutral",
    },
    {
      key: "ytd-contribution",
      label: ytdContributionOnPace
        ? "YTD Contribution — On Plan"
        : "YTD Contribution — Behind Plan",
      valueLabel: `$${Math.round(aux.contribution.ytdActual).toLocaleString("en-US")}`,
      tone: ytdContributionOnPace ? "favorable" : "risk",
      checkmark: ytdContributionOnPace,
    },
  ];

  // ---- Stress-test commentary — fed by LIVE numerics where possible ----
  // For "annual" figures used by the stress test we use IS-derived
  // YTD scaled up by the period's monthsInYear (if a full year of
  // data) OR fall back to auxiliary annual budgets when the YTD is
  // zero (test datasets that don't include capital accounts).
  const stressInitiationFeesAnnual =
    initiationFeesYtd > 0 ? annualizeFromYtd(initiationFeesYtd, args.period) : aux.annualBudgets.initiationFees;
  const stressCapitalDuesAnnual =
    capitalDuesYtd > 0 ? annualizeFromYtd(capitalDuesYtd, args.period) : aux.annualBudgets.capitalDues;
  const stressDebtServiceAnnual =
    debtServiceYtd > 0 ? annualizeFromYtd(debtServiceYtd, args.period) : aux.annualBudgets.debtService;

  const stressTest: CapitalFundStressTest = buildCapitalStressTestCommentary({
    initiationFeesAnnual: stressInitiationFeesAnnual,
    capitalDuesAnnual: stressCapitalDuesAnnual,
    initiationFeeDeclinePct: aux.stressTest.initiationFeeDeclinePct,
    requiredAnnualReserveContribution: aux.contribution.annual,
    annualDebtService: stressDebtServiceAnnual,
  });

  return {
    dataSource: is.dataSource === "demo" && bs.dataSource === "demo" ? "demo" : "live",
    eyebrow: `${args.clubName} · Capital Fund`,
    title: "Capital Fund Statement",
    periodLabel: args.period.statementHeaderLabel,
    introNote:
      "Where capital comes from, where it goes, and whether the reserve fund is on trajectory.",
    statementNumber: "Statement 05 of 14",
    documentChip: "Capital Fund",
    preparedFor: "Finance Committee",
    columnHeaders: {
      category: "Capital Fund Sources & Uses",
      annualBudget: `${args.period.year} Budget`,
      ytdActual: "YTD Actual",
      remaining: "Remaining",
    },
    rows,
    reserveCoverage,
    reserveAdequacy,
    stressTest,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rowValues(
  annualBudget: number | null,
  ytdActual: number | null,
): CapitalFundStatementValues {
  const remaining =
    annualBudget === null || ytdActual === null ? null : annualBudget - ytdActual;
  return { annualBudget, ytdActual, remaining };
}

function sumByPattern(
  lines: ReadonlyArray<IncomeStatementLine>,
  pattern: RegExp,
): number {
  return lines
    .filter((l) => pattern.test(l.accountName))
    .reduce((s, l) => s + l.amount, 0);
}

function classifyCoverageTone(pct: number): CapitalFundAdequacyTone {
  if (pct >= 0.60) return "favorable";
  if (pct >= 0.50) return "neutral";
  return "risk";
}

function classifyNetToGrossPpeTone(ratio: number): CapitalFundAdequacyTone {
  if (ratio >= 0.50) return "favorable";
  if (ratio >= 0.45) return "neutral";
  return "risk";
}

/**
 * Project a YTD amount to an implied annual figure for stress-test
 * purposes. Uses the period's fiscalPeriodSequence on the snapshot
 * — fallback assumes May (period 5 of 12) so a Q1-style demo
 * doesn't return zeros.
 */
function annualizeFromYtd(ytdAmount: number, period: ReportingPeriod): number {
  const periodsElapsed = Math.max(1, period.month);
  return (ytdAmount / periodsElapsed) * 12;
}

async function resolveBsAndIs(args: {
  ledger: ReportingLedger & ReportingLedgerWriter;
  clubId: string;
  period: ReportingPeriod;
}): Promise<{ bs: BalanceSheetSnapshot; is: IncomeStatementSnapshot } | null> {
  const asOf = endOfDayUtc(args.period.periodEnd);
  const tb = await args.ledger.getTrialBalance(args.clubId, asOf);
  if (!tb) return null;

  // Founder rule 2026-07-01 v14.12 — direct snapshot preference,
  // mirrors executive-summary.ts. The ledger's live-synthesis
  // (v14.11) returns authoritative BS + IS snapshots for clubs
  // with a committed real Opening Trial Balance; the range-based
  // projection would misclassify non-standard accounts here.
  // v14.13 — use fiscal-year start from the TB snapshot for YTD.
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

// ---------------------------------------------------------------------------
// Silver Springs auxiliary defaults (preserve existing demo values)
// ---------------------------------------------------------------------------

export const SILVER_SPRINGS_CAPITAL_FUND_AUX: CapitalFundAuxiliaryInputs = {
  annualBudgets: {
    capitalDues: 1_920_000,
    initiationFees: 2_160_000,
    investmentIncome: 175_000,
    transferFromOps: 0,
    replacements: 1_840_000,
    improvements: 480_000,
    enhancements: 320_000,
    debtService: 216_000,
  },
  deployedYtd: {
    replacements: 412_000,
    improvements: 128_000,
    enhancements: 80_000,
  },
  totalAssetReplacementCost: 7_900_000,
  deferredCapitalLiability: 3_080_000,
  contribution: {
    annual: 480_000,
    ytdTarget: 120_000,
    ytdActual: 120_000,
  },
  labels: {
    facBenchmark: "FAC Benchmark: 60%+",
    threeYearGoal: "3-Year Goal: 75%",
  },
  stressTest: {
    initiationFeeDeclinePct: 0.50,
  },
  inlineCommentary: {
    initiationFees: "7 memberships Q1. 28 forecast annually.",
  },
};
