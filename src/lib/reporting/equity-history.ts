// ---------------------------------------------------------------------------
// Equity Value Over Time — reporting data service.
//
// This service is the SINGLE source for the Monthly Reporting Package's
// "Equity Value Over Time" stewardship chart (Chair's Dashboard,
// Section II). The chart's React component is now a pure consumer —
// the values returned here come from the accounting system, not from
// inline arrays.
//
// Data sources (in priority order):
//
//   - Closed historical years: `FiscalYear.closingEquity` Decimal field,
//     which is set by the period-close engine when an FY transitions to
//     CLOSED, or seeded for years that pre-date the system's go-live.
//   - Current open year: live `balanceSheet(clubId, asOf).totalEquity`
//     from src/lib/accounting/reports.ts, which itself is
//     `sum(equity-typed account balances) + currentYearEarnings`.
//
// Benchmark projections (best-in-class CAGR + minimum-required CAGR)
// are CONFIGURABLE per club via `ClubProfile.equityBenchmarkBestCagrBps`
// and `ClubProfile.equityBenchmarkMinCagrBps`. Both lines are PROJECTED
// from the first year's actual equity base, not stored point-by-point.
//
// Tenant scope: every Prisma read is filtered by clubId. No global reads.
//
// Output shape mirrors what the React card needs:
//   - currentEquityCents       — current period equity in $ × 100
//   - actualCagrBps            — compounded annual growth in basis points
//   - bestInClassCagrBps       — configured benchmark CAGR (bps)
//   - minimumRequiredCagrBps   — configured floor CAGR (bps)
//   - series                   — N year-end points, each carrying actual
//                                club equity + the two projected benchmarks
//
// All arithmetic uses `Prisma.Decimal` to avoid float drift.
// ---------------------------------------------------------------------------

import { Prisma } from "@prisma/client";
import { prisma } from "../prisma";
import { balanceSheet } from "../accounting/reports";

const DEFAULT_YEARS_BACK = 8;
const DEFAULT_BEST_IN_CLASS_CAGR_BPS = 600;  // 6.00 %
const DEFAULT_MIN_REQUIRED_CAGR_BPS  = 300;  // 3.00 %
const CENTS = new Prisma.Decimal(100);

export type EquityHistoryPoint = {
  /** Fiscal year label as authored on the FiscalYear row (e.g. "FY2026"). */
  fiscalYear: string;
  /** Actual closing equity in cents (integer). Sourced from the GL via
   *  `FiscalYear.closingEquity` for closed years, or `balanceSheet` for
   *  the current open year. */
  clubEquityCents: bigint;
  /** Projected best-in-class equity at this point in cents (integer).
   *  Computed by compounding the first year's actual equity forward at
   *  the configured best-in-class CAGR. */
  bestInClassBenchmarkCents: bigint;
  /** Projected minimum-required equity at this point in cents. */
  minimumRequiredBenchmarkCents: bigint;
};

export type EquityHistory = {
  /** Current-period equity in cents.
   *
   *  MBR-FP-5 (2026-10-13) — this is NOW decoupled from `series`.
   *  The chart's series carries ONLY completed fiscal year-end
   *  observations; the Current Equity KPI continues to display the
   *  live-period balance sheet (e.g. Jan 31 2026) because it is a
   *  "current state" measure.  The two must not be conflated. */
  currentEquityCents: bigint;
  /** Compounded annual growth rate over the series in basis points.
   *  MBR-FP-5 — null when fewer than two distinct fiscal year-end
   *  observations exist (prevents a false "0.0 %" CAGR when the
   *  tenant has only one closed year of history). */
  actualCagrBps: number | null;
  /** Configured best-in-class benchmark CAGR in basis points. */
  bestInClassCagrBps: number;
  /** Configured minimum-required benchmark CAGR in basis points. */
  minimumRequiredCagrBps: number;
  /** Year-by-year actual + benchmark projections, oldest first.
   *  MBR-FP-5 — strictly completed fiscal year-end points.  Monthly
   *  balances no longer leak into this series. */
  series: EquityHistoryPoint[];
  /** Provenance record so tests + the UI can prove the data origin. */
  source: {
    /** "closed-fy" for closed-year snapshots, "live-bs" for current. */
    perYear: Array<{ fiscalYear: string; origin: "closed-fy" | "live-bs" | "missing" }>;
  };
};

