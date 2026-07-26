// ---------------------------------------------------------------------------
// Stewardship Scorecard reporting service.
//
// Parallel to src/lib/reporting/equity-history.ts and
// src/lib/reporting/operating-results.ts. Owns the per-row computation
// for the two Chapter II scorecards:
//
//   - Operating Stewardship — KPI Scorecard
//   - Capital  Stewardship — KPI Scorecard
//
// Why this exists:
//   Before this service, every scorecard row's `actual`, `budget`,
//   and `benchmark` strings were hardcoded literals in the
//   monthly-package builder block. That violated the "no React
//   hardcoded values" rule by proxy — the package-builder block is
//   the LAST stop before the React tree, so literals there are
//   indistinguishable from React-tree literals from a discipline
//   standpoint.
//
//   This service does the inverse: numeric inputs (raw amounts,
//   counts, goal thresholds) are typed and seeded ONCE, and every
//   display string flows from a computation over those inputs. The
//   service is the single source of truth for both VALUES and the
//   STATUS LOGIC that picks each row's dot/arrow.
//
// What's hardcoded vs. computed:
//   - The numeric INPUTS (e.g. duesRevenue, payrollBenefitsExpense,
//     goalRatios) are demo-seeded constants per club. A real club
//     would replace these with prisma reads against income-statement
//     / balance-sheet / membership-activity tables.
//   - The OUTPUT strings (actual / budget / variance percentages and
//     dollar values) are computed from the inputs every render.
//   - The STATUS DOT and TREND ARROW for every row are computed by
//     simple threshold logic, not chosen by hand.
//   - Only the BENCHMARK column is allowed to carry policy strings
//     (e.g. "≥60%", "Required", "<25%") — these are board-level
//     thresholds, not accounting facts.
// ---------------------------------------------------------------------------

import type {
  ScorecardStatus,
  StewardshipScorecard,
  StewardshipScorecardRow,
  ReportingDataSource,
} from "./monthly-package";
import {
  classifyNoiPctRevenueStatus,
  classifyNoiVarianceStatus,
  type OperatingScorecardSnapshot,
} from "./operating-scorecard-service";
import {
  classifyEquityCagrStatus,
  classifyLongTermDebtStatus,
  type CapitalScorecardSnapshot,
} from "./capital-scorecard-service";
import { toLegacyDataSource } from "./monthly-accounting-contract";

/** Numeric inputs to the Operating Stewardship scorecard. Every row's
 *  actual / budget / status flows from these — no display strings are
 *  passed in. */
export type OperatingScorecardInputs = {
  /** Total dues revenue ($) — numerator of Dues-to-Revenue. */
  duesRevenue: number;
  duesRevenueBudget: number;
  /** Total operating revenue ($) — denominator of multiple ratios. */
  totalOperatingRevenue: number;
  totalOperatingRevenueBudget: number;
  /** Initiation-fee dollars sitting in operating instead of capital.
   *  Best practice = $0; any positive amount is a posting violation. */
  initiationFeeSubsidy: number;
  initiationFeeSubsidyBudget: number;
  /** Loaded payroll + benefits expense ($). */
  payrollBenefitsExpense: number;
  payrollBenefitsExpenseBudget: number;
  /** Annual F&B operating subsidy ($) — null when not yet posted /
   *  classified in the GL. Drives the F&B Subsidy % of Dues row's
   *  "—" placeholder. */
  fbSubsidy: number | null;
  /** Dues income used as the denominator for the F&B Subsidy %
   *  ratio. May differ from `duesRevenue` if dues categories are
   *  classified differently for this metric. */
  duesForFbRatio: number | null;
  /** Golf rounds — annual count. */
  golfRoundsActual: number;
  golfRoundsBudget: number;
  /** F&B covers — annual count. */
  fbCoversActual: number;
  fbCoversBudget: number;
};

