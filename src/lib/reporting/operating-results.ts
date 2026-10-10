// ---------------------------------------------------------------------------
// Operating Results — 12-month accounting-fed reporting service.
//
// Parallel to src/lib/reporting/equity-history.ts. Reads
// FiscalPeriod.closingNoi / .closingRevenue / .budgetNoi for the
// trailing 12 months relative to the reporting period and the matching
// 12 months from the prior fiscal year for the YoY context line.
//
// All values are returned in DOLLARS as numbers (Decimal converted via
// `.toNumber()`). Cents would force the React tree to do float math
// for display; dollars stay precise enough for board-level rounding
// to $K and never become Float64-loose at any club's scale (typical
// monthly NOI is in the tens of thousands, well within Number.MAX
// _SAFE_INTEGER).
//
// Tenant scope: every Prisma query is club-scoped via `clubId`. There
// is no path here that returns cross-club data.
// ---------------------------------------------------------------------------

import { prisma } from "@/lib/prisma";

export type OperatingMonth = {
  /** ISO date of the period's last day. */
  endDate: Date;
  /** Calendar month label, e.g. "Jan" / "Feb". Sized to fit a 12-slot
   *  x-axis without rotating. */
  monthLabel: string;
  /** Sequence within the fiscal year (1..12). */
  sequence: number;
  /** Net operating income in dollars for the month. Null if the
   *  period has not yet been closed and no live computation exists. */
  noi: number | null;
  /** Operating revenue in dollars for the month. */
  revenue: number | null;
  /** Board-approved budget NOI for the month. Null if not seeded. */
  budgetNoi: number | null;
};

export type OperatingResults = {
  /** Trailing 12 months relative to `asOf`, oldest → newest. The
   *  service ALWAYS returns 12 entries; periods with no data are
   *  emitted with null values so the chart can render a clean
   *  gap rather than misalign the x-axis. */
  months: OperatingMonth[];
  /** Matching 12 months from the prior fiscal year, used as the
   *  YoY overlay line. Same chronological order; same length. */
  priorYearMonths: OperatingMonth[];
  /** Sum of NOI across the trailing 12 months (dollars). Drives the
   *  YTD NOI KPI. */
  ytdNoi: number;
  /** Sum of revenue across the trailing 12 months (dollars). Drives
   *  the %-of-revenue KPI denominator. */
  ytdRevenue: number;
  /** Sum of budget NOI across the trailing 12 months (dollars).
   *  Null when the Budget source is not connected on this tenant. */
  ytdBudgetNoi: number | null;
  /** Sum of prior-year NOI across the matched 12 months (dollars).
   *  SCORECARD-PARTIAL-1 §2 (2026-10-04): null when the prior-year
   *  source is not loaded. Downstream formatters render "—" (never
   *  "$0") so missing prior-year is visually distinct from a real
   *  zero result. */
  priorYearNoi: number | null;
  /** Break-even policy line — currently the configured ClubBenchmarking
   *  zone midpoint, but defaults to 0 if no club profile exists. */
  breakEven: number;
  /** Break-even tolerance corridor in $K (lower / upper). Configurable
   *  per club as a board policy assumption (parallel to the equity
   *  benchmark assumptions). */
  breakEvenCorridor: { lower: number; upper: number };
};

/** Default break-even tolerance corridor in $K. Matches the
 *  ClubBenchmarking "−2.8% to +3.3%" zone scaled to a $14M operating
 *  base, used until the club profile carries explicit assumptions. */
const DEFAULT_BREAK_EVEN_CORRIDOR_K = { lower: -25, upper: 25 };

/** Convert a Prisma Decimal | null (or already-narrowed number | null)
 *  to a plain number, preserving null. Used by the service to flatten
 *  Decimal columns to display-ready values without forcing the caller
 *  to think about the Decimal API. */
function decimalToNumber(v: { toNumber?: () => number } | number | null | undefined): number | null {
  if (v == null) return null;
  if (typeof v === "number") return v;
  if (typeof v.toNumber === "function") return v.toNumber();
  return null;
}

function monthLabel(d: Date): string {
  // "Jan" / "Feb" / … — Saguaro-style 3-letter abbreviations.
  return d.toLocaleDateString("en-US", { month: "short" });
}

