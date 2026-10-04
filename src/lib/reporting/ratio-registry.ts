// TB-HIST-12B §5 (2026-10-03) — centralized ratio / metric registry.
//
// PURPOSE
//   Every January-derivable KPI resolves through ONE calculation
//   path per metric key. Executive Opening, Financial Performance,
//   Stewardship Dashboard, and Financial Statements consume these
//   resolved metrics — none of them re-derives the formula.
//
//   The registry models each metric's provenance separately from
//   its target provenance. A metric can be AVAILABLE while its
//   target is TARGET_NOT_CONFIGURED, and the Board card renders both
//   independently (per §4-5 of the directive).
//
// DIVIDE-BY-ZERO IS NOT UNAVAILABLE
//   Zero denominator is a distinct state (DENOMINATOR_ZERO) from
//   missing inputs (INPUT_MISSING) and from a source that is simply
//   not connected (SOURCE_NOT_CONNECTED). All five states live on the
//   same `MetricAvailability` enum so UI code can distinguish them.
//
// NEVER-INVENT RULE (TB-HIST-12B §2)
//   The resolvers below consume only existing approved COA
//   classifications (fsGroupKey / categoryKey / accountType /
//   dimensional.department). If a metric's formula depends on a
//   classification that is not first-class in the current COA, the
//   metric reports `SOURCE_NOT_CONNECTED` + names the missing
//   classification in its `reason` string.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { balanceSheet } from "@/lib/accounting/reports";
import { reportingAccountBalances } from "@/lib/accounting/reporting-balances";
import { consolidateAccountBalances } from "@/lib/accounting/balance";
import { toMoney, ZERO } from "@/lib/accounting/decimal";

// -------------------------------------------------------------------
// TYPES
// -------------------------------------------------------------------

export type MetricAvailability =
  | "AVAILABLE"
  | "INPUT_MISSING"
  | "DENOMINATOR_ZERO"
  | "TARGET_NOT_CONFIGURED"
  | "SOURCE_NOT_CONNECTED";

export type MetricProvenance = {
  availability: MetricAvailability;
  /** One-line human explanation + source citation. */
  reason: string;
};

export type MetricValue = {
  /** The metric's numeric value. Null when the metric is not
   *  AVAILABLE. */
  value: Prisma.Decimal | number | null;
  /** Formatted representation of the value for board rendering.
   *  "$X.XX M" / "X.XXx" / "X.X%" / "Unavailable". */
  display: string;
  provenance: MetricProvenance;
};

export type MetricTarget = {
  /** The threshold / policy target against which the metric is
   *  compared. Null when the target is not configured. */
  value: number | string | null;
  /** Pre-formatted target label e.g. "Policy ≥ 1.25x" or "Not
   *  configured". */
  display: string;
  provenance: MetricProvenance;
};

/** A resolved Board-level metric. Carries the metric itself + its
 *  target so UI tiles can render both or either independently.
 *  Numerator / denominator inputs are preserved so tests can prove
 *  numerical reconciliation across chapters. */
export type ResolvedMetric = {
  key: string;
  name: string;
  formula: string;
  metric: MetricValue;
  target: MetricTarget;
  numerator?: Prisma.Decimal | null;
  denominator?: Prisma.Decimal | null;
};

export type JanuaryMetricSet = {
  // Operating / IS metrics
  revenue: ResolvedMetric;
  cogs: ResolvedMetric;
  opex: ResolvedMetric;
  noi: ResolvedMetric;
  grossMargin: ResolvedMetric;
  duesToRevenuePct: ResolvedMetric;
  payrollRatio: ResolvedMetric;

  // Balance-sheet / position metrics
  currentAssets: ResolvedMetric;
  currentLiabilities: ResolvedMetric;
  workingCapital: ResolvedMetric;
  currentRatio: ResolvedMetric;
  totalAssets: ResolvedMetric;
  totalLiabilities: ResolvedMetric;
  membersEquity: ResolvedMetric;

  // Capital metrics
  netPpe: ResolvedMetric;
  longTermDebt: ResolvedMetric;
  capitalReserve: ResolvedMetric;
  capitalAssessmentsYtd: ResolvedMetric;
  deferredCapitalContributions: ResolvedMetric;
  longTermDebtToEquity: ResolvedMetric;

  // Operational feeds — always SOURCE_NOT_CONNECTED on live tenants
  arCurrentPct: ResolvedMetric;
  reserveCoverage: ResolvedMetric;
};