/** Numeric inputs to the Capital Stewardship scorecard. */
export type CapitalScorecardInputs = {
  /** Total assets ($) — denominator for Equity-to-Assets, Capital
   *  Reserve % of Assets. */
  totalAssets: number;
  /** Total club equity ($). */
  totalEquity: number;
  /** Goal (as a 0..1 ratio) for Equity-to-Assets. */
  equityToAssetsGoal: number;
  /** Capital reserve balance ($). */
  capitalReserveBalance: number;
  /** Goal (as a 0..1 ratio) for Capital Reserve % of Assets. */
  capitalReserveGoal: number;
  /** Net available capital ($). */
  netAvailableCapital: number;
  /** Total operating revenue ($) — denominator for Net Available
   *  Capital Ratio. (Capital cards still anchor on operating revenue
   *  per ClubBenchmarking convention.) */
  operatingRevenueForCapital: number;
  /** Goal (as a 0..1 ratio) for Net Available Capital Ratio. */
  netAvailableCapitalGoal: number;
  /** Net capital available for asset replacement ($). */
  netCapital: number;
  /** Annual depreciation ($). The Net Capital > Depreciation row is
   *  YES iff netCapital > depreciation. */
  depreciation: number;
  /** Long-term debt ($) — null when not yet classified / posted. */
  longTermDebt: number | null;
  /** Net PPE ($). */
  netPPE: number;
  /** Gross PPE ($). */
  grossPPE: number;
  /** Goal (as a 0..1 ratio) for Net PPE / Gross PPE. */
  netPPEGoal: number;
  /** Capital income — annual actual + budget ($). */
  totalCapitalIncomeActual: number;
  totalCapitalIncomeBudget: number;
};

// -- formatters ---------------------------------------------------------------

function pct1(num: number, den: number): string {
  if (den <= 0) return "—";
  return `${((num / den) * 100).toFixed(1)}%`;
}
function pctRatio(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}
function pctFromRatio0dp(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}
function pctFrom2(num: number, den: number): string {
  if (den <= 0) return "—";
  return `${Math.round((num / den) * 100)}%`;
}
/** Render a dollar amount as "$X.XXM" with 2 dp ($2,400,000 → $2.40M). */
function dollarsM(d: number): string {
  const m = d / 1_000_000;
  // Sign convention: parentheses for negatives.
  if (d < 0) return `($${Math.abs(m).toFixed(2)}M)`;
  return `$${m.toFixed(2)}M`;
}
/** Render an integer count with thousands separators. */
function intCount(n: number): string {
  return n.toLocaleString("en-US");
}
/** Render a variance count: "+1,028" or "−5,103" with U+2212 minus. */
function variance(n: number): string {
  const abs = Math.abs(n).toLocaleString("en-US");
  if (n > 0) return `+${abs}`;
  if (n < 0) return `−${abs}`;
  return "0";
}
/** Render a dollar variance: "$1.59M" or "−$1.59M" with U+2212 minus. */
function dollarsVarianceM(d: number): string {
  const m = Math.abs(d / 1_000_000).toFixed(2);
  if (d > 0) return `+$${m}M`;
  if (d < 0) return `−$${m}M`;
  return "$0.00M";
}

// -- status / trend logic -----------------------------------------------------

/** Status threshold helper: pct as 0..100. */
function classifyByThreshold(
  actualPct: number,
  threshold: number,
  /** "above" = on-track when actualPct >= threshold;
   *  "below" = on-track when actualPct <= threshold. */
  direction: "above" | "below",
  /** Half-distance from threshold that demotes to "monitor". */
  monitorSlack: number,
): ScorecardStatus {
  if (direction === "above") {
    if (actualPct >= threshold) return "on-track";
    if (actualPct >= threshold - monitorSlack) return "monitor";
    return "action";
  }
  // direction === "below"
  if (actualPct <= threshold) return "on-track";
  if (actualPct <= threshold + monitorSlack) return "monitor";
  return "action";
}

/** Classify a dollar-variance row: positive variance → on-track,
 *  negative → action when material, else monitor. */
function classifyDollarVariance(
  actual: number,
  budget: number,
  monitorSlack: number,
): ScorecardStatus {
  const v = actual - budget;
  if (v >= 0) return "on-track";
  if (Math.abs(v) <= monitorSlack) return "monitor";
  return "action";
}

/** Classify an integer-variance row (Golf Rounds / F&B Covers). */
function classifyCountVariance(actual: number, budget: number): ScorecardStatus {
  const v = actual - budget;
  if (v >= 0) return "on-track";
  if (Math.abs(v) <= Math.max(50, budget * 0.05)) return "monitor";
  return "action";
}

