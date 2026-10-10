// TB-HIST-12A (2026-10-03) — January partial-availability resolver.
//
// Supports the Executive Opening cards' per-KPI availability model.
// Each KPI reports its OWN provenance (available / derived / manual /
// unavailable), so a card renders the KPIs it can calculate and marks
// only the unsupported ones as Unavailable. A card is never globally
// Unavailable merely because one input is missing.
//
// Inputs come from the committed Jonas Trial Balance snapshot via the
// existing `reportingAccountBalances({ from, to })` chain + `balanceSheet`
// resolver — no parallel calculation. For live tenants without a
// committed TB, every KPI is Unavailable (hasRealData === false path
// stays on the Silver Springs demo flow in the caller).
//
// This resolver does NOT compute budget / benchmark / target values —
// those sources are not yet wired. Status verdicts ("On Plan", "Strong
// Position", etc.) require a budget / policy source and remain
// Unavailable until that source lands.

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { balanceSheet } from "@/lib/accounting/reports";
import { reportingAccountBalances } from "@/lib/accounting/reporting-balances";
import { consolidateAccountBalances } from "@/lib/accounting/balance";
import { toMoney, ZERO } from "@/lib/accounting/decimal";

/** Per-KPI availability tag.
 *  - REAL        : exact figure from source (e.g. account natural balance)
 *  - DERIVED     : computed from available REAL inputs via a documented formula
 *  - MANUAL      : requires a persisted manual input (not yet wired)
 *  - UNAVAILABLE : source not loaded; render "Unavailable", NOT $0
 */
export type KpiAvailability = "REAL" | "DERIVED" | "MANUAL" | "UNAVAILABLE";

export type KpiProvenance = {
  availability: KpiAvailability;
  /** One short line explaining where this value came from or why it is
   *  unavailable. Example: "Jan 2026 Jonas TB · DUES_AND_CHARGES ÷
   *  total revenue" or "AR aging source not imported". */
  source: string;
};

export type DerivedKpi<T> = {
  value: T | null;
  provenance: KpiProvenance;
};

/** Operations-card inputs sourced from the committed Jonas TB (actuals)
 *  + committed Budget (plan).  Shape covers both actuals and
 *  comparison values so `buildOperationsBriefing` can render a
 *  reactive narrative without re-reading sources. */
export type OperationsPartialAvailability = {
  // ------- Actuals (operating-fund, fiscal YTD) -------
  revenue: DerivedKpi<Prisma.Decimal>;
  noi: DerivedKpi<Prisma.Decimal>;
  duesToRevenuePct: DerivedKpi<number>;
  // ------- Budget (operating-fund, fiscal YTD) -------
  // MBR-FIX-2B (2026-10-10) — budget actuals + variances now wired
  // through `resolveBudgetIncomeStatement` so the Operations briefing
  // can emit a factual actual-vs-plan narrative instead of the stale
  // "Budget comparison unavailable" copy.
  budgetRevenue: DerivedKpi<number>;
  budgetNoi: DerivedKpi<number>;
  revenueVariance: DerivedKpi<number>;
  revenueVariancePct: DerivedKpi<number>;
  noiVariance: DerivedKpi<number>;
  noiVariancePct: DerivedKpi<number>;
  budgetComparison: KpiProvenance;
  statusVerdict: KpiProvenance;
};

/** Financial-health card inputs from the Jan BS. */
export type FinancialHealthPartialAvailability = {
  workingCapital: DerivedKpi<Prisma.Decimal>;
  currentRatio: DerivedKpi<number>;
  currentAssets: DerivedKpi<Prisma.Decimal>;
  currentLiabilities: DerivedKpi<Prisma.Decimal>;
  reserveCoverage: KpiProvenance;
  // EXEC-AR-1 (2026-10-03) — arCurrentPct now carries a value when a
  // committed AR snapshot exists for the period. Was `KpiProvenance`
  // only; now `DerivedKpi<number>` so the Executive Opening card can
  // render the authoritative %.
  arCurrentPct: DerivedKpi<number>;
  statusVerdict: KpiProvenance;
};

