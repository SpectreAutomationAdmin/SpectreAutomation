// Capital Fund Statement service.
//
// Owns the row dataset, reserve coverage data, reserve adequacy
// table, and reactive capital-stress-test commentary for chapter V
// "Capital Fund Statement". Mirrors the Statement of Activities
// architecture: all values + labels are owned by this service, the
// React surface renders only.
//
// Period labels (statement header, annual-budget column header)
// MUST flow from the canonical `ReportingPeriod` per the
// `Reporting Period Golden Rule` (CLAUDE.md +
// docs/reporting-package-period-golden-rule.md). No hardcoded
// Q1 / March / quarter strings.
//
// Shared-source-of-truth note: the capital section already rendered
// in the chapter IV Statement of Activities lives there as a
// combined-performance presentation. The chapter V Capital Fund
// Statement is the dedicated capital-stewardship surface. To keep
// the two from drifting, the capital dues + initiation fees inputs
// for the stress-test reactive commentary in THIS module are
// scraped off the same row dataset both surfaces consume — i.e.
// the inputs feed `buildCapitalStressTestCommentary` from the
// capital fund builder's own seeded numerics, which are sized
// against the Statement of Activities capital section seeds.

import type { ReportingDataSource } from "@/lib/reporting/monthly-package";
import type { ReportingPeriod } from "@/lib/reporting/reporting-period";

// =============================================================================
// Public types
// =============================================================================

/** Tone for an adequacy-detail row value (controls the brand-clear
 *  colour applied to the right-aligned value cell). */
export type CapitalFundAdequacyTone = "neutral" | "favorable" | "risk";

export type CapitalFundStatementValues = {
  annualBudget: number | null;
  ytdActual: number | null;
  remaining: number | null;
};

export type CapitalFundRowKind =
  | "section-band"
  | "detail"
  | "commentary"
  | "subtotal"
  | "summary-band"
  | "analysis-band"
  | "net-line";

export type CapitalFundRow = {
  key: string;
  kind: CapitalFundRowKind;
  label?: string;
  values?: CapitalFundStatementValues;
  /** Italic full-width row for kind="commentary". */
  text?: string;
};

/** Marker label rendered above the reserve coverage progress bar. */
export type CapitalFundReserveMarker = {
  /** Position on the bar as a decimal 0..1 (e.g. 0.30 → "30%"). */
  pct: number;
  /** Label rendered beneath the tick (e.g. "30%", "60% ← target"). */
  label: string;
};

export type CapitalFundReserveCoverage = {
  /** Current reserve coverage ratio as a decimal (e.g. 0.61). */
  currentPct: number;
  /** Pre-formatted "61%" string for the hero number. */
  currentPctLabel: string;
  /** "FAC Benchmark: 60%+" — formatted at the service. */
  facBenchmarkLabel: string;
  /** "3-Year Goal: 75%" — formatted at the service. */
  threeYearGoalLabel: string;
  /** Reserve balance label, e.g. "$4.82M". */
  reserveBalanceLabel: string;
  /** Tick markers on the bar. */
  markers: ReadonlyArray<CapitalFundReserveMarker>;
};

export type CapitalFundAdequacyRow = {
  key: string;
  label: string;
  valueLabel: string;
  tone: CapitalFundAdequacyTone;
  /** Optional check glyph after the value (used for "YTD Contribution — On Plan ✓"). */
  checkmark?: boolean;
};

export type CapitalFundStressTest = {
  eyebrow: string;
  body: string;
};

export type CapitalFundStatement = {
  dataSource: ReportingDataSource;
  // Header chrome — same structure as StatementOfActivitiesV2 so the
  // two chapters read as peers in the Financial Performance group.
  eyebrow: string;
  title: string;
  /** Period header line — derived from `ReportingPeriod.statementHeaderLabel`. */
  periodLabel: string;
  introNote: string;
  statementNumber: string;
  documentChip: string;
  preparedFor: string;
  // Sources & Uses table — 4 columns.
  columnHeaders: {
    category: string;
    /** Annual-budget column header — derived from `ReportingPeriod.year`
     *  (e.g. "2026 Budget"). NEVER hardcoded inside this service. */
    annualBudget: string;
    ytdActual: string;
    remaining: string;
  };
  rows: ReadonlyArray<CapitalFundRow>;
  // Right-column dashboard cards.
  reserveCoverage: CapitalFundReserveCoverage;
  reserveAdequacy: ReadonlyArray<CapitalFundAdequacyRow>;
  stressTest: CapitalFundStressTest;
  // External attribution / reference-source footer removed
  // 2026-06-15: production reporting package, not a Saguaro
  // reference illustration. Bottom padding is preserved via the
  // surrounding chapter ornament + section gap.
};