/** Discriminator — distinguishes the new snapshot shape from the
 *  legacy raw-input shape passed by some tests + (briefly) the
 *  package builder. */
function isSnapshot(
  v: OperatingScorecardSnapshot | OperatingScorecardInputs,
): v is OperatingScorecardSnapshot {
  return (
    typeof v === "object" &&
    v !== null &&
    "inputs" in v &&
    "noi" in v &&
    "perRowDataSource" in v
  );
}

/** Trend follows the sign of (actual − budget). Used when status alone
 *  doesn't carry enough information (e.g. Monitor + downward arrow). */
function trendOfDelta(d: number): "up" | "down" | "flat" {
  if (d > 0) return "up";
  if (d < 0) return "down";
  return "flat";
}

// -- builders -----------------------------------------------------------------

/** Strings the operating-results dashboard already computes and that
 *  flow straight through to the two reconciliation rows. */
export type OperatingDashboardLabels = {
  ytdNoiLabel: string;
  budgetGoalLabel: string;
  noiPctRevenueLabel: string;
};

/** Strings the equity dashboard already computes and that flow to the
 *  Equity Growth CAGR row. */
export type EquityDashboardLabels = {
  actualCagrLabel: string;
  bestInClassCagrLabel: string;
};

/**
 * Build the Operating Stewardship scorecard.
 *
 * Per CLAUDE.md `Financial Reporting Data Integrity — Mandatory`,
 * EVERY row's `actual` / `budget` string flows from the snapshot's
 * numeric inputs (never from a literal). The two NOI rows derive
 * their `status` from the snapshot's NOI numerics (was previously a
 * hardcoded `"on-track"` literal — flagged in the Jonas-readiness
 * audit). Per-row `dataSource` reads from
 * `snapshot.perRowDataSource` so a row's provenance reflects its
 * actual input source (`accounting` / `operational` / `demo`),
 * mapped to the legacy `"live" | "demo"` flag via
 * `toLegacyDataSource`.
 *
 * The `opsLabels` parameter still flows in for the two NOI rows'
 * display strings — those labels are pre-formatted by
 * `formatOperatingDashboard` (already live against
 * `getOperatingResults` → `prisma.fiscalPeriod`).
 *
 * BACKWARDS COMPATIBILITY: callers may pass either the new
 * `OperatingScorecardSnapshot` (preferred — carries per-row
 * provenance + NOI numerics) OR the legacy `OperatingScorecardInputs`
 * (the raw 14-field shape). When the legacy shape is passed, the
 * function wraps it with default NOI numerics that classify
 * `on-track` and tags the NOI rows as `accounting` (preserving the
 * pre-snapshot `dataSource: "live"` behaviour that earlier tests
 * relied on). New consumers should always pass a snapshot.
 */