// ---------------------------------------------------------------------------
// Math helpers
// ---------------------------------------------------------------------------

/** Compound a base in cents forward by `bps` for `years` years, returning
 *  cents (rounded to nearest integer). Uses pure float for the exponent
 *  (which is numerically safe at small exponents and basis-point precision
 *  — this is a projection, not posting math). */
function compoundForward(baseCents: bigint, bps: number, years: number): bigint {
  const rate = bps / 10_000;
  const factor = Math.pow(1 + rate, years);
  // Convert via Number; cents at $millions × 100 fit in a double well
  // below 2^53. Round half-to-even for stable test snapshots.
  const projected = Number(baseCents) * factor;
  return BigInt(Math.round(projected));
}

/** Compute the CAGR in basis points between two cent-denominated values
 *  over `years` years. Returns 0 if `from` or `years` are non-positive. */
export function computeCagrBps(fromCents: bigint, toCents: bigint, years: number): number {
  if (years <= 0 || fromCents <= 0n) return 0;
  const ratio = Number(toCents) / Number(fromCents);
  const r = Math.pow(ratio, 1 / years) - 1;
  return Math.round(r * 10_000);
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export type EquityHistoryOptions = {
  /** Number of fiscal years to include in the trend. Default 8. */
  yearsBack?: number;
  /** "As of" date for the current-year live balance sheet. Default now. */
  asOf?: Date;
};

/**
 * Returns the equity history for `clubId` ending at the FY that contains
 * (or most recently ended before) `asOf`. The return shape is consumed
 * directly by the `EquityValueCard` React component — no chart-array
 * fixture data lives in the React tree.
 *
 * Tenant scope: every Prisma read in this function filters by clubId.
 */
export async function getEquityHistory(
  clubId: string,
  options: EquityHistoryOptions = {},
): Promise<EquityHistory> {
  const yearsBack = options.yearsBack ?? DEFAULT_YEARS_BACK;
  const asOf = options.asOf ?? new Date();

  // Pull the last N COMPLETED fiscal years (endDate strictly before
  // the reporting period end) for this club, oldest first. Using
  // `endDate < asOf` enforces the "completed fiscal year" semantic
  // the Monthly Reporting Package needs:
  //   - May 2026 reporting (asOf = 2026-05-31) → most recent
  //     completed FY is FY2025 (endDate 2025-12-31). The in-progress
  //     FY2026 (endDate 2026-12-31 > asOf) is excluded by design.
  //   - Jan 2027 reporting → FY2026 now qualifies (endDate
  //     2026-12-31 < 2027-01-15) and the window rolls forward by
  //     one year.
  const fiscalYears = await prisma.fiscalYear.findMany({
    where: { clubId, endDate: { lt: asOf } },
    orderBy: { endDate: "desc" },
    take: yearsBack,
  });
  fiscalYears.reverse();

  // Resolve actual equity per FY:
  //   - closed FYs use the stored snapshot
  //   - the OPEN current FY computes live from the balance sheet
  const profile = await prisma.clubProfile.findUnique({ where: { clubId } });
  const bestInClassCagrBps =
    profile?.equityBenchmarkBestCagrBps ?? DEFAULT_BEST_IN_CLASS_CAGR_BPS;
  const minimumRequiredCagrBps =
    profile?.equityBenchmarkMinCagrBps ?? DEFAULT_MIN_REQUIRED_CAGR_BPS;

  const perYearOrigin: EquityHistory["source"]["perYear"] = [];
  const actualCents: bigint[] = [];

  for (const fy of fiscalYears) {
    let cents: bigint;
    let origin: "closed-fy" | "live-bs" | "missing";

    if (fy.closingEquity) {
      // Closing-equity snapshot always wins when present — set by the
      // period-close engine on a real club, or seeded by the
      // accounting/demo layer for demo tenants. This is the
      // authoritative accounting record for the year's equity.
      cents = decimalToCents(fy.closingEquity);
      origin = "closed-fy";
    } else {
      // No snapshot — the FY ended (the upstream `endDate < asOf`
      // filter guarantees this) but the close engine hasn't written
      // a closingEquity. Compute live from the balance sheet at
      // year-end; on any error fall through to "missing" so the
      // chart honestly surfaces a data gap.
      try {
        const bs = await balanceSheet(clubId, fy.endDate);
        cents = decimalToCents(bs.totalEquity);
        origin = "live-bs";
      } catch {
        cents = 0n;
        origin = "missing";
      }
    }

    actualCents.push(cents);
    perYearOrigin.push({ fiscalYear: fy.label, origin });
  }

  // First-year actual is the projection base for both benchmark lines.
  const baseCents = actualCents[0] ?? 0n;

  const series: EquityHistoryPoint[] = fiscalYears.map((fy, i) => ({
    fiscalYear: fy.label,
    clubEquityCents: actualCents[i],
    bestInClassBenchmarkCents: compoundForward(baseCents, bestInClassCagrBps, i),
    minimumRequiredBenchmarkCents: compoundForward(baseCents, minimumRequiredCagrBps, i),
  }));

  const currentEquityCents = actualCents[actualCents.length - 1] ?? 0n;
  const years = Math.max(0, actualCents.length - 1);
  const actualCagrBps = computeCagrBps(baseCents, currentEquityCents, years);

  // MBR-FP-5 (2026-10-13) — the live Current Equity KPI is always
  // sourced from the balance sheet at the ACTUAL reporting-period
  // asOf, independent of what's on the historical chart.  A Jan
  // 2026 package may plot only Dec 31 2025 on the chart but still
  // show Jan 31 2026 equity as the "Current Equity" KPI — the two
  // measures are intentionally different.
  const liveCurrent = await resolveLiveEquity(clubId, asOf);

  // MBR-FP-5 — snapshot-path replacement rule.  Restricted to
  // snapshots whose asOf is a COMPLETED FISCAL YEAR-END for the
  // tenant.  Monthly balances no longer leak into this series —
  // they would misrepresent a mid-year balance as an annual
  // observation.  Fiscal year-end resolution reads
  // `ClubProfile.fiscalYearEndMonth` / `.fiscalYearEndDay`; defaults
  // to Dec 31 when the tenant hasn't configured them.
  //
  // Note: `clubProfile` is reused — the earlier `profile` lookup
  // above also returns `fiscalYearEndMonth/Day` on the same row,
  // but we fetch it with its own `select` here for clarity.
  const fyProfile = await prisma.clubProfile.findUnique({
    where: { clubId },
    select: { fiscalYearEndMonth: true, fiscalYearEndDay: true },
  });
  const fyEndMonth = fyProfile?.fiscalYearEndMonth ?? 12;
  const fyEndDay = fyProfile?.fiscalYearEndDay ?? 31;

  const snapshotPoints = await getEquityPointsFromCommittedSnapshots(
    clubId,
    asOf,
    { fyEndMonth, fyEndDay },
  );
  if (snapshotPoints.length > series.length) {
    {
      const sp = snapshotPoints;
      const base = sp[0].clubEquityCents;
      const current = sp[sp.length - 1].clubEquityCents;
      const yrs = Math.max(0, sp.length - 1);
      return {
        // MBR-FP-5 — current equity decoupled from the last year-end.
        currentEquityCents: liveCurrent ?? current,
        // MBR-FP-5 — CAGR null when only one annual observation exists.
        actualCagrBps: sp.length < 2 ? null : computeCagrBps(base, current, yrs),
        // §5 — benchmark projections are suppressed on the snapshot
        // path.  Two points do not constitute a long-term benchmark
        // base; projecting a demo CAGR off a 2-point series would
        // misrepresent the data.
        bestInClassCagrBps: 0,
        minimumRequiredCagrBps: 0,
        series: sp.map((p) => ({
          fiscalYear: p.fiscalYear,
          clubEquityCents: p.clubEquityCents,
          bestInClassBenchmarkCents: 0n,
          minimumRequiredBenchmarkCents: 0n,
        })),
        source: {
          perYear: sp.map((p) => ({ fiscalYear: p.fiscalYear, origin: "live-bs" as const })),
        },
      };
    }
  }

  return {
    // MBR-FP-5 — on the FY-driven path the series already includes
    // the current open year (its last point IS the current-period
    // equity), so `currentEquityCents` is kept as the series tail.
    // The snapshot-path return above handles the Jonas-tenant case
    // where the chart plots only year-ends and the KPI needs the
    // live BS at asOf separately.
    currentEquityCents,
    // MBR-FP-5 — CAGR null when fewer than two annual observations.
    actualCagrBps: actualCents.length < 2 ? null : actualCagrBps,
    bestInClassCagrBps,
    minimumRequiredCagrBps,
    series,
    source: { perYear: perYearOrigin },
  };
}

/** MBR-FP-5 — resolve current-period equity from the live balance
 *  sheet at the reporting-period asOf.  Returns null when the BS
 *  read fails; the caller falls back to the series' last value. */
async function resolveLiveEquity(clubId: string, asOf: Date): Promise<bigint | null> {
  try {
    const bs = await balanceSheet(clubId, asOf);
    return decimalToCents(bs.totalEquity);
  } catch {
    return null;
  }
}

/** REPORT-CHART-1 §4 (2026-10-03) / MBR-FP-5 (2026-10-13) — enumerate
 *  committed TB snapshots whose `asOf` is a COMPLETED FISCAL YEAR-END
 *  for the tenant on-or-before `asOf`, and resolve equity at each
 *  via `balanceSheet`.
 *
 *  Fiscal year-end filter rule (MBR-FP-5 §2-3):
 *    - A snapshot qualifies ONLY when its `asOf` month and
 *      day-of-month equal the tenant-configured
 *      `Club.fiscalYearEndMonth` / `Club.fiscalYearEndDay`
 *      (default Dec 31).
 *    - A monthly balance (e.g. Jan 31, Feb 28, Mar 31) is NEVER
 *      an annual observation and is excluded.
 *    - The reporting-cutoff filter (`asOf: { lte: asOfEod }`) is
 *      preserved — a future year-end that's uploaded later must
 *      not appear in an earlier reporting period's package.
 *
 *  Label format: `"<YYYY>"` (e.g. `"2025"`) so the chart x-axis
 *  carries the fiscal year directly per the directive §3. */
async function getEquityPointsFromCommittedSnapshots(
  clubId: string,
  asOf: Date,
  cfg: { fyEndMonth: number; fyEndDay: number },
): Promise<Array<{ fiscalYear: string; clubEquityCents: bigint }>> {
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
  const points: Array<{ fiscalYear: string; clubEquityCents: bigint }> = [];
  // Dedupe by fiscal year to prevent two same-FY snapshots from
  // producing two points — the LATER capture wins (asOf-asc orderBy
  // → the second overwrite is the newer one).
  const byYear = new Map<string, { asOf: Date; clubEquityCents: bigint }>();
  for (const s of snapshots) {
    if (!s.asOf) continue;
    const month = s.asOf.getUTCMonth() + 1; // 1..12
    const day = s.asOf.getUTCDate();
    // MBR-FP-5 — strict fiscal year-end match.  Nothing else plots.
    if (month !== cfg.fyEndMonth || day !== cfg.fyEndDay) continue;
    try {
      const bs = await balanceSheet(clubId, s.asOf);
      const label = String(s.asOf.getUTCFullYear());
      byYear.set(label, { asOf: s.asOf, clubEquityCents: decimalToCents(bs.totalEquity) });
    } catch {
      continue;
    }
  }
  for (const [label, p] of byYear) {
    points.push({ fiscalYear: label, clubEquityCents: p.clubEquityCents });
  }
  // asOf-asc order is preserved by Map insertion order.
  return points;
}

// ---------------------------------------------------------------------------
// Decimal → cents
// ---------------------------------------------------------------------------
function decimalToCents(d: Prisma.Decimal | null | undefined): bigint {
  if (!d) return 0n;
  // Prisma.Decimal × 100, truncated to int.
  return BigInt(d.mul(CENTS).toFixed(0));
}
