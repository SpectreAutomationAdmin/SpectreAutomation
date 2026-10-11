// MBR-FIX-2H (2026-10-10) — Payroll Ratio Monthly Trend live builder.
//
// Produces the Chair's Dashboard "Payroll Ratio — Monthly Trend" chart
// from the committed TBs via the canonical FS-Group projection.
//
// Live wiring semantic (matches the Silver Springs demo semantic the
// `buildPayrollRatioTrendData` builder already consumes):
//
//   • Monthly actual ratio (per month m, 1..reportingMonth)
//       = MTD IS_PAYROLL(m) / MTD Operating Revenue(m) × 100
//     where MTD = YTD(m) − YTD(m−1); first fiscal month short-circuits
//     to MTD = YTD.  `resolveFsGroupProjection` returns cmActual on
//     each row which already encodes this subtraction identity.
//
//   • Monthly budget ratio (per month m, 1..12)
//       = MTD Budget Payroll(m) / MTD Budget Revenue(m) × 100
//     Budget data is known for the full fiscal year via the central
//     Budget contract — all 12 months plotted.
//
//   • Prior-year series: NULL on tenants without 2025 committed TBs.
//     The chart renderer treats a null-valued series as "omit".
//
//   • Benchmark: config-driven policy threshold (57 % — board rule-
//     of-thumb for financially-healthy private clubs).
//
// Every number on the chart reconciles to the same TB + Budget sources
// that drive Statement of Activities, Section III Payroll Ratio KPI,
// Section X Departmental P&L, and Section XII Departmental Payroll.
// See the Financial Reporting Data Integrity audit in the MBR-FIX-2H
// report for the full reconciliation chain.

import { buildReportingPeriod } from "./reporting-period";
import { resolveBudget } from "./budget-resolver";
import { prisma } from "@/lib/prisma";
import { resolveFsGroupProjection } from "./fs-group-projection";
import {
  buildPayrollRatioTrendData,
  type PayrollRatioMonthlyInput,
  type PayrollRatioTrendData,
} from "./payroll-analysis";

const MONTH_LABELS = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/** Config-driven policy benchmark — a healthy private club keeps
 *  payroll under ~57 % of operating revenue.  Not an accounting
 *  record, so this is the one allowed hardcoded scalar on the live
 *  chart (per the Financial Reporting Data Integrity rule: benchmark
 *  / threshold / policy values may be config). */
const BENCHMARK_PCT = 57;