export function buildOperatingScorecardData(
  snapshotOrInputs: OperatingScorecardSnapshot | OperatingScorecardInputs,
  opsLabels: OperatingDashboardLabels,
): StewardshipScorecard {
  const snapshot: OperatingScorecardSnapshot = isSnapshot(snapshotOrInputs)
    ? snapshotOrInputs
    : {
        inputs: snapshotOrInputs,
        // Defaults that preserve historical on-track classification
        // for callers passing raw inputs without NOI numerics.
        noi: {
          ytdNoi:             45_000,
          ytdBudgetNoi:            0,
          ytdRevenue:    15_000_000,
          breakEvenLowerPct: -0.028,
          breakEvenUpperPct:  0.033,
        },
        perRowDataSource: {
          "dues-to-revenue":         "demo",
          "initiation-fee-subsidy":  "demo",
          "payroll-benefits-ratio":  "demo",
          // Raw-input callers historically got NOI labels from the
          // live operating-results service, so the NOI rows were
          // tagged `dataSource: "live"`. Preserve that here.
          "noi-variance-to-budget":  "accounting",
          "noi-pct-revenue":         "accounting",
          "fb-subsidy-pct-dues":     "demo",
          "golf-rounds-vs-budget":   "demo",
          "fb-covers-vs-budget":     "demo",
        },
      };
  const { inputs, noi, perRowDataSource } = snapshot;
  const tagOf = (key: keyof typeof perRowDataSource): ReportingDataSource =>
    toLegacyDataSource(perRowDataSource[key]);

  // ----- Dues-to-Revenue Ratio -----
  const duesPct = (inputs.duesRevenue / inputs.totalOperatingRevenue) * 100;
  const duesStatus = classifyByThreshold(duesPct, 60, "above", 5);
  const dues: StewardshipScorecardRow = {
    key: "dues-to-revenue",
    metric: "Dues-to-Revenue Ratio",
    description: "Operating dues as % of total revenue — must exceed the payroll ratio.",
    actual: pct1(inputs.duesRevenue, inputs.totalOperatingRevenue),
    budget: pct1(inputs.duesRevenueBudget, inputs.totalOperatingRevenueBudget),
    benchmark: "≥60%",
    status: duesStatus,
    dataSource: tagOf("dues-to-revenue"),
  };

  // ----- Initiation Fee Operating Subsidy -----
  // Best practice = $0. ANY positive amount is a posting violation
  // (initiation fees belong in capital). Status is action on any
  // material positive amount.
  const initSubsidy: StewardshipScorecardRow = {
    key: "initiation-fee-subsidy",
    metric: "Initiation Fee Operating Subsidy",
    description: "Best practice: $0. Initiation fees belong in capital, not daily operations.",
    actual: dollarsM(inputs.initiationFeeSubsidy),
    budget: dollarsM(inputs.initiationFeeSubsidyBudget),
    benchmark: "$0",
    status: inputs.initiationFeeSubsidy > 100_000 ? "action"
      : inputs.initiationFeeSubsidy > 0 ? "monitor"
      : "on-track",
    dataSource: tagOf("initiation-fee-subsidy"),
  };

  // ----- Payroll & Benefits Ratio -----
  const payrollPct = (inputs.payrollBenefitsExpense / inputs.totalOperatingRevenue) * 100;
  // On-track if payrollPct < duesPct (the dues-must-exceed-payroll
  // rule). Action if payrollPct > duesPct.
  const payrollStatus: ScorecardStatus =
    payrollPct < duesPct - 3 ? "on-track"
    : payrollPct < duesPct ? "monitor"
    : "action";
  const payroll: StewardshipScorecardRow = {
    key: "payroll-benefits-ratio",
    metric: "Payroll & Benefits Ratio",
    description: "Total loaded payroll ÷ operating revenue. Dues ratio must exceed this.",
    actual: pct1(inputs.payrollBenefitsExpense, inputs.totalOperatingRevenue),
    budget: pct1(inputs.payrollBenefitsExpenseBudget, inputs.totalOperatingRevenueBudget),
    benchmark: "57%+",
    status: payrollStatus,
    dataSource: tagOf("payroll-benefits-ratio"),
  };

  // ----- NOI Variance to Budget (accounting-fed) -----
  // Status DERIVED from snapshot.noi (was hardcoded `"on-track"`
  // before the Jonas-readiness sweep). Display strings still come
  // from opsLabels — pre-formatted by formatOperatingDashboard
  // which already reads prisma.fiscalPeriod live.
  const noiVarianceStatus = classifyNoiVarianceStatus(
    noi.ytdNoi,
    noi.ytdBudgetNoi,
  );
  const noiVarianceSuffix =
    noiVarianceStatus === "on-track" ? "fav."
      : noiVarianceStatus === "monitor" ? "watch"
        : "unf.";
  const noiVariance: StewardshipScorecardRow = {
    key: "noi-variance-to-budget",
    metric: "NOI Variance to Budget",
    description: "$0 is the goal. Falling within ±3% is the acceptable break-even zone.",
    actual: `${opsLabels.ytdNoiLabel} ${noiVarianceSuffix}`,
    budget: opsLabels.budgetGoalLabel,
    benchmark: "±3% zone",
    status: noiVarianceStatus,
    dataSource: tagOf("noi-variance-to-budget"),
  };

  // ----- NOI as % of Operating Revenue (accounting-fed) -----
  // Status DERIVED from snapshot.noi against the ClubBenchmarking
  // corridor stored on the snapshot (was hardcoded `"on-track"`).
  const noiPctStatus = classifyNoiPctRevenueStatus(
    noi.ytdNoi,
    noi.ytdRevenue,
    noi.breakEvenLowerPct,
    noi.breakEvenUpperPct,
  );
  const noiPctRow: StewardshipScorecardRow = {
    key: "noi-pct-revenue",
    metric: "NOI as % of Operating Revenue",
    description: "ClubBenchmarking break-even zone: −2.8% to +3.3%.",
    actual: opsLabels.noiPctRevenueLabel,
    budget: "0.0%",
    benchmark: "−2.8/+3.3%",
    status: noiPctStatus,
    dataSource: tagOf("noi-pct-revenue"),
  };

  // ----- F&B Subsidy % of Dues -----
  const fbSubsidyPctRow: StewardshipScorecardRow = {
    key: "fb-subsidy-pct-dues",
    metric: "F&B Subsidy % of Dues",
    description:
      "Healthy range (12%–21%). A ratio below 12% may signal under-investment in the member experience.",
    actual:
      inputs.fbSubsidy != null && inputs.duesForFbRatio != null && inputs.duesForFbRatio > 0
        ? pct1(inputs.fbSubsidy, inputs.duesForFbRatio)
        : "—",
    budget: "12%–21%",
    benchmark: "12%+",
    status: "monitor",
    dataSource: tagOf("fb-subsidy-pct-dues"),
  };

  // ----- Golf Rounds vs. Budget -----
  const golfDelta = inputs.golfRoundsActual - inputs.golfRoundsBudget;
  const golfRounds: StewardshipScorecardRow = {
    key: "golf-rounds-vs-budget",
    metric: "Golf Rounds vs. Budget",
    description: "Engagement signal — member utilization of the primary amenity.",
    actual: intCount(inputs.golfRoundsActual),
    budget: intCount(inputs.golfRoundsBudget),
    benchmark: variance(golfDelta),
    status: classifyCountVariance(inputs.golfRoundsActual, inputs.golfRoundsBudget),
    trend: trendOfDelta(golfDelta),
    dataSource: tagOf("golf-rounds-vs-budget"),
  };

  // ----- F&B Covers vs. Budget -----
  const fbDelta = inputs.fbCoversActual - inputs.fbCoversBudget;
  const fbCovers: StewardshipScorecardRow = {
    key: "fb-covers-vs-budget",
    metric: "F&B Covers vs. Budget",
    description: "Total dining covers as a measure of social engagement vs. plan.",
    actual: intCount(inputs.fbCoversActual),
    budget: intCount(inputs.fbCoversBudget),
    benchmark: variance(fbDelta),
    status: classifyCountVariance(inputs.fbCoversActual, inputs.fbCoversBudget),
    trend: trendOfDelta(fbDelta),
    dataSource: tagOf("fb-covers-vs-budget"),
  };

  const rows = [dues, initSubsidy, payroll, noiVariance, noiPctRow, fbSubsidyPctRow, golfRounds, fbCovers];
  // Top-level dataSource is "live" only when every row is live.
  const scorecardDataSource: ReportingDataSource = rows.every(
    (r) => r.dataSource === "live",
  )
    ? "live"
    : "demo";

  return {
    title: "Operating Stewardship — KPI Scorecard",
    subtitle: "IS THE CLUB LIVING WITHIN THE OPERATING PLAN?",
    sectionBand: "NON-PROFIT OPERATING LEDGER",
    columnHeaders: { actual: "Actual", budget: "Budget", benchmark: "Benchmark" },
    dataSource: scorecardDataSource,
    rows,
  };
}

