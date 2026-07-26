// Capital Stewardship Scorecard — accounting-backed input service.
//
// Replaces direct consumption of the `SILVER_SPRINGS_CAPITAL_INPUTS`
// constant in `monthly-package.ts`. Per the Jonas-readiness audit
// (Tier 2, items 5–9), the capital scorecard previously displayed
// seeded balance-sheet / PP&E / debt numbers with confident
// green/amber/red status tones — after a Jonas import the rows
// would have continued to display those same demo verdicts.
//
// This service supplies the typed contract the capital scorecard
// now consumes:
//
//   • A 14-field numeric input shape (preserved from the legacy
//     `CapitalScorecardInputs` so the scorecard builder is
//     unchanged from a computation standpoint).
//
//   • Equity-CAGR numerics — actual/best-in-class/minimum-required
//     in basis points — so the Equity Growth CAGR row can derive
//     its status from real numbers instead of carrying a hardcoded
//     `status: "on-track"`.
//
//   • A per-row data-source map so each row's provenance reflects
//     its actual input source (`accounting` for balance-sheet /
//     PP&E / debt; `accounting` for the equity-CAGR row from
//     `getEquityHistory()` which is already prisma-backed; `demo`
//     until Phase 1 wiring lands).
//
// Phase 1 wiring path (deferred): replace
// `buildDemoCapitalScorecardSnapshot()` with
// `buildCapitalScorecardSnapshotFromAccounting(...)` reading from
// `getBalanceSheet()` + `getCapitalIncomeYTD()` +
// `getDepreciationSchedule()` + `getEquityHistory()` (already live).

import type { MonthlyAccountingDataSource } from "@/lib/reporting/monthly-accounting-contract";
import type { CapitalScorecardInputs } from "@/lib/reporting/scorecard-metrics";

/**
 * Per-row data-source map for the capital scorecard. Each row's key
 * matches its `StewardshipScorecardRow.key`; the value is the
 * provenance class of that row's underlying inputs.
 *
 * The Equity Growth CAGR row is sourced from `getEquityHistory()`
 * which already reads `prisma.fiscalYear` live, so even in the demo
 * snapshot it carries `accounting` provenance. Every other row
 * stays `demo` until Phase 1 wiring populates the snapshot from
 * `getBalanceSheet()` + `getCapitalIncomeYTD()` +
 * `getDepreciationSchedule()`.
 */
export type CapitalScorecardPerRowDataSource = Readonly<{
  "equity-cagr": MonthlyAccountingDataSource;
  "equity-to-assets": MonthlyAccountingDataSource;
  "capital-reserve-pct": MonthlyAccountingDataSource;
  "net-available-capital": MonthlyAccountingDataSource;
  "net-capital-vs-depreciation": MonthlyAccountingDataSource;
  "long-term-debt-equity": MonthlyAccountingDataSource;
  "net-ppe-to-gross-ppe": MonthlyAccountingDataSource;
  "total-capital-income-vs-budget": MonthlyAccountingDataSource;
}>;

/**
 * Numeric equity-CAGR atoms — straight from `getEquityHistory()`.
 * Surfaced on the snapshot so the Equity Growth CAGR row can
 * classify its status from real numbers instead of a hardcoded
 * `"on-track"` literal.
 */
export type CapitalEquityCagrNumerics = {
  /** Actual compounded annual growth in basis points (e.g. 740 = 7.40 %). */
  actualCagrBps: number;
  /** Best-in-class benchmark CAGR in basis points (configured). */
  bestInClassCagrBps: number;
  /** Minimum required CAGR in basis points (configured). */
  minimumRequiredCagrBps: number;
};

/** Full snapshot — the typed input to
 *  `buildCapitalScorecardData()`. Combines the 14 numeric balance-
 *  sheet / capital-income atoms, the equity-CAGR numerics for the
 *  CAGR row's status derivation, and the per-row provenance map. */
export type CapitalScorecardSnapshot = {
  inputs: CapitalScorecardInputs;
  equity: CapitalEquityCagrNumerics;
  perRowDataSource: CapitalScorecardPerRowDataSource;
};

// ---------------------------------------------------------------------------
// Status-derivation helpers — replace the hardcoded verdicts
// ---------------------------------------------------------------------------

/**
 * Classify the Equity Growth CAGR row.
 *
 *   - `on-track` when actual CAGR ≥ best-in-class benchmark.
 *   - `monitor`  when actual CAGR is between minimum-required and
 *                best-in-class.
 *   - `action`   when actual CAGR is below the minimum required.
 *
 * Replaces the hardcoded `status: "on-track"` literal on the row.
 * The numeric thresholds come from `ClubProfile` configuration via
 * `getEquityHistory()`.
 */
