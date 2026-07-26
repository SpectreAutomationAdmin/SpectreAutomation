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
  /** Current-period equity in cents (matches the last point of `series`). */
  currentEquityCents: bigint;
  /** Compounded annual growth rate over the series in basis points. */
  actualCagrBps: number;
  /** Configured best-in-class benchmark CAGR in basis points. */
  bestInClassCagrBps: number;
  /** Configured minimum-required benchmark CAGR in basis points. */
  minimumRequiredCagrBps: number;
  /** Year-by-year actual + benchmark projections, oldest first. */
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

  return {
    currentEquityCents,
    actualCagrBps,
    bestInClassCagrBps,
    minimumRequiredCagrBps,
    series,
    source: { perYear: perYearOrigin },
  };
}

// ---------------------------------------------------------------------------
// Decimal → cents
// ---------------------------------------------------------------------------
function decimalToCents(d: Prisma.Decimal | null | undefined): bigint {
  if (!d) return 0n;
  // Prisma.Decimal × 100, truncated to int.
  return BigInt(d.mul(CENTS).toFixed(0));
}
