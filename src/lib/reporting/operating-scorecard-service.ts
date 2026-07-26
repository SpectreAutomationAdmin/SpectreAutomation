// Operating Stewardship Scorecard — accounting-backed input service.
//
// Replaces direct consumption of the `SILVER_SPRINGS_OPERATING_INPUTS`
// constant in `monthly-package.ts`. Per the Jonas-readiness audit
// (Tier 2, item 8), several scorecard rows were seeded and would NOT
// respond to Jonas imports — the values, the status dots, the
// commentary all stayed pinned to the demo numbers.
//
// Now:
//
//   • A typed `OperatingScorecardSnapshot` wraps both the numeric
//     atoms (revenue, expenses, NOI, payroll, etc.) AND the
//     per-row data-source metadata. The 8 scorecard rows derive
//     their `dataSource` tag from this metadata, not from a global
//     "demo" assumption.
//
//   • The snapshot also carries the NOI numerics the
//     scorecard-metrics builder previously could not see — so the
//     two NOI rows (`noi-variance-to-budget`,
//     `noi-pct-revenue`) can now derive their status dots from the
//     real numbers instead of carrying a hardcoded
//     `status: "on-track"` literal.
//
//   • A demo snapshot factory preserves the historical Silver
//     Springs seed values (visual layout is identical to the
//     pre-change state) until Phase 1 wiring services populate the
//     snapshot from prisma reads.
//
// Phase 1 wiring path (deferred): replace
// `buildDemoOperatingScorecardSnapshot()` with
// `buildOperatingScorecardSnapshotFromAccounting(...)` reading from
// `getGLAccountTotals(category)` + `getOperatingResults()` +
// (future) operational integrations for golf rounds + F&B covers.

import type { MonthlyAccountingDataSource } from "@/lib/reporting/monthly-accounting-contract";
import type { OperatingScorecardInputs } from "@/lib/reporting/scorecard-metrics";

/**
 * Per-row data-source map for the operating scorecard. Each row's
 * key matches its `StewardshipScorecardRow.key`; the value is the
 * provenance class of that row's underlying inputs.
 *
 * The two NOI rows always carry `accounting` provenance when the
 * snapshot is populated from real accounting reads — they're sourced
 * from `getOperatingResults()`, which already does prisma reads
 * against `FiscalPeriod`. The 6 other rows reflect whichever atom
 * they consume:
 *   - dues / payroll / initiation / F&B subsidy → `accounting`
 *   - golf rounds / F&B covers → `operational` (POS / tee sheet)
 *   - any row without a real source yet → `demo`
 */
export type OperatingScorecardPerRowDataSource = Readonly<{
  "dues-to-revenue": MonthlyAccountingDataSource;
  "initiation-fee-subsidy": MonthlyAccountingDataSource;
  "payroll-benefits-ratio": MonthlyAccountingDataSource;
  "noi-variance-to-budget": MonthlyAccountingDataSource;
  "noi-pct-revenue": MonthlyAccountingDataSource;
  "fb-subsidy-pct-dues": MonthlyAccountingDataSource;
  "golf-rounds-vs-budget": MonthlyAccountingDataSource;
  "fb-covers-vs-budget": MonthlyAccountingDataSource;
}>;

/**
 * The numeric atoms the NOI rows need to derive their status. Today
 * the operating-results dashboard already computes these; we surface
 * them on the snapshot so the scorecard builder can classify the
 * NOI rows without a hardcoded verdict.
 */
export type OperatingNoiNumerics = {
  /** Sum of NOI across the trailing 12 months (dollars). May be
   *  negative. */
  ytdNoi: number;
  /** Sum of budget NOI across the trailing 12 months (dollars). */
  ytdBudgetNoi: number;
  /** Sum of revenue across the trailing 12 months (dollars).
   *  Denominator for the NOI % rule. */
  ytdRevenue: number;
  /** Break-even corridor — fraction (e.g. `0.033` for +3.3 %).
   *  Defaults to ClubBenchmarking's +3.3 % / −2.8 % zone if the
   *  service can't supply it. */
  breakEvenUpperPct: number;
  breakEvenLowerPct: number;
};

/**
 * Full snapshot — the typed input to
 * `buildOperatingScorecardData()`. Combines the 14 numeric atoms,
 * the per-row provenance map, and the NOI numerics for status
 * derivation.
 */
export type OperatingScorecardSnapshot = {
  inputs: OperatingScorecardInputs;
  noi: OperatingNoiNumerics;
  perRowDataSource: OperatingScorecardPerRowDataSource;
};

// ---------------------------------------------------------------------------
// NOI status derivation — replaces the hardcoded `status: "on-track"`
// ---------------------------------------------------------------------------

/** Classify the NOI Variance to Budget row.
 *
 *   - `on-track` when `ytdNoi >= ytdBudgetNoi` (favorable variance).
 *   - `monitor`  when below budget but within a $50K or 5 % cushion
 *                (whichever is larger) — material but not severe.
 *   - `action`   when materially below budget.
 *
 * Symmetric to the count-variance classifier used by the golf
 * rounds / F&B covers rows. */
