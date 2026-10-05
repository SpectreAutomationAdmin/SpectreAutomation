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
// CAPITAL-LIVE-1 (2026-10-05) — Section V now consumes the canonical
// period-aware FS-Group projection + availability signals so Section
// V = Section IV + Section III to the penny and missing sources are
// precisely unavailable (not silently zero).
import {
  findFsGroupRow,
  type FsGroupProjection,
  type FsGroupProjectionRow,
} from "@/lib/reporting/fs-group-projection";

/** CAPITAL-LIVE-1 helper — pulls the full-year Budget total from a
 *  projection group. Safe for null/undefined. */
function sumAnnualBudget(group: FsGroupProjectionRow | undefined): number {
  return group?.annualBudget ?? 0;
}

/** CAPITAL-LIVE-1 (2026-10-05) — availability signals Section V reads
 *  so missing sources NEVER collapse to zero. */
export type CapitalFundAvailabilityInputs = {
  /** True when the loaded Budget source carries capital-fund revenue
   *  budget lines. Audited at monthly-package call site from
   *  resolveBudget.byAccount. */
  capitalBudgetConnected: boolean;
  /** True when a Reserve Study integration provides authoritative
   *  Reserve Fund Balance / Total Asset Replacement Cost / Deferred
   *  Capital Liability / Annual Reserve Contribution. */
  reserveStudyConnected: boolean;
  /** True when a Capital Projects tracker provides authoritative
   *  Deployed-YTD actuals for Replacements / Improvements /
   *  Enhancements. */
  capitalProjectsConnected: boolean;
  /** True when the Balance Sheet classifies PP&E as two distinct FS
   *  Groups (BS_PPE_GROSS + BS_PPE_ACCUMULATED_DEPRECIATION or
   *  equivalent `category === "ppe-gross"` and
   *  `category === "ppe-accumulated-depreciation"`). Coulee's current
   *  COA puts both into one BS_CAPITAL_ASSETS fsGroup, so this is
   *  false — Net-to-Gross PP&E renders unavailable. */
  ppeSplitAvailable: boolean;
  /** True when an authoritative debt-service account / classification
   *  exists (e.g. a dedicated fsGroup like BS_LONG_TERM_DEBT_SERVICE,
   *  or a GL account tagged "debt-service"). Coulee has neither;
   *  Debt Service renders unavailable. */
  debtServiceSourceConnected: boolean;
  /** True when an authoritative Transfer-from-Operations account /
   *  classification exists (e.g. a Reserve Contribution account
   *  on the Capital side funded by an inter-fund transfer from
   *  Operations). Coulee has none; Transfer from Operations renders
   *  unavailable (NOT a residual catch-all). */
  transferFromOpsSourceConnected: boolean;
};

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

/** TB-HIST-2 (2026-10-01) — zeroed auxiliary input for tenants
 *  without a Budget / Reserve Study / Capital Project importer wired.
 *  Downstream views render blank-equivalent budget columns and
 *  "— unavailable —" where applicable. */
export const EMPTY_CAPITAL_FUND_AUXILIARY_INPUTS: CapitalFundAuxiliaryInputs = {
  annualBudgets: {
    capitalDues: 0,
    initiationFees: 0,
    investmentIncome: 0,
    transferFromOps: null,
    replacements: 0,
    improvements: 0,
    enhancements: 0,
    debtService: 0,
  },
  deployedYtd: { replacements: 0, improvements: 0, enhancements: 0 },
  totalAssetReplacementCost: 0,
  deferredCapitalLiability: 0,
  contribution: { annual: 0, ytdTarget: 0, ytdActual: 0 },
  labels: { facBenchmark: "", threeYearGoal: "" },
  stressTest: { initiationFeeDeclinePct: 0 },
  inlineCommentary: { initiationFees: "" },
};

// ---------------------------------------------------------------------------
// Dual-read entry point
// ---------------------------------------------------------------------------