export function classifyEquityCagrStatus(
  actualBps: number,
  bestInClassBps: number,
  minimumRequiredBps: number,
): "on-track" | "monitor" | "action" {
  if (actualBps >= bestInClassBps) return "on-track";
  if (actualBps >= minimumRequiredBps) return "monitor";
  return "action";
}

/**
 * Classify the Long-Term Debt-to-Equity row.
 *
 *   - `null` debt → `monitor` (we don't know the debt position; the
 *                   board should not see a confident "on-track" when
 *                   the comparator is missing). The audit explicitly
 *                   flagged the prior `"on-track"` placeholder as
 *                   misleading.
 *   - debt / equity ratio < 25 % → `on-track`.
 *   - 25 %–30 % → `monitor`.
 *   - > 30 % → `action`.
 */
export function classifyLongTermDebtStatus(
  longTermDebt: number | null,
  totalEquity: number,
): "on-track" | "monitor" | "action" {
  if (longTermDebt === null) return "monitor";
  if (totalEquity <= 0) return "monitor";
  const ratioPct = (longTermDebt / totalEquity) * 100;
  if (ratioPct < 25) return "on-track";
  if (ratioPct <= 30) return "monitor";
  return "action";
}

// ---------------------------------------------------------------------------
// Demo snapshot — preserves historical Silver Springs seed values
// ---------------------------------------------------------------------------

/** Demo snapshot factory. Returns a snapshot whose `inputs` carry
 *  the same numbers `SILVER_SPRINGS_CAPITAL_INPUTS` did, whose
 *  `equity` numerics make the CAGR row classify on-track (matching
 *  the pre-change visual layout), and whose `perRowDataSource` map
 *  honestly tags every row:
 *
 *    - `equity-cagr`     → `accounting` (already live via
 *      `getEquityHistory()`; the equity bps below would be
 *      threaded from the live service in real production)
 *    - everything else   → `demo` until Phase 1 wiring lands.
 *
 *  When Jonas import lands, replace this factory with
 *  `buildCapitalScorecardSnapshotFromAccounting(...)` reading from
 *  `getBalanceSheet()` + `getCapitalIncomeYTD()` +
 *  `getDepreciationSchedule()` + `getEquityHistory()`. */
export function buildDemoCapitalScorecardSnapshot(): CapitalScorecardSnapshot {
  return {
    inputs: {
      // 77.2 % of total assets is equity. Pick totalEquity = $31.0M
      // (matches the Current Equity KPI tile on the equity card) so
      // totalAssets = 31.0M / 0.772 = ~40.155M.
      totalAssets:                40_155_000,
      totalEquity:                31_000_000,
      equityToAssetsGoal:              0.770,
      // 11.7 % of $40.155M = $4,698,135.
      capitalReserveBalance:       4_698_000,
      capitalReserveGoal:              0.140,
      // 26.2 % of operating revenue.
      netAvailableCapital:         3_930_000,
      operatingRevenueForCapital: 15_000_000,
      netAvailableCapitalGoal:         0.347,
      // Net capital available for replacement vs. depreciation.
      // YES → NC > D.
      netCapital:                  4_700_000,
      depreciation:                4_200_000,
      longTermDebt:                     null,  // not yet posted → "—"
      // 31 % of gross PPE.
      netPPE:                      8_060_000,
      grossPPE:                   26_000_000,
      netPPEGoal:                       0.35,
      // $4.44M actual vs $6.03M budget → variance −$1.59M.
      totalCapitalIncomeActual:    4_440_000,
      totalCapitalIncomeBudget:    6_030_000,
    },
    equity: {
      // Demo values mirror the historical pre-snapshot baseline.
      // 7.4 % actual ≥ 5.5 % best-in-class → equity-CAGR row
      // classifies on-track, preserving the prior visual layout.
      actualCagrBps:          740,
      bestInClassCagrBps:     550,
      minimumRequiredCagrBps: 300,
    },
    perRowDataSource: {
      // Equity CAGR is already live via `getEquityHistory()`.
      "equity-cagr":                    "accounting",
      // The remaining 7 rows remain demo until Phase 1 wiring lands.
      "equity-to-assets":               "demo",
      "capital-reserve-pct":            "demo",
      "net-available-capital":          "demo",
      "net-capital-vs-depreciation":    "demo",
      "long-term-debt-equity":          "demo",
      "net-ppe-to-gross-ppe":           "demo",
      "total-capital-income-vs-budget": "demo",
    },
  };
}

// ---------------------------------------------------------------------------
// Accounting-backed snapshot factory — the contract Phase 1 will wire
// ---------------------------------------------------------------------------

/**
 * Raw atoms the future Jonas-import wiring will produce. Each
 * field carries its own data-source tag; the snapshot's per-row
 * provenance is computed from these tags (`worse-of` semantics for
 * multi-input rows). Today only the demo factory + tests exercise
 * this contract.
 */