// -------------------------------------------------------------------
// OPERATIONS — Revenue, NOI, Dues-to-Revenue
// -------------------------------------------------------------------

/** Derive the Operations card KPIs for a reporting period from the
 *  committed TB. Returns `null`-valued KPIs tagged UNAVAILABLE when no
 *  snapshot covers the period; otherwise each KPI carries its DERIVED
 *  value + a one-line source citation. */
export async function computeOperationsPartialAvailability(opts: {
  clubId: string;
  periodStart: Date;
  periodEnd: Date;
}): Promise<OperationsPartialAvailability> {
  const { clubId, periodEnd } = opts;

  // MBR-FIX-2B (2026-10-10) — this resolver previously queried
  // `reportingAccountBalances({ from: periodStart, to: periodEnd })`
  // with `periodStart = current-month start` (e.g. Feb 1).  Jonas
  // TB snapshots are imported with `snapshot.periodStart = fiscal-
  // year start` (Jan 1), so the `sameDay(periodStart, filter.from)`
  // gate in `reportingAccountBalances` silently returned no balances
  // on every month after the first, which left the Operations
  // briefing stuck at "Unavailable" even though the Section II /
  // Operating Results chart / Statement of Activities all had real
  // numbers.  See MBR-AUDIT-1 DEF-4 for the original trace;
  // MBR-FIX-1 fixed the ratio-registry's version of this bug, and
  // this slice fixes the parallel occurrence here.
  const fiscalYearStart = new Date(Date.UTC(periodEnd.getUTCFullYear(), 0, 1));
  const result = await reportingAccountBalances(
    clubId,
    { from: fiscalYearStart, to: periodEnd },
  );

  const periodLabel =
    `${fiscalYearStart.toISOString().slice(0, 10)}–${periodEnd.toISOString().slice(0, 10)}`;
  if (result.balances.length === 0) {
    const periodMiss: KpiProvenance = {
      availability: "UNAVAILABLE",
      source: `No committed TB snapshot covering ${periodLabel}`,
    };
    const nullNum: DerivedKpi<number> = { value: null, provenance: periodMiss };
    return {
      revenue: { value: null, provenance: periodMiss },
      noi: { value: null, provenance: periodMiss },
      duesToRevenuePct: { value: null, provenance: periodMiss },
      budgetRevenue: nullNum,
      budgetNoi: nullNum,
      revenueVariance: nullNum,
      revenueVariancePct: nullNum,
      noiVariance: nullNum,
      noiVariancePct: nullNum,
      budgetComparison: {
        availability: "UNAVAILABLE",
        source: "No budget source wired for this tenant",
      },
      statusVerdict: {
        availability: "UNAVAILABLE",
        source: "Status verdict requires a budget / policy source — not yet wired",
      },
    };
  }

  const balances = consolidateAccountBalances(result.balances);

  // MBR-FIX-2B — operating-fund gate applied to every actual IS line
  // so the Operations briefing's Revenue / NOI reconciles to the
  // Section II Authoritative Source panel + the Operating Results
  // chart (both of which operate only on OPERATING-tagged accounts).
  // Capital-fund revenue (initiation fees, LRP dues, etc.) is
  // reported separately under Capital Fund — never folded into the
  // operating NOI line.
  const isOperating = (fund: string | null): boolean => {
    if (!fund) return false;
    return fund.split(",").map((s) => s.trim().toUpperCase()).includes("OPERATING");
  };

  // Revenue — sum of every OPERATING-fund REVENUE account's natural
  // balance over the fiscal YTD window.
  let revenue = ZERO;
  for (const b of balances) {
    if (b.accountType !== "REVENUE") continue;
    if (!isOperating(b.fundApplicability)) continue;
    revenue = revenue.plus(b.naturalBalance);
  }

  // COGS vs OpEx split via fsGroupKey.  MBR-FIX-2B — authoritative
  // NOI Before Depreciation definition (parity with ratio-registry
  // + IS Projection + the Operating Results chart's resolver):
  // operating fund only, IS_DEPRECIATION and IS_INTEREST_EXPENSE
  // carved out so NOI reconciles across every surface.
  let cogs = ZERO;
  let opex = ZERO;
  for (const b of balances) {
    if (b.accountType !== "EXPENSE") continue;
    if (!isOperating(b.fundApplicability)) continue;
    const key = b.fsGroupKey ?? "";
    if (key === "IS_DEPRECIATION" || key === "IS_INTEREST_EXPENSE") continue;
    const isCogs = key.startsWith("IS_COGS");
    if (isCogs) cogs = cogs.plus(b.naturalBalance);
    else opex = opex.plus(b.naturalBalance);
  }
  const noi = revenue.minus(cogs).minus(opex);

  // Dues-to-Revenue — reads the DUES_AND_CHARGES Spectre Department
  // balance from AccountBalance.dimensional[] (TB-HIST-7 seeded this
  // per-(account, department, fund) tuple).  Operating-fund gate also
  // applied here so dues ratio reconciles to the operating-revenue
  // definition the rest of the briefing uses.
  let dues = ZERO;
  let dimensionalSeen = false;
  for (const b of balances) {
    if (b.accountType !== "REVENUE") continue;
    if (!isOperating(b.fundApplicability)) continue;
    if (!b.dimensional || b.dimensional.length === 0) continue;
    for (const d of b.dimensional) {
      if (d.department != null) dimensionalSeen = true;
      if (d.department === "DUES_AND_CHARGES") {
        dues = dues.plus(d.naturalBalance);
      }
    }
  }

  const revenueProv: KpiProvenance = {
    availability: "DERIVED",
    source: `Fiscal YTD ${periodLabel} · sum(OPERATING REVENUE natural balances)`,
  };
  const noiProv: KpiProvenance = {
    availability: "DERIVED",
    source: "Revenue − COGS − OpEx (ex-depreciation, ex-financing; operating-fund only)",
  };
  const duesProv: KpiProvenance = dimensionalSeen
    ? (dues.isZero()
        ? {
            availability: "UNAVAILABLE",
            source: "Dues ÷ Revenue requires DUES_AND_CHARGES department on the TB; snapshot has no DUES_AND_CHARGES revenue rows",
          }
        : {
            availability: "DERIVED",
            source: "DUES_AND_CHARGES department revenue ÷ total REVENUE",
          })
    : {
        availability: "UNAVAILABLE",
        source: "Snapshot lacks dimensional (department) data — pre-TB-HIST-7 payload",
      };

  const duesToRevenuePct = revenue.gt(0) && !dues.isZero()
    ? Number(dues.toString()) / Number(revenue.toString()) * 100
    : null;

  // MBR-FIX-2B — budget comparison via the canonical resolver.
  // `resolveBudgetIncomeStatement` already carves depreciation +
  // financing out of OpEx, so its `noi` is the authoritative Budget
  // NOI Before Depreciation (parity with the Operating Results
  // chart's "Budget Goal" tile).  Lazy-loaded to avoid pulling the
  // resolver on code paths that don't need it.
  let budgetRevenueVal: number | null = null;
  let budgetNoiVal: number | null = null;
  let budgetProv: KpiProvenance;
  try {
    const { resolveBudgetIncomeStatement } = await import("@/lib/reporting/budget-resolver");
    const throughMonth = periodEnd.getUTCMonth() + 1;
    const b = await resolveBudgetIncomeStatement({
      clubId,
      fiscalYear: periodEnd.getUTCFullYear(),
      throughMonth,
    });
    if (b.budget) {
      budgetRevenueVal = b.revenue;
      budgetNoiVal = b.noi;
      budgetProv = {
        availability: "DERIVED",
        source: `Committed FY${periodEnd.getUTCFullYear()} Budget v${b.budget.version} · YTD through month ${throughMonth}`,
      };
    } else {
      budgetProv = {
        availability: "UNAVAILABLE",
        source: `No committed Budget for FY${periodEnd.getUTCFullYear()} on this tenant`,
      };
    }
  } catch (e) {
    budgetProv = {
      availability: "UNAVAILABLE",
      source: `Budget resolver error: ${(e as Error).message}`,
    };
  }

  const nullNumProv = (reason: string): KpiProvenance => ({
    availability: "UNAVAILABLE",
    source: reason,
  });
  const unavail = (reason: string): DerivedKpi<number> => ({
    value: null,
    provenance: nullNumProv(reason),
  });

  const revenueNum = revenue.isZero() ? null : Number(revenue.toString());
  const noiNum = revenue.isZero() ? null : Number(noi.toString());
  let revenueVariance: DerivedKpi<number> = unavail("Budget or actual revenue not available");
  let revenueVariancePct: DerivedKpi<number> = unavail("Variance % requires budgeted revenue > 0");
  let noiVariance: DerivedKpi<number> = unavail("Budget or actual NOI not available");
  let noiVariancePct: DerivedKpi<number> = unavail("Variance % requires non-zero budgeted NOI");
  if (budgetRevenueVal != null && revenueNum != null) {
    const d = revenueNum - budgetRevenueVal;
    revenueVariance = { value: d, provenance: { availability: "DERIVED", source: "Actual YTD Revenue − Budget YTD Revenue" } };
    if (budgetRevenueVal !== 0) {
      revenueVariancePct = {
        value: (d / Math.abs(budgetRevenueVal)) * 100,
        provenance: { availability: "DERIVED", source: "Revenue variance ÷ |Budget Revenue|" },
      };
    }
  }
  if (budgetNoiVal != null && noiNum != null) {
    const d = noiNum - budgetNoiVal;
    noiVariance = { value: d, provenance: { availability: "DERIVED", source: "Actual YTD NOI − Budget YTD NOI" } };
    if (budgetNoiVal !== 0) {
      noiVariancePct = {
        value: (d / Math.abs(budgetNoiVal)) * 100,
        provenance: { availability: "DERIVED", source: "NOI variance ÷ |Budget NOI|" },
      };
    }
  }

  return {
    revenue: {
      value: revenue.isZero() ? null : revenue,
      provenance: revenue.isZero()
        ? { availability: "UNAVAILABLE", source: "Snapshot period has no REVENUE rows" }
        : revenueProv,
    },
    noi: {
      value: revenue.isZero() ? null : noi,
      provenance: revenue.isZero()
        ? { availability: "UNAVAILABLE", source: "NOI depends on Revenue which is unavailable for this period" }
        : noiProv,
    },
    duesToRevenuePct: {
      value: duesToRevenuePct,
      provenance: duesProv,
    },
    budgetRevenue: {
      value: budgetRevenueVal,
      provenance: budgetRevenueVal == null
        ? nullNumProv(budgetProv.source)
        : { availability: "DERIVED", source: budgetProv.source },
    },
    budgetNoi: {
      value: budgetNoiVal,
      provenance: budgetNoiVal == null
        ? nullNumProv(budgetProv.source)
        : { availability: "DERIVED", source: budgetProv.source },
    },
    revenueVariance,
    revenueVariancePct,
    noiVariance,
    noiVariancePct,
    budgetComparison: budgetProv,
    statusVerdict: budgetRevenueVal != null && budgetNoiVal != null && noiNum != null && revenueNum != null
      ? { availability: "DERIVED", source: "Status derived from Actual vs Budget NOI + Revenue" }
      : {
          availability: "UNAVAILABLE",
          source: budgetProv.availability === "DERIVED"
            ? "Status verdict waits on actual IS values"
            : "Status verdict requires a budget / policy source",
        },
  };
}

