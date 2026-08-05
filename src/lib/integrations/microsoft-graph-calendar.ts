// Sprint 3 · Checkpoint 16G Stage E (2026-08-04) — Microsoft Graph
// calendar client (read-only, delegated, single-user).
//
// Never writes to Outlook. Never reads shared calendars. Never
// fabricates events. If Calendars.Read consent is missing, callers
// receive a { state: "PERMISSION_MISSING" } response and MUST fall
// back to the Spectre-proposed-only view.

import type { RawGraphMessage } from "./microsoft-graph-delegated";
import { prisma } from "@/lib/prisma";
// Sprint 3 · Checkpoint 16H calendar-acceptance (2026-08-05) —
// canonical time helpers. Graph returns naive wall-clock dateTime
// strings + a separate timeZone field; we must convert them to
// absolute UTC instants exactly once.
import { zonedTimeToUtc } from "@/lib/mission-control/arrival";
import { logger } from "@/lib/observability/logger";

export type CalendarCommitment = {
  externalEventId: string;
  subject: string;
  startAt: Date;
  endAt: Date;
  locationSummary?: string;
  organiserName?: string;
  attendeeStatus?: string;
  isAllDay: boolean;
  source: "OUTLOOK_CALENDAR";
};

export type CalendarFetchResult =
  | { state: "CONNECTED"; events: CalendarCommitment[] }
  | { state: "PERMISSION_MISSING" }
  | { state: "DISCONNECTED" }
  | { state: "ERROR"; reason: string };

interface GraphEvent {
  id: string;
  subject?: string;
  start?: { dateTime: string; timeZone?: string };
  end?: { dateTime: string; timeZone?: string };
  isAllDay?: boolean;
  location?: { displayName?: string };
  organizer?: { emailAddress?: { name?: string; address?: string } };
  responseStatus?: { response?: string };
  sensitivity?: string;
}

/**
 * Fetch today's calendar events for the connected user's mailbox.
 * Uses /me/calendarView?startDateTime=..&endDateTime=.. which returns
 * events (including all-day) whose window intersects the range.
 *
 * Errors are contained — a Graph 4xx / 5xx does NOT throw. The panel
 * still renders (with Spectre-proposed items alone).
 *
 * @param args.userAccessToken - delegated bearer token
 * @param args.timezone        - IANA tz for the local-calendar day
 * @param args.now             - reference "now" (defaults to Date.now())
 * @param args.startOfLocalDayUtc - UTC instant matching local midnight
 * @param args.endOfLocalDayUtc   - UTC instant matching local midnight-of-tomorrow
 */
export async function fetchCalendarCommitmentsForToday(args: {
  userAccessToken: string;
  timezone: string;
  startOfLocalDayUtc: Date;
  endOfLocalDayUtc: Date;
  grantedScopes: string[];
}): Promise<CalendarFetchResult> {
  if (!args.grantedScopes.map((s) => s.toLowerCase()).includes("calendars.read")) {
    return { state: "PERMISSION_MISSING" };
  }
  const startIso = args.startOfLocalDayUtc.toISOString();
  const endIso = args.endOfLocalDayUtc.toISOString();
  const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(startIso)}&endDateTime=${encodeURIComponent(endIso)}&$select=id,subject,start,end,isAllDay,location,organizer,responseStatus,sensitivity&$top=50&$orderby=start/dateTime`;
  try {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${args.userAccessToken}`,
        Accept: "application/json",
        Prefer: `outlook.timezone="${args.timezone}"`,
      },
    });
    if (res.status === 401 || res.status === 403) return { state: "PERMISSION_MISSING" };
    if (!res.ok) return { state: "ERROR", reason: `graph_${res.status}` };
    const body = (await res.json()) as { value?: GraphEvent[] };
    const rawEvents = body.value ?? [];
    const events: CalendarCommitment[] = rawEvents.map((e) => {
      // Sprint 3 · Checkpoint 16H calendar-acceptance (2026-08-05) —
      // parse dateTime as a wall-clock in the event's own timeZone,
      // then convert exactly once to an absolute UTC instant.
      //
      // Graph honours `Prefer: outlook.timezone="America/Edmonton"`
      // by returning dateTime WITHOUT any offset or Z suffix
      // ("2026-08-04T18:00:00.0000000") plus a separate timeZone
      // field. Passing that raw string to `new Date(...)` would
      // parse it as UTC (per ECMAScript), shifting the instant by
      // the local offset — the founder-reported 6-hour bug.
      //
      // Fallback tz = args.timezone (the club's IANA zone we
      // requested via Prefer). If Graph ever returns a Windows tz
      // identifier we still get correctly-formatted display times
      // because the club-tz fallback matches the requested zone.
      const startAt = normaliseGraphInstant(e.start?.dateTime, e.start?.timeZone ?? args.timezone, args.timezone);
      const endAt = normaliseGraphInstant(e.end?.dateTime, e.end?.timeZone ?? args.timezone, args.timezone);
      return {
        externalEventId: e.id,
        // Sprint 3 · Checkpoint 16G §12 — respect private-event
        // visibility. When Outlook flags an event as `private` we
        // still render its time-slot but obscure the subject.
        subject: e.sensitivity === "private" ? "Private event" : (e.subject ?? "(no subject)"),
        startAt,
        endAt,
        locationSummary: e.sensitivity === "private" ? undefined : e.location?.displayName,
        organiserName: e.sensitivity === "private" ? undefined : e.organizer?.emailAddress?.name,
        attendeeStatus: e.responseStatus?.response,
        isAllDay: !!e.isAllDay,
        source: "OUTLOOK_CALENDAR",
      };
    });
    return { state: "CONNECTED", events };
  } catch (e) {
    return { state: "ERROR", reason: `network_${(e as Error).message?.slice(0, 40) ?? "unknown"}` };
  }
}

