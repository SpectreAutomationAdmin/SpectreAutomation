// WI-2B (2026-09-27) — "Today · 11:24 AM" / "Yesterday · 4:36 PM"
// timestamp formatter for the accepted Work Intake feed.
//
// Composes over the existing timezone-aware calendar helpers in
// mission-control/arrival.ts. All formatting is done in the CLUB's
// IANA timezone — never the server or the viewer's local time.

import { toLocalDateString, todayLocalDateString } from "@/lib/mission-control/arrival";

/**
 * Format an ISO timestamp into the accepted feed presentation form:
 *   same day    → "Today · 11:24 AM"
 *   yesterday   → "Yesterday · 4:36 PM"
 *   this week   → "Mon · 4:36 PM"
 *   older       → "May 12, 2024"
 *
 * The comparison uses the wall-clock date in the club's timezone.
 * A missing/invalid iso returns the empty string.
 */
export function formatFeedTimestamp(
  iso: string | null | undefined,
  clubTimezone: string,
  nowIsoOverride?: string,
): string {
  if (!iso) return "";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const now = nowIsoOverride ? new Date(nowIsoOverride) : new Date();
  if (Number.isNaN(now.getTime())) return "";

  const zone = clubTimezone || "UTC";
  const atDay = toLocalDateString(at, zone);          // YYYY-MM-DD
  const today = todayLocalDateString(zone, now);      // YYYY-MM-DD
  const yesterday = shiftIsoDate(today, -1);          // YYYY-MM-DD

  const timePart = formatTimeInZone(at, zone);
  if (atDay === today) return `Today · ${timePart}`;
  if (atDay === yesterday) return `Yesterday · ${timePart}`;

  const daysAgo = daysBetween(atDay, today);
  if (daysAgo > 0 && daysAgo < 7) {
    // "Mon · 4:36 PM"
    return `${formatWeekdayInZone(at, zone)} · ${timePart}`;
  }

  // Older than a week — calendar date, no time.
  return formatCalendarDateInZone(at, zone);
}

// --------- internal helpers ---------

function pad2(s: string | number): string {
  return String(s).padStart(2, "0");
}

/** Return a wall-clock date shifted by `days` (integer). Pure string
 *  math — no Date object is constructed, so no DST ambiguity. */
function shiftIsoDate(isoDate: string, days: number): string {
  // isoDate is YYYY-MM-DD. Use Date UTC arithmetic to avoid DST issues.
  const [y, m, d] = isoDate.split("-").map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86_400_000;
  const dt = new Date(t);
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/** Non-negative day count between two YYYY-MM-DD strings (a - b). */
function daysBetween(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const at = Date.UTC(by, bm - 1, bd);
  const bt = Date.UTC(ay, am - 1, ad);
  return Math.round((at - bt) / 86_400_000);
}

function formatTimeInZone(d: Date, zone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone, hour: "numeric", minute: "2-digit", hour12: true,
  }).formatToParts(d);
  // Intl produces e.g. "4:36 PM" with a narrow non-breaking space
  // between the number and the meridiem. Normalise to a plain space.
  return parts.map((p) => p.value).join("").replace(/ /g, " ");
}

function formatWeekdayInZone(d: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone, weekday: "short",
  }).format(d);
}

function formatCalendarDateInZone(d: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone, month: "short", day: "numeric", year: "numeric",
  }).format(d);
}