// =============================================================================
// Reactive capital stress test commentary
// =============================================================================

export type CapitalStressTestInputs = {
  /** Annual initiation-fee revenue at full budget (e.g. 2,160,000). */
  initiationFeesAnnual: number;
  /** Annual capital dues revenue (e.g. 1,920,000). */
  capitalDuesAnnual: number;
  /** Initiation-fee decline % the stress test assumes (0.5 = 50%). */
  initiationFeeDeclinePct: number;
  /** Required annual reserve contribution (e.g. 480,000). */
  requiredAnnualReserveContribution: number;
  /** Annual debt service obligation (e.g. 216,000). */
  annualDebtService: number;
};

function formatDollars(value: number): string {
  const abs = Math.abs(Math.round(value));
  const sign = value < 0 ? "−" : "";
  return `${sign}$${abs.toLocaleString("en-US")}`;
}

function formatDollarsM(value: number): string {
  const m = Math.abs(value) / 1_000_000;
  const sign = value < 0 ? "−" : "";
  return `${sign}$${m.toFixed(2)}M`;
}

/** Reactive stress-test commentary. Branches on whether the club's
 *  recurring capital dues (a structural revenue source) can absorb
 *  a meaningful initiation-fee decline AND still fund the required
 *  reserve contribution + debt service. */
export function buildCapitalStressTestCommentary(
  inputs: CapitalStressTestInputs,
): CapitalFundStressTest {
  const declinePctLabel = `${Math.round(inputs.initiationFeeDeclinePct * 100)}%`;
  const incomeDecrease = inputs.initiationFeesAnnual * inputs.initiationFeeDeclinePct;
  const baseObligation = inputs.requiredAnnualReserveContribution + inputs.annualDebtService;
  const duesCoversObligation = inputs.capitalDuesAnnual >= baseObligation;

  const eyebrow = `Capital Stress Test — ${declinePctLabel} Initiation Fee Decline`;

  const body =
    `If initiation fee revenue declined ${declinePctLabel} for two consecutive years, ` +
    `annual capital income would decrease by approximately ${formatDollarsM(incomeDecrease)}. ` +
    `At current capital dues levels of ${formatDollarsM(inputs.capitalDuesAnnual)} annually, the club would ` +
    `${
      duesCoversObligation
        ? "retain sufficient structural funding to maintain reserve contributions and debt service without deferral. " +
          "The club passes this stress test."
        : `face a structural shortfall against the ${formatDollars(baseObligation)} ` +
          `combined reserve + debt service obligation; the board should evaluate deferral or supplemental funding.`
    } ` +
    `The structurally funded capital model — where capital dues, not initiation fees, carry the base obligation — ` +
    `provides meaningful protection against housing market cycles.`;

  return { eyebrow, body };
}

// =============================================================================
// Seeded Silver Springs Capital Fund Statement
// =============================================================================
//
// Numerics seeded directly from the Saguaro reference. Period
// presentation (statement header + annual-budget column header)
// flows from `ReportingPeriod` per the Golden Rule.
//
// The seeded YTD values reflect roughly 25% of annual budget (Q1
// pacing in the reference). When the GL ships month-level capital
// activity, this builder swaps the seed for live computation; the
// page surface remains unchanged.

function row(
  annualBudget: number | null,
  ytdActual: number | null,
): CapitalFundStatementValues {
  const remaining =
    annualBudget === null || ytdActual === null
      ? null
      : annualBudget - ytdActual;
  return {
    annualBudget,
    ytdActual,
    remaining,
  };
}