/** Returns the trailing 12 months of operating results ending at
 *  `asOf` (default: now), plus the matching 12 months from the prior
 *  year. The chart uses these to draw three series (actual / budget /
 *  prior-year) of equal length.
 *
 *  When the club has no `FiscalPeriod` rows seeded (e.g. a brand-new
 *  tenant), the function returns an OperatingResults with empty arrays
 *  and zero totals — the formatter downstream handles that gracefully
 *  by showing the "no data" KPI state.
 */
export async function getOperatingResults(
  clubId: string,
  asOf: Date = new Date(),
): Promise<OperatingResults> {
  // Pull the trailing 12 periods whose endDate is strictly before
  // asOf — same "completed only" rule as getEquityHistory. Ordered
  // by endDate desc then reversed for chronological rendering.
  const recent = await prisma.fiscalPeriod.findMany({
    where: { clubId, endDate: { lt: asOf } },
    orderBy: { endDate: "desc" },
    take: 12,
  });
  recent.reverse();

  const months: OperatingMonth[] = recent.map((p) => ({
    endDate: p.endDate,
    monthLabel: monthLabel(p.endDate),
    sequence: p.sequence,
    noi: decimalToNumber(p.closingNoi as unknown as { toNumber: () => number } | null),
    revenue: decimalToNumber(p.closingRevenue as unknown as { toNumber: () => number } | null),
    budgetNoi: decimalToNumber(p.budgetNoi as unknown as { toNumber: () => number } | null),
  }));

  // Prior-year overlay: same 12 months but one fiscal year earlier.
  // Anchor on the trailing window's first month's endDate, minus
  // one year — then pull the next 12 periods forward.
  let priorYearMonths: OperatingMonth[] = [];
  if (recent.length > 0) {
    const oldest = recent[0].endDate;
    const priorAnchor = new Date(oldest);
    priorAnchor.setUTCFullYear(priorAnchor.getUTCFullYear() - 1);
    const priorEnd = new Date(asOf);
    priorEnd.setUTCFullYear(priorEnd.getUTCFullYear() - 1);
    const prior = await prisma.fiscalPeriod.findMany({
      where: {
        clubId,
        endDate: { gte: priorAnchor, lte: priorEnd },
      },
      orderBy: { endDate: "asc" },
      take: 12,
    });
    priorYearMonths = prior.map((p) => ({
      endDate: p.endDate,
      monthLabel: monthLabel(p.endDate),
      sequence: p.sequence,
      noi: decimalToNumber(p.closingNoi as unknown as { toNumber: () => number } | null),
      revenue: decimalToNumber(p.closingRevenue as unknown as { toNumber: () => number } | null),
      budgetNoi: decimalToNumber(p.budgetNoi as unknown as { toNumber: () => number } | null),
    }));
  }

  // Roll up the trailing-12 totals from the (possibly partial) data.
  // Nulls fold to 0 — a missing month does not break the sum.
  const sum = (xs: (number | null)[]) => xs.reduce<number>((s, v) => s + (v ?? 0), 0);
  const ytdNoi = sum(months.map((m) => m.noi));
  const ytdRevenue = sum(months.map((m) => m.revenue));
  // SCORECARD-PARTIAL-1 §2 — on the FP path, when EVERY month's
  // budget / prior-year value is null the sum is a false zero. Null
  // the aggregate so the KPI tile renders "—" (never fabricated $0).
  const anyBudgetMonth = months.some((m) => m.budgetNoi != null);
  const anyPriorYearMonth = priorYearMonths.some((m) => m.noi != null);
  const ytdBudgetNoi: number | null = anyBudgetMonth
    ? sum(months.map((m) => m.budgetNoi))
    : null;
  const priorYearNoi: number | null = anyPriorYearMonth
    ? sum(priorYearMonths.map((m) => m.noi))
    : null;

  // REPORT-CHART-1 §7 (2026-10-03) — snapshot fallback. The FY-period
  // path may return 12 rows that are all null (Jonas-only tenant whose
  // FiscalPeriod shells were seeded without closingNoi / closingRevenue
  // / budgetNoi). Treat "all null, zero plottable points" the same as
  // "empty list" and fall through to committed TB snapshots.
  const hasPlottableFpData =
    months.length > 0 &&
    months.some((m) => m.noi !== null || m.revenue !== null || m.budgetNoi !== null);
  if (!hasPlottableFpData) {
    const snapshotMonths = await getOperatingMonthsFromCommittedSnapshots(clubId, asOf);
    if (snapshotMonths.length > 0) {
      // REPORT-WIRING-1 §13-16 (2026-10-04) — the Operating Results
      // chart renders a Budget bar for EVERY month FY2026 Budget
      // covers (not just months with a committed Actual snapshot).
      // Builds a 12-slot month skeleton Jan..Dec; populates Actual
      // from committed snapshots and Budget from the canonical
      // monthly Budget resolver. Future-month Actual stays null;
      // Budget populates independently.
      const { resolveBudgetMonthlyIncomeStatement } = await import("@/lib/reporting/budget-resolver");
      let monthlyBudgetNoi: number[] | null = null;
      try {
        const b = await resolveBudgetMonthlyIncomeStatement({
          clubId,
          fiscalYear: asOf.getUTCFullYear(),
          throughMonth: 12,
        });
        if (b.budget) monthlyBudgetNoi = b.monthlyNoi;
      } catch { /* budget not imported yet → leave null */ }

      // Build a 12-slot skeleton anchored on FY2026 (Jan..Dec).
      const anchorYear = asOf.getUTCFullYear();
      const actualByMonth = new Map<number, OperatingMonth>();
      for (const m of snapshotMonths) actualByMonth.set(m.endDate.getUTCMonth(), m);
      const monthLabels = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
      const enriched: OperatingMonth[] = [];
      for (let monthIndex = 0; monthIndex < 12; monthIndex++) {
        const existing = actualByMonth.get(monthIndex);
        const endDate = new Date(Date.UTC(anchorYear, monthIndex + 1, 0, 23, 59, 59, 999));
        const budgetForMonth = monthlyBudgetNoi
          ? monthlyBudgetNoi[monthIndex] ?? null
          : null;
        if (existing) {
          // Snapshot-backed Actual + Budget overlay.
          enriched.push({ ...existing, budgetNoi: budgetForMonth ?? existing.budgetNoi });
        } else {
          // Future / unloaded Actual — Budget still plots.
          enriched.push({
            endDate,
            monthLabel: `${monthLabels[monthIndex]} ${anchorYear}`,
            sequence: monthIndex + 1,
            noi: null,
            revenue: null,
            budgetNoi: budgetForMonth,
          });
        }
      }

      const sYtdNoi = sum(enriched.map((m) => m.noi));
      const sYtdRevenue = sum(enriched.map((m) => m.revenue));
      // YTD Budget rolls through `throughMonth` only — the chart
      // shows the full 12-month plan, but the KPI tile sums only
      // up to the reporting period.
      const throughMonth = asOf.getUTCMonth() + 1;
      const sYtdBudgetNoi = enriched
        .slice(0, throughMonth)
        .map((m) => m.budgetNoi)
        .reduce<number>((s, v) => s + (v ?? 0), 0);
      return {
        months: enriched,
        // §11 — Prior-Year series is SOURCE_NOT_LOADED on live tenant;
        // emit an empty array (not zero-filled).
        priorYearMonths: [],
        ytdNoi: sYtdNoi,
        ytdRevenue: sYtdRevenue,
        // SCORECARD-PARTIAL-1 §2 — Budget may be null when the Budget
        // resolver returned nothing (tenant without a Budget import yet).
        ytdBudgetNoi: monthlyBudgetNoi ? sYtdBudgetNoi : null,
        // SCORECARD-PARTIAL-1 §2 — Prior Year source NOT loaded on
        // live tenant → null (never fabricated $0 so the KPI tile can
        // honestly render "—" instead of a fake zero).
        priorYearNoi: null,
        breakEven: 0,
        breakEvenCorridor: { ...DEFAULT_BREAK_EVEN_CORRIDOR_K },
      };
    }
  }

  // Break-even corridor — currently a constant; will become a
  // ClubProfile assumption when the board policy fields land
  // (parallel to ClubProfile.equityBenchmark*CagrBps).
  return {
    months,
    priorYearMonths,
    ytdNoi,
    ytdRevenue,
    ytdBudgetNoi,
    priorYearNoi,
    breakEven: 0,
    breakEvenCorridor: { ...DEFAULT_BREAK_EVEN_CORRIDOR_K },
  };
}

