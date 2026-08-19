// Mission Control local-time utilities (Phase 4R rev-3 · 2026-08-15).
//
// ONE source of truth for the two questions the founder asked:
//   1. "What time is it for THIS TENANT right now?"
//   2. "How does Spectre display a meeting time?"
//
// Both consumers (greeting derivation + Today's Commitments row
// formatting) MUST read from here so a future change to the tenant
// timezone convention or the display convention lives in ONE place.
//
// Design notes:
//   • Everything is timezone-aware. `new Date().getHours()` is
//     STRICTLY FORBIDDEN in Mission Control display paths — it
//     returns the SERVER local hour, which on Fly.io is UTC. That
//     was the founder-reported "Good evening" bug (server = 21:00
//     UTC while Alberta was 15:00 MDT).
//   • IANA zones only. NEVER hardcode a UTC offset (`-6`, `-7`) —
//     Alberta observes daylight-saving transitions, so offsets
//     shift twice a year. `Intl.DateTimeFormat` reads the current
//     IANA rules and is DST-safe by construction.
//   • The tenant's IANA zone is already resolved by
//     `snapshot.clubTimezone.ianaZone` in the Mission Control
//     loader — do not reinvent that lookup here.

export type TimeOfDay = "morning" | "afternoon" | "evening";

/**
 * Boundaries chosen to match the founder-approved language contract
 * (`Good morning` / `Good afternoon` / `Good evening`):
 *
 *   • morning:   05:00 – 11:59  local
 *   • afternoon: 12:00 – 16:59  local
 *   • evening:   17:00 onward   local
 *
 * "Evening" also absorbs the 00:00 – 04:59 pre-dawn window — a
 * conservative choice: a 3am login is treated as "still evening"
 * rather than "already morning". Consumers that need a distinct
 * "night" band can extend this without touching call sites.
 */
export const GREETING_BOUNDARIES = {
  morningStartHour: 5,
  afternoonStartHour: 12,
  eveningStartHour: 17,
} as const;

function extractLocalHour(instant: Date, ianaZone: string): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ianaZone,
    hour: "2-digit",
    hour12: false,
  }).formatToParts(instant);
  const raw = parts.find((p) => p.type === "hour")?.value ?? "0";
  const n = parseInt(raw, 10);
  // Intl returns "24" at midnight for hour12:false — normalise.
  return Number.isFinite(n) ? (n === 24 ? 0 : n) : 0;
}

/**
 * Resolve the founder greeting time-of-day from an absolute UTC
 * instant + the tenant's IANA timezone. Never consults the server
 * local timezone.
 */
export function getTimeOfDay(instant: Date, ianaZone: string): TimeOfDay {
  const h = extractLocalHour(instant, ianaZone);
  if (h >= GREETING_BOUNDARIES.eveningStartHour) return "evening";
  if (h >= GREETING_BOUNDARIES.afternoonStartHour) return "afternoon";
  if (h >= GREETING_BOUNDARIES.morningStartHour) return "morning";
  return "evening"; // 00:00 – 04:59 wraps into evening
}

export function greetingWordForInstant(instant: Date, ianaZone: string): string {
  switch (getTimeOfDay(instant, ianaZone)) {
    case "morning":   return "Good morning";
    case "afternoon": return "Good afternoon";
    case "evening":   return "Good evening";
  }
}

/**
 * Format an absolute UTC instant as `H:MM AM/PM` in the tenant's
 * IANA timezone. Founder rules:
 *   • no leading zero on the hour
 *   • minutes always two digits
 *   • uppercase AM / PM
 *   • 12-hour clock (00:00 → 12:00 AM, 12:00 → 12:00 PM, 13:30 → 1:30 PM)
 *
 * Replaces the prior `formatLocalTime` (hour12:false) in
 * `src/lib/mission-control/commitments.ts`.
 */
export function formatLocalTimeAmPm(instant: Date, ianaZone: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: ianaZone,
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).formatToParts(instant);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hour = g("hour");
  const minute = g("minute").padStart(2, "0");
  const period = g("dayPeriod").toUpperCase();
  return `${hour}:${minute} ${period}`;
}