// ---------------------------------------------------------------------------
// Sprint 3 · Checkpoint 16H calendar-acceptance (2026-08-05) —
// canonical normalisation from Graph's naive wall-clock format to an
// absolute UTC instant.
// ---------------------------------------------------------------------------

/**
 * Convert a Microsoft-Graph event dateTime string + timeZone tuple to
 * an absolute UTC Date. Graph returns dateTime as a naive wall-clock
 * without any offset/Z suffix (e.g. "2026-08-04T18:00:00.0000000")
 * along with a separate timeZone field naming the zone that wall
 * clock refers to. We must NEVER pass that raw string to `new Date`
 * — ES spec parses offset-less ISO strings as UTC, producing an
 * instant shifted by the local offset.
 *
 * Uses zonedTimeToUtc (from src/lib/mission-control/arrival.ts) which
 * is DST-safe via Intl.DateTimeFormat iteration.
 */
export function normaliseGraphInstant(
  dateTime: string | undefined,
  eventTz: string,
  fallbackTz: string,
): Date {
  if (!dateTime) return new Date();
  // Strip Graph's high-precision fractional seconds (".0000000") so
  // the string matches the "YYYY-MM-DDTHH:mm:ss" contract zonedTimeToUtc
  // expects. Graph never returns an offset in this shape.
  const trimmed = dateTime.slice(0, 19);
  // If Graph returned a Windows tz name (unusual when we set the
  // Prefer header, but possible) or an empty string, fall back to
  // the club/fallback zone we requested. We do NOT ship a Windows→
  // IANA table here — the fallback is the same zone we asked Graph
  // for via Prefer, so display remains correct.
  const zone = looksLikeIanaZone(eventTz) ? eventTz : fallbackTz;
  try {
    const utc = zonedTimeToUtc(trimmed, zone);
    if (Number.isNaN(utc.getTime())) throw new Error("Invalid Date");
    return utc;
  } catch (err) {
    logger.warn("calendar.graph.normalise_failed", {
      // Keep the log actionable but sanitised — no attendee names,
      // no subject, no organiser.
      wallClockLen: trimmed.length,
      eventTzLen: eventTz.length,
      reason: (err as Error).message?.slice(0, 60),
    });
    // Fail-safe: interpret as UTC (matches pre-16H behaviour) so a
    // parse error never blocks the panel. Instant is wrong but
    // rendering doesn't crash.
    return new Date(`${trimmed}Z`);
  }
}

/**
 * Coarse check that a timezone string looks like an IANA identifier.
 * IANA identifiers are `Region/City[/Subregion]` with letters +
 * underscores/hyphens/slashes only. Windows tz identifiers use
 * spaces ("Mountain Standard Time") which this rejects.
 */
function looksLikeIanaZone(tz: string | undefined): boolean {
  if (!tz) return false;
  return /^[A-Za-z_+\-]+\/[A-Za-z_+\-]+(\/[A-Za-z_+\-]+)?$/.test(tz);
}