export async function getCapitalFundForClub(args: {
  clubId: string;
  clubName: string;
  period: ReportingPeriod;
  ledger: ReportingLedger & ReportingLedgerWriter;
  // TB-HIST-2 (2026-10-01) — optional on tenants with real data.
  auxiliaryInputs?: CapitalFundAuxiliaryInputs;
  /** CAPITAL-LIVE-1 (2026-10-05) — canonical period-aware FS-Group
   *  projection. When provided (live tenants), Section V consumes
   *  Capital Revenue + per-group + per-account amounts from this
   *  authoritative source so Section V = Section IV = Section III
   *  to the penny. */
  projection: FsGroupProjection | null;
  /** CAPITAL-LIVE-1 availability signals — see type doc. Null for
   *  demo tenants. */
  availability: CapitalFundAvailabilityInputs | null;
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
      auxiliaryInputs: args.auxiliaryInputs ?? EMPTY_CAPITAL_FUND_AUXILIARY_INPUTS,
      projection: args.projection,
      availability: args.availability,
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
  /** CAPITAL-LIVE-1 §3 — when supplied, Section V consumes the
   *  canonical FS-Group projection (same source Section IV + III
   *  consume). */
  projection?: FsGroupProjection | null;
  /** CAPITAL-LIVE-1 §4-9 — availability signals; null for demo. */
  availability?: CapitalFundAvailabilityInputs | null;
}): CapitalFundStatement {
  const { bs, is, auxiliaryInputs: aux } = args;
  const projection = args.projection ?? null;
  const availability = args.availability ?? null;

  // CAPITAL-LIVE-1 §3 — Capital revenue line classification is now
  // fsGroupKey-driven when the projection is available:
  //   IS_ENTRANCE_FEES       → Initiation Fees row
  //   IS_CAPITAL_ASSESSMENTS → Capital Dues row (Coulee: 0 accounts)
  //   IS_INTEREST_INCOME     → Investment Income row (capital subset)
  //   Transfer from Operations → unavailable unless an authoritative
  //                              transferFromOpsSourceConnected signal
  //                              is true (Coulee: false)
  //   Everything else capital-tagged → "Other Capital Revenue" row
  //                                    (explicit catch-all; the
  //                                    directive forbids residuals
  //                                    masquerading as transfers)
  const useProjection = Boolean(projection && availability);
  const findRow = (key: string) =>
    projection ? findFsGroupRow(projection, key) : undefined;

  const initiationFeesYtd = useProjection
    ? (findRow("IS_ENTRANCE_FEES")?.ytdActual ?? 0)
    : sumByPattern(
        is.lines.filter((l) => l.category === "revenue" && l.fund === "capital"),
        /initiation/i,
      );
  const initiationFeesBudgetFY = useProjection && availability!.capitalBudgetConnected
    ? sumAnnualBudget(findRow("IS_ENTRANCE_FEES"))
    : null;

  // Capital Dues — IS_CAPITAL_ASSESSMENTS fsGroup. 0 accounts on
  // Coulee's COA so the row renders $0 actual / $0 budget — which
  // IS the real zero (no accounts classified there), not source-not-
  // connected.
  const capitalDuesRow = findRow("IS_CAPITAL_ASSESSMENTS");
  const capitalDuesYtd = useProjection
    ? (capitalDuesRow?.ytdActual ?? 0)
    : sumByPattern(
        is.lines.filter((l) => l.category === "revenue" && l.fund === "capital"),
        /capital dues/i,
      );
  const capitalDuesBudgetFY = useProjection && availability!.capitalBudgetConnected
    ? sumAnnualBudget(capitalDuesRow)
    : null;

  // Investment Income on Reserve Fund — IS_INTEREST_INCOME on the
  // capital side. Coulee: 0 operating-side and no explicit capital-
  // interest fsGroup account → render null (SOURCE_NOT_CONNECTED).
  const investmentIncomeRow = findRow("IS_INTEREST_INCOME");
  const investmentIncomeYtd = useProjection
    ? (investmentIncomeRow?.ytdActual ?? null)
    : sumByPattern(
        is.lines.filter((l) => l.category === "revenue" && l.fund === "capital"),
        /investment/i,
      );
  const investmentIncomeBudgetFY = useProjection && availability!.capitalBudgetConnected
    ? (investmentIncomeRow ? sumAnnualBudget(investmentIncomeRow) : null)
    : null;

  // CAPITAL-LIVE-1 §4 — Transfer from Operations: must be an
  // authoritative classified fund-transfer source. Coulee has none;
  // render as SOURCE_NOT_CONNECTED. NEVER a residual catch-all.
  const transferFromOpsYtd = useProjection
    ? (availability!.transferFromOpsSourceConnected ? 0 : null)
    : (() => {
        // Demo path only — keep the historical regex behavior for
        // Silver Springs test data.
        const other = is.lines
          .filter((l) => l.category === "revenue" && l.fund === "capital")
          .filter(
            (l) =>
              !/capital dues/i.test(l.accountName) &&
              !/initiation/i.test(l.accountName) &&
              !/investment/i.test(l.accountName),
          )
          .reduce((s, l) => s + l.amount, 0);
        return other > 0 ? other : null;
      })();
  const transferFromOpsBudgetFY = null; // never from residual math

  // CAPITAL-LIVE-1 §3 — Other Capital Revenue: canonical catch-all
  // for CAPITAL-tagged accounts whose fsGroup isn't IS_ENTRANCE_FEES
  // / IS_CAPITAL_ASSESSMENTS / IS_INTEREST_INCOME. For Coulee this
  // row captures 4086 Share Transfer Fee + 4087 Share Redemption +
  // 4090 Facility Improvement Fee + 7000 LRP Capital Improvement
  // Dues + 7100 Interest Income so Total Capital Sources reconciles
  // exactly to Section IV's Capital Revenue subtotal.
  let otherCapitalRevenueYtd: number | null = null;
  let otherCapitalRevenueBudgetFY: number | null = null;
  if (useProjection && projection) {
    const otherGroups = projection.capitalRevenue.filter(
      (g) =>
        g.fsGroupKey !== "IS_ENTRANCE_FEES" &&
        g.fsGroupKey !== "IS_CAPITAL_ASSESSMENTS" &&
        g.fsGroupKey !== "IS_INTEREST_INCOME",
    );
    otherCapitalRevenueYtd = otherGroups.reduce((s, g) => s + g.ytdActual, 0);
    otherCapitalRevenueBudgetFY = availability!.capitalBudgetConnected
      ? otherGroups.reduce((s, g) => s + sumAnnualBudget(g), 0)
      : null;
  }

  // CAPITAL-LIVE-1 §3 — Total Capital Sources = canonical
  // projection.totals.capitalRevenue.ytdActual (same source Section IV
  // uses). Guarantees Section V = Section IV parity. Falls back to
  // the summed classified rows on the demo path.
  const totalCapitalSourcesYtd = useProjection && projection
    ? projection.totals.capitalRevenue.ytdActual
    : capitalDuesYtd +
      initiationFeesYtd +
      (investmentIncomeYtd ?? 0) +
      (transferFromOpsYtd ?? 0);
  const totalCapitalSourcesAnnual = useProjection && projection
    ? (availability!.capitalBudgetConnected
        ? projection.capitalRevenue.reduce((s, g) => s + sumAnnualBudget(g), 0)
        : null)
    : aux.annualBudgets.capitalDues +
      aux.annualBudgets.initiationFees +
      aux.annualBudgets.investmentIncome +
      (aux.annualBudgets.transferFromOps ?? 0);

  // CAPITAL-LIVE-1 §8 — Debt Service: authoritative only if a
  // dedicated debt-service source is connected. Coulee has no such
  // source; render as unavailable (null). Demo path keeps the
  // historical regex behavior for Silver Springs.
  const debtServiceYtd = useProjection
    ? (availability!.debtServiceSourceConnected ? 0 : null)
    : sumByPattern(
        is.lines.filter((l) => l.category === "expense" && l.fund === "capital"),
        /interest|debt/i,
      );
  const debtServiceBudgetFY = useProjection
    ? (availability!.debtServiceSourceConnected && availability!.capitalBudgetConnected ? 0 : null)
    : aux.annualBudgets.debtService;

  // CAPITAL-LIVE-1 — Deployed-YTD rows render unavailable when
  // Capital Projects tracker isn't connected.
  const projectsConnected = availability?.capitalProjectsConnected ?? !useProjection;
  const replacementsYtd = projectsConnected ? aux.deployedYtd.replacements : null;
  const replacementsBudgetFY = projectsConnected && (availability?.capitalBudgetConnected ?? true)
    ? aux.annualBudgets.replacements
    : null;
  const improvementsYtd = projectsConnected ? aux.deployedYtd.improvements : null;
  const improvementsBudgetFY = projectsConnected && (availability?.capitalBudgetConnected ?? true)
    ? aux.annualBudgets.improvements
    : null;
  const enhancementsYtd = projectsConnected ? aux.deployedYtd.enhancements : null;
  const enhancementsBudgetFY = projectsConnected && (availability?.capitalBudgetConnected ?? true)
    ? aux.annualBudgets.enhancements
    : null;

  // Deployed totals — null if ANY component is unavailable (we don't
  // sum nulls as zeros).
  const totalCapitalDeployedYtd =
    replacementsYtd === null || improvementsYtd === null ||
    enhancementsYtd === null || debtServiceYtd === null
      ? null
      : replacementsYtd + improvementsYtd + enhancementsYtd + debtServiceYtd;
  const totalCapitalDeployedAnnual =
    replacementsBudgetFY === null || improvementsBudgetFY === null ||
    enhancementsBudgetFY === null || debtServiceBudgetFY === null
      ? null
      : replacementsBudgetFY + improvementsBudgetFY + enhancementsBudgetFY + debtServiceBudgetFY;

  const netPositionAnnual =
    totalCapitalSourcesAnnual === null || totalCapitalDeployedAnnual === null
      ? null
      : totalCapitalSourcesAnnual - totalCapitalDeployedAnnual;
  const netPositionYtd =
    totalCapitalDeployedYtd === null ? null : totalCapitalSourcesYtd - totalCapitalDeployedYtd;
  const netCapitalIncomeAnnual =
    totalCapitalSourcesAnnual === null || debtServiceBudgetFY === null
      ? null
      : totalCapitalSourcesAnnual - debtServiceBudgetFY;
  const netCapitalIncomeYtd =
    debtServiceYtd === null ? null : totalCapitalSourcesYtd - debtServiceYtd;

  const rows: CapitalFundRow[] = [
    { key: "band-sources", kind: "section-band", label: "Sources of Capital" },
    {
      key: "capital-dues",
      kind: "detail",
      label: "Capital Dues — Monthly Assessment",
      values: rowValues(capitalDuesBudgetFY ?? (useProjection ? null : aux.annualBudgets.capitalDues), capitalDuesYtd),
    },
    {
      key: "initiation-fees",
      kind: "detail",
      label: "Initiation Fees — New Memberships",
      values: rowValues(initiationFeesBudgetFY ?? (useProjection ? null : aux.annualBudgets.initiationFees), initiationFeesYtd),
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
      values: rowValues(investmentIncomeBudgetFY ?? (useProjection ? null : aux.annualBudgets.investmentIncome), investmentIncomeYtd),
    },
    {
      key: "transfer-from-ops",
      kind: "detail",
      label: "Transfer from Operations (Surplus)",
      values: rowValues(transferFromOpsBudgetFY ?? (useProjection ? null : (aux.annualBudgets.transferFromOps ?? null)), transferFromOpsYtd),
    },
    // CAPITAL-LIVE-1 §3 — Other Capital Revenue: canonical catch-all
    // for CAPITAL-tagged accounts whose fsGroup isn't one of the
    // three above. Preserves parity with Section IV without
    // misclassifying residual activity as a "transfer".
    ...(useProjection
      ? [{
          key: "other-capital-revenue",
          kind: "detail" as const,
          label: "Other Capital Revenue",
          values: rowValues(otherCapitalRevenueBudgetFY, otherCapitalRevenueYtd),
        }]
      : []),
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
      values: rowValues(replacementsBudgetFY, replacementsYtd),
    },
    {
      key: "improvements",
      kind: "detail",
      label: "Improvements — Facility Upgrades",
      values: rowValues(improvementsBudgetFY, improvementsYtd),
    },
    {
      key: "enhancements",
      kind: "detail",
      label: "Enhancements — Committee Projects",
      values: rowValues(enhancementsBudgetFY, enhancementsYtd),
    },
    {
      key: "debt-service",
      kind: "detail",
      label: "Debt Service — Long-Term Note",
      values: rowValues(debtServiceBudgetFY, debtServiceYtd),
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
        annualBudget: debtServiceBudgetFY === null ? null : -debtServiceBudgetFY,
        ytdActual: debtServiceYtd === null ? null : -debtServiceYtd,
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

  // ---- CAPITAL-LIVE-1 §5-7 — Reserve coverage + reserve adequacy
  // obey source availability. When Reserve Study is not connected,
  // every reserve-dependent metric renders precisely unavailable —
  // not zero. ----
  const reserveStudyOn = availability?.reserveStudyConnected ?? !useProjection;

  // Reserve Fund Balance — on the demo path, derive from BS
  // capital-fund-asset "reserve" lines. On the live path, require a
  // Reserve Study connection (Coulee has BS_CAPITAL_RESERVE fsGroup
  // but no committed balance from a Reserve Study importer; the
  // directive forbids inferring from unrelated cash accounts).
  const reserveFundBalance: number | null = useProjection
    ? (reserveStudyOn
        ? bs.lines
            .filter((l) => l.category === "capital-fund-asset" && l.fund === "reserve")
            .reduce((s, l) => s + l.amount, 0)
        : null)
    : (() => {
        const r = bs.lines.filter((l) => l.category === "capital-fund-asset" && l.fund === "reserve");
        return r.length > 0
          ? r.reduce((s, l) => s + l.amount, 0)
          : bs.lines.filter((l) => l.category === "capital-fund-asset").reduce((s, l) => s + l.amount, 0);
      })();

  const reserveCoveragePct: number | null =
    reserveStudyOn && reserveFundBalance != null && aux.totalAssetReplacementCost > 0
      ? reserveFundBalance / aux.totalAssetReplacementCost
      : null;

  const reserveCoverage: CapitalFundReserveCoverage = {
    currentPct: reserveCoveragePct ?? 0,
    currentPctLabel: reserveCoveragePct == null ? "—" : `${(reserveCoveragePct * 100).toFixed(0)}%`,
    facBenchmarkLabel: aux.labels.facBenchmark,
    threeYearGoalLabel: aux.labels.threeYearGoal,
    reserveBalanceLabel: reserveFundBalance == null
      ? "Reserve Study not connected"
      : `Reserve Balance: $${(reserveFundBalance / 1_000_000).toFixed(2)}M`,
    markers: [
      { pct: 0.00, label: "0%" },
      { pct: 0.30, label: "30%" },
      { pct: 0.60, label: "60% ← target" },
      { pct: 0.75, label: "75% 3yr" },
      { pct: 1.00, label: "100%" },
    ],
  };

  // CAPITAL-LIVE-1 §7 — Net-to-Gross PP&E ratio. Coulee's BS carries
  // PP&E as one BS_CAPITAL_ASSETS fsGroup mixing original cost +
  // accumulated depreciation. The current category === "ppe-gross" /
  // "ppe-accumulated-depreciation" filter never matches so this
  // ratio has rendered as 0% (wrong). Render unavailable when the
  // availability signal says the split isn't present.
  const ppeSplitOn = availability?.ppeSplitAvailable ?? !useProjection;
  const grossPpe = bs.lines.filter((l) => l.category === "ppe-gross").reduce((s, l) => s + l.amount, 0);
  const accumDepr = bs.lines.filter((l) => l.category === "ppe-accumulated-depreciation").reduce((s, l) => s + l.amount, 0);
  const netToGrossPpe: number | null = ppeSplitOn && grossPpe > 0
    ? (grossPpe - accumDepr) / grossPpe
    : null;

  // CAPITAL-LIVE-1 §5 — Reserve adequacy rows render null-aware
  // valueLabel so a disconnected Reserve Study produces "—" + a
  // precise reason, never $0.
  const unavailableValueLabel = (reason: string) => reason;
  const dollarsLabel = (v: number) => `$${Math.round(v).toLocaleString("en-US")}`;
  const reserveAdequacy: CapitalFundAdequacyRow[] = [
    {
      key: "reserve-balance",
      label: "Reserve Fund Balance",
      valueLabel: reserveFundBalance == null ? unavailableValueLabel("—") : dollarsLabel(reserveFundBalance),
      tone: "neutral",
    },
    {
      key: "asset-replacement-cost",
      label: "Total Asset Replacement Cost",
      valueLabel: reserveStudyOn ? dollarsLabel(aux.totalAssetReplacementCost) : "—",
      tone: "neutral",
    },
    {
      key: "coverage-ratio",
      label: "Reserve Coverage Ratio",
      valueLabel: reserveCoveragePct == null ? "—" : `${(reserveCoveragePct * 100).toFixed(1)}%`,
      tone: reserveCoveragePct == null ? "neutral" : classifyCoverageTone(reserveCoveragePct),
    },
    {
      key: "deferred-capital",
      label: "Deferred Capital Liability",
      valueLabel: reserveStudyOn ? dollarsLabel(aux.deferredCapitalLiability) : "—",
      tone: reserveStudyOn && aux.deferredCapitalLiability > 0 ? "risk" : "neutral",
    },
    {
      key: "net-to-gross-ppe",
      label: "Net-to-Gross PP&E Ratio",
      valueLabel: netToGrossPpe == null ? "—" : `${(netToGrossPpe * 100).toFixed(0)}%`,
      tone: netToGrossPpe == null ? "neutral" : classifyNetToGrossPpeTone(netToGrossPpe),
    },
    {
      key: "annual-contribution",
      label: "Annual Reserve Contribution",
      valueLabel: reserveStudyOn ? dollarsLabel(aux.contribution.annual) : "—",
      tone: "neutral",
    },
    {
      key: "ytd-contribution",
      label: reserveStudyOn
        ? (aux.contribution.ytdTarget > 0 && aux.contribution.ytdActual >= aux.contribution.ytdTarget * 0.95
            ? "YTD Contribution — On Plan"
            : "YTD Contribution — Behind Plan")
        : "YTD Contribution — Reserve Study not connected",
      valueLabel: reserveStudyOn ? dollarsLabel(aux.contribution.ytdActual) : "—",
      tone: reserveStudyOn
        ? (aux.contribution.ytdTarget > 0 && aux.contribution.ytdActual >= aux.contribution.ytdTarget * 0.95 ? "favorable" : "risk")
        : "neutral",
      checkmark: reserveStudyOn && aux.contribution.ytdTarget > 0 && aux.contribution.ytdActual >= aux.contribution.ytdTarget * 0.95,
    },
  ];

  // CAPITAL-LIVE-1 §9 — Stress-test. Rendered ONLY when every
  // required input is authoritatively available. Else emit a precise
  // availability statement — never fabricated $0 inputs into a
  // Board-recommendation narrative.
  const stressInputsAvailable =
    reserveStudyOn &&
    aux.contribution.annual > 0 &&
    initiationFeesYtd !== 0 &&
    (useProjection
      ? availability!.debtServiceSourceConnected
      : debtServiceYtd !== 0);

  let stressTest: CapitalFundStressTest;
  if (stressInputsAvailable) {
    const stressInitiationFeesAnnual =
      initiationFeesYtd > 0 ? annualizeFromYtd(initiationFeesYtd, args.period) : aux.annualBudgets.initiationFees;
    const stressCapitalDuesAnnual =
      capitalDuesYtd > 0 ? annualizeFromYtd(capitalDuesYtd, args.period) : aux.annualBudgets.capitalDues;
    const stressDebtServiceAnnual =
      debtServiceYtd !== null && debtServiceYtd > 0
        ? annualizeFromYtd(debtServiceYtd, args.period)
        : aux.annualBudgets.debtService;
    stressTest = buildCapitalStressTestCommentary({
      initiationFeesAnnual: stressInitiationFeesAnnual,
      capitalDuesAnnual: stressCapitalDuesAnnual,
      initiationFeeDeclinePct: aux.stressTest.initiationFeeDeclinePct,
      requiredAnnualReserveContribution: aux.contribution.annual,
      annualDebtService: stressDebtServiceAnnual ?? 0,
    });
  } else {
    stressTest = {
      eyebrow: "Capital Stress Test",
      body:
        "Stress-test unavailable — this analysis requires an authoritative Reserve Study (annual required contribution + total asset replacement cost) and a connected debt-service source. Those inputs are not yet integrated for this tenant, so the model cannot produce a Board-grade shortfall calculation.",
    };
  }

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
