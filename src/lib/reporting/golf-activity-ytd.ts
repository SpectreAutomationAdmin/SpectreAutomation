// OPS-LIVE-1 (2026-10-06) — canonical Golf Activity YTD resolver.
//
// ONE provider-neutral resolver shared by Section IX (Operating
// Statistics) and Section XI (Utilization Outcomes). Both sections
// MUST consume the same resolver and return the same values for the
// same (clubId, period). Separate calculations are forbidden by the
// OPS-LIVE-1 directive ("Do not let Sections IX and XI independently
// calculate the same operating metric.").
//
// YTD boundary semantics:
//   - YTD start = fiscal year start of the fiscal year the reporting
//                 period falls in. For clubs with no configured
//                 fiscal-year-end (Coulee), that's Jan 1 of the
//                 reporting period's year (calendar YTD).
//   - YTD end   = reporting period end (last day of the reporting
//                 month, UTC midnight).
//
// Coverage semantics:
//   - "coverage days expected" = (ytdEnd - ytdStart + 1) in whole days.
//   - "coverage days present" = count of GolfActivityDay rows in that
//                               range (authoritative + real-zero).
//   - "coverage complete" = coverage days present === coverage days
//                           expected.
//   - Partial coverage is reported honestly — never fabricated.

import { prisma } from "@/lib/prisma";
import { getFiscalPeriodForClub } from "@/lib/clubs/profile";
import { resolveGolfActivity } from "@/lib/reporting/golf-activity-resolver";

export type GolfActivityYtd = {
  clubId: string;
  ytdStart: Date;
  ytdEnd: Date;
  // Expected daily rows from ytdStart..ytdEnd inclusive (calendar count).
  coverageDaysExpected: number;
  // Days with a committed GolfActivityDay row.
  coverageDaysPresent: number;
  // True iff the Golf source covers every expected day in the YTD
  // window (including authoritative zero days).
  coverageComplete: boolean;
  // Authoritative aggregates — null when `coverageDaysPresent === 0`
  // so downstream consumers can distinguish "no coverage" from
  // "real zero across the period".
  totalRounds: number | null;
  memberRounds: number | null;
  guestRounds: number | null;
  // Guest share percent (guestRounds / totalRounds * 100). Null
  // when totalRounds is null or zero.
  guestSharePct: number | null;
  // Source system(s) that supplied the committed data, provenance
  // for the acceptance package. [] when no coverage.
  sourceSystems: string[];
};

export type ResolveGolfYtdInput = {
  clubId: string;
  /** The reporting period's monthEnd date (UTC midnight of the last
   *  calendar day of the month, typically derived from
   *  `ReportingPeriod` by `new Date(Date.UTC(year, month, 0))`). */
  periodEnd: Date;
};

/** Canonical YTD resolver. */
export async function resolveGolfActivityYtd(input: ResolveGolfYtdInput): Promise<GolfActivityYtd> {
  const { clubId, periodEnd } = input;
  const ytdStart = await resolveYtdStart(clubId, periodEnd);
  const ytdEnd = new Date(Date.UTC(
    periodEnd.getUTCFullYear(),
    periodEnd.getUTCMonth(),
    periodEnd.getUTCDate(),
  ));

  const activity = await resolveGolfActivity({
    clubId,
    periodStart: ytdStart,
    periodEnd: ytdEnd,
  });

  const coverageDaysExpected = daysBetweenInclusive(ytdStart, ytdEnd);
  const coverageDaysPresent = activity.days.length;
  const coverageComplete = coverageDaysPresent === coverageDaysExpected && coverageDaysExpected > 0;

  const totalRounds = coverageDaysPresent > 0 ? activity.totalRounds : null;
  const memberRounds = coverageDaysPresent > 0 ? activity.memberRounds : null;
  const guestRounds = coverageDaysPresent > 0 ? activity.guestRounds : null;
  const guestSharePct =
    totalRounds != null && totalRounds > 0 && guestRounds != null
      ? (guestRounds / totalRounds) * 100
      : null;

  return {
    clubId,
    ytdStart,
    ytdEnd,
    coverageDaysExpected,
    coverageDaysPresent,
    coverageComplete,
    totalRounds,
    memberRounds,
    guestRounds,
    guestSharePct,
    sourceSystems: activity.sourceSystems,
  };
}

/** Resolve the fiscal YTD start date for a club. Clubs with no
 *  configured fiscal year end fall back to calendar YTD (Jan 1 of
 *  the reporting year). */
async function resolveYtdStart(clubId: string, periodEnd: Date): Promise<Date> {
  // Attempt to use the configured fiscal year.
  const fiscalPeriod = await getFiscalPeriodForClub(clubId, periodEnd);
  if (fiscalPeriod && fiscalPeriod.fiscalYearStart instanceof Date) {
    return new Date(Date.UTC(
      fiscalPeriod.fiscalYearStart.getUTCFullYear(),
      fiscalPeriod.fiscalYearStart.getUTCMonth(),
      fiscalPeriod.fiscalYearStart.getUTCDate(),
    ));
  }
  // Fallback: calendar year start of the periodEnd year.
  return new Date(Date.UTC(periodEnd.getUTCFullYear(), 0, 1));
}

function daysBetweenInclusive(a: Date, b: Date): number {
  const start = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate())).getTime();
  const end = new Date(Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate())).getTime();
  const diffDays = Math.round((end - start) / 86_400_000);
  return Math.max(0, diffDays + 1);
}

// =============================================================================
// Pre-check helpers for tests that stub out Prisma.
// =============================================================================

/** Small helper exposing the day-span calculation for unit tests. */
export const _opsLive1Internals = { daysBetweenInclusive, resolveYtdStart };
void prisma; // keep bundler aware of the dependency
