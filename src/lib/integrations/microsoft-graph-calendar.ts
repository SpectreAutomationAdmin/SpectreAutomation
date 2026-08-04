// Sprint 3 · Checkpoint 16G Stage E (2026-08-04) — Microsoft Graph
// calendar client (read-only, delegated, single-user).
//
// Never writes to Outlook. Never reads shared calendars. Never
// fabricates events. If Calendars.Read consent is missing, callers
// receive a { state: "PERMISSION_MISSING" } response and MUST fall
// back to the Spectre-proposed-only view.

import type { RawGraphMessage } from "./microsoft-graph-delegated";
import { prisma } from "@/lib/prisma";

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
    const events: CalendarCommitment[] = rawEvents.map((e) => ({
      externalEventId: e.id,
      // Sprint 3 · Checkpoint 16G §12 — respect private-event
      // visibility. When Outlook flags an event as `private` we
      // still render its time-slot but obscure the subject.
      subject: e.sensitivity === "private" ? "Private event" : (e.subject ?? "(no subject)"),
      startAt: new Date(e.start?.dateTime ?? new Date().toISOString()),
      endAt: new Date(e.end?.dateTime ?? new Date().toISOString()),
      locationSummary: e.sensitivity === "private" ? undefined : e.location?.displayName,
      organiserName: e.sensitivity === "private" ? undefined : e.organizer?.emailAddress?.name,
      attendeeStatus: e.responseStatus?.response,
      isAllDay: !!e.isAllDay,
      source: "OUTLOOK_CALENDAR",
    }));
    return { state: "CONNECTED", events };
  } catch (e) {
    return { state: "ERROR", reason: `network_${(e as Error).message?.slice(0, 40) ?? "unknown"}` };
  }
}
