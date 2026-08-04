// Sprint 3 · Checkpoint 16G Stage A — arrival + overnight tests.
//
// Covers the founder-specified cases:
//   received today / yesterday / 5 days ago;
//   UTC-vs-local date-boundary crossing;
//   DST forward + backward transitions in America/Edmonton;
//   old item re-analysed today (must NOT count as today);
//   old item updated today (must NOT count);
//   backfilled row (must NOT count);
//   overnight window pre-07:00 vs post-07:00;
//   overnight sentence honesty (zero → "No new work…").

import { describe, it, expect } from "vitest";
import {
  resolveArrivalTime,
  toLocalDateString,
  startOfLocalDayUtc,
  arrivedTodayInClubTimezone,
  zonedTimeToUtc,
} from "@/lib/mission-control/arrival";
import {
  overnightWindow,
  composeOvernightSentence,
} from "@/lib/mission-control/overnight-preparation";

const TZ = "America/Edmonton";

describe("16G · arrival resolver — source hierarchy", () => {
  it("prefers email received time over WI createdAt", () => {
    const emailReceivedAt = new Date("2026-08-04T02:00:00Z"); // Aug 3 20:00 MDT
    const workIntakeCreatedAt = new Date("2026-08-04T03:00:00Z");
    const r = resolveArrivalTime({ clubTimezone: TZ, emailReceivedAt, workIntakeCreatedAt });
    expect(r.sourceOccurredAt).toEqual(emailReceivedAt);
    expect(r.derivedFrom).toBe("EMAIL_RECEIVED");
    expect(r.sourceType).toBe("EMAIL");
  });

  it("uses source email time even when the WI carries a doc-only origin", () => {
    // A doc-derived WI whose source is an Outlook attachment must
    // resolve to the email's receivedAt, not the doc's ingestion time.
    const emailReceivedAtForDoc = new Date("2026-07-30T03:26:21Z");
    const workIntakeCreatedAt = new Date("2026-07-30T03:26:32Z");
    const r = resolveArrivalTime({ clubTimezone: TZ, emailReceivedAtForDoc, workIntakeCreatedAt });
    expect(r.sourceOccurredAt).toEqual(emailReceivedAtForDoc);
    expect(r.derivedFrom).toBe("EMAIL_RECEIVED");
    expect(r.sourceType).toBe("DOCUMENT_FROM_EMAIL");
  });

  it("ignores updatedAt / lastAnalysedAt entirely — they are not accepted as input", () => {
    // Compilation-level guarantee: ResolveArrivalInput has no such
    // field. Assert here that a re-analysed item still resolves to
    // its original arrival.
    const emailReceivedAt = new Date("2026-07-22T18:55:11Z");
    const r = resolveArrivalTime({
      clubTimezone: TZ, emailReceivedAt,
      workIntakeCreatedAt: new Date("2026-07-23T03:51:27Z"),
    });
    expect(r.sourceOccurredAt).toEqual(emailReceivedAt);
    expect(r.derivedFrom).toBe("EMAIL_RECEIVED");
  });

  it("falls back to WI createdAt only when every source is null", () => {
    const workIntakeCreatedAt = new Date("2026-08-01T12:00:00Z");
    const r = resolveArrivalTime({ clubTimezone: TZ, workIntakeCreatedAt });
    expect(r.sourceOccurredAt).toEqual(workIntakeCreatedAt);
    expect(r.derivedFrom).toBe("FALLBACK_CREATED_AT");
    expect(r.sourceType).toBe("UNKNOWN");
  });
});

describe("16G · timezone-aware local calendar dates", () => {
  it("computes local date for a UTC instant in America/Edmonton (MDT)", () => {
    // Aug 4 2026 03:00 UTC = Aug 3 21:00 MDT
    expect(toLocalDateString(new Date("2026-08-04T03:00:00Z"), "America/Edmonton")).toBe("2026-08-03");
    // Aug 4 2026 08:00 UTC = Aug 4 02:00 MDT
    expect(toLocalDateString(new Date("2026-08-04T08:00:00Z"), "America/Edmonton")).toBe("2026-08-04");
  });

  it("computes local date for a UTC instant in America/Edmonton (MST, standard time)", () => {
    // Feb 15 2026 03:00 UTC = Feb 14 20:00 MST (UTC−7)
    expect(toLocalDateString(new Date("2026-02-15T03:00:00Z"), "America/Edmonton")).toBe("2026-02-14");
    // Feb 15 2026 07:00 UTC = Feb 15 00:00 MST
    expect(toLocalDateString(new Date("2026-02-15T07:00:00Z"), "America/Edmonton")).toBe("2026-02-15");
  });

  it("startOfLocalDayUtc handles Edmonton spring-forward day (2026-03-08)", () => {
    // Spring forward: 02:00 MST → 03:00 MDT. Midnight local is unaffected.
    const midnightUtc = startOfLocalDayUtc("2026-03-08", "America/Edmonton");
    // 2026-03-08 00:00 MST = 2026-03-08 07:00 UTC
    expect(midnightUtc.toISOString()).toBe("2026-03-08T07:00:00.000Z");
  });

  it("startOfLocalDayUtc handles Edmonton fall-back day (2026-11-01)", () => {
    // Fall back: 02:00 MDT → 01:00 MST. Midnight local (before transition) = MDT.
    const midnightUtc = startOfLocalDayUtc("2026-11-01", "America/Edmonton");
    // 2026-11-01 00:00 MDT = 2026-11-01 06:00 UTC
    expect(midnightUtc.toISOString()).toBe("2026-11-01T06:00:00.000Z");
  });
});