// -------------------------------------------------------------------
// FINANCIAL HEALTH — Working Capital, Current Ratio
// -------------------------------------------------------------------

/** Derive the Financial Health card KPIs from the committed BS at
 *  period end. Working Capital = CURRENT_ASSETS − CURRENT_LIABILITIES
 *  by `Account.categoryKey`. */
export async function computeFinancialHealthPartialAvailability(opts: {
  clubId: string;
  periodEnd: Date;
}): Promise<FinancialHealthPartialAvailability> {
  const { clubId, periodEnd } = opts;

  // EXEC-AR-1 (2026-10-03) — resolve AR snapshot FIRST so even a
  // period without an authoritative BS still produces the AR
  // Current % correctly when the AR source IS loaded.
  const { resolveArAgingAsOf } = await import("./ar-aging-resolver");
  const arResult = await resolveArAgingAsOf({ clubId, asOf: periodEnd });
  const arKpi: DerivedKpi<number> = arResult.provenance.availability === "AVAILABLE" && arResult.snapshot?.currentPct != null
    ? {
        value: arResult.snapshot.currentPct,
        provenance: {
          availability: "DERIVED",
          source: `Jan 2026 AR Aging · batch=${arResult.snapshot.batchId.slice(0, 10)}…`,
        },
      }
    : {
        value: null,
        provenance: {
          availability: "UNAVAILABLE",
          source: arResult.provenance.reason,
        },
      };

  const bs = await balanceSheet(clubId, periodEnd);
  if (bs.source !== "AUTHORITATIVE_SNAPSHOT") {
    const miss: KpiProvenance = {
      availability: "UNAVAILABLE",
      source: "No authoritative BS snapshot for this period",
    };
    return {
      workingCapital: { value: null, provenance: miss },
      currentRatio: { value: null, provenance: miss },
      currentAssets: { value: null, provenance: miss },
      currentLiabilities: { value: null, provenance: miss },
      reserveCoverage: { availability: "UNAVAILABLE", source: "Reserve coverage needs 3-yr capex history" },
      arCurrentPct: arKpi,
      statusVerdict: { availability: "UNAVAILABLE", source: "Status verdict requires policy / benchmark configuration" },
    };
  }

  // Load the account rows the BS already drew from and sum by
  // `categoryKey`. The BS result already carries the resolved
  // FSGroupNode tree but not the raw categoryKey — re-fetch per account
  // in a single Prisma call. Only `id`, `categoryKey`, `accountType`
  // are needed; no PII.
  const accountIds = new Set<string>();
  const walk = (nodes: typeof bs.assets): void => {
    for (const n of nodes) {
      for (const a of n.accounts) if (a.accountId) accountIds.add(a.accountId);
      walk(n.subgroups);
    }
  };
  walk(bs.assets);
  walk(bs.liabilities);

  const accounts = await prisma.account.findMany({
    where: { id: { in: Array.from(accountIds) } },
    select: {
      id: true,
      type: true,
      category: { select: { key: true } },
    },
  });
  const categoryByAccountId = new Map(
    accounts.map((a) => [a.id, a.category?.key ?? null]),
  );

  // Re-fetch the raw AccountBalance rows the BS consumed — same
  // asOf, carry-forward on. We need natural balances per account to
  // sum by categoryKey.
  const raw = await reportingAccountBalances(
    clubId,
    { asOf: periodEnd },
    { allowCarryForward: true },
  );
  const consolidated = consolidateAccountBalances(raw.balances);

  let currentAssets = ZERO;
  let currentLiabilities = ZERO;
  for (const b of consolidated) {
    if (!b.accountId) continue;
    const cat = categoryByAccountId.get(b.accountId);
    if (!cat) continue;
    if (cat === "CURRENT_ASSETS" && b.accountType === "ASSET") {
      currentAssets = currentAssets.plus(b.naturalBalance);
    }
    if (cat === "CURRENT_LIABILITIES" && b.accountType === "LIABILITY") {
      currentLiabilities = currentLiabilities.plus(b.naturalBalance);
    }
  }

  const workingCapital = currentAssets.minus(currentLiabilities);
  const currentRatioNum = currentLiabilities.gt(0)
    ? Number(currentAssets.toString()) / Number(currentLiabilities.toString())
    : null;

  const haveCA = !currentAssets.isZero();
  const haveCL = !currentLiabilities.isZero();

  const caProv: KpiProvenance = haveCA
    ? { availability: "DERIVED", source: "sum(categoryKey=CURRENT_ASSETS natural balance) at period end" }
    : { availability: "UNAVAILABLE", source: "No CURRENT_ASSETS classification on the BS at this asOf" };
  const clProv: KpiProvenance = haveCL
    ? { availability: "DERIVED", source: "sum(categoryKey=CURRENT_LIABILITIES natural balance) at period end" }
    : { availability: "UNAVAILABLE", source: "No CURRENT_LIABILITIES classification on the BS at this asOf" };
  const wcProv: KpiProvenance = (haveCA || haveCL)
    ? { availability: "DERIVED", source: "Current Assets − Current Liabilities" }
    : { availability: "UNAVAILABLE", source: "Working capital requires at least one of CA / CL to be classified" };
  const crProv: KpiProvenance = currentRatioNum != null && haveCA
    ? { availability: "DERIVED", source: "Current Assets ÷ Current Liabilities" }
    : { availability: "UNAVAILABLE", source: "Current ratio requires non-zero Current Liabilities" };

  return {
    workingCapital: {
      value: !haveCA && !haveCL ? null : workingCapital,
      provenance: wcProv,
    },
    currentRatio: { value: currentRatioNum, provenance: crProv },
    currentAssets: {
      value: haveCA ? currentAssets : null,
      provenance: caProv,
    },
    currentLiabilities: {
      value: haveCL ? currentLiabilities : null,
      provenance: clProv,
    },
    reserveCoverage: {
      availability: "UNAVAILABLE",
      source: "Reserve coverage ratio requires 3-year average capex history (not yet derivable from a single committed snapshot)",
    },
    arCurrentPct: arKpi,
    statusVerdict: {
      availability: "UNAVAILABLE",
      source: "Status verdict (Strong Position / Stable / Watch / Concern) requires policy thresholds / benchmark configuration",
    },
  };
}

