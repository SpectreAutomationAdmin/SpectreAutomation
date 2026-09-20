// Slice F (2026-09-19) — Alberta ES overtime classifier.
//
// AUTHORITATIVE RULE (Employment Standards Code + AR 14/1997 + alberta.ca):
//   • Daily threshold  : 8 hours/day
//   • Weekly threshold : 44 hours/week
//   • "Greater-of" rule: OT owed for the workweek =
//                       MAX(sum of daily-OT hours in workweek,
//                           workweek total − 44).
//   • Multiplier       : 1.5× regular wage rate.
//   • Workweek         : 7 consecutive days. Employer chooses the
//                       start day; default Sunday (dow=0).
//   • Salary alone     : NOT an exemption. Only AR 14/1997 exempts
//                       (managers, professionals, etc.).
//
// This module does NOT decide policy STATE (STANDARD / EXEMPT /
// AGREEMENT_REQUIRED / AVERAGING_REQUIRED) — that's Prepare's fail-
// closed gate. This module classifies hours GIVEN that STANDARD applies.
//
// ALLOCATION MODEL for cross-period workweeks:
//   Walk the workweek chronologically. Daily OT accrues on each day
//   (max(0, day.hours − 8)); the rest are "regular candidates".
//   Any extra weekly-OT (weekly_total − 44 exceeding daily_OT_sum) is
//   allocated to the LATEST regular hours in reverse chronological
//   order. Then hours for each day are pinned to (regular, overtime).
//   To split into pay periods, sum daily tuples whose workDate ∈ period.
//
// Guarantees:
//   • Total hours preserved (regular + overtime = HW across the workweek).
//   • No hour classified twice.
//   • Overtime allocated only to hours that actually earned it.
//   • Cross-period workweeks split cleanly with no double counting.

import { Decimal } from "./statutory/decimal-money";

export type OvertimePolicyKind = "ALBERTA_DEFAULT_ES";

/**
 * Statutory OT rules. Owned by the province / jurisdiction. Does NOT
 * carry a workweek anchor — the workweek is a CLUB choice, not part
 * of the statutory rule set (Slice F workweek-closeout, 2026-09-19).
 */
export interface OvertimePolicyConfig {
  kind: OvertimePolicyKind;
  dailyThresholdHours: Decimal;
  weeklyThresholdHours: Decimal;
  multiplier: Decimal;
}

/** Durable day-of-week naming. Stored on `PayrollClubConfig.workweekStartsOn`. */
export type WorkweekStartsOn =
  | "SUNDAY" | "MONDAY" | "TUESDAY" | "WEDNESDAY"
  | "THURSDAY" | "FRIDAY" | "SATURDAY";

const DOW_NUM: Record<WorkweekStartsOn, number> = {
  SUNDAY: 0, MONDAY: 1, TUESDAY: 2, WEDNESDAY: 3,
  THURSDAY: 4, FRIDAY: 5, SATURDAY: 6,
};

/** Map durable name → JS Date-compatible 0..6 integer. Throws on unknown. */
export function workweekStartsOnToDow(name: WorkweekStartsOn | string): number {
  const n = (name ?? "").toString().toUpperCase();
  if (!(n in DOW_NUM)) {
    throw new Error(`Unknown workweekStartsOn value: ${name}. Expected SUNDAY..SATURDAY.`);
  }
  return DOW_NUM[n as WorkweekStartsOn];
}

/** Inverse map — used to display the workweek label consistently. */
export function dowToWorkweekStartsOn(dow: number): WorkweekStartsOn {
  const entry = Object.entries(DOW_NUM).find(([, v]) => v === dow);
  if (!entry) throw new Error(`Workweek DOW out of range 0..6: ${dow}`);
  return entry[0] as WorkweekStartsOn;
}

export interface ApprovedTimeEntryLike {
  id: string;
  workDate: Date;                // civil date (UTC midnight)
  hours: Decimal;                // approved payable hours for the day
}