describe("16G · arrivedTodayInClubTimezone", () => {
  it("returns true for an arrival on the same local calendar day", () => {
    // "Now" = Aug 4 15:00 UTC = Aug 4 09:00 MDT. Arrival at Aug 4 14:00 UTC (08:00 MDT).
    const now = new Date("2026-08-04T15:00:00Z");
    const arrival = resolveArrivalTime({
      clubTimezone: "America/Edmonton",
      emailReceivedAt: new Date("2026-08-04T14:00:00Z"),
      workIntakeCreatedAt: now,
    });
    expect(arrivedTodayInClubTimezone(arrival, now)).toBe(true);
  });

  it("returns false for an arrival 5 days ago (matches staging state)", () => {
    const now = new Date("2026-08-04T15:00:00Z");
    const arrival = resolveArrivalTime({
      clubTimezone: "America/Edmonton",
      emailReceivedAt: new Date("2026-07-30T03:26:21Z"),
      workIntakeCreatedAt: now,
    });
    expect(arrivedTodayInClubTimezone(arrival, now)).toBe(false);
  });

  it("respects the local-day boundary at Edmonton midnight", () => {
    // Aug 4 05:59 UTC = Aug 3 23:59 MDT (still yesterday locally)
    const beforeMidnight = new Date("2026-08-04T05:59:00Z");
    // Aug 4 06:01 UTC = Aug 4 00:01 MDT (today locally)
    const afterMidnight = new Date("2026-08-04T06:01:00Z");
    const now = new Date("2026-08-04T15:00:00Z");
    const arrivalBefore = resolveArrivalTime({
      clubTimezone: "America/Edmonton", emailReceivedAt: beforeMidnight, workIntakeCreatedAt: now,
    });
    const arrivalAfter = resolveArrivalTime({
      clubTimezone: "America/Edmonton", emailReceivedAt: afterMidnight, workIntakeCreatedAt: now,
    });
    expect(arrivedTodayInClubTimezone(arrivalBefore, now)).toBe(false);
    expect(arrivedTodayInClubTimezone(arrivalAfter, now)).toBe(true);
  });

  it("does not count as today when a WI's row was BACKFILLED today but the source is old", () => {
    const now = new Date("2026-08-04T15:00:00Z");
    const arrival = resolveArrivalTime({
      clubTimezone: "America/Edmonton",
      emailReceivedAt: new Date("2026-07-22T18:55:11Z"), // 13 days ago
      workIntakeCreatedAt: new Date("2026-08-04T10:00:00Z"),   // backfill today
    });
    expect(arrivedTodayInClubTimezone(arrival, now)).toBe(false);
  });

  it("null clubTimezone falls back to UTC and still computes correctly", () => {
    const now = new Date("2026-08-04T15:00:00Z");
    const arrival = resolveArrivalTime({
      clubTimezone: null,
      emailReceivedAt: new Date("2026-08-04T14:00:00Z"),
      workIntakeCreatedAt: now,
    });
    expect(arrival.sourceTimezone).toBe("UTC");
    expect(arrivedTodayInClubTimezone(arrival, now)).toBe(true);
  });
});

describe("16G · overnight-preparation window", () => {
  it("morning (post-07:00 local): window is prev 19:00 → today 07:00", () => {
    // Aug 4 15:00 UTC = Aug 4 09:00 MDT (post-07:00)
    const now = new Date("2026-08-04T15:00:00Z");
    const { start, end } = overnightWindow(now, "America/Edmonton");
    // Aug 3 19:00 MDT = Aug 4 01:00 UTC
    expect(start.toISOString()).toBe("2026-08-04T01:00:00.000Z");
    // Aug 4 07:00 MDT = Aug 4 13:00 UTC
    expect(end.toISOString()).toBe("2026-08-04T13:00:00.000Z");
  });

  it("early morning (pre-07:00 local): window is prev 19:00 → now", () => {
    // Aug 4 11:00 UTC = Aug 4 05:00 MDT (pre-07:00)
    const now = new Date("2026-08-04T11:00:00Z");
    const { start, end } = overnightWindow(now, "America/Edmonton");
    expect(start.toISOString()).toBe("2026-08-04T01:00:00.000Z");
    expect(end.getTime()).toBe(now.getTime());
  });
});

describe("16G · overnight sentence honesty", () => {
  it("zero analysed → 'No new work was prepared overnight'", () => {
    expect(composeOvernightSentence({
      itemsAnalysed: 0, itemsCompletedAutomatically: 0,
      itemsReadyForApproval: 0, itemsNeedingJudgment: 0,
    })).toBe("No new work was prepared overnight.");
  });

  it("some analysed, some auto-completed", () => {
    expect(composeOvernightSentence({
      itemsAnalysed: 4, itemsCompletedAutomatically: 2,
      itemsReadyForApproval: 1, itemsNeedingJudgment: 1,
    })).toBe("Spectre prepared 4 items overnight — 2 handled automatically, 1 ready for approval, 1 needs judgment.");
  });

  it("some analysed but nothing actionable", () => {
    expect(composeOvernightSentence({
      itemsAnalysed: 3, itemsCompletedAutomatically: 0,
      itemsReadyForApproval: 0, itemsNeedingJudgment: 0,
    })).toBe("Spectre prepared 3 items overnight.");
  });

  it("one analysed, one ready — singular form", () => {
    expect(composeOvernightSentence({
      itemsAnalysed: 1, itemsCompletedAutomatically: 0,
      itemsReadyForApproval: 1, itemsNeedingJudgment: 0,
    })).toBe("Spectre prepared 1 item overnight — 1 ready for approval.");
  });
});