/** MBR-FIX-2A (2026-10-09) — committed-snapshot fallback for the
 *  Operating Results 12-Month Rolling Trend chart.  Reads each
 *  committed TB snapshot on-or-before `asOf` and derives per-month
 *  (monthly, not YTD) NOI + Revenue from the FISCAL-YTD slice.
 *
 *  Monthly NOI contract (per the founder's MBR-FIX-2A directive §3):
 *
 *     First fiscal month                 : monthlyNoi = YTD(month)
 *     Any subsequent month in the same FY: monthlyNoi = YTD(month) − YTD(prevMonth)
 *     First month of a new fiscal year   : monthlyNoi = YTD(month)
 *       (priorYTD resets on fiscal-year boundary)
 *
 *  Prior to MBR-FIX-2A this function queried
 *  `reportingAccountBalances({ from: calendar-month-start, to: asOf })`
 *  which hit the same YTD-slice `sameDay(snapshot.periodStart, from)`
 *  gate the ratio-registry hit (MBR-AUDIT-1 DEF-4): Jonas TBs carry
 *  `snapshot.periodStart = fiscal-year start`, so every month after
 *  the first silently returned zero balances and the month was
 *  OMITTED from the chart.  Live Coulee Feb 2026 was the first
 *  observable case — the only Actual bar on the chart was Jan.
 *
 *  Scoping guard (per directive §3): this function MUST use the
 *  "NOI Before Depreciation" definition shared by the IS Projection
 *  and the ratio-registry:
 *
 *     NOI = sum(REVENUE naturalBalance)
 *         − sum(EXPENSE where fsGroupKey startsWith "IS_COGS")
 *         − sum(EXPENSE where fsGroupKey ∉ {IS_COGS*, IS_DEPRECIATION, IS_INTEREST_EXPENSE})
 *
 *     — operating-fund filter via `isOperatingFundTag(fundApplicability)`
 *     — depreciation + financing excluded (above-the-line NOI)
 *
 *  Any `getOperatingMonthsFromCommittedSnapshots` call now matches
 *  the NOI definition used by `resolveJanuaryMetricSet` and by
 *  `IncomeStatementProjection.noiBeforeDepreciation`.  The
 *  `january-partial-availability.ts` resolver uses a different NOI
 *  (does NOT carve depreciation out of OpEx); unifying that
 *  resolver is explicitly out of scope for MBR-FIX-2A per the
 *  directive's "do not expand" guard.
 */
