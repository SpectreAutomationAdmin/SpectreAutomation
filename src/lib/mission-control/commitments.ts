// Sprint 3 · Checkpoint 16G Stage E (2026-08-04) — Today's
// Commitments loader.
//
// Merges the connected user's real Outlook calendar events with
// Spectre-proposed operational deadlines for the local calendar
// day, in the club's IANA timezone.
//
// Founder rules honoured:
//   - Do NOT include every unresolved WI item.
//   - Do NOT include dismissed / completed / past proposals.
//   - Do NOT fabricate events when calendar permission is missing.
//   - Real calendar events and Spectre proposals stay distinct
//     (`source` field).
//   - Private events obscured (see microsoft-graph-calendar.ts).

import { prisma } from "@/lib/prisma";
import { fetchCalendarCommitmentsForToday, type CalendarCommitment, type CalendarFetchResult } from "@/lib/integrations/microsoft-graph-calendar";
import { startOfLocalDayUtc, todayLocalDateString } from "./arrival";

export type TodayCommitmentSource = "OUTLOOK_CALENDAR" | "SPECTRE_PROPOSED";

export type TodayCommitment = {
  key: string;
  source: TodayCommitmentSource;
  title: string;
  startAt: Date | null;   // null for all-day / date-only proposals
  endAt?: Date | null;
  isAllDay: boolean;
  timeLabel: string;      // "09:30" for timed, "All day" for all-day
  sourceLabel: string;    // "Outlook calendar" | "Spectre proposed"
  workIntakeItemId?: string;
  proposalStatus?: string;
  locationSummary?: string;
  organiserName?: string;
};

export type CalendarConsentState =
  | "CONNECTED"
  | "PERMISSION_MISSING"
  | "DISCONNECTED"
  | "MAIL_ONLY";   // mailbox exists, mail scopes granted, calendar scope not

export interface TodayCommitmentsSnapshot {
  items: TodayCommitment[];
  calendarConsent: CalendarConsentState;
  outlookEventCount: number;
  spectreCommitmentCount: number;
  windowStart: Date;
  windowEnd: Date;
}

export async function loadTodayCommitments(args: {
  clubId: string;
  userId: string;
  clubTimezone: string;
  now: Date;
  /** Injected accessor for the user's mailbox connection. Kept as a
   *  function so tests can stub without touching the real DB. */
  loadUserMailbox?: (userId: string) => Promise<{ grantedScopes: string[]; accessToken: string | null } | null>;
}): Promise<TodayCommitmentsSnapshot> {
  const tz = args.clubTimezone;
  const start = startOfLocalDayUtc(args.now, tz);
  const end = startOfLocalDayUtc(addDaysToLocalDate(todayLocalDateString(tz, args.now), 1, tz), tz);

  // 1. Load Spectre-proposed commitments due today (status PROPOSED
  //    or ACCEPTED; NEVER DISMISSED / COMPLETED).
  const proposals = await prisma.proposedCommitment.findMany({
    where: {
      clubId: args.clubId,
      status: { in: ["PROPOSED", "ACCEPTED"] },
      dueAt: { gte: start, lt: end },
    },
    orderBy: { dueAt: "asc" },
  }).catch(() => []);

  // 2. Load Outlook calendar events for today. If the loader isn't
  //    provided (unit tests) OR the user has no mailbox OR the scope
  //    isn't granted → PERMISSION_MISSING and we fall back to
  //    proposals only.
  let calendarResult: CalendarFetchResult = { state: "DISCONNECTED" };
  let consent: CalendarConsentState = "DISCONNECTED";
  const mailbox = args.loadUserMailbox ? await args.loadUserMailbox(args.userId) : null;
  if (mailbox && mailbox.accessToken) {
    if (!mailbox.grantedScopes.map((s) => s.toLowerCase()).includes("calendars.read")) {
      consent = "MAIL_ONLY";
    } else {
      calendarResult = await fetchCalendarCommitmentsForToday({
        userAccessToken: mailbox.accessToken,
        timezone: tz,
        startOfLocalDayUtc: start,
        endOfLocalDayUtc: end,
        grantedScopes: mailbox.grantedScopes,
      });
      consent = calendarResult.state === "CONNECTED" ? "CONNECTED" : "PERMISSION_MISSING";
    }
  }
  const events: CalendarCommitment[] = calendarResult.state === "CONNECTED" ? calendarResult.events : [];

  // 3. Merge + sort chronologically.
  const items: TodayCommitment[] = [
    ...events.map((e) => ({
      key: `cal_${e.externalEventId}`,
      source: "OUTLOOK_CALENDAR" as const,
      title: e.subject,
      startAt: e.startAt,
      endAt: e.endAt,
      isAllDay: e.isAllDay,
      timeLabel: e.isAllDay ? "All day" : formatLocalTime(e.startAt, tz),
      sourceLabel: "Outlook calendar",
      locationSummary: e.locationSummary,
      organiserName: e.organiserName,
    })),
    ...proposals.map((p) => ({
      key: `pc_${p.id}`,
      source: "SPECTRE_PROPOSED" as const,
      title: p.title,
      startAt: p.dueAt,
      isAllDay: false,
      timeLabel: formatLocalTime(p.dueAt, tz),
      sourceLabel: "Spectre proposed",
      workIntakeItemId: p.workIntakeItemId ?? undefined,
      proposalStatus: p.status,
    })),
  ].sort((a, b) => {
    // All-day items first, then chronological.
    if (a.isAllDay && !b.isAllDay) return -1;
    if (!a.isAllDay && b.isAllDay) return 1;
    const at = a.startAt ? a.startAt.getTime() : Number.MAX_SAFE_INTEGER;
    const bt = b.startAt ? b.startAt.getTime() : Number.MAX_SAFE_INTEGER;
    return at - bt;
  });

  return {
    items,
    calendarConsent: consent,
    outlookEventCount: events.length,
    spectreCommitmentCount: proposals.length,
    windowStart: start,
    windowEnd: end,
  };
}

/** Format a UTC instant as HH:mm in the given IANA timezone. */
function formatLocalTime(d: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const hh = g("hour") === "24" ? "00" : g("hour");
  return `${hh.padStart(2, "0")}:${g("minute").padStart(2, "0")}`;
}

/**
 * Add N days to a local calendar date string, preserving IANA-tz
 * DST safety. Returns YYYY-MM-DD.
 */
function addDaysToLocalDate(dateStr: string, days: number, tz: string): string {
  const noon = startOfLocalDayUtc(dateStr, tz);
  const shifted = new Date(noon.getTime() + days * 24 * 60 * 60 * 1000 + 12 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(shifted);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month").padStart(2, "0")}-${g("day").padStart(2, "0")}`;
}