export interface ClassifiedDay {
  workDate: Date;                // civil date (UTC midnight)
  regularHours: Decimal;
  overtimeHours: Decimal;
  sourceEntryIds: string[];      // provenance
}

export interface WorkweekClassification {
  workweekStart: Date;
  workweekEnd: Date;             // exclusive — start + 7 days
  totalHours: Decimal;
  regularHours: Decimal;
  overtimeHours: Decimal;
  days: ClassifiedDay[];         // one entry per day that had approved time
}

/** Compute the workweek start (UTC-midnight civil date) for a workDate. */
export function workweekStartFor(workDate: Date, workweekStartDow: number): Date {
  const dow = workDate.getUTCDay();
  const backDays = (dow - workweekStartDow + 7) % 7;
  const start = new Date(workDate.getTime() - backDays * 86_400_000);
  // Snap to UTC-midnight for civil-date safety.
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
}

/** Sum entries by their civil workDate (UTC midnight). */
function groupByCivilDate(entries: ApprovedTimeEntryLike[]): Map<number, ApprovedTimeEntryLike[]> {
  const bucket = new Map<number, ApprovedTimeEntryLike[]>();
  for (const e of entries) {
    const civil = Date.UTC(e.workDate.getUTCFullYear(), e.workDate.getUTCMonth(), e.workDate.getUTCDate());
    const list = bucket.get(civil) ?? [];
    list.push(e);
    bucket.set(civil, list);
  }
  return bucket;
}

/**
 * Classify a SINGLE workweek's approved time under the Alberta ES
 * "greater-of" rule. Returns per-day tuples so callers can allocate to
 * pay periods.
 */
export function classifyWorkweek(
  entriesInWorkweek: ApprovedTimeEntryLike[],
  policy: OvertimePolicyConfig,
  workweekStartDow: number,
): WorkweekClassification {
  if (entriesInWorkweek.length === 0) {
    // Empty workweek — return a stub for callers that must produce a
    // workweek row anyway.
    return {
      workweekStart: new Date(0),
      workweekEnd: new Date(0),
      totalHours: new Decimal(0),
      regularHours: new Decimal(0),
      overtimeHours: new Decimal(0),
      days: [],
    };
  }
  // Determine workweek boundaries from any entry (all belong to the same week).
  const workweekStart = workweekStartFor(entriesInWorkweek[0]!.workDate, workweekStartDow);
  const workweekEnd = new Date(workweekStart.getTime() + 7 * 86_400_000);

  const dailyMap = groupByCivilDate(entriesInWorkweek);
  const civilKeys = [...dailyMap.keys()].sort();

  // Step 1: compute per-day totals and daily OT.
  interface DayBucket {
    workDate: Date;
    total: Decimal;
    regularCandidate: Decimal;
    dailyOvertime: Decimal;
    sourceEntryIds: string[];
  }
  const days: DayBucket[] = civilKeys.map((civil) => {
    const list = dailyMap.get(civil)!;
    const total = list.reduce<Decimal>((a, e) => a.plus(e.hours), new Decimal(0));
    const dailyOT = Decimal.max(new Decimal(0), total.minus(policy.dailyThresholdHours));
    return {
      workDate: new Date(civil),
      total,
      regularCandidate: total.minus(dailyOT),
      dailyOvertime: dailyOT,
      sourceEntryIds: list.map((e) => e.id),
    };
  });

  const dailyOtSum = days.reduce<Decimal>((a, d) => a.plus(d.dailyOvertime), new Decimal(0));
  const totalHours = days.reduce<Decimal>((a, d) => a.plus(d.total), new Decimal(0));
  const weeklyOt = Decimal.max(new Decimal(0), totalHours.minus(policy.weeklyThresholdHours));
  const workweekOt = Decimal.max(dailyOtSum, weeklyOt);

  // Step 2: allocate any EXTRA OT (workweekOt − dailyOtSum) to the
  // LATEST regular hours in reverse chronological order.
  let extraOtRemaining = workweekOt.minus(dailyOtSum);
  if (extraOtRemaining.gt(0)) {
    for (let i = days.length - 1; i >= 0 && extraOtRemaining.gt(0); i--) {
      const d = days[i]!;
      if (d.regularCandidate.lte(0)) continue;
      const take = Decimal.min(d.regularCandidate, extraOtRemaining);
      d.regularCandidate = d.regularCandidate.minus(take);
      d.dailyOvertime = d.dailyOvertime.plus(take);
      extraOtRemaining = extraOtRemaining.minus(take);
    }
  }

  const classified: ClassifiedDay[] = days.map((d) => ({
    workDate: d.workDate,
    regularHours: d.regularCandidate,
    overtimeHours: d.dailyOvertime,
    sourceEntryIds: d.sourceEntryIds,
  }));

  const regularHours = classified.reduce<Decimal>((a, d) => a.plus(d.regularHours), new Decimal(0));
  const overtimeHours = classified.reduce<Decimal>((a, d) => a.plus(d.overtimeHours), new Decimal(0));

  return {
    workweekStart,
    workweekEnd,
    totalHours,
    regularHours,
    overtimeHours,
    days: classified,
  };
}

