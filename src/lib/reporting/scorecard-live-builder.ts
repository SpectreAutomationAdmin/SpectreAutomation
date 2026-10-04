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
    {
      key: "noi-variance-to-budget",
      metric: "NOI Variance to Budget",
      description: "Actual NOI − Budget NOI (mathematical only)",
      actual: fmtMillions(actualNoi),
      budget: fmtMillions(budgetNoi),
      benchmark: fmtDollarVariance(actualNoi, budgetNoi), // variance in the right-most column
      status: null,
      dataSource: dsLive,
    },
    {
      key: "initiation-fee-subsidy",
      metric: "Initiation-Fee Operating Subsidy",
      description: "Initiation-fee dollars left in operating (best: $0)",
      actual: null,
      budget: null,
      benchmark: null,
      status: null,
      dataSource: "demo",
    },
    {
      key: "fb-subsidy-pct-dues",
      metric: "F&B Subsidy as % of Dues",
      description: "Annual F&B operating subsidy ÷ dues",
      actual: null,
      budget: null,
      benchmark: null,
      status: null,
      dataSource: "demo",
    },
    {
      key: "golf-rounds-vs-budget",
      metric: "Golf Rounds vs Budget",
      description: "Annual rounds count (POS source not connected)",
      actual: null,
      budget: null,
      benchmark: null,
      status: null,
      dataSource: "demo",
    },
    {
      key: "fb-covers-vs-budget",
      metric: "F&B Covers vs Budget",
      description: "Annual covers count (POS source not connected)",
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
    sectionBand: "LIVE JANUARY FINANCIAL ROWS · OPERATIONAL + POLICY ROWS AWAIT SOURCE",
    columnHeaders: { actual: "Actual", budget: "Budget", benchmark: "Variance / Target" },
    rows,
    dataSource: rows.some((r) => r.dataSource === "live") ? "live" : "demo",
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
    {
      key: "net-available-capital",
      metric: "Net Available Capital Ratio",
      description: "Net available capital ÷ operating revenue",
      actual: null,
      budget: null,
      benchmark: null,
      status: null,
      dataSource: "demo",
    },
    {
      key: "net-capital-vs-depreciation",
      metric: "Net Capital > Depreciation?",
      description: "Reserve + assessments ≥ annual depreciation",
      actual: null,
      budget: null,
      benchmark: null,
      status: null,
      dataSource: "demo",
    },
    {
      key: "total-capital-income-vs-budget",
      metric: "Total Capital Income vs Budget",
      description: "Capital-income Actual vs Budget",
      actual: null,
      budget: null,
      benchmark: null,
      status: null,
      dataSource: "demo",
    },
  ];

  return {
    title: "Capital Stewardship — KPI Scorecard",
    subtitle: "IS THE CLUB PROTECTING ITS FUTURE?",
    sectionBand: "LIVE BALANCE-SHEET ROWS · CAPITAL BUDGET + POLICY NOT CONNECTED",
    columnHeaders: { actual: "Actual", budget: "Budget", benchmark: "Target" },
    rows,
    dataSource: rows.some((r) => r.dataSource === "live") ? "live" : "demo",
  };
}
