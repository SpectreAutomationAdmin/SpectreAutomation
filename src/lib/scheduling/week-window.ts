// Scheduling Foundation · Phase D (2026-09-07) — canonical week
// window helpers.
//
// Week boundaries are Monday 00:00 → next Monday 00:00 in UTC. Club-
// timezone-aware bounding could be added later if needed; the shifts
// UI currently reads shift.startAt (already an instant) so a UTC
// week window is sufficient for the query filter.
//
// Never mix `Date.getDay()` (Sunday=0) with our ISO-week convention
// (Monday=start-of-week).

const MS_PER_DAY = 86_400_000;

/**
 * Given an arbitrary instant, return the UTC-midnight of the Monday
 * that begins that instant's ISO week.
 */
export function isoWeekStart(at: Date): Date {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  // JS: Sunday=0, Monday=1, ..., Saturday=6.
  // Days to subtract to reach the ISO week's Monday.
  const daysBack = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - daysBack * MS_PER_DAY);
}

/** Add whole days to a Date (UTC-safe). */
export function addDays(at: Date, days: number): Date {
  return new Date(at.getTime() + days * MS_PER_DAY);
}

/** The Monday-anchored [start, end) window that contains `at`. */
export function isoWeekWindow(at: Date): { start: Date; end: Date } {
  const start = isoWeekStart(at);
  return { start, end: addDays(start, 7) };
}

/** Human label: "September 7 – 13, 2026" (or "Aug 29 – Sep 4, 2026"
 *  when the week crosses months). */
export function isoWeekLabel(weekStart: Date): string {
  const start = weekStart;
  const end = addDays(weekStart, 6);
  const startFmt = start.toLocaleDateString("en-US", {
    month: "long", day: "numeric", timeZone: "UTC",
  });
  const endFmt = start.getUTCMonth() === end.getUTCMonth()
    ? end.toLocaleDateString("en-US", { day: "numeric", timeZone: "UTC" })
    : end.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  return `${startFmt} – ${endFmt}, ${end.getUTCFullYear()}`;
}

/** Return the 7 dates (UTC-midnight) of a week starting at weekStart. */
export function weekDays(weekStart: Date): Date[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}