/**
 * Given approved-time entries covering a pay period (plus any spillover
 * needed for full workweek context), return the regular + overtime
 * hours attributable to the pay period.
 *
 * Caller MUST fetch approved-time entries for the union of workweeks
 * that overlap the pay period — the classifier trusts the input set is
 * complete for every workweek it touches.
 */
export function classifyForPayPeriod(
  entries: ApprovedTimeEntryLike[],
  payPeriodStart: Date,      // inclusive UTC midnight
  payPeriodEnd: Date,        // exclusive UTC midnight
  policy: OvertimePolicyConfig,
  workweekStartDow: number,
): {
  regularHours: Decimal;
  overtimeHours: Decimal;
  workweeks: WorkweekClassification[];
} {
  // Group entries by workweek.
  const workweekBuckets = new Map<number, ApprovedTimeEntryLike[]>();
  for (const e of entries) {
    const wwStart = workweekStartFor(e.workDate, workweekStartDow);
    const key = wwStart.getTime();
    const list = workweekBuckets.get(key) ?? [];
    list.push(e);
    workweekBuckets.set(key, list);
  }

  const workweeks: WorkweekClassification[] = [];
  let regular = new Decimal(0);
  let overtime = new Decimal(0);
  for (const [, weekEntries] of workweekBuckets.entries()) {
    const wc = classifyWorkweek(weekEntries, policy, workweekStartDow);
    workweeks.push(wc);
    // Sum days that fall inside the pay period.
    for (const d of wc.days) {
      if (d.workDate.getTime() < payPeriodStart.getTime()) continue;
      if (d.workDate.getTime() >= payPeriodEnd.getTime()) continue;
      regular = regular.plus(d.regularHours);
      overtime = overtime.plus(d.overtimeHours);
    }
  }
  return { regularHours: regular, overtimeHours: overtime, workweeks };
}

/** For a given pay period, return the earliest workweek-start and
 *  latest workweek-end that overlap it. Used by Prepare to fetch the
 *  full approved-time context. */
export function surroundingWorkweekBounds(
  payPeriodStart: Date,
  payPeriodEnd: Date,          // exclusive
  workweekStartDow: number,
): { fetchStart: Date; fetchEnd: Date } {
  const fetchStart = workweekStartFor(payPeriodStart, workweekStartDow);
  // payPeriodEnd is exclusive; the last day is periodEnd − 1 day.
  const lastDayInclusive = new Date(payPeriodEnd.getTime() - 86_400_000);
  const lastWorkweekStart = workweekStartFor(lastDayInclusive, workweekStartDow);
  const fetchEnd = new Date(lastWorkweekStart.getTime() + 7 * 86_400_000);
  return { fetchStart, fetchEnd };
}