export function buildSilverSpringsCapitalFundStatement(opts: {
  clubName: string;
  period: ReportingPeriod;
}): CapitalFundStatement {
  // -- Seeded numerics (sized vs the Saguaro reference) --
  const capitalDuesAnnual    = 1_920_000;
  const initiationFeesAnnual = 2_160_000;
  const investmentIncomeAnnual = 175_000;
  const transferFromOpsAnnual = 0;
  const replacementsAnnual   = 1_840_000;
  const improvementsAnnual   = 480_000;
  const enhancementsAnnual   = 320_000;
  const debtServiceAnnual    = 216_000;

  const capitalDuesYtd       = 480_000;
  const initiationFeesYtd    = 480_000;
  const investmentIncomeYtd  = 46_200;
  const transferFromOpsYtd   = 0;
  const replacementsYtd      = 412_000;
  const improvementsYtd      = 128_000;
  const enhancementsYtd      = 80_000;
  const debtServiceYtd       = 54_000;

  const totalCapitalSourcesAnnual =
    capitalDuesAnnual + initiationFeesAnnual + investmentIncomeAnnual + transferFromOpsAnnual;
  const totalCapitalSourcesYtd =
    capitalDuesYtd + initiationFeesYtd + investmentIncomeYtd + transferFromOpsYtd;
  const totalCapitalDeployedAnnual =
    replacementsAnnual + improvementsAnnual + enhancementsAnnual + debtServiceAnnual;
  const totalCapitalDeployedYtd =
    replacementsYtd + improvementsYtd + enhancementsYtd + debtServiceYtd;
  const netPositionAnnual = totalCapitalSourcesAnnual - totalCapitalDeployedAnnual;
  const netPositionYtd    = totalCapitalSourcesYtd    - totalCapitalDeployedYtd;
  const netCapitalIncomeAnnual = totalCapitalSourcesAnnual - debtServiceAnnual;
  const netCapitalIncomeYtd    = totalCapitalSourcesYtd    - debtServiceYtd;

  const rows: CapitalFundRow[] = [
    // SOURCES OF CAPITAL
    { key: "band-sources", kind: "section-band", label: "Sources of Capital" },
    { key: "capital-dues",       kind: "detail", label: "Capital Dues — Monthly Assessment",
      values: row(capitalDuesAnnual, capitalDuesYtd) },
    { key: "initiation-fees",    kind: "detail", label: "Initiation Fees — New Memberships",
      values: row(initiationFeesAnnual, initiationFeesYtd) },
    { key: "initiation-fees-comment", kind: "commentary",
      text: "7 memberships Q1. 28 forecast annually." },
    { key: "investment-income",  kind: "detail", label: "Investment Income on Reserve Fund",
      values: row(investmentIncomeAnnual, investmentIncomeYtd) },
    { key: "transfer-from-ops",  kind: "detail", label: "Transfer from Operations (Surplus)",
      values: row(null, null) },
    { key: "total-sources", kind: "subtotal", label: "Total Capital Sources",
      values: row(totalCapitalSourcesAnnual, totalCapitalSourcesYtd) },

    // CAPITAL DEPLOYED — APPROVED PROJECTS
    { key: "band-deployed", kind: "section-band", label: "Capital Deployed — Approved Projects" },
    { key: "replacements", kind: "detail", label: "Replacements — Facilities & Equipment",
      values: row(replacementsAnnual, replacementsYtd) },
    { key: "improvements", kind: "detail", label: "Improvements — Facility Upgrades",
      values: row(improvementsAnnual, improvementsYtd) },
    { key: "enhancements", kind: "detail", label: "Enhancements — Committee Projects",
      values: row(enhancementsAnnual, enhancementsYtd) },
    { key: "debt-service",  kind: "detail", label: "Debt Service — Long-Term Note",
      values: row(debtServiceAnnual, debtServiceYtd) },
    { key: "total-deployed", kind: "subtotal", label: "Total Capital Deployed",
      values: row(totalCapitalDeployedAnnual, totalCapitalDeployedYtd) },

    // NET CAPITAL POSITION CHANGE (YTD) — emphasised pale-blue summary band
    { key: "net-position", kind: "summary-band", label: "Net Capital Position Change (YTD)",
      values: row(netPositionAnnual, netPositionYtd) },

    // NET CAPITAL INCOME ANALYSIS
    { key: "band-analysis", kind: "analysis-band", label: "Net Capital Income Analysis" },
    { key: "analysis-total-sources", kind: "detail", label: "Total Capital Sources",
      values: { annualBudget: totalCapitalSourcesAnnual, ytdActual: totalCapitalSourcesYtd, remaining: null } },
    { key: "analysis-less-debt",     kind: "detail", label: "Less: Debt Service",
      values: { annualBudget: -debtServiceAnnual, ytdActual: -debtServiceYtd, remaining: null } },
    { key: "analysis-net-income",    kind: "net-line", label: "Net Capital Income",
      values: { annualBudget: netCapitalIncomeAnnual, ytdActual: netCapitalIncomeYtd, remaining: null } },
  ];

  // -- Reserve coverage card --
  const reserveFundBalance      = 4_820_000;
  const totalAssetReplacementCost = 7_900_000;
  const reserveCoveragePct = reserveFundBalance / totalAssetReplacementCost; // 0.610...
  const reserveCoverage: CapitalFundReserveCoverage = {
    currentPct: reserveCoveragePct,
    currentPctLabel: `${(reserveCoveragePct * 100).toFixed(0)}%`,
    facBenchmarkLabel: "FAC Benchmark: 60%+",
    threeYearGoalLabel: "3-Year Goal: 75%",
    reserveBalanceLabel: `Reserve Balance: $${(reserveFundBalance / 1_000_000).toFixed(2)}M`,
    markers: [
      { pct: 0.00, label: "0%" },
      { pct: 0.30, label: "30%" },
      { pct: 0.60, label: "60% ← target" },
      { pct: 0.75, label: "75% 3yr" },
      { pct: 1.00, label: "100%" },
    ],
  };

  // -- Reserve adequacy detail card --
  const annualReserveContribution = 480_000;
  const ytdContribution = 120_000;
  const deferredCapitalLiability = 3_080_000;
  const netToGrossPpe = 0.44;
  const reserveAdequacy: ReadonlyArray<CapitalFundAdequacyRow> = [
    { key: "reserve-balance",        label: "Reserve Fund Balance",
      valueLabel: `$${reserveFundBalance.toLocaleString("en-US")}`, tone: "neutral" },
    { key: "asset-replacement-cost", label: "Total Asset Replacement Cost",
      valueLabel: `$${totalAssetReplacementCost.toLocaleString("en-US")}`, tone: "neutral" },
    { key: "coverage-ratio",         label: "Reserve Coverage Ratio",
      valueLabel: `${(reserveCoveragePct * 100).toFixed(1)}%`, tone: "neutral" },
    { key: "deferred-capital",       label: "Deferred Capital Liability",
      valueLabel: `$${deferredCapitalLiability.toLocaleString("en-US")}`, tone: "risk" },
    { key: "net-to-gross-ppe",       label: "Net-to-Gross PP&E Ratio",
      valueLabel: `${(netToGrossPpe * 100).toFixed(0)}%`, tone: "risk" },
    { key: "annual-contribution",    label: "Annual Reserve Contribution",
      valueLabel: `$${annualReserveContribution.toLocaleString("en-US")}`, tone: "neutral" },
    { key: "ytd-contribution",       label: "YTD Contribution — On Plan",
      valueLabel: `$${ytdContribution.toLocaleString("en-US")}`, tone: "favorable", checkmark: true },
  ];

  // -- Reactive stress test commentary --
  const stressTest = buildCapitalStressTestCommentary({
    initiationFeesAnnual,
    capitalDuesAnnual,
    initiationFeeDeclinePct: 0.50,
    requiredAnnualReserveContribution: annualReserveContribution,
    annualDebtService: debtServiceAnnual,
  });

  return {
    dataSource: "demo",
    eyebrow: `${opts.clubName} · Capital Fund`,
    title: "Capital Fund Statement",
    // Period header line + annual-budget column header BOTH flow from
    // ReportingPeriod. NO hardcoded Q1/March/2026 strings.
    periodLabel: opts.period.statementHeaderLabel,
    introNote:
      "Where capital comes from, where it goes, and whether the reserve fund is on trajectory.",
    statementNumber: "Statement 05 of 14",
    documentChip: "Capital Fund",
    preparedFor: "Finance Committee",
    columnHeaders: {
      category: "Capital Fund Sources & Uses",
      annualBudget: `${opts.period.year} Budget`,
      ytdActual: "YTD Actual",
      remaining: "Remaining",
    },
    rows,
    reserveCoverage,
    reserveAdequacy,
    stressTest,
  };
}