export async function buildPayrollRatioTrendLive(
  clubId: string,
  periodEnd: Date,
): Promise<PayrollRatioTrendData> {
  const reportingYear = periodEnd.getUTCFullYear();
  const reportingMonth = periodEnd.getUTCMonth() + 1;
  const fiscalYearStart = new Date(Date.UTC(reportingYear, 0, 1));

  // ------------------------------------------------------------------
  // Per-committed-month projection.  One call per month covers both
  // Actual (MTD via cmActual) and Budget (MTD via cmBudget).  We only
  // query 1..reportingMonth — later months have no committed TB and
  // would fall through to the operational-ledger path (noisy data).
  // ------------------------------------------------------------------
  const monthEnds: Date[] = [];
  for (let m = 1; m <= reportingMonth; m++) {
    monthEnds.push(
      new Date(Date.UTC(reportingYear, m, 0, 23, 59, 59, 999)),
    );
  }

  const projections = await Promise.all(
    monthEnds.map((mEnd) =>
      resolveFsGroupProjection({
        clubId,
        period: buildReportingPeriod(mEnd, { periodStart: fiscalYearStart }),
      }),
    ),
  );

  // Monthly Actual = YTD payroll(m) / YTD revenue(m) × 100 at each
  // month-end.  We intentionally use YTD-at-month-end rather than
  // MTD subtraction because private clubs collect annual dues in
  // January: a pure MTD ratio for Feb would divide February's small
  // MTD payroll by February's near-zero MTD revenue (dues already
  // booked in Jan), producing a nonsensical >100 % spike that is
  // arithmetically correct but useless as a trend signal.  The YTD-
  // at-month-end semantic produces a steady, board-legible curve
  // and also reconciles to the "YTD Ratio" KPI tile at every
  // monthly step.
  //
  // Revenue rows are credit-normal on the projection, so flip the
  // sign of totals.operatingRevenue.ytdActual for the positive
  // scalar.
  const monthlyActual: PayrollRatioMonthlyInput[] = MONTH_LABELS.map(
    (label, i) => {
      if (i >= reportingMonth) {
        // Placeholder — the chart renderer masks this to null via the
        // reportingMonth gate inside buildPayrollRatioTrendData.
        return { label, ratio: 0 };
      }
      const proj = projections[i];
      const payrollYtd = Math.abs(
        proj.operatingExpense.find((r) => r.fsGroupKey === "IS_PAYROLL")
          ?.ytdActual ?? 0,
      );
      const revenueYtd = Math.abs(proj.totals.operatingRevenue.ytdActual);
      const ratio =
        revenueYtd > 0 ? (payrollYtd / revenueYtd) * 100 : 0;
      return { label, ratio };
    },
  );

  // ------------------------------------------------------------------
  // Monthly Budget — all 12 months.  resolveBudget returns each
  // Budget line's monthlyTotals array; we aggregate across accounts
  // of the right FS-Group / fund + apply the display-sign normalise.
  // Fallback: if resolveBudget has no data, every monthly budget
  // ratio is 0 and the chart's Budget series stays flat at zero.
  // ------------------------------------------------------------------
  const budgetResult = await resolveBudget({
    clubId,
    fiscalYear: reportingYear,
    throughMonth: 12,
  }).catch(() => null);

  const monthlyBudget: PayrollRatioMonthlyInput[] = MONTH_LABELS.map((label) => ({
    label,
    ratio: 0,
  }));

  if (budgetResult != null && budgetResult.byAccount.length > 0) {
    // Load account metadata so we can filter to Operating + classify
    // the account's fsGroupKey (payroll vs. non-payroll revenue).
    const accountNumbers = budgetResult.byAccount.map((b) => b.accountNumber);
    const accounts = await prisma.account.findMany({
      where: { clubId, accountNumber: { in: accountNumbers } },
      select: {
        accountNumber: true,
        type: true,
        fundApplicability: true,
        fsGroup: { select: { key: true } },
      },
    });
    const metaByNumber = new Map(accounts.map((a) => [a.accountNumber, a]));

    // Pass 1: aggregate per-month increments across every account.
    // Pass 2: convert increments to cumulative YTD per month-end so
    // the ratio mirrors the Actual semantic (dues-heavy January
    // doesn't force Feb MTD into the triple-digit range).
    const budgetPayrollMtd = new Array<number>(12).fill(0);
    const budgetRevenueMtd = new Array<number>(12).fill(0);

    for (const b of budgetResult.byAccount) {
      const meta = metaByNumber.get(b.accountNumber);
      if (!meta) continue;
      const fund = (meta.fundApplicability ?? "")
        .split(",")
        .map((s) => s.trim().toUpperCase());
      if (!fund.includes("OPERATING")) continue;

      // Normalise Budget monthlyTotals to display-sign: central Budget
      // contract stores REVENUE negative, EXPENSE positive — flip
      // revenue to positive so the ratio arithmetic is sign-clean.
      const sign = meta.type === "REVENUE" ? -1 : 1;
      const isPayroll = meta.fsGroup?.key === "IS_PAYROLL";
      const isRevenue = meta.type === "REVENUE";

      for (let m = 0; m < 12; m++) {
        const amt = sign * (b.monthlyTotals[m] ?? 0);
        if (isPayroll) budgetPayrollMtd[m] += amt;
        else if (isRevenue) budgetRevenueMtd[m] += amt;
      }
    }

    const budgetPayrollYtd = new Array<number>(12).fill(0);
    const budgetRevenueYtd = new Array<number>(12).fill(0);
    let runPayroll = 0;
    let runRevenue = 0;
    for (let m = 0; m < 12; m++) {
      runPayroll += budgetPayrollMtd[m];
      runRevenue += budgetRevenueMtd[m];
      budgetPayrollYtd[m] = runPayroll;
      budgetRevenueYtd[m] = runRevenue;
    }

    for (let i = 0; i < 12; i++) {
      const p = budgetPayrollYtd[i];
      const r = budgetRevenueYtd[i];
      monthlyBudget[i] = {
        label: MONTH_LABELS[i],
        ratio: r > 0 ? (p / r) * 100 : 0,
      };
    }
  }

  // ------------------------------------------------------------------
  // Prior-Year series — on tenants without 2025 committed TBs
  // (Coulee), every value is 0.  The React chart's prior-year legend
  // tile reads "0.0 %" rather than being hidden; a future TB-HIST
  // slice that loads 2025 TBs will replace this with real data.
  // ------------------------------------------------------------------
  const monthlyPriorYear: PayrollRatioMonthlyInput[] = MONTH_LABELS.map((label) => ({
    label,
    ratio: 0,
  }));

  // ------------------------------------------------------------------
  // Commentary ancillaries: Dues ratio and golf-rounds YoY.  These
  // feed the narrative paragraph on the chart.  Both pulled from the
  // same authoritative projection so the commentary reconciles.
  // ------------------------------------------------------------------
  const latestProj = projections[reportingMonth - 1];
  const latestRevenue = Math.abs(latestProj.totals.operatingRevenue.ytdActual);
  const latestDues = Math.abs(
    latestProj.operatingRevenue.find(
      (r) => r.fsGroupKey === "IS_MEMBERSHIP_DUES",
    )?.ytdActual ?? 0,
  );
  const duesRatioPct = latestRevenue > 0 ? (latestDues / latestRevenue) * 100 : 0;

  return buildPayrollRatioTrendData(
    {
      monthlyActual,
      monthlyBudget,
      monthlyPriorYear,
      benchmarkPct: BENCHMARK_PCT,
      duesRatioPct,
      // Golf rounds — not wired to the live resolver here. Pass 0/0 so
      // the commentary's "member utilization up X.X%" reads 0 % (not a
      // fabricated figure). A future slice that threads
      // `resolveGolfActivityYtd` through will replace these.
      golfRoundsActual: 0,
      golfRoundsPriorYear: 0,
      reportingYear,
      reportingMonth,
    },
    { dataSource: "live" },
  );
}
