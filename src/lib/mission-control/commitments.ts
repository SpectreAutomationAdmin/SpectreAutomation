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
import { formatLocalTimeAmPm } from "./local-time";

export type TodayCommitmentSource = "OUTLOOK_CALENDAR" | "SPECTRE_PROPOSED";

// Sprint 3 · Checkpoint 16H calendar-acceptance (2026-08-05) —
// temporal state derived from absolute start/end instants + the
// current wall-clock in the club's IANA timezone. Never derived
// from start alone.
export type CalendarCommitmentState = "PAST" | "IN_PROGRESS" | "UPCOMING" | "ALL_DAY";

export type TodayCommitment = {
  key: string;
  source: TodayCommitmentSource;
  title: string;
  startAt: Date | null;   // null for all-day / date-only proposals
  endAt?: Date | null;
  isAllDay: boolean;
  timeLabel: string;      // "8:00 AM" / "1:30 PM" for timed, "All day" for all-day
  sourceLabel: string;    // "Outlook calendar" | "Spectre proposed"
  workIntakeItemId?: string;
  proposalStatus?: string;
  locationSummary?: string;
  organiserName?: string;
  // Sprint 3 · Checkpoint 16H — serialisable state fields. The panel
  // re-derives state on the client every minute using startIso + endIso
  // so past appointments fade without a Graph refetch.
  state: CalendarCommitmentState;
  startIso: string | null;
  endIso: string | null;
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
      timeLabel: e.isAllDay ? "All day" : formatLocalTimeAmPm(e.startAt, tz),
      sourceLabel: "Outlook calendar",
      locationSummary: e.locationSummary,
      organiserName: e.organiserName,
      state: deriveCommitmentState({ startAt: e.startAt, endAt: e.endAt, isAllDay: e.isAllDay, now: args.now }),
      startIso: e.startAt.toISOString(),
      endIso: e.endAt.toISOString(),
    })),
    ...proposals.map((p) => ({
      key: `pc_${p.id}`,
      source: "SPECTRE_PROPOSED" as const,
      title: p.title,
      startAt: p.dueAt,
      isAllDay: false,
      timeLabel: formatLocalTimeAmPm(p.dueAt, tz),
      sourceLabel: "Spectre proposed",
      workIntakeItemId: p.workIntakeItemId ?? undefined,
      proposalStatus: p.status,
      // Proposed commitments don't have a native end time — treat
      // dueAt as both start and end for state purposes so the item
      // fades once the deadline has passed.
      state: deriveCommitmentState({ startAt: p.dueAt, endAt: p.dueAt, isAllDay: false, now: args.now }),
      startIso: p.dueAt.toISOString(),
      endIso: p.dueAt.toISOString(),
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

/**
 * Sprint 3 · Checkpoint 16H calendar-acceptance (2026-08-05) —
 * temporal-state derivation. Derived from ABSOLUTE start/end
 * instants + the current instant. Never derived from start alone.
 *
 *   endAt <= now                → PAST
 *   startAt <= now < endAt      → IN_PROGRESS
 *   startAt > now               → UPCOMING
 *   isAllDay + still within today's local day → ALL_DAY
 *
 * The caller supplies `now` explicitly so tests can use a fake clock.
 */
export function deriveCommitmentState(input: {
  startAt: Date;
  endAt: Date;
  isAllDay: boolean;
  now: Date;
}): CalendarCommitmentState {
  if (input.isAllDay) return "ALL_DAY";
  const nowMs = input.now.getTime();
  if (input.endAt.getTime() <= nowMs) return "PAST";
  if (input.startAt.getTime() <= nowMs) return "IN_PROGRESS";
  return "UPCOMING";
}

// Phase 4R rev-3 (2026-08-15) — the prior `formatLocalTime` (24h,
// no AM/PM) has been retired. All time-of-day formatting now flows
// through the shared `formatLocalTimeAmPm` in `./local-time.ts` so
// the display convention lives in one place. See Phase 4R rev-3
// checkpoint for the founder-approved format contract.

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