// -------------------------------------------------------------------
// INTERNAL — helpers
// -------------------------------------------------------------------

const AVAILABLE_REASON = (src: string): MetricProvenance => ({
  availability: "AVAILABLE",
  reason: src,
});

const inputMissing = (reason: string): MetricProvenance => ({
  availability: "INPUT_MISSING",
  reason,
});

const sourceNotConnected = (reason: string): MetricProvenance => ({
  availability: "SOURCE_NOT_CONNECTED",
  reason,
});

const denominatorZero = (reason: string): MetricProvenance => ({
  availability: "DENOMINATOR_ZERO",
  reason,
});

const targetNotConfigured = (name: string): MetricTarget => ({
  value: null,
  display: "Not configured",
  provenance: { availability: "TARGET_NOT_CONFIGURED", reason: `${name} target not configured for this tenant` },
});

function fmtMoneyDec(d: Prisma.Decimal | null | undefined): string {
  if (d == null) return "Unavailable";
  const n = Number(d.toString());
  if (!Number.isFinite(n)) return "Unavailable";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${n < 0 ? "−" : ""}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${n < 0 ? "−" : ""}$${(abs / 1_000).toFixed(0)}K`;
  return `${n < 0 ? "−" : ""}$${abs.toFixed(0)}`;
}

function fmtPct(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "Unavailable";
  return `${n.toFixed(1)}%`;
}

function fmtRatio(n: number | null): string {
  if (n == null || !Number.isFinite(n)) return "Unavailable";
  return `${n.toFixed(2)}x`;
}

// Metric constructor — a single call site to avoid shape drift.
function metric(opts: {
  key: string;
  name: string;
  formula: string;
  value: Prisma.Decimal | number | null;
  display: string;
  provenance: MetricProvenance;
  numerator?: Prisma.Decimal | null;
  denominator?: Prisma.Decimal | null;
}): ResolvedMetric {
  return {
    key: opts.key,
    name: opts.name,
    formula: opts.formula,
    metric: { value: opts.value, display: opts.display, provenance: opts.provenance },
    target: targetNotConfigured(opts.name),
    numerator: opts.numerator,
    denominator: opts.denominator,
  };
}

// -------------------------------------------------------------------
// PUBLIC — resolve the January metric set from the committed TB
// -------------------------------------------------------------------

/** Resolve every Board-level metric for the January reporting period
 *  from the committed Jonas Trial Balance. Called ONCE per package
 *  build; downstream chapter builders consume `JanuaryMetricSet`
 *  rather than re-deriving formulas. */
export async function resolveJanuaryMetricSet(opts: {
  clubId: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<JanuaryMetricSet> {
  const { clubId, periodStart, periodEnd } = opts;

  // ---------------------------------------------------------
  // Income Statement reads (exact-period match)
  // ---------------------------------------------------------
  const isResult = await reportingAccountBalances(
    clubId,
    { from: periodStart, to: periodEnd },
  );
  const isAvailable = isResult.balances.length > 0;
  const isBalances = isAvailable ? consolidateAccountBalances(isResult.balances) : [];

  let revenue = ZERO;
  let cogs = ZERO;
  let opex = ZERO;
  let payroll = ZERO;
  let capitalAssessments = ZERO;
  let dues = ZERO;

  // REPORT-WIRING-1A §7 + §10 (2026-10-04) — Operating Revenue /
  // COGS / OpEx / NOI must ONLY include accounts tagged OPERATING
  // in `Account.fundApplicability`. Accounts tagged solely CAPITAL
  // (LRP Capital Improvement Dues, Initiation Fee, Facility
  // Improvement Fee, Share Redemption Brokerage Fee, Interest Income
  // on capital fund, etc.) are CAPITAL-fund revenue and belong on
  // the capital reporting side — never on operating NOI. This
  // matches the IS projection's `mapIncomeStatementAccount` contract
  // and the Spectre accounting architecture:
  //   • fundApplicability includes "OPERATING" → counted
  //   • null / empty / only "CAPITAL" → excluded (capital-side)
  const isOperatingFund = (fund: string | null): boolean => {
    if (!fund) return false;
    const parts = fund.split(",").map((s) => s.trim().toUpperCase());
    return parts.includes("OPERATING");
  };

  for (const b of isBalances) {
    const operating = isOperatingFund(b.fundApplicability);
    if (b.accountType === "REVENUE") {
      if (operating) revenue = revenue.plus(b.naturalBalance);
      // IS_CAPITAL_ASSESSMENTS is reported separately (capital side),
      // not folded into operating revenue — track regardless of fund.
      if (b.fsGroupKey === "IS_CAPITAL_ASSESSMENTS") {
        capitalAssessments = capitalAssessments.plus(b.naturalBalance);
      }
    } else if (b.accountType === "EXPENSE") {
      if (operating) {
        const isCogs = b.fsGroupKey?.startsWith("IS_COGS") ?? false;
        if (isCogs) cogs = cogs.plus(b.naturalBalance);
        else opex = opex.plus(b.naturalBalance);
        if (b.fsGroupKey === "IS_PAYROLL") payroll = payroll.plus(b.naturalBalance);
      }
    }
    // Dues through dimensional (DUES_AND_CHARGES department) — only
    // operating dues count toward dues-to-operating-revenue.
    if (b.accountType === "REVENUE" && operating && b.dimensional && b.dimensional.length > 0) {
      for (const d of b.dimensional) {
        if (d.department === "DUES_AND_CHARGES") dues = dues.plus(d.naturalBalance);
      }
    }
  }
  const noi = revenue.minus(cogs).minus(opex);
  const revenueNum = Number(revenue.toString());
  const grossMarginPct = revenueNum > 0
    ? (Number(revenue.minus(cogs).toString()) / revenueNum) * 100
    : null;
  const duesToRevenuePct = revenueNum > 0 && !dues.isZero()
    ? (Number(dues.toString()) / revenueNum) * 100
    : null;
  const payrollRatioPct = revenueNum > 0 && !payroll.isZero()
    ? (Number(payroll.toString()) / revenueNum) * 100
    : null;

  // ---------------------------------------------------------
  // Balance Sheet reads (as-of carry-forward)
  // ---------------------------------------------------------
  const bs = await balanceSheet(clubId, periodEnd);
  const bsAvailable = bs.source === "AUTHORITATIVE_SNAPSHOT";

  const totalAssets = bsAvailable ? bs.totalAssets : ZERO;
  const totalLiabilities = bsAvailable ? bs.totalLiabilities.abs() : ZERO;
  const membersEquity = bsAvailable ? bs.totalEquity : ZERO;

  // Current Assets / Liabilities + fs-group aggregates — raw read.
  const accountIds = new Set<string>();
  const walk = (nodes: typeof bs.assets): void => {
    for (const n of nodes) {
      for (const a of n.accounts) if (a.accountId) accountIds.add(a.accountId);
      walk(n.subgroups);
    }
  };
  if (bsAvailable) {
    walk(bs.assets);
    walk(bs.liabilities);
    walk(bs.equity);
  }
  const accounts = accountIds.size > 0
    ? await prisma.account.findMany({
        where: { id: { in: Array.from(accountIds) } },
        select: { id: true, type: true, category: { select: { key: true } } },
      })
    : [];
  const categoryByAccountId = new Map(
    accounts.map((a) => [a.id, a.category?.key ?? null]),
  );

  const raw = bsAvailable
    ? await reportingAccountBalances(clubId, { asOf: periodEnd }, { allowCarryForward: true })
    : null;
  const consolidated = raw ? consolidateAccountBalances(raw.balances) : [];

  let currentAssets = ZERO;
  let currentLiabilities = ZERO;
  let netPpe = ZERO;
  let ltdNaturalBal = ZERO;
  let capitalReserve = ZERO;
  let deferredCapitalContributions = ZERO;
  let hasLtdAccount = false;
  let hasReserveAccount = false;
  let hasDeferredCapAccount = false;
  let hasPpeAccount = false;
  for (const b of consolidated) {
    if (!b.accountId) continue;
    const cat = categoryByAccountId.get(b.accountId);
    if (cat === "CURRENT_ASSETS" && b.accountType === "ASSET") {
      currentAssets = currentAssets.plus(b.naturalBalance);
    }
    if (cat === "CURRENT_LIABILITIES" && b.accountType === "LIABILITY") {
      currentLiabilities = currentLiabilities.plus(b.naturalBalance);
    }
    if (b.fsGroupKey === "BS_CAPITAL_ASSETS") {
      netPpe = netPpe.plus(b.naturalBalance);
      hasPpeAccount = true;
    }
    if (b.fsGroupKey === "BS_LONG_TERM_DEBT") {
      ltdNaturalBal = ltdNaturalBal.plus(b.naturalBalance);
      hasLtdAccount = true;
    }
    if (b.fsGroupKey === "BS_CAPITAL_RESERVE") {
      capitalReserve = capitalReserve.plus(b.naturalBalance);
      hasReserveAccount = true;
    }
    if (b.fsGroupKey === "BS_DEFERRED_CAPITAL_CONTRIBUTIONS") {
      deferredCapitalContributions = deferredCapitalContributions.plus(b.naturalBalance);
      hasDeferredCapAccount = true;
    }
  }
  const workingCapital = currentAssets.minus(currentLiabilities);
  const currentRatioNum = currentLiabilities.gt(0)
    ? Number(currentAssets.toString()) / Number(currentLiabilities.toString())
    : null;
  const ltdToEquity = hasLtdAccount && membersEquity.gt(0)
    ? Number(ltdNaturalBal.toString()) / Number(membersEquity.toString())
    : null;

  // ---------------------------------------------------------
  // Build the resolved metric set
  // ---------------------------------------------------------
  return {
    revenue: metric({
      key: "revenue",
      name: "Revenue",
      formula: "sum(REVENUE natural balance over period)",
      value: isAvailable && !revenue.isZero() ? revenue : null,
      display: isAvailable && !revenue.isZero() ? fmtMoneyDec(revenue) : "Unavailable",
      provenance: isAvailable
        ? (revenue.isZero()
            ? inputMissing("Snapshot period has no REVENUE rows")
            : AVAILABLE_REASON("Jan Jonas TB · sum(REVENUE naturalBalance)"))
        : inputMissing("No committed TB snapshot covering the period"),
    }),
    cogs: metric({
      key: "cogs",
      name: "Cost of Sales",
      formula: "sum(EXPENSE where fsGroupKey starts IS_COGS)",
      value: isAvailable ? cogs : null,
      display: isAvailable ? fmtMoneyDec(cogs) : "Unavailable",
      provenance: isAvailable
        ? AVAILABLE_REASON("Jan Jonas TB · IS_COGS classification")
        : inputMissing("No committed TB snapshot covering the period"),
    }),
    opex: metric({
      key: "opex",
      name: "Operating Expenses",
      formula: "sum(EXPENSE where fsGroupKey not IS_COGS)",
      value: isAvailable ? opex : null,
      display: isAvailable ? fmtMoneyDec(opex) : "Unavailable",
      provenance: isAvailable
        ? AVAILABLE_REASON("Jan Jonas TB · EXPENSE accounts classified non-COGS")
        : inputMissing("No committed TB snapshot covering the period"),
    }),
    noi: metric({
      key: "noi",
      name: "NOI before Depreciation",
      formula: "Revenue − COGS − OpEx",
      value: isAvailable && !revenue.isZero() ? noi : null,
      display: isAvailable && !revenue.isZero() ? fmtMoneyDec(noi) : "Unavailable",
      provenance: isAvailable && !revenue.isZero()
        ? AVAILABLE_REASON("Revenue − COGS − OpEx")
        : inputMissing("NOI requires non-zero revenue"),
      numerator: revenue,
      denominator: null,
    }),
    grossMargin: metric({
      key: "gross-margin",
      name: "Gross Margin",
      formula: "(Revenue − COGS) ÷ Revenue",
      value: grossMarginPct,
      display: fmtPct(grossMarginPct),
      provenance: grossMarginPct != null
        ? AVAILABLE_REASON("(Revenue − COGS) ÷ Revenue")
        : (revenueNum === 0
            ? denominatorZero("Gross margin requires non-zero revenue")
            : inputMissing("Gross margin inputs not available")),
      numerator: revenue.minus(cogs),
      denominator: revenue,
    }),
    duesToRevenuePct: metric({
      key: "dues-to-revenue",
      name: "Dues-to-Revenue",
      formula: "DUES_AND_CHARGES revenue ÷ total REVENUE",
      value: duesToRevenuePct,
      display: fmtPct(duesToRevenuePct),
      provenance: duesToRevenuePct != null
        ? AVAILABLE_REASON("Jan Jonas TB · DUES_AND_CHARGES dimensional ÷ total REVENUE")
        : (revenueNum === 0
            ? denominatorZero("Dues-to-Revenue requires non-zero revenue")
            : inputMissing("DUES_AND_CHARGES dimensional revenue not present on this snapshot")),
      numerator: dues,
      denominator: revenue,
    }),
    payrollRatio: metric({
      key: "payroll-ratio",
      name: "Payroll Ratio",
      formula: "IS_PAYROLL sum ÷ total REVENUE",
      value: payrollRatioPct,
      display: fmtPct(payrollRatioPct),
      provenance: payrollRatioPct != null
        ? AVAILABLE_REASON("Jan Jonas TB · IS_PAYROLL ÷ total REVENUE")
        : (revenueNum === 0
            ? denominatorZero("Payroll ratio requires non-zero revenue")
            : inputMissing("No accounts classified IS_PAYROLL on this snapshot")),
      numerator: payroll,
      denominator: revenue,
    }),

    currentAssets: metric({
      key: "current-assets",
      name: "Current Assets",
      formula: "sum(ASSET where categoryKey=CURRENT_ASSETS)",
      value: bsAvailable && !currentAssets.isZero() ? currentAssets : null,
      display: bsAvailable && !currentAssets.isZero() ? fmtMoneyDec(currentAssets) : "Unavailable",
      provenance: bsAvailable
        ? (currentAssets.isZero()
            ? inputMissing("No CURRENT_ASSETS classification at this asOf")
            : AVAILABLE_REASON("Jan Jonas BS · categoryKey=CURRENT_ASSETS"))
        : inputMissing("No BS snapshot"),
    }),
    currentLiabilities: metric({
      key: "current-liabilities",
      name: "Current Liabilities",
      formula: "sum(LIABILITY where categoryKey=CURRENT_LIABILITIES)",
      value: bsAvailable && !currentLiabilities.isZero() ? currentLiabilities : null,
      display: bsAvailable && !currentLiabilities.isZero() ? fmtMoneyDec(currentLiabilities) : "Unavailable",
      provenance: bsAvailable
        ? (currentLiabilities.isZero()
            ? inputMissing("No CURRENT_LIABILITIES classification at this asOf")
            : AVAILABLE_REASON("Jan Jonas BS · categoryKey=CURRENT_LIABILITIES"))
        : inputMissing("No BS snapshot"),
    }),
    workingCapital: metric({
      key: "working-capital",
      name: "Working Capital",
      formula: "Current Assets − Current Liabilities",
      value: bsAvailable && (!currentAssets.isZero() || !currentLiabilities.isZero()) ? workingCapital : null,
      display: bsAvailable && (!currentAssets.isZero() || !currentLiabilities.isZero())
        ? fmtMoneyDec(workingCapital)
        : "Unavailable",
      provenance: bsAvailable && (!currentAssets.isZero() || !currentLiabilities.isZero())
        ? AVAILABLE_REASON("Current Assets − Current Liabilities")
        : inputMissing("Working capital requires at least one of CA / CL to be classified"),
      numerator: currentAssets,
      denominator: currentLiabilities,
    }),
    currentRatio: metric({
      key: "current-ratio",
      name: "Current Ratio",
      formula: "Current Assets ÷ Current Liabilities",
      value: currentRatioNum,
      display: fmtRatio(currentRatioNum),
      provenance: currentRatioNum != null
        ? AVAILABLE_REASON("Current Assets ÷ Current Liabilities")
        : (currentLiabilities.isZero() && !currentAssets.isZero()
            ? denominatorZero("Current ratio requires non-zero Current Liabilities")
            : inputMissing("Current ratio requires non-zero CA and CL inputs")),
      numerator: currentAssets,
      denominator: currentLiabilities,
    }),
    totalAssets: metric({
      key: "total-assets",
      name: "Total Assets",
      formula: "sum(ASSET natural balance)",
      value: bsAvailable && !totalAssets.isZero() ? totalAssets : null,
      display: bsAvailable && !totalAssets.isZero() ? fmtMoneyDec(totalAssets) : "Unavailable",
      provenance: bsAvailable && !totalAssets.isZero()
        ? AVAILABLE_REASON("Chapter VII totalAssets")
        : inputMissing("Total Assets unavailable — no snapshot"),
    }),
    totalLiabilities: metric({
      key: "total-liabilities",
      name: "Total Liabilities",
      formula: "sum(LIABILITY natural balance)",
      value: bsAvailable && !totalLiabilities.isZero() ? totalLiabilities : null,
      display: bsAvailable && !totalLiabilities.isZero() ? fmtMoneyDec(totalLiabilities) : "Unavailable",
      provenance: bsAvailable && !totalLiabilities.isZero()
        ? AVAILABLE_REASON("Chapter VII totalLiabilities")
        : inputMissing("Total Liabilities unavailable — no snapshot"),
    }),
    membersEquity: metric({
      key: "members-equity",
      name: "Members' Equity",
      formula: "Assets − Liabilities (incl. current-year earnings)",
      value: bsAvailable && !membersEquity.isZero() ? membersEquity : null,
      display: bsAvailable && !membersEquity.isZero() ? fmtMoneyDec(membersEquity) : "Unavailable",
      provenance: bsAvailable && !membersEquity.isZero()
        ? AVAILABLE_REASON("Chapter VII totalEquity")
        : inputMissing("Members' Equity unavailable — no snapshot"),
    }),

    netPpe: metric({
      key: "net-ppe",
      name: "Net PP&E",
      formula: "sum(BS_CAPITAL_ASSETS natural balance; combined gross + accum dep)",
      value: hasPpeAccount && !netPpe.isZero() ? netPpe : null,
      display: hasPpeAccount && !netPpe.isZero() ? fmtMoneyDec(netPpe) : "Unavailable",
      provenance: hasPpeAccount
        ? AVAILABLE_REASON("Jan Jonas BS · fsGroupKey=BS_CAPITAL_ASSETS")
        : sourceNotConnected("No account mapped to fsGroupKey BS_CAPITAL_ASSETS"),
    }),
    longTermDebt: metric({
      key: "long-term-debt",
      name: "Long-Term Debt",
      formula: "sum(BS_LONG_TERM_DEBT natural balance)",
      value: hasLtdAccount ? ltdNaturalBal : null,
      display: hasLtdAccount ? fmtMoneyDec(ltdNaturalBal) : "Unavailable",
      provenance: hasLtdAccount
        ? AVAILABLE_REASON("Jan Jonas BS · fsGroupKey=BS_LONG_TERM_DEBT")
        : sourceNotConnected("No account mapped to fsGroupKey BS_LONG_TERM_DEBT"),
    }),
    capitalReserve: metric({
      key: "capital-reserve",
      name: "Capital Reserve",
      formula: "sum(BS_CAPITAL_RESERVE natural balance)",
      value: hasReserveAccount ? capitalReserve : null,
      display: hasReserveAccount ? fmtMoneyDec(capitalReserve) : "Unavailable",
      provenance: hasReserveAccount
        ? AVAILABLE_REASON("Jan Jonas BS · fsGroupKey=BS_CAPITAL_RESERVE")
        : sourceNotConnected("No account mapped to fsGroupKey BS_CAPITAL_RESERVE"),
    }),
    capitalAssessmentsYtd: metric({
      key: "capital-assessments-ytd",
      name: "Capital Assessments YTD",
      formula: "sum(IS_CAPITAL_ASSESSMENTS natural balance over period)",
      value: isAvailable && !capitalAssessments.isZero() ? capitalAssessments : null,
      display: isAvailable && !capitalAssessments.isZero() ? fmtMoneyDec(capitalAssessments) : "Unavailable",
      provenance: isAvailable
        ? (capitalAssessments.isZero()
            ? sourceNotConnected("No account mapped to fsGroupKey IS_CAPITAL_ASSESSMENTS or no activity this period")
            : AVAILABLE_REASON("Jan Jonas IS · fsGroupKey=IS_CAPITAL_ASSESSMENTS"))
        : inputMissing("No IS snapshot"),
    }),
    deferredCapitalContributions: metric({
      key: "deferred-capital-contributions",
      name: "Deferred Capital Contributions",
      formula: "sum(BS_DEFERRED_CAPITAL_CONTRIBUTIONS natural balance)",
      value: hasDeferredCapAccount ? deferredCapitalContributions : null,
      display: hasDeferredCapAccount ? fmtMoneyDec(deferredCapitalContributions) : "Unavailable",
      provenance: hasDeferredCapAccount
        ? AVAILABLE_REASON("Jan Jonas BS · fsGroupKey=BS_DEFERRED_CAPITAL_CONTRIBUTIONS")
        : sourceNotConnected("No account mapped to fsGroupKey BS_DEFERRED_CAPITAL_CONTRIBUTIONS"),
    }),
    longTermDebtToEquity: metric({
      key: "ltd-to-equity",
      name: "Long-Term Debt-to-Equity",
      formula: "Long-Term Debt ÷ Members' Equity",
      value: ltdToEquity,
      display: fmtRatio(ltdToEquity),
      provenance: ltdToEquity != null
        ? AVAILABLE_REASON("Long-Term Debt ÷ Members' Equity")
        : (!hasLtdAccount
            ? sourceNotConnected("No account mapped to fsGroupKey BS_LONG_TERM_DEBT")
            : membersEquity.isZero()
              ? denominatorZero("LTD-to-Equity requires non-zero Members' Equity")
              : inputMissing("LTD-to-Equity inputs incomplete")),
      numerator: ltdNaturalBal,
      denominator: membersEquity,
    }),

    arCurrentPct: await (async () => {
      // AR-HIST-1 §19 — swap SOURCE_NOT_CONNECTED for an AR snapshot
      // read when a committed snapshot exists for the periodEnd.
      const { resolveArAgingAsOf } = await import("./ar-aging-resolver");
      const r = await resolveArAgingAsOf({ clubId, asOf: periodEnd });
      if (r.provenance.availability === "AVAILABLE" && r.snapshot) {
        return metric({
          key: "ar-current-pct",
          name: "AR Current %",
          formula: "AR Current bucket ÷ Total AR",
          value: r.snapshot.currentPct,
          display: fmtPct(r.snapshot.currentPct),
          provenance: AVAILABLE_REASON(`AR snapshot batch=${r.snapshot.batchId} effective=${r.snapshot.sourceEffectiveDate.toISOString().slice(0, 10)}`),
          numerator: r.snapshot.current,
          denominator: r.snapshot.totalAR,
        });
      }
      return metric({
        key: "ar-current-pct",
        name: "AR Current %",
        formula: "AR Current bucket ÷ Total AR",
        value: null,
        display: "Unavailable",
        provenance: sourceNotConnected(`AR aging source not imported for ${periodEnd.toISOString().slice(0, 10)}`),
      });
    })(),
    reserveCoverage: metric({
      key: "reserve-coverage",
      name: "Reserve Coverage",
      formula: "Capital Reserve ÷ 3-year average capex",
      value: null,
      display: "Unavailable",
      provenance: sourceNotConnected("Reserve coverage requires 3-year capex history (two snapshots on file is insufficient for CAGR / avg capex)"),
    }),
  };
}