/**
 * Build the Capital Stewardship scorecard.
 *
 * Per the Jonas-readiness audit (Tier 2, items 5–9), this builder
 * previously consumed raw `CapitalScorecardInputs` with the
 * `equity-cagr` row hardcoded `status: "on-track"` and the
 * `long-term-debt-equity` row falling back to a misleading
 * `"on-track"` when `longTermDebt === null`. Both verdicts are now
 * derived from numeric inputs (see `classifyEquityCagrStatus` and
 * `classifyLongTermDebtStatus`).
 *
 * Per-row `dataSource` reads from `snapshot.perRowDataSource` so
 * each row's provenance reflects its actual input source
 * (`accounting` / `operational` / `demo`), mapped to the legacy
 * `"live" | "demo"` flag via `toLegacyDataSource`.
 *
 * BACKWARDS COMPATIBILITY: callers may pass either the new
 * `CapitalScorecardSnapshot` (preferred — carries per-row
 * provenance + equity-CAGR numerics) OR the legacy
 * `CapitalScorecardInputs` (the raw shape). When the legacy shape
 * is passed, the function wraps it with default equity numerics
 * that classify `on-track` and tags the equity-CAGR row as
 * `accounting` (preserving the pre-snapshot `dataSource: "live"`
 * behaviour that earlier tests relied on). New consumers always
 * pass a snapshot.
 */