// -------------------------------------------------------------------
// FACTUAL NARRATIVE BUILDER
// -------------------------------------------------------------------

/** Compose a deterministic factual-narrative sentence from derived
 *  numerics. The output cites what was observed — never evaluates
 *  ("Strong Position", "On Plan") unless a derived rule provides it.
 *
 *  Example:
 *    `buildFactualNarrative({
 *       currentAssets: toMoney("1234567"),
 *       currentLiabilities: toMoney("456789"),
 *     })`
 *  →
 *    "Current assets exceed current liabilities by $777,778."
 */
export function buildFactualNarrative(parts: {
  currentAssets?: Prisma.Decimal | null;
  currentLiabilities?: Prisma.Decimal | null;
  revenue?: Prisma.Decimal | null;
  noi?: Prisma.Decimal | null;
  duesToRevenuePct?: number | null;
}): string {
  const sentences: string[] = [];
  if (parts.currentAssets && parts.currentLiabilities) {
    const diff = parts.currentAssets.minus(parts.currentLiabilities);
    if (diff.gt(0)) {
      sentences.push(`Current assets exceed current liabilities by ${fmtMoney(diff)}.`);
    } else if (diff.lt(0)) {
      sentences.push(`Current liabilities exceed current assets by ${fmtMoney(diff.abs())}.`);
    } else {
      sentences.push("Current assets equal current liabilities.");
    }
  }
  if (parts.revenue) {
    sentences.push(`Revenue over the period totals ${fmtMoney(parts.revenue)}.`);
  }
  if (parts.noi) {
    if (parts.noi.gt(0)) sentences.push(`NOI before depreciation is ${fmtMoney(parts.noi)}.`);
    else sentences.push(`NOI before depreciation is a loss of ${fmtMoney(parts.noi.abs())}.`);
  }
  if (parts.duesToRevenuePct != null) {
    sentences.push(`Dues account for ${parts.duesToRevenuePct.toFixed(1)}% of operating revenue.`);
  }
  return sentences.join(" ");
}

function fmtMoney(d: Prisma.Decimal): string {
  const n = Number(d.toString());
  if (!Number.isFinite(n)) return "$—";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${n < 0 ? "−" : ""}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${n < 0 ? "−" : ""}$${(abs / 1_000).toFixed(0)}K`;
  return `${n < 0 ? "−" : ""}$${abs.toFixed(0)}`;
}

// Export unused re-usable toMoney so the module keeps its decimal
// imports visible to downstream callers.
export { toMoney };