export function classifyNoiVarianceStatus(
  ytdNoi: number,
  ytdBudgetNoi: number,
): "on-track" | "monitor" | "action" {
  const delta = ytdNoi - ytdBudgetNoi;
  if (delta >= 0) return "on-track";
  const tolerance = Math.max(50_000, Math.abs(ytdBudgetNoi) * 0.05);
  if (Math.abs(delta) <= tolerance) return "monitor";
  return "action";
}

/** Classify the NOI as % of Operating Revenue row against the
 *  ClubBenchmarking break-even corridor.
 *
 *   - `on-track` when NOI % falls INSIDE the corridor (between
 *                lower and upper).
 *   - `monitor`  when within 1 percentage-point of either edge
 *                (typically −3.8 % to −2.8 % or +3.3 % to +4.3 %).
 *   - `action`   when outside the corridor by more than 1 pt.
 */
export function classifyNoiPctRevenueStatus(
  ytdNoi: number,
  ytdRevenue: number,
  breakEvenLowerPct: number,
  breakEvenUpperPct: number,
): "on-track" | "monitor" | "action" {
  if (ytdRevenue <= 0) return "monitor";
  const noiPct = ytdNoi / ytdRevenue;
  if (noiPct >= breakEvenLowerPct && noiPct <= breakEvenUpperPct) {
    return "on-track";
  }
  const ONE_POINT = 0.01;
  if (
    noiPct >= breakEvenLowerPct - ONE_POINT &&
    noiPct <= breakEvenUpperPct + ONE_POINT
  ) {
    return "monitor";
  }
  return "action";
}

// ---------------------------------------------------------------------------
// Demo snapshot — preserves the historical Silver Springs seed values
// ---------------------------------------------------------------------------

/** Demo snapshot factory. Returns a snapshot whose `inputs` carry the
 *  same numbers the `SILVER_SPRINGS_OPERATING_INPUTS` constant did,
 *  whose `noi` numerics make the two NOI rows classify on-track (so
 *  the visual layout is unchanged), and whose `perRowDataSource`
 *  map tags every row's provenance honestly:
 *
 *    - The four accounting-class rows (dues, payroll, initiation,
 *      F&B subsidy) → `demo` (their inputs are seeded constants).
 *    - The two NOI rows → `demo` until `getOperatingResults()`
 *      writes into the snapshot (Phase 1).
 *    - The two operational rows (golf rounds, F&B covers) → `demo`
 *      until POS / tee-sheet integration lands (Phase 3).
 *
 *  When the founder-approved Jonas import lands, replace this
 *  factory with `buildOperatingScorecardSnapshotFromAccounting(...)`
 *  which reads each atom from its corresponding live service. The
 *  scorecard builder is unchanged. */
export function buildDemoOperatingScorecardSnapshot(): OperatingScorecardSnapshot {
  return {
    inputs: {
      // 65.9 % of 15.0M → $9,885,000 dues  (rounds to 65.9 %).
      duesRevenue:                  9_885_000,
      duesRevenueBudget:           10_080_000, // 67.2 % of 15.0M
      totalOperatingRevenue:       15_000_000,
      totalOperatingRevenueBudget: 15_000_000,
      initiationFeeSubsidy:         1_070_000, // $1.07M
      initiationFeeSubsidyBudget:   1_040_000, // $1.04M
      payrollBenefitsExpense:       8_880_000, // 59.2 % of 15.0M
      payrollBenefitsExpenseBudget: 8_730_000, // 58.2 % of 15.0M
      fbSubsidy:                    null,      // not yet posted → "—"
      duesForFbRatio:               null,
      golfRoundsActual:             6_483,
      golfRoundsBudget:             5_455,
      fbCoversActual:              24_207,
      fbCoversBudget:              29_310,
    },
    noi: {
      // Seeded to a small favourable variance against budget — so
      // the two derived NOI rows classify `on-track`, matching the
      // pre-change visual layout. Real numbers will arrive via
      // `getOperatingResults()` once the snapshot is wired live.
      ytdNoi:               45_000,
      ytdBudgetNoi:          0,
      ytdRevenue:       15_000_000,
      // ClubBenchmarking corridor (−2.8 % / +3.3 %).
      breakEvenLowerPct: -0.028,
      breakEvenUpperPct:  0.033,
    },
    perRowDataSource: {
      "dues-to-revenue":         "demo",
      "initiation-fee-subsidy":  "demo",
      "payroll-benefits-ratio":  "demo",
      "noi-variance-to-budget":  "demo",
      "noi-pct-revenue":         "demo",
      "fb-subsidy-pct-dues":     "demo",
      "golf-rounds-vs-budget":   "demo",
      "fb-covers-vs-budget":     "demo",
    },
  };
}

// ---------------------------------------------------------------------------
// Accounting-backed snapshot factory — the shape Phase 1 wiring will
// populate from prisma reads
// ---------------------------------------------------------------------------