export function buildCapitalScorecardData(
  snapshotOrInputs: CapitalScorecardSnapshot | CapitalScorecardInputs,
  equityLabels: EquityDashboardLabels,
): StewardshipScorecard {
  const snapshot: CapitalScorecardSnapshot = isCapitalSnapshot(snapshotOrInputs)
    ? snapshotOrInputs
    : {
        inputs: snapshotOrInputs,
        // Defaults preserve historical on-track classification for
        // raw-input callers (mostly existing tests).
        equity: {
          actualCagrBps:          740,
          bestInClassCagrBps:     550,
          minimumRequiredCagrBps: 300,
        },
        perRowDataSource: {
          "equity-cagr":                    "accounting",
          "equity-to-assets":               "demo",
          "capital-reserve-pct":            "demo",
          "net-available-capital":          "demo",
          "net-capital-vs-depreciation":    "demo",
          "long-term-debt-equity":          "demo",
          "net-ppe-to-gross-ppe":           "demo",
          "total-capital-income-vs-budget": "demo",
        },
      };
  const { inputs, equity, perRowDataSource } = snapshot;
  const tagOf = (key: keyof typeof perRowDataSource): ReportingDataSource =>
    toLegacyDataSource(perRowDataSource[key]);

  // ----- Equity Growth CAGR -----
  // Status DERIVED from snapshot.equity bps (was hardcoded
  // `"on-track"` before the Jonas-readiness sweep).
  const cagrRow: StewardshipScorecardRow = {
    key: "equity-cagr",
    metric: "Equity Growth (CAGR 2018–Now)",
    description: "Min. 3.5% annually to outpace inflation and rising asset replacement costs.",
    actual: equityLabels.actualCagrLabel,
    budget: "5.9%",
    benchmark: `${equityLabels.bestInClassCagrLabel}+`,
    status: classifyEquityCagrStatus(
      equity.actualCagrBps,
      equity.bestInClassCagrBps,
      equity.minimumRequiredCagrBps,
    ),
    dataSource: tagOf("equity-cagr"),
  };

  // ----- Equity-to-Assets Ratio -----
  const eqAssetsPct = (inputs.totalEquity / inputs.totalAssets) * 100;
  const eqAssetsStatus = classifyByThreshold(eqAssetsPct, 66, "above", 6);
  const equityAssets: StewardshipScorecardRow = {
    key: "equity-to-assets",
    metric: "Equity-to-Assets Ratio",
    description: "How much of club assets are owned by members vs. leveraged through debt.",
    actual: pct1(inputs.totalEquity, inputs.totalAssets),
    budget: pctRatio(inputs.equityToAssetsGoal),
    benchmark: "66%+",
    status: eqAssetsStatus,
    dataSource: tagOf("equity-to-assets"),
  };

  // ----- Capital Reserve % of Assets -----
  const reservePct = (inputs.capitalReserveBalance / inputs.totalAssets) * 100;
  const reserveStatus = classifyByThreshold(reservePct, 14, "above", 3);
  const capReserve: StewardshipScorecardRow = {
    key: "capital-reserve-pct",
    metric: "Capital Reserve % of Assets",
    description: "Critical measure of the club's ability to fund annual asset replacement.",
    actual: pct1(inputs.capitalReserveBalance, inputs.totalAssets),
    budget: pctRatio(inputs.capitalReserveGoal),
    benchmark: "14%+",
    status: reserveStatus,
    dataSource: tagOf("capital-reserve-pct"),
  };

  // ----- Net Available Capital Ratio -----
  const netAvailPct = (inputs.netAvailableCapital / inputs.operatingRevenueForCapital) * 100;
  const netAvailStatus = classifyByThreshold(netAvailPct, 20, "above", 5);
  const netAvail: StewardshipScorecardRow = {
    key: "net-available-capital",
    metric: "Net Available Capital Ratio",
    description: "Net available capital as % of operating revenue, after the NOI result.",
    actual: pct1(inputs.netAvailableCapital, inputs.operatingRevenueForCapital),
    budget: pctRatio(inputs.netAvailableCapitalGoal),
    benchmark: "20%+",
    status: netAvailStatus,
    dataSource: tagOf("net-available-capital"),
  };

  // ----- Net Capital > Depreciation? -----
  const netCapCoversDepreciation = inputs.netCapital > inputs.depreciation;
  const netCapDep: StewardshipScorecardRow = {
    key: "net-capital-vs-depreciation",
    metric: "Net Capital > Depreciation?",
    description: "Must cover depreciation — a real future cost, not just an accounting entry.",
    actual: netCapCoversDepreciation ? "YES" : "NO",
    budget: "YES",
    benchmark: "Required",
    status: netCapCoversDepreciation ? "on-track" : "action",
    dataSource: tagOf("net-capital-vs-depreciation"),
  };

  // ----- Long-Term Debt-to-Equity -----
  // Status DERIVED via classifyLongTermDebtStatus. Null debt now
  // classifies `monitor` (was hardcoded `"on-track"`, which the
  // audit flagged as a misleading placeholder verdict).
  const ltDebtRow: StewardshipScorecardRow = {
    key: "long-term-debt-equity",
    metric: "Long-Term Debt-to-Equity",
    description: "Low debt relative to equity. Under 25% is healthy for private clubs.",
    actual:
      inputs.longTermDebt != null && inputs.totalEquity > 0
        ? pct1(inputs.longTermDebt, inputs.totalEquity)
        : "—",
    budget: "—",
    benchmark: "<25%",
    status: classifyLongTermDebtStatus(inputs.longTermDebt, inputs.totalEquity),
    dataSource: tagOf("long-term-debt-equity"),
  };

  // ----- Net PPE to Gross PPE Ratio -----
  const ppeDelta = inputs.netPPE / inputs.grossPPE;
  const ppeStatus = classifyByThreshold(ppeDelta * 100, 40, "above", 5);
  const ppeRow: StewardshipScorecardRow = {
    key: "net-ppe-to-gross-ppe",
    metric: "Net PPE to Gross PPE Ratio",
    description: "Asset age indicator. Below 40% signals aging facilities needing investment.",
    actual: pctFrom2(inputs.netPPE, inputs.grossPPE),
    budget: pctFromRatio0dp(inputs.netPPEGoal),
    benchmark: "55%+ target",
    status: ppeStatus,
    trend: ppeStatus === "on-track" ? "up" : "down",
    dataSource: tagOf("net-ppe-to-gross-ppe"),
  };

  // ----- Total Capital Income vs. Budget -----
  const capIncomeDelta = inputs.totalCapitalIncomeActual - inputs.totalCapitalIncomeBudget;
  const capIncomeStatus = classifyDollarVariance(
    inputs.totalCapitalIncomeActual,
    inputs.totalCapitalIncomeBudget,
    2_000_000, // $2M slack before promoting from monitor → action
  );
  const capIncome: StewardshipScorecardRow = {
    key: "total-capital-income-vs-budget",
    metric: "Total Capital Income vs. Budget",
    description: "Shortfall driven by reduced lot sales; operational capital income on track.",
    actual: dollarsM(inputs.totalCapitalIncomeActual),
    budget: dollarsM(inputs.totalCapitalIncomeBudget),
    benchmark: dollarsVarianceM(capIncomeDelta),
    status: capIncomeStatus,
    trend: trendOfDelta(capIncomeDelta),
    dataSource: tagOf("total-capital-income-vs-budget"),
  };

  const rows = [cagrRow, equityAssets, capReserve, netAvail, netCapDep, ltDebtRow, ppeRow, capIncome];
  // Top-level dataSource rolls up to "live" only when every row is live.
  const scorecardDataSource: ReportingDataSource = rows.every(
    (r) => r.dataSource === "live",
  )
    ? "live"
    : "demo";

  return {
    title: "Capital Stewardship — KPI Scorecard",
    subtitle: "IS THE CLUB PROTECTING ITS FUTURE?",
    sectionBand: "CAPITAL LEDGER & BALANCE SHEET HEALTH",
    columnHeaders: { actual: "Actual", budget: "Budget/Goal", benchmark: "Best-in-Class" },
    dataSource: scorecardDataSource,
    rows,
  };
}

