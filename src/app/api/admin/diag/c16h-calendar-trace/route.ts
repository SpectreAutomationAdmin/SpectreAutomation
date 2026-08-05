// Sprint 3 · Checkpoint 16H calendar-acceptance diagnostic
// (2026-08-05). TEMPORARY endpoint — hits Graph /me/calendarView with
// the connected user's delegated token, returns the raw response +
// current parse outcome + candidate-fix parse outcome for every
// event, so the exact stage where wall-clock becomes UTC-mistreated
// is visible.
//
// Auth: authenticated principal + Coulee-Ridge-only (hardcoded club
// id + slug guard to avoid drift on any other tenant). Emit is
// sanitized — no attendee emails, no token, no oid.
//
// This route is scheduled for removal after the calendar time-
// normalization fix ships. If you're reading this after 16H-1
// calendar acceptance passes, delete the file.

import { NextResponse } from "next/server";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { getActiveClubId } from "@/lib/active-club";
import { prisma } from "@/lib/prisma";
import { getFreshDelegatedAccessToken } from "@/lib/mailbox/connect";

export const dynamic = "force-dynamic";

const CR_ID = "cmrvdeny7000144372ktmmg9c";

export async function GET() {
  const principal = await getCurrentPrincipal();
  if (!principal) return NextResponse.json({ error: "unauthenticated" }, { status: 401 });
  const clubId = await getActiveClubId({ clubId: principal.activeClubId ?? null, role: "" });
  if (clubId !== CR_ID) return NextResponse.json({ error: "not_available" }, { status: 404 });

  const club = await prisma.club.findUnique({ where: { id: clubId }, select: { timezone: true } });
  const tz = club?.timezone ?? "UTC";
  const mb = await prisma.mailboxConnection.findFirst({
    where: { clubId, status: "CONNECTED" },
    select: { id: true, userId: true, grantedScopes: true },
  });
  if (!mb) return NextResponse.json({ error: "no_mailbox" }, { status: 404 });

  const token = await getFreshDelegatedAccessToken({
    mailboxConnectionId: mb.id, callerClubId: clubId, callerUserId: mb.userId,
  }).catch((e) => ({ error: (e as Error).message }));
  if ("error" in token) return NextResponse.json({ stage: "token", ...token }, { status: 200 });

  // Compute today's Edmonton window without introducing new helpers.
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now);
  const g = (t: string) => parts.find((x) => x.type === t)?.value ?? "";
  const today = `${g("year")}-${g("month").padStart(2, "0")}-${g("day").padStart(2, "0")}`;
  function zonedToUtc(wallIsoNoZone: string, zone: string): Date {
    let guess = new Date(`${wallIsoNoZone}Z`);
    for (let i = 0; i < 3; i++) {
      const pp = new Intl.DateTimeFormat("en-CA", {
        timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
      }).formatToParts(guess);
      const gg = (t: string) => pp.find((x) => x.type === t)?.value ?? "";
      const hh = gg("hour") === "24" ? "00" : gg("hour");
      const back = `${gg("year")}-${gg("month").padStart(2,"0")}-${gg("day").padStart(2,"0")}T${hh.padStart(2,"0")}:${gg("minute").padStart(2,"0")}:${gg("second").padStart(2,"0")}`;
      if (back === wallIsoNoZone) break;
      const drift = new Date(`${wallIsoNoZone}Z`).getTime() - new Date(`${back}Z`).getTime();
      guess = new Date(guess.getTime() + drift);
    }
    return guess;
  }
  const startUtc = zonedToUtc(`${today}T00:00:00`, tz);
  const tomorrowInstant = new Date(startUtc.getTime() + 26 * 60 * 60 * 1000);
  const tomorrowParts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(tomorrowInstant);
  const tg = (t: string) => tomorrowParts.find((x) => x.type === t)?.value ?? "";
  const tomorrow = `${tg("year")}-${tg("month").padStart(2,"0")}-${tg("day").padStart(2,"0")}`;
  const endUtc = zonedToUtc(`${tomorrow}T00:00:00`, tz);

  const url = `https://graph.microsoft.com/v1.0/me/calendarView?startDateTime=${encodeURIComponent(startUtc.toISOString())}&endDateTime=${encodeURIComponent(endUtc.toISOString())}&$select=id,subject,start,end,isAllDay,location,sensitivity&$top=50&$orderby=start/dateTime`;
  const preferHeader = `outlook.timezone="${tz}"`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token.accessToken}`,
      Accept: "application/json",
      Prefer: preferHeader,
    },
  });
  const preferenceApplied = res.headers.get("preference-applied") ?? null;
  const body = await res.json().catch(() => ({}));

  const rawEvents = (body as { value?: Array<{ id?: string; subject?: string; start?: { dateTime?: string; timeZone?: string }; end?: { dateTime?: string; timeZone?: string }; isAllDay?: boolean; sensitivity?: string }> }).value ?? [];
  const eventTraces = rawEvents.map((ev) => {
    const buggyStart = new Date(ev.start?.dateTime ?? new Date().toISOString());
    const buggyEnd = new Date(ev.end?.dateTime ?? new Date().toISOString());
    const fmt = (d: Date) => new Intl.DateTimeFormat("en-CA", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(d);
    let candidateStart: Date | null = null;
    let candidateEnd: Date | null = null;
    if (ev.start?.dateTime && ev.start?.timeZone) {
      candidateStart = zonedToUtc(ev.start.dateTime.slice(0, 19), ev.start.timeZone);
      candidateEnd = zonedToUtc((ev.end?.dateTime ?? ev.start.dateTime).slice(0, 19), ev.end?.timeZone ?? ev.start.timeZone);
    }
    return {
      subject: ev.sensitivity === "private" ? "(private)" : (ev.subject ?? "").slice(0, 50),
      isAllDay: !!ev.isAllDay,
      raw: {
        start: { dateTime: ev.start?.dateTime, timeZone: ev.start?.timeZone },
        end:   { dateTime: ev.end?.dateTime,   timeZone: ev.end?.timeZone },
      },
      currentBuggy: {
        startUtc: buggyStart.toISOString(),
        endUtc: buggyEnd.toISOString(),
        startFormattedInClubTz: fmt(buggyStart),
        endFormattedInClubTz: fmt(buggyEnd),
      },
      candidateFix: candidateStart && candidateEnd ? {
        startUtc: candidateStart.toISOString(),
        endUtc: candidateEnd.toISOString(),
        startFormattedInClubTz: fmt(candidateStart),
        endFormattedInClubTz: fmt(candidateEnd),
      } : null,
    };
  });

  return NextResponse.json({
    clubTimezone: tz,
    windowUtc: { start: startUtc.toISOString(), end: endUtc.toISOString() },
    windowLocalDate: today,
    grantedScopes: mb.grantedScopes,
    tokenExpiresAt: token.expiresAt.toISOString(),
    request: { url, preferHeader },
    response: {
      status: res.status,
      preferenceAppliedHeader: preferenceApplied,
      eventCount: rawEvents.length,
    },
    events: eventTraces,
    serverProcessTz: process.env.TZ ?? "(unset, defaults to UTC on Fly)",
    nowIso: now.toISOString(),
  }, { status: 200 });
}
