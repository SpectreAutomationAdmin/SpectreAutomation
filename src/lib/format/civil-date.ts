// AUTH-3D.CLOSEOUT-FIX (2026-09-26) — shared calendar-date renderer.
//
// PROBLEM: Spectre stores many business calendar-dates (termination,
// hire, DOB, effective-from/to, pay-period boundaries, TD1 effective,
// training completion) as `DateTime` columns at UTC midnight per the
// civil-date convention. Rendering them with `new Date(iso).
// toLocaleDateString(undefined, {...})` applies the viewer's local
// timezone offset — so a value written as "2026-09-26" (stored as
// 2026-09-26T00:00:00.000Z) renders as **September 25** for any
// viewer west of UTC.
//
// A termination date is a business calendar date. It is not a moment
// in time. It must render as the day it was captured as, regardless
// of the viewer's timezone.
//
// This helper reads the value's UTC calendar fields directly and
// formats them without applying any timezone shift. It is the single
// canonical renderer for civil-date semantics.
//
// USE THIS FOR:
//   - termination date, hire date, start date, end date
//   - date of birth
//   - compensation / assignment / allowance effective-from / -to
//   - pay period start / end
//   - TD1 / tax effective dates
//   - training completion / expiry dates
//
// DO NOT USE THIS FOR:
//   - "last saved at" timestamps, "created at", "uploaded at", or any
//     other value that represents a specific moment in time (those
//     SHOULD render in the viewer's local timezone).

const MONTHS_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

const MONTHS_LONG = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
] as const;

export type CivilDateInput = string | Date | null | undefined;

export interface FormatCivilDateOptions {
  /** "short" (default) → "Sep 26, 2026". "long" → "September 26, 2026". */
  month?: "short" | "long";
  /** Value to return when the input is null/undefined/invalid. Default: null. */
  fallback?: string | null;
}

/** Render a business calendar-date without applying the viewer's
 *  timezone offset. See file header for what this is / is not for. */
export function formatCivilDate(
  value: CivilDateInput,
  opts: FormatCivilDateOptions = {},
): string | null {
  const fallback = opts.fallback ?? null;
  if (value === null || value === undefined || value === "") return fallback;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return fallback;
  const y = d.getUTCFullYear();
  const mIdx = d.getUTCMonth();
  const day = d.getUTCDate();
  const names = opts.month === "long" ? MONTHS_LONG : MONTHS_SHORT;
  return `${names[mIdx]} ${day}, ${y}`;
}