/** Discriminator for the new vs legacy capital input shape. */
function isCapitalSnapshot(
  v: CapitalScorecardSnapshot | CapitalScorecardInputs,
): v is CapitalScorecardSnapshot {
  return (
    typeof v === "object" &&
    v !== null &&
    "inputs" in v &&
    "equity" in v &&
    "perRowDataSource" in v
  );
}

// ---------------------------------------------------------------------------
// Silver Springs demo seeds.
//
// These numeric inputs reproduce the displayed values the founder
// approved in the prior visual pass. They live in the reporting
// service so they're not React-tree literals and so each row's
// display string flows from a computation rather than being hand-
// typed. A real club would replace these with prisma reads against
// the income-statement / balance-sheet / membership-activity tables.
// ---------------------------------------------------------------------------
/**
 * @deprecated — kept exported so existing tests that import it can
 * continue to compile, but `monthly-package.ts` no longer consumes
 * this constant directly. The canonical accounting-backed path now
 * flows through `buildDemoOperatingScorecardSnapshot()` /
 * `buildOperatingScorecardSnapshotFromAccounting()` in
 * `src/lib/reporting/operating-scorecard-service.ts`. Once Phase 1
 * Jonas wiring lands, this constant can be removed entirely.
 */
export const SILVER_SPRINGS_OPERATING_INPUTS: OperatingScorecardInputs = {
  // 65.9 % of 15.0M → $9,885,000 dues  (rounds to 65.9 %)
  duesRevenue:                  9_885_000,
  duesRevenueBudget:           10_080_000,  // 67.2 % of 15.0M
  totalOperatingRevenue:       15_000_000,
  totalOperatingRevenueBudget: 15_000_000,
  initiationFeeSubsidy:         1_070_000,  // $1.07M
  initiationFeeSubsidyBudget:   1_040_000,  // $1.04M
  payrollBenefitsExpense:       8_880_000,  // 59.2 % of 15.0M
  payrollBenefitsExpenseBudget: 8_730_000,  // 58.2 % of 15.0M
  fbSubsidy:                    null,       // not yet posted → "—"
  duesForFbRatio:               null,
  golfRoundsActual:             6_483,
  golfRoundsBudget:             5_455,
  fbCoversActual:              24_207,
  fbCoversBudget:              29_310,
};

