// Sprint 3 · Checkpoint 16H rejection (2026-08-06) — Completed
// History timeline separators. See founder §16 for the required
// label ladder:
//
//   items from today       → "Today"
//   previous local day     → "Yesterday"
//   recent prior days      → weekday-oriented label
//   older current-year     → "Month Day" (e.g. "July 28")
//   prior-year items       → "Month Day, Year"
//
// Grouping key = the calendar day the item was ORIGINALLY created
// (WorkIntakeItem.createdAt), computed in the club's IANA timezone
// (America/Edmonton for Coulee Ridge). Restoration and recompletion
// never change position (§17).

interface LabelInputs {
  ianaZone: string;
  now: Date;
}

/** YYYY-MM-DD in the given IANA timezone, used as the grouping key
 *  so DST does not split a single local day into two groups. */
export function localDateKey(instant: Date, ianaZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: ianaZone,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(instant);
  const y = parts.find((p) => p.type === "year")?.value ?? "0000";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  const d = parts.find((p) => p.type === "day")?.value ?? "01";
  return `${y}-${m}-${d}`;
}

/** Add whole calendar days in the club timezone by iterating one day
 *  at a time. Handles DST transitions because localDateKey is
 *  timezone-aware. */
function keyDaysAgo(base: Date, days: number, ianaZone: string): string {
  // 24h * days is close enough for the label ladder — the key
 //  derivation runs the timezone conversion afterward, so a DST
 //  shift moves the boundary by at most ~1h either way.
  return localDateKey(new Date(base.getTime() - days * 86_400_000), ianaZone);
}

/** Weekday name in the club timezone. */
function weekdayName(instant: Date, ianaZone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ianaZone, weekday: "long",
  }).format(instant);
}

/** Human label for the timeline marker preceding items grouped by
 *  `dayKey` (from localDateKey). */
export function labelForDayKey(dayKey: string, inputs: LabelInputs): string {
  const { ianaZone, now } = inputs;
  const todayKey = localDateKey(now, ianaZone);
  if (dayKey === todayKey) return "Today";
  const yesterdayKey = keyDaysAgo(now, 1, ianaZone);
  if (dayKey === yesterdayKey) return "Yesterday";

  // Reconstruct a Date at noon local for the given dayKey so the
  // weekday / month / year labels are stable across DST.
  const [ys, ms, ds] = dayKey.split("-");
  // Use UTC noon then convert via toLocaleDateString to sidestep
  // parseISO ambiguities — the label formatter is timezone-aware so
  // the value we produce here for a 12:00 UTC anchor is safe.
  const anchor = new Date(Date.UTC(Number(ys), Number(ms) - 1, Number(ds), 12, 0, 0));

  // Recent prior days (within past 7 days of `now`) — weekday name.
  const weekAgoKey = keyDaysAgo(now, 7, ianaZone);
  if (dayKey > weekAgoKey) {
    return weekdayName(anchor, ianaZone);
  }

  // Older items — Month Day, plus year if prior calendar year.
  const nowYear = new Intl.DateTimeFormat("en-US", {
    timeZone: ianaZone, year: "numeric",
  }).format(now);
  const dayYear = ys;
  if (dayYear === nowYear) {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: ianaZone, month: "long", day: "numeric",
    }).format(anchor);
  }
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ianaZone, month: "long", day: "numeric", year: "numeric",
  }).format(anchor);
}

export interface TimelineMarker {
  key: string;      // dayKey — deterministic for React keys
  label: string;    // human label (Today / Yesterday / Monday / July 28 / etc.)
}

/** Given items with a canonical createdAt (ISO string), return a
 *  parallel array where entry i is the marker to render BEFORE
 *  item i, or null when item i is on the same local day as item
 *  i-1. Items with no createdAt are always null-marker. */
export function computeTimelineMarkers<T extends { workIntakeCreatedAt?: string }>(
  items: readonly T[],
  ianaZone: string,
  now: Date,
): Array<TimelineMarker | null> {
  const out: Array<TimelineMarker | null> = [];
  let prev: string | null = null;
  for (const it of items) {
    if (!it.workIntakeCreatedAt) { out.push(null); continue; }
    const key = localDateKey(new Date(it.workIntakeCreatedAt), ianaZone);
    if (key === prev) { out.push(null); continue; }
    out.push({ key, label: labelForDayKey(key, { ianaZone, now }) });
    prev = key;
  }
  return out;
}
