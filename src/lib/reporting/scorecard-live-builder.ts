// SCORECARD-PARTIAL-1 §6-21 (2026-10-04) — live-tenant scorecard
// builders.
//
// The existing `buildOperatingScorecardData` + `buildCapitalScorecardData`
// in `scorecard-metrics.ts` were authored for the demo tenant and bake
// in strict-numeric inputs + classifier calls that evaluate hardcoded
// Silver Springs policy thresholds. On live Coulee tenants where
// most of those inputs are SOURCE_NOT_CONNECTED, running those
// builders would emit "$0 / 0% / Not configured" garbage.
//
// This file is a parallel path for live tenants. It composes rows
// DIRECTLY from the canonical ratio registry (`resolveJanuaryMetricSet`)
// + the canonical Budget resolver (`resolveBudget` /
// `resolveBudgetMonthlyIncomeStatement`), emits nullable row values
// per directive §6-8 (metric-level availability), and skips any
// evaluative status unless an authoritative policy target exists on
// this tenant. Classifier logic is intentionally conservative — no
// status verdict is produced in this slice because Coulee has no
// board-approved policy thresholds configured yet.

import { prisma } from "@/lib/prisma";
import type {
  StewardshipScorecard,
  StewardshipScorecardRow,
  ReportingDataSource,
} from "./monthly-package";
import { resolveJanuaryMetricSet, type JanuaryMetricSet } from "./ratio-registry";
import {
  resolveBudget,
  resolveBudgetIncomeStatement,
} from "./budget-resolver";

type Period = { periodStart: Date; periodEnd: Date; label: string };

/** MBR-FIX-2M (2026-10-11) — ancillary inputs the scorecard builders
 *  need beyond `resolveJanuaryMetricSet` + the Budget resolver.  These
 *  live outside the ratio registry's shape so the caller
 *  (monthly-package.ts) can share the same resolver output already
 *  used by Section III (Stewardship Dashboard) + Section X
 *  (Departmental P&L) without a second DB round-trip per scorecard.
 *
 *  Every field is optional + null-safe: when a field is null, the
 *  scorecard row stays unavailable (never fabricated). */
export type ScorecardLiveAncillary = {
  /** F&B department Net Operating Loss YTD, positive scalar (dollars
   *  absorbed by Operating Dues). Null when the F&B dept has no
   *  committed activity.  Same source Section III Stewardship
   *  Dashboard F&B Subsidy card consumes (MBR-FIX-2J). */
  fbNetOperatingLoss?: number | null;
  /** Operating Membership Dues YTD, positive scalar.  Same source
   *  Section III + the Operating Cost Coverage donut consume. */
  operatingDuesYtd?: number | null;
  /** Total Capital Fund Income YTD, positive scalar.  Sourced from
   *  `FsGroupProjection.totals.capitalRevenue.ytdActual` (sign-flipped
   *  to positive display). Same number Section V renders. */
  capitalIncomeActual?: number | null;
  /** Total Capital Fund Income YTD Budget, positive scalar.  From
   *  `FsGroupProjection.totals.capitalRevenue.ytdBudget`. */
  capitalIncomeBudget?: number | null;
};

/** Formatter helpers — kept local so changes to the demo-tenant
 *  formatters in scorecard-metrics.ts never silently affect live
 *  tenants (demo and live render differently; this preserves parity
 *  with the Spectre voice guide: "$X.XM" / "N.N%"). */
const fmtMillions = (d: number | null): string | null =>
  d == null ? null : d < 0
    ? `($${(Math.abs(d) / 1_000_000).toFixed(2)}M)`
    : `$${(d / 1_000_000).toFixed(2)}M`;
const fmtK = (d: number | null): string | null =>
  d == null ? null : d < 0
    ? `($${Math.round(Math.abs(d) / 1_000).toLocaleString("en-US")}K)`
    : `$${Math.round(d / 1_000).toLocaleString("en-US")}K`;
const fmtPct1 = (n: number | null): string | null =>
  n == null ? null : `${n.toFixed(1)}%`;
const fmtRatio = (r: number | null): string | null =>
  r == null ? null : `${r.toFixed(2)}x`;
const fmtVariancePct = (actual: number | null, budget: number | null): string | null => {
  if (actual == null || budget == null) return null;
  if (budget === 0) return null;
  const varPct = ((actual - budget) / Math.abs(budget)) * 100;
  const sign = varPct >= 0 ? "+" : "";
  return `${sign}${varPct.toFixed(1)}% vs Budget`;
};
const fmtDollarVariance = (actual: number | null, budget: number | null): string | null => {
  if (actual == null || budget == null) return null;
  const d = actual - budget;
  const sign = d >= 0 ? "+" : "";
  return `${sign}${fmtK(d) ?? ""}`;
};

