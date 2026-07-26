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
   *  Drives the Budget Goal KPI. */
  ytdBudgetNoi: number;
  /** Sum of prior-year NOI across the matched 12 months (dollars). */
  priorYearNoi: number;
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
  const ytdBudgetNoi = sum(months.map((m) => m.budgetNoi));
  const priorYearNoi = sum(priorYearMonths.map((m) => m.noi));

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