/**
 * Raw atoms the future Jonas-import wiring will produce. Each field
 * carries its own data-source tag so the scorecard builder can
 * classify per-row provenance accurately. Today, only `monthly-
 * package.ts` calls `buildDemoOperatingScorecardSnapshot()`; this
 * factory is the contract Phase 1 will wire against.
 */
export type AccountingOperatingScorecardAtoms = {
  /** Operating dues revenue. */
  dues: { actual: number; budget: number; dataSource: MonthlyAccountingDataSource };
  /** Total operating revenue. */
  totalOperatingRevenue: { actual: number; budget: number; dataSource: MonthlyAccountingDataSource };
  /** Initiation fees POSTED TO OPERATING (best practice = $0). */
  initiationFeeSubsidy: { actual: number; budget: number; dataSource: MonthlyAccountingDataSource };
  /** Payroll & benefits expense. */
  payrollBenefits: { actual: number; budget: number; dataSource: MonthlyAccountingDataSource };
  /** F&B subsidy + denominator for the F&B subsidy % rule. `null`
   *  on either side suppresses the row (renders "—" in the
   *  scorecard) — the legacy SILVER_SPRINGS demo behaviour. */
  fbSubsidy:
    | { actual: number; duesForRatio: number; dataSource: MonthlyAccountingDataSource }
    | null;
  /** Operational counts — sourced from tee-sheet / POS, not the GL. */
  golfRounds: { actual: number; budget: number; dataSource: MonthlyAccountingDataSource };
  fbCovers: { actual: number; budget: number; dataSource: MonthlyAccountingDataSource };
  /** NOI numerics — straight from `getOperatingResults()` (already
   *  live today against `prisma.fiscalPeriod`). */
  noi: OperatingNoiNumerics & { dataSource: MonthlyAccountingDataSource };
};

/**
 * Build an `OperatingScorecardSnapshot` from accounting atoms. The
 * per-row dataSource map collapses each row's input(s) into a single
 * provenance value (worst case: any input `demo` → row `demo`).
 *
 * Pure function. Phase 1 wiring will call this from
 * `monthly-package.ts` after `getGLAccountTotals()` etc. populate
 * the atoms. Until then, only tests + the demo factory exercise this
 * path.
 */
export function buildOperatingScorecardSnapshotFromAccounting(
  atoms: AccountingOperatingScorecardAtoms,
): OperatingScorecardSnapshot {
  return {
    inputs: {
      duesRevenue:                  atoms.dues.actual,
      duesRevenueBudget:            atoms.dues.budget,
      totalOperatingRevenue:        atoms.totalOperatingRevenue.actual,
      totalOperatingRevenueBudget:  atoms.totalOperatingRevenue.budget,
      initiationFeeSubsidy:         atoms.initiationFeeSubsidy.actual,
      initiationFeeSubsidyBudget:   atoms.initiationFeeSubsidy.budget,
      payrollBenefitsExpense:       atoms.payrollBenefits.actual,
      payrollBenefitsExpenseBudget: atoms.payrollBenefits.budget,
      fbSubsidy:                    atoms.fbSubsidy?.actual ?? null,
      duesForFbRatio:               atoms.fbSubsidy?.duesForRatio ?? null,
      golfRoundsActual:             atoms.golfRounds.actual,
      golfRoundsBudget:             atoms.golfRounds.budget,
      fbCoversActual:               atoms.fbCovers.actual,
      fbCoversBudget:               atoms.fbCovers.budget,
    },
    noi: atoms.noi,
    perRowDataSource: {
      // Two-input rows take the worse of their two atoms' provenance.
      "dues-to-revenue":         worseProvenance(atoms.dues.dataSource, atoms.totalOperatingRevenue.dataSource),
      "initiation-fee-subsidy":  atoms.initiationFeeSubsidy.dataSource,
      "payroll-benefits-ratio":  worseProvenance(atoms.payrollBenefits.dataSource, atoms.totalOperatingRevenue.dataSource),
      "noi-variance-to-budget":  atoms.noi.dataSource,
      "noi-pct-revenue":         atoms.noi.dataSource,
      "fb-subsidy-pct-dues":     atoms.fbSubsidy?.dataSource ?? "demo",
      "golf-rounds-vs-budget":   atoms.golfRounds.dataSource,
      "fb-covers-vs-budget":     atoms.fbCovers.dataSource,
    },
  };
}

/** Pick the more conservative provenance class. `demo` is worst;
 *  `derived` is also conservative; `accounting` and `operational`
 *  are equally OK. */
function worseProvenance(
  a: MonthlyAccountingDataSource,
  b: MonthlyAccountingDataSource,
): MonthlyAccountingDataSource {
  const order: Record<MonthlyAccountingDataSource, number> = {
    accounting: 0,
    operational: 1,
    derived: 2,
    demo: 3,
  };
  return order[a] >= order[b] ? a : b;
}