async function getOperatingMonthsFromCommittedSnapshots(
  clubId: string,
  asOf: Date,
): Promise<OperatingMonth[]> {
  const { reportingAccountBalances } = await import("@/lib/accounting/reporting-balances");
  const { consolidateAccountBalances } = await import("@/lib/accounting/balance");
  const { isOperatingFundTag } = await import("@/lib/reporting/budget-resolver");
  const asOfEod = new Date(Date.UTC(
    asOf.getUTCFullYear(), asOf.getUTCMonth(), asOf.getUTCDate(),
    23, 59, 59, 999,
  ));
  const snapshots = await prisma.reportingLedgerSnapshot.findMany({
    where: {
      clubId,
      entityKind: "trial-balance",
      batchState: "committed",
      asOf: { lte: asOfEod },
    },
    orderBy: { asOf: "asc" },
    select: { asOf: true },
  });
  if (snapshots.length === 0) return [];

  type YtdPoint = {
    asOfDate: Date;
    ytdRevenue: number;
    ytdCogs: number;
    ytdOpex: number;
    ytdNoi: number;
    hasIsActivity: boolean;
  };

  /** Compute fiscal-YTD IS totals for a single snapshot by reading
   *  `reportingAccountBalances({ from: fiscalYearStart, to: asOfDate })`.
   *  Returns null when the snapshot is balance-sheet-only (no non-
   *  zero REVENUE or EXPENSE rows — e.g. the TB-HIST-11 opening
   *  Dec 31, 2025 import). */
  async function ytdFor(asOfDate: Date): Promise<YtdPoint | null> {
    const fiscalYearStart = new Date(Date.UTC(asOfDate.getUTCFullYear(), 0, 1));
    try {
      const result = await reportingAccountBalances(
        clubId,
        { from: fiscalYearStart, to: asOfDate },
      );
      if (result.balances.length === 0) return null;
      const consolidated = consolidateAccountBalances(result.balances);
      let revenue = 0;
      let cogs = 0;
      let opex = 0;
      let hasRevenueAccount = false;
      let hasExpenseAccount = false;
      for (const b of consolidated) {
        if (!isOperatingFundTag(b.fundApplicability)) continue;
        if (b.accountType === "REVENUE") {
          const v = Number(b.naturalBalance.toString());
          revenue += v;
          if (v !== 0) hasRevenueAccount = true;
        } else if (b.accountType === "EXPENSE") {
          const isCogs = b.fsGroupKey?.startsWith("IS_COGS") ?? false;
          const isDepreciation = b.fsGroupKey === "IS_DEPRECIATION";
          const isFinancing = b.fsGroupKey === "IS_INTEREST_EXPENSE";
          if (isDepreciation || isFinancing) continue;
          const v = Number(b.naturalBalance.toString());
          if (isCogs) cogs += v;
          else opex += v;
          if (v !== 0) hasExpenseAccount = true;
        }
      }
      if (!hasRevenueAccount && !hasExpenseAccount) return null;
      return {
        asOfDate,
        ytdRevenue: revenue,
        ytdCogs: cogs,
        ytdOpex: opex,
        ytdNoi: revenue - cogs - opex,
        hasIsActivity: true,
      };
    } catch {
      return null;
    }
  }

  // Walk snapshots in asOf-asc order.  Track the running prior-YTD
  // per fiscal year — reset to zero when the next snapshot crosses
  // a fiscal-year boundary.
  //
  // Gap detection: a monthly value is only emitted when the
  // snapshot's calendar month is month-after the LAST processed
  // snapshot (within the same FY), OR is the first fiscal month
  // (January for the current Spectre convention).  If there's a
  // gap in the fiscal history (e.g. we have Jan + Mar but no Feb),
  // we cannot compute Mar's monthly activity reliably — the "YTD −
  // priorYTD" would collapse two months' activity into one Mar bar.
  // In that case we EMIT NO POINT for the current snapshot (and
  // every subsequent in-gap snapshot) rather than fabricate a
  // misleading monthly value.
  const points: OperatingMonth[] = [];
  let priorYtdNoi = 0;
  let priorYtdRevenue = 0;
  let priorFiscalYear: number | null = null;
  let priorMonthIndex: number | null = null; // calendar 0..11
  for (let i = 0; i < snapshots.length; i++) {
    const s = snapshots[i];
    if (!s.asOf) continue;
    const asOfDate = s.asOf;
    const fy = asOfDate.getUTCFullYear();
    const monthIdx = asOfDate.getUTCMonth();

    if (priorFiscalYear !== null && fy !== priorFiscalYear) {
      // Fiscal-year boundary: reset YTD tracker + prior-month cursor.
      priorYtdNoi = 0;
      priorYtdRevenue = 0;
      priorMonthIndex = null;
    }
    priorFiscalYear = fy;

    const ytd = await ytdFor(asOfDate);
    if (ytd == null) {
      // Balance-sheet-only snapshot (e.g. Dec 2025 opening import).
      // Do NOT emit a month and do NOT advance any tracker — a
      // BS-only snapshot has no YTD income activity to compare to.
      continue;
    }

    // Enforce the "no fabricated monthly value" guard.
    const expectedPrior = monthIdx === 0 ? null : monthIdx - 1;
    const hasGap =
      priorMonthIndex === null
        ? monthIdx !== 0 // first-ever snapshot in this FY isn't January
        : priorMonthIndex !== expectedPrior;
    if (hasGap) {
      // Advance the YTD tracker so the next contiguous snapshot (if
      // any) still has a sensible prior-YTD to subtract from — but
      // emit no point for this gap-starting snapshot.
      priorYtdNoi = ytd.ytdNoi;
      priorYtdRevenue = ytd.ytdRevenue;
      priorMonthIndex = monthIdx;
      continue;
    }

    const monthlyNoi = ytd.ytdNoi - priorYtdNoi;
    const monthlyRevenue = ytd.ytdRevenue - priorYtdRevenue;

    points.push({
      endDate: asOfDate,
      monthLabel: monthLabelFromDate(asOfDate),
      sequence: i + 1,
      noi: monthlyNoi,
      revenue: monthlyRevenue,
      budgetNoi: null,
    });

    priorYtdNoi = ytd.ytdNoi;
    priorYtdRevenue = ytd.ytdRevenue;
    priorMonthIndex = monthIdx;
  }
  return points;
}

function monthLabelFromDate(d: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${months[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
