// Payroll-3D-4 (2026-09-05) — Cutoff instant helper.
//
// The cutoff is the moment beyond which time approvals are treated
// as LATE for a given pay period. Default: 5 calendar days before
// scheduled payDate, at the START of that day in the Club's IANA
// timezone (so approvals earlier that day are still on-time). Clubs
// may override the lead via `PayrollClubConfig.payrollCutoffLeadDays`.
//
// Inclusive/exclusive rule (§43): approvals whose commit timestamp
// is <= cutoffInstant are ON_TIME. > cutoffInstant is LATE.

const DEFAULT_CUTOFF_LEAD_DAYS = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Given a pay-period pay date (canonical UTC anchor from the
 *  payroll calendar) and the Club's IANA timezone, return the UTC
 *  instant that represents the start of `payDate - leadDays` in
 *  that timezone. */
export function computeCutoffInstant(
  payDate: Date,
  clubTimezone: string | null,
  leadDays: number = DEFAULT_CUTOFF_LEAD_DAYS,
): Date {
  const iana = clubTimezone ?? "UTC";
  const rawCutoff = new Date(payDate.getTime() - leadDays * DAY_MS);
  // Compute the local YYYY-MM-DD components in the Club tz.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: iana, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(rawCutoff);
  const y  = Number(parts.find((p) => p.type === "year")!.value);
  const mo = Number(parts.find((p) => p.type === "month")!.value);
  const d  = Number(parts.find((p) => p.type === "day")!.value);
  // Convert local midnight → UTC via iterative offset resolution.
  const guess = new Date(Date.UTC(y, mo - 1, d, 0, 0, 0));
  const offset = tzOffsetMs(guess, iana);
  return new Date(guess.getTime() - offset);
}

function tzOffsetMs(at: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
  const parts = dtf.formatToParts(at);
  const y  = Number(parts.find((p) => p.type === "year")!.value);
  const mo = Number(parts.find((p) => p.type === "month")!.value);
  const d  = Number(parts.find((p) => p.type === "day")!.value);
  const hh = Number(parts.find((p) => p.type === "hour")!.value);
  const mm = Number(parts.find((p) => p.type === "minute")!.value);
  const ss = Number(parts.find((p) => p.type === "second")!.value);
  return Date.UTC(y, mo - 1, d, hh, mm, ss) - at.getTime();
}

export type CutoffTiming = "ON_TIME" | "LATE";

export function classifyCutoffTiming(
  approvedAt: Date, cutoffInstant: Date,
): CutoffTiming {
  return approvedAt.getTime() <= cutoffInstant.getTime() ? "ON_TIME" : "LATE";
}
