// GOLF-HIST-1 (2026-10-05) — canonical Golf Activity resolver.
//
// Provider-neutral: reads the `GolfActivityDay` table. The reporting
// layer MUST consume this resolver — not the raw table, not the
// import rows (uncommitted), not any provider-specific code path. A
// future GGGolf live connector writes to the same table through its
// own loader; this resolver returns the same shape to callers.
//
// Semantic:
//   - "activeDays"   — days in the period with totalRounds > 0.
//   - "realZeroDays" — days in the period with totalRounds == 0
//                      AND the Golf source recorded the day
//                      (authoritative zero).
//   - "missingDays"  — days in the period with NO GolfActivityDay
//                      row (the Golf source either doesn't cover
//                      the date OR hasn't been imported yet).
//
// Period Average Rounds (periodAverageRoundsPerDay) is calculated as
//   totalRounds / (activeDays + realZeroDays)
// = rounds per day of authoritative coverage. Missing dates are
// EXCLUDED from the denominator because the Golf source has not
// established what happened on those days. (Directive: "Real zero-
// round days must participate in averages when the Golf source
// establishes that the day had zero activity. Missing Golf Activity
// dates must not be treated as zero.")

import { prisma } from "@/lib/prisma";

export type GolfActivityDayView = {
  activityDate: Date;
  dateISO: string;         // "YYYY-MM-DD" (UTC midnight slice)
  totalRounds: number;
  memberRounds: number;
  guestRounds: number;
  greenFeeRounds: number;
  juniorRounds: number;
  womenRounds: number;
  sourceSystem: string;
  sourceBatchId: string | null;
};

export type GolfActivitySummary = {
  clubId: string;
  periodStart: Date;
  periodEnd: Date;
  // Days returned to the caller, in ascending date order.
  days: GolfActivityDayView[];
  // Aggregates.
  totalRounds: number;
  memberRounds: number;
  guestRounds: number;
  activeDays: number;      // days with totalRounds > 0
  realZeroDays: number;    // days with totalRounds == 0 (authoritative)
  missingDates: Date[];    // days in [periodStart, periodEnd] with NO row
  // Period Average Rounds — rounds per authoritative day. Null when
  // no authoritative coverage.
  periodAverageRoundsPerDay: number | null;
  // Member/guest mix (fractions of totalRounds). Null when totalRounds
  // is zero.
  memberSharePct: number | null;
  guestSharePct: number | null;
  // Provenance.
  dataAvailable: boolean;  // true iff at least one row for the period
  sourceSystems: string[]; // distinct sourceSystem values represented
};

export type ResolveGolfActivityInput = {
  clubId: string;
  periodStart: Date;
  periodEnd: Date;
};

export async function resolveGolfActivity(
  input: ResolveGolfActivityInput,
): Promise<GolfActivitySummary> {
  const { clubId, periodStart, periodEnd } = input;
  const rows = await prisma.golfActivityDay.findMany({
    where: {
      clubId,
      activityDate: { gte: periodStart, lte: periodEnd },
    },
    orderBy: { activityDate: "asc" },
    select: {
      activityDate: true,
      totalRounds: true,
      members: true,
      guests: true,
      greenFees: true,
      juniors: true,
      women: true,
      sourceSystem: true,
      sourceBatchId: true,
    },
  });

  const days: GolfActivityDayView[] = rows.map((r) => ({
    activityDate: r.activityDate,
    dateISO: r.activityDate.toISOString().slice(0, 10),
    totalRounds: r.totalRounds,
    memberRounds: r.members,
    guestRounds: r.guests,
    greenFeeRounds: r.greenFees,
    juniorRounds: r.juniors,
    womenRounds: r.women,
    sourceSystem: r.sourceSystem,
    sourceBatchId: r.sourceBatchId,
  }));

  let totalRounds = 0, memberRounds = 0, guestRounds = 0;
  let activeDays = 0, realZeroDays = 0;
  const sourceSet = new Set<string>();
  for (const d of days) {
    totalRounds += d.totalRounds;
    memberRounds += d.memberRounds;
    guestRounds += d.guestRounds;
    if (d.totalRounds > 0) activeDays++;
    else realZeroDays++;
    sourceSet.add(d.sourceSystem);
  }

  const authoritativeDays = activeDays + realZeroDays;
  const periodAverageRoundsPerDay = authoritativeDays > 0
    ? totalRounds / authoritativeDays
    : null;

  const memberSharePct = totalRounds > 0 ? (memberRounds / totalRounds) * 100 : null;
  const guestSharePct  = totalRounds > 0 ? (guestRounds  / totalRounds) * 100 : null;

  const missingDates = computeMissingDates(periodStart, periodEnd, days);

  return {
    clubId,
    periodStart,
    periodEnd,
    days,
    totalRounds,
    memberRounds,
    guestRounds,
    activeDays,
    realZeroDays,
    missingDates,
    periodAverageRoundsPerDay,
    memberSharePct,
    guestSharePct,
    dataAvailable: days.length > 0,
    sourceSystems: Array.from(sourceSet).sort(),
  };
}

/** Enumerate the dates in [start, end] (inclusive, UTC midnights) that
 *  are not represented by any `GolfActivityDay` row returned above.
 *  Used by the Section XI "missing dates" callout. */
function computeMissingDates(
  periodStart: Date,
  periodEnd: Date,
  days: GolfActivityDayView[],
): Date[] {
  const haveDates = new Set(days.map((d) => d.dateISO));
  const missing: Date[] = [];
  const start = new Date(Date.UTC(
    periodStart.getUTCFullYear(),
    periodStart.getUTCMonth(),
    periodStart.getUTCDate(),
  ));
  const end = new Date(Date.UTC(
    periodEnd.getUTCFullYear(),
    periodEnd.getUTCMonth(),
    periodEnd.getUTCDate(),
  ));
  for (let d = start.getTime(); d <= end.getTime(); d += 86_400_000) {
    const iso = new Date(d).toISOString().slice(0, 10);
    if (!haveDates.has(iso)) missing.push(new Date(d));
  }
  return missing;
}