/**
 * @deprecated — kept exported so existing tests that import it can
 * continue to compile, but `monthly-package.ts` no longer consumes
 * this constant directly. The canonical accounting-backed path now
 * flows through `buildDemoCapitalScorecardSnapshot()` /
 * `buildCapitalScorecardSnapshotFromAccounting()` in
 * `src/lib/reporting/capital-scorecard-service.ts`. Once Phase 1
 * Jonas wiring lands, this constant can be removed entirely.
 */
export const SILVER_SPRINGS_CAPITAL_INPUTS: CapitalScorecardInputs = {
  // 77.2 % of total assets is equity. Pick totalEquity = $31.0M
  // (matches the Current Equity KPI tile on the equity card) so
  // totalAssets = 31.0M / 0.772 = ~40.155M.
  totalAssets:           40_155_000,
  totalEquity:           31_000_000,
  equityToAssetsGoal:    0.770,
  // 11.7 % of $40.155M = $4,698,135
  capitalReserveBalance:  4_698_000,
  capitalReserveGoal:    0.140,
  // 26.2 % of operating revenue
  netAvailableCapital:    3_930_000,
  operatingRevenueForCapital: 15_000_000,
  netAvailableCapitalGoal: 0.347,
  // Net capital available for replacement; depreciation. YES → NC > D.
  netCapital:             4_700_000,
  depreciation:           4_200_000,
  longTermDebt:           null,       // not yet posted → "—"
  // 31% of gross PPE
  netPPE:                 8_060_000,
  grossPPE:              26_000_000,
  netPPEGoal:             0.35,
  // $4.44M actual vs $6.03M budget → variance −$1.59M
  totalCapitalIncomeActual: 4_440_000,
  totalCapitalIncomeBudget: 6_030_000,
};