/** Pull a dollar value from a ResolvedMetric that stores a Decimal. */
function dollarsOrNull(m: JanuaryMetricSet[keyof JanuaryMetricSet]): number | null {
  if (m.metric.provenance.availability !== "AVAILABLE") return null;
  const v = m.metric.value;
  if (v == null) return null;
  if (typeof v === "number") return v;
  // Prisma.Decimal exposes toString + toNumber.
  if (typeof (v as { toNumber?: () => number }).toNumber === "function") {
    return (v as { toNumber: () => number }).toNumber();
  }
  const n = Number(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Pull a numeric percent / ratio from a ResolvedMetric that stores
 *  a plain number (percent 0-100 or a ratio). */
function numberOrNull(m: JanuaryMetricSet[keyof JanuaryMetricSet]): number | null {
  if (m.metric.provenance.availability !== "AVAILABLE") return null;
  const v = m.metric.value;
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof (v as { toNumber?: () => number }).toNumber === "function") {
    return (v as { toNumber: () => number }).toNumber();
  }
  const n = Number(String(v));
  return Number.isFinite(n) ? n : null;
}

/** Convenience: data-source tag flows from the metric's availability. */
function provenanceToSource(availability: string): ReportingDataSource {
  return availability === "AVAILABLE" ? "live" : "demo";
}

// ---------------------------------------------------------------------------
// Operating Stewardship — live tenant builder
// ---------------------------------------------------------------------------
//
// Row inventory + source contract (SCORECARD-PARTIAL-1 §10):
//
// | key                          | Actual                      | Budget                              | Target                | Status            |
// |------------------------------|-----------------------------|-------------------------------------|-----------------------|-------------------|
// | dues-to-revenue              | ratio-registry.duesToRevenuePct | duesBudget / revenueBudget via resolveBudget | Not configured    | no verdict        |
// | payroll-ratio                | ratio-registry.payrollRatio | payrollBudget / revenueBudget       | Not configured        | no verdict        |
// | noi-pct-revenue              | metrics.noi / metrics.revenue | noiBudget / revenueBudget          | Not configured        | no verdict        |
// | noi-variance-to-budget       | metrics.noi                 | noi budget via resolveBudgetIS      | Not configured        | no verdict        |
// | initiation-fee-subsidy       | SOURCE_NOT_CONNECTED        | SOURCE_NOT_CONNECTED                | Not configured        | no verdict        |
// | fb-subsidy-pct-dues          | SOURCE_NOT_CONNECTED        | SOURCE_NOT_CONNECTED                | Not configured        | no verdict        |
// | golf-rounds-vs-budget        | SOURCE_NOT_CONNECTED (ops) | SOURCE_NOT_CONNECTED                | Not configured        | no verdict        |
// | fb-covers-vs-budget          | SOURCE_NOT_CONNECTED (ops) | SOURCE_NOT_CONNECTED                | Not configured        | no verdict        |
//
export async function buildOperatingScorecardLive(
  clubId: string,
  period: Period,
  ancillary: ScorecardLiveAncillary = {},
): Promise<StewardshipScorecard> {
  const fiscalYear = period.periodEnd.getUTCFullYear();
  const throughMonth = period.periodEnd.getUTCMonth() + 1;
  const [metrics, budgetIs, budgetDues] = await Promise.all([
    resolveJanuaryMetricSet({
      clubId,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
    }).catch(() => null),
    resolveBudgetIncomeStatement({ clubId, fiscalYear, throughMonth }).catch(() => null),
    (async () => {
      const r = await resolveBudget({ clubId, fiscalYear, throughMonth }).catch(() => null);
      if (!r?.budget) return null;
      let duesDollars = 0;
      let found = false;
      for (const a of r.byAccount) {
        if (a.fsGroupKey === "IS_MEMBERSHIP_DUES") {
          const ytd = a.monthlyTotals.slice(0, throughMonth).reduce((s, v) => s + v, 0);
          duesDollars += -ytd; // display sign-flip (revenue natural = negative)
          found = true;
        }
      }
      return found ? duesDollars : null;
    })(),
  ]);

  const actualDues = metrics ? dollarsOrNull(metrics.duesToRevenuePct) : null; // not applicable — it's a percent
  const actualDuesPct = metrics ? numberOrNull(metrics.duesToRevenuePct) : null;
  const actualPayrollPct = metrics ? numberOrNull(metrics.payrollRatio) : null;
  const actualRevenue = metrics ? dollarsOrNull(metrics.revenue) : null;
  const actualNoi = metrics ? dollarsOrNull(metrics.noi) : null;

  // Budget derivations.
  const budgetRevenue = budgetIs?.revenue ?? null;
  const budgetNoi = budgetIs?.noi ?? null;
  const budgetPayroll = budgetIs?.payroll ?? null;

  // Dues-to-Revenue — Budget uses canonical formula (duesBudget / revenueBudget).
  const budgetDuesToRevenuePct =
    budgetDues != null && budgetRevenue != null && budgetRevenue !== 0
      ? (budgetDues / budgetRevenue) * 100
      : null;
  const budgetPayrollRatioPct =
    budgetPayroll != null && budgetRevenue != null && budgetRevenue !== 0
      ? (budgetPayroll / budgetRevenue) * 100
      : null;
  const budgetNoiPctRevenuePct =
    budgetNoi != null && budgetRevenue != null && budgetRevenue !== 0
      ? (budgetNoi / budgetRevenue) * 100
      : null;
  const actualNoiPctRevenue =
    actualNoi != null && actualRevenue != null && actualRevenue > 0
      ? (actualNoi / actualRevenue) * 100
      : null;

  const dsLive: ReportingDataSource = metrics ? "live" : "demo";

  const rows: StewardshipScorecardRow[] = [
    {
      key: "dues-to-revenue",
      metric: "Dues-to-Revenue Ratio",
      description: "Operating dues as % of operating revenue",
      actual: fmtPct1(actualDuesPct),
      budget: fmtPct1(budgetDuesToRevenuePct),
      benchmark: null, // Target not configured
      status: null,
      dataSource: dsLive,
    },
    {
      key: "payroll-benefits-ratio",
      metric: "Payroll & Benefits Ratio",
      description: "Loaded payroll + benefits as % of operating revenue",
      actual: fmtPct1(actualPayrollPct),
      budget: fmtPct1(budgetPayrollRatioPct),
      benchmark: null,
      status: null,
      dataSource: dsLive,
    },
    {
      key: "noi-pct-revenue",
      metric: "NOI as % of Operating Revenue",
      description: "NOI (before depreciation) ÷ revenue",
      actual: fmtPct1(actualNoiPctRevenue),
      budget: fmtPct1(budgetNoiPctRevenuePct),
      benchmark: null,
      status: null,
      dataSource: dsLive,
    },
    // MBR-FIX-2M (2026-10-11) — "NOI vs Budget" row. Three
    // distinguishable values per the directive §3D:
    //   Actual = NOI YTD (dollars)
    //   Budget = Budget NOI YTD (dollars)
    //   Variance = $ delta (actual − budget), rendered in the
    //              right-most "Variance / Target" column
    // The pre-fix row label "NOI Variance to Budget" conflated the
    // row's purpose with the right-most column's content; renamed
    // to "NOI vs Budget" so Actual / Budget / Variance remain
    // unambiguous when read column-by-column.
    {
      key: "noi-vs-budget",
      metric: "NOI vs Budget",
      description: "NOI YTD (actual) · Budget NOI YTD · Variance",
      actual: fmtMillions(actualNoi),
      budget: fmtMillions(budgetNoi),
      benchmark: fmtDollarVariance(actualNoi, budgetNoi),
      status: null,
      dataSource: dsLive,
    },
    // MBR-FIX-2M §3E (2026-10-11) — Entrance / Initiation Fees are
    // classified entirely within the Capital Fund on Coulee's COA
    // (fsGroupKey=IS_ENTRANCE_FEES → fundApplicability=CAPITAL).
    // Preserve N/A — do NOT reclassify capital income as operating
    // merely to populate the KPI (directive §3E + §5).
    {
      key: "initiation-fee-subsidy",
      metric: "Initiation-Fee Operating Subsidy",
      description: "N/A — entrance fees classified to Capital Fund",
      actual: "N/A",
      budget: null,
      benchmark: null,
      status: null,
      dataSource: dsLive,
    },
    // MBR-FIX-2M §3F (2026-10-11) — F&B Subsidy as % of Dues.
    //   subsidy% = max(0, −F&B Net Operating Result) ÷ Operating
    //              Membership Dues YTD × 100
    // Numerator reconciles to Section X Departmental P&L
    // (committed TB departmental aggregation).  Denominator
    // reconciles to Section IV Statement of Activities + Section III
    // Operating Cost Coverage donut (fsGroupKey=IS_MEMBERSHIP_DUES).
    buildFbSubsidyRow(ancillary.fbNetOperatingLoss, ancillary.operatingDuesYtd, dsLive),
    {
      key: "golf-rounds-vs-budget",
      metric: "Golf Rounds vs Budget",
      description: "Rounds YTD · tee-sheet / POS source not connected",
      actual: null,
      budget: null,
      benchmark: null,
      status: null,
      dataSource: "demo",
    },
    {
      key: "fb-covers-vs-budget",
      metric: "F&B Covers vs Budget",
      description: "Covers YTD · POS source not connected",
      actual: null,
      budget: null,
      benchmark: null,
      status: null,
      dataSource: "demo",
    },
  ];

  return {
    title: "Operating Stewardship — KPI Scorecard",
    subtitle: "IS THE CLUB LIVING WITHIN THE OPERATING PLAN?",
    // MBR-FIX-2M §2 (2026-10-11) — pre-fix band hardcoded
    // "LIVE JANUARY FINANCIAL ROWS · OPERATIONAL + POLICY ROWS
    // AWAIT SOURCE" even for Feb / Mar / later periods. Now
    // period-aware (uses the resolved period label).
    sectionBand: `LIVE ${period.label.toUpperCase()} FINANCIAL ROWS · OPERATIONAL + POLICY ROWS AWAIT SOURCE`,
    columnHeaders: { actual: "Actual", budget: "Budget", benchmark: "Variance / Target" },
    rows,
    dataSource: rows.some((r) => r.dataSource === "live") ? "live" : "demo",
  };
}

/** MBR-FIX-2N §4 (2026-10-11) — F&B Operating Loss as % of Dues row.
 *
 *  Renamed from the pre-fix "F&B Subsidy as % of Dues" per founder
 *  authorization: the word "subsidy" implies a formally approved
 *  allocation of membership dues to departmental operations, which
 *  does NOT exist on Coulee's accounting records.  The calculation
 *  is unchanged — only the label + explanation are corrected to be
 *  financially accurate.
 *
 *  Numerator semantics (directive §4.3): a POSITIVE F&B Net
 *  Operating Result (a surplus) is NOT an operating loss and is not
 *  described as one.  When the department is not in loss, the row
 *  renders "0.0%" (a genuine calculated zero — distinct from an
 *  unavailable state) with a description that names the signed
 *  result accurately. */
function buildFbSubsidyRow(
  fbNetOperatingLoss: number | null | undefined,
  operatingDuesYtd: number | null | undefined,
  dsLive: ReportingDataSource,
): StewardshipScorecardRow {
  const loss = fbNetOperatingLoss ?? null;
  const dues = operatingDuesYtd ?? null;
  if (loss == null || dues == null || dues <= 0) {
    return {
      key: "fb-operating-loss-pct-dues",
      metric: "F&B Operating Loss as % of Dues",
      description: "F&B department net operating loss ÷ Operating Membership Dues YTD",
      actual: null,
      budget: null,
      benchmark: null,
      status: null,
      dataSource: "demo",
    };
  }
  const lossPct = (Math.max(0, loss) / dues) * 100;
  const isSurplus = loss <= 0;
  return {
    key: "fb-operating-loss-pct-dues",
    metric: "F&B Operating Loss as % of Dues",
    description: isSurplus
      ? "F&B department operating at net surplus (no operating loss absorbed by dues)"
      : "F&B department operating loss ÷ Operating Membership Dues YTD (Section X) — not a formal allocation of dues",
    actual: `${lossPct.toFixed(1)}%`,
    budget: null,
    benchmark: null,
    status: null,
    dataSource: dsLive,
  };
}

// ---------------------------------------------------------------------------
// Capital Stewardship — live tenant builder
// ---------------------------------------------------------------------------
//
// Row inventory (SCORECARD-PARTIAL-1 §18-19):
//
// | key                          | Actual                      | Budget                              | Target             | Status      |
// |------------------------------|-----------------------------|-------------------------------------|--------------------|-------------|
// | equity-to-assets             | metrics.membersEquity / metrics.totalAssets | SOURCE_NOT_CONNECTED (op. budget only) | Not configured | no verdict |
// | capital-reserve-pct          | metrics.capitalReserve / metrics.totalAssets| SOURCE_NOT_CONNECTED               | Not configured     | no verdict  |
// | long-term-debt-equity        | metrics.longTermDebtToEquity | SOURCE_NOT_CONNECTED              | Not configured     | no verdict  |
// | net-ppe                      | metrics.netPpe              | SOURCE_NOT_CONNECTED                | Not configured     | no verdict  |
// | capital-assessments-ytd      | metrics.capitalAssessmentsYtd| SOURCE_NOT_CONNECTED               | Not configured     | no verdict  |
// | net-available-capital        | SOURCE_NOT_CONNECTED        | SOURCE_NOT_CONNECTED                | Not configured     | no verdict  |
// | net-capital-vs-depreciation  | SOURCE_NOT_CONNECTED        | SOURCE_NOT_CONNECTED                | Not configured     | no verdict  |
// | total-capital-income-vs-budget| SOURCE_NOT_CONNECTED       | SOURCE_NOT_CONNECTED                | Not configured     | no verdict  |
//
// Capital Budget source is NOT connected — the 2026.csv is operating
// budget only (BUDGET-HIST-1 §R). We render Actuals + "—" / "Not
// configured" per directive §20.
//
export async function buildCapitalScorecardLive(
  clubId: string,
  period: Period,
  ancillary: ScorecardLiveAncillary = {},
): Promise<StewardshipScorecard> {
  const metrics = await resolveJanuaryMetricSet({
    clubId,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
  }).catch(() => null);

  const totalAssets = metrics ? dollarsOrNull(metrics.totalAssets) : null;
  const totalEquity = metrics ? dollarsOrNull(metrics.membersEquity) : null;
  const capitalReserve = metrics ? dollarsOrNull(metrics.capitalReserve) : null;
  const longTermDebt = metrics ? dollarsOrNull(metrics.longTermDebt) : null;
  const ltdToEquity = metrics ? numberOrNull(metrics.longTermDebtToEquity) : null;
  const netPpe = metrics ? dollarsOrNull(metrics.netPpe) : null;
  const capAssessments = metrics ? dollarsOrNull(metrics.capitalAssessmentsYtd) : null;

  const equityToAssetsPct =
    totalEquity != null && totalAssets != null && totalAssets > 0
      ? (totalEquity / totalAssets) * 100
      : null;
  const reserveToAssetsPct =
    capitalReserve != null && totalAssets != null && totalAssets > 0
      ? (capitalReserve / totalAssets) * 100
      : null;

  const dsLive: ReportingDataSource = metrics ? "live" : "demo";

  const rows: StewardshipScorecardRow[] = [
    {
      key: "equity-to-assets",
      metric: "Equity-to-Assets Ratio",
      description: "Member equity ÷ total assets",
      actual: fmtPct1(equityToAssetsPct),
      budget: null,
      benchmark: null,
      status: null,
      dataSource: dsLive,
    },
    {
      key: "capital-reserve-pct",
      metric: "Capital Reserve % of Assets",
      description: "Capital reserve balance ÷ total assets",
      actual: fmtPct1(reserveToAssetsPct),
      budget: null,
      benchmark: null,
      status: null,
      dataSource: dsLive,
    },
    {
      key: "long-term-debt-equity",
      metric: "Long-Term Debt / Equity",
      description: "LTD ÷ member equity",
      actual: fmtRatio(ltdToEquity),
      budget: null,
      benchmark: null,
      status: null,
      dataSource: dsLive,
    },
    {
      key: "net-ppe",
      metric: "Net Property, Plant & Equipment",
      description: "BS carrying value of fixed assets",
      actual: fmtMillions(netPpe),
      budget: null,
      benchmark: null,
      status: null,
      dataSource: dsLive,
    },
    {
      key: "capital-assessments-ytd",
      metric: "Capital Assessments (YTD)",
      description: "Capital-assessment revenue YTD",
      actual: fmtMillions(capAssessments),
      budget: null,
      benchmark: null,
      status: null,
      dataSource: dsLive,
    },
    // MBR-FIX-2N §2 (2026-10-11) — Capital Funding Coverage Ratio.
    //
    // Formula (approved by founder 2026-10-11):
    //   Available Capital Funding ÷ Approved Capital Requirements × 100
    //
    // Required inputs for a defensible calculation:
    //   • Approved capital expenditure plan over a documented
    //     planning horizon (not loaded on Coulee today — no capital-
    //     planning module).
    //   • Approved available capital funding over the SAME horizon,
    //     net of restrictions, double-counts, and undrawn financing
    //     commitments (requires an approved funding source table —
    //     also not loaded today).
    //
    // Per directive §2.4: if the required information is incomplete,
    // do NOT calculate or display a ratio. The KPI stays unavailable
    // with a precise reason and will automatically populate once the
    // approved capital plan + funding sources land. No invented
    // policy threshold.
    {
      key: "capital-funding-coverage",
      metric: "Capital Funding Coverage Ratio",
      description:
        "Available Capital Funding ÷ Approved Capital Requirements. " +
        "Unavailable — Approved capital funding and expenditure plan not fully configured.",
      actual: null,
      budget: null,
      benchmark: null,
      status: null,
      dataSource: "demo",
    },
    // MBR-FIX-2N §3 (2026-10-11) — Capital Reinvestment Ratio.
    //
    // Formula (approved by founder 2026-10-11):
    //   Capital Asset Additions ÷ Depreciation Expense
    //   (trailing 12 months, same window for both)
    //
    // Required inputs:
    //   • Reliable monthly capital asset additions source (actual
    //     recognized additions, not budget, not inferred from net
    //     PP&E balance movement). Not loaded on Coulee today —
    //     no capital-additions ledger / fixed-asset subsidiary.
    //   • 12 consecutive months of depreciation history. Coulee has
    //     3 committed months (Jan + Feb + Mar 2026); 9 months short
    //     of the required window.
    //
    // Per directive §3.4: do NOT manufacture missing months or
    // annualize incomplete data; do NOT infer additions from net
    // PP&E movement. Stay unavailable with the precise reason.
    {
      key: "capital-reinvestment-ratio",
      metric: "Capital Reinvestment Ratio",
      description:
        "Capital Asset Additions ÷ Depreciation Expense (trailing 12 months). " +
        "Unavailable — 12 months of capital additions and depreciation history required.",
      actual: null,
      budget: null,
      benchmark: null,
      status: null,
      dataSource: "demo",
    },
    // MBR-FIX-2M §4H (2026-10-11) — Total Capital Income vs Budget
    // now sources Actual + Budget from the canonical FS-Group
    // projection (same source Section V Capital Fund consumes).  The
    // caller pre-computes both values from `fsGroupProjection.
    // totals.capitalRevenue.ytdActual` + `.ytdBudget` so Section V
    // and this scorecard reconcile byte-for-byte.
    buildCapitalIncomeVsBudgetRow(
      ancillary.capitalIncomeActual,
      ancillary.capitalIncomeBudget,
      dsLive,
    ),
  ];

  return {
    title: "Capital Stewardship — KPI Scorecard",
    subtitle: "IS THE CLUB PROTECTING ITS FUTURE?",
    // MBR-FIX-2M §2 (2026-10-11) — period-aware section band so
    // Feb / Mar / later packages don't display Jan-specific copy.
    sectionBand: `LIVE ${period.label.toUpperCase()} BALANCE-SHEET ROWS · CAPITAL BUDGET + POLICY NOT CONNECTED`,
    columnHeaders: { actual: "Actual", budget: "Budget", benchmark: "Target" },
    rows,
    dataSource: rows.some((r) => r.dataSource === "live") ? "live" : "demo",
  };
}

/** MBR-FIX-2M §4H — Total Capital Income vs Budget row builder.
 *  Three-value shape: Actual YTD (dollars), Budget YTD (dollars),
 *  Variance (dollars) in the right-most column. Keeps nullable
 *  semantics: a null Actual or null Budget renders the row's
 *  unavailable half(s) as "—" rather than $0. */
function buildCapitalIncomeVsBudgetRow(
  actual: number | null | undefined,
  budget: number | null | undefined,
  dsLive: ReportingDataSource,
): StewardshipScorecardRow {
  const a = actual ?? null;
  const b = budget ?? null;
  if (a == null && b == null) {
    return {
      key: "total-capital-income-vs-budget",
      metric: "Total Capital Income vs Budget",
      description: "Capital-income Actual vs Budget YTD",
      actual: null,
      budget: null,
      benchmark: null,
      status: null,
      dataSource: "demo",
    };
  }
  const variance = a != null && b != null ? a - b : null;
  return {
    key: "total-capital-income-vs-budget",
    metric: "Total Capital Income vs Budget",
    description: "Capital-income Actual vs Budget YTD (Section V)",
    actual: fmtMillions(a),
    budget: fmtMillions(b),
    benchmark: variance != null ? fmtDollarVariance(a, b) : null,
    status: null,
    dataSource: dsLive,
  };
}