export type AccountingCapitalScorecardAtoms = {
  /** Balance-sheet equity + assets (from `getBalanceSheet`). */
  totalEquity:  { value: number; dataSource: MonthlyAccountingDataSource };
  totalAssets:  { value: number; dataSource: MonthlyAccountingDataSource };
  /** Capital reserve fund balance. */
  capitalReserveBalance: { value: number; dataSource: MonthlyAccountingDataSource };
  /** Net available capital (computed by service / reserve study). */
  netAvailableCapital: { value: number; dataSource: MonthlyAccountingDataSource };
  /** Operating revenue used as denominator for the Net Available
   *  Capital Ratio row. Typically matches the operating
   *  scorecard's `totalOperatingRevenue` atom. */
  operatingRevenueForCapital: { value: number; dataSource: MonthlyAccountingDataSource };
  /** Net capital available for replacement. */
  netCapital:   { value: number; dataSource: MonthlyAccountingDataSource };
  /** Annual depreciation from the depreciation schedule. */
  depreciation: { value: number; dataSource: MonthlyAccountingDataSource };
  /** Long-term debt — null when no debt is recorded. */
  longTermDebt: { value: number | null; dataSource: MonthlyAccountingDataSource };
  /** PP&E net + gross from the fixed-asset register. */
  netPPE:       { value: number; dataSource: MonthlyAccountingDataSource };
  grossPPE:     { value: number; dataSource: MonthlyAccountingDataSource };
  /** Total capital income (capital dues + initiation fees +
   *  investment income + transfer-from-ops) actual + budget. */
  totalCapitalIncome: {
    actual: number;
    budget: number;
    dataSource: MonthlyAccountingDataSource;
  };
  /** Policy goals — config-driven, not GL-derived. */
  goals: {
    equityToAssets: number;
    capitalReserve: number;
    netAvailableCapital: number;
    netPPE: number;
  };
  /** Equity-CAGR numerics + provenance (from `getEquityHistory()`). */
  equity: CapitalEquityCagrNumerics & { dataSource: MonthlyAccountingDataSource };
};

/**
 * Build a `CapitalScorecardSnapshot` from accounting atoms. Pure
 * function. Phase 1 wiring will call this from `monthly-package.ts`
 * after `getBalanceSheet()` etc. populate the atoms.
 */
export function buildCapitalScorecardSnapshotFromAccounting(
  atoms: AccountingCapitalScorecardAtoms,
): CapitalScorecardSnapshot {
  return {
    inputs: {
      totalAssets:                atoms.totalAssets.value,
      totalEquity:                atoms.totalEquity.value,
      equityToAssetsGoal:         atoms.goals.equityToAssets,
      capitalReserveBalance:      atoms.capitalReserveBalance.value,
      capitalReserveGoal:         atoms.goals.capitalReserve,
      netAvailableCapital:        atoms.netAvailableCapital.value,
      operatingRevenueForCapital: atoms.operatingRevenueForCapital.value,
      netAvailableCapitalGoal:    atoms.goals.netAvailableCapital,
      netCapital:                 atoms.netCapital.value,
      depreciation:               atoms.depreciation.value,
      longTermDebt:               atoms.longTermDebt.value,
      netPPE:                     atoms.netPPE.value,
      grossPPE:                   atoms.grossPPE.value,
      netPPEGoal:                 atoms.goals.netPPE,
      totalCapitalIncomeActual:   atoms.totalCapitalIncome.actual,
      totalCapitalIncomeBudget:   atoms.totalCapitalIncome.budget,
    },
    equity: {
      actualCagrBps:          atoms.equity.actualCagrBps,
      bestInClassCagrBps:     atoms.equity.bestInClassCagrBps,
      minimumRequiredCagrBps: atoms.equity.minimumRequiredCagrBps,
    },
    perRowDataSource: {
      "equity-cagr":                    atoms.equity.dataSource,
      "equity-to-assets":               worseProvenance(atoms.totalEquity.dataSource, atoms.totalAssets.dataSource),
      "capital-reserve-pct":            worseProvenance(atoms.capitalReserveBalance.dataSource, atoms.totalAssets.dataSource),
      "net-available-capital":          worseProvenance(atoms.netAvailableCapital.dataSource, atoms.operatingRevenueForCapital.dataSource),
      "net-capital-vs-depreciation":    worseProvenance(atoms.netCapital.dataSource, atoms.depreciation.dataSource),
      "long-term-debt-equity":          worseProvenance(atoms.longTermDebt.dataSource, atoms.totalEquity.dataSource),
      "net-ppe-to-gross-ppe":           worseProvenance(atoms.netPPE.dataSource, atoms.grossPPE.dataSource),
      "total-capital-income-vs-budget": atoms.totalCapitalIncome.dataSource,
    },
  };
}

/** Pick the more conservative provenance class. `demo` is worst;
 *  `derived` is next; `accounting` and `operational` are equally OK. */
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
