// Sprint 3 · Checkpoint 16G Stage E — Today's Commitments contract
// tests. Focuses on the merge logic + empty/disconnected states.
// Full Prisma round-trip covered by staging verification later.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/prisma", () => ({
  prisma: {
    proposedCommitment: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/integrations/microsoft-graph-calendar", async () => ({
  fetchCalendarCommitmentsForToday: vi.fn(),
}));

import { loadTodayCommitments } from "@/lib/mission-control/commitments";
import { prisma } from "@/lib/prisma";
import { fetchCalendarCommitmentsForToday } from "@/lib/integrations/microsoft-graph-calendar";

const CR_TZ = "America/Edmonton";
const NOW = new Date("2026-08-05T14:00:00Z");  // Aug 5 08:00 MDT

beforeEach(() => {
  (prisma.proposedCommitment.findMany as any).mockReset();
  (fetchCalendarCommitmentsForToday as any).mockReset();
});

describe("16G Stage E · loadTodayCommitments", () => {
  it("returns DISCONNECTED + Spectre proposals only when no mailbox is provided", async () => {
    (prisma.proposedCommitment.findMany as any).mockResolvedValue([
      { id: "pc1", clubId: "cr", workIntakeItemId: "wi1", title: "Review vendor response", dueAt: new Date("2026-08-05T20:00:00Z"), sourceRule: "R", rationaleCode: "R", confidence: 0.7, status: "PROPOSED" },
    ]);
    const s = await loadTodayCommitments({ clubId: "cr", userId: "u1", clubTimezone: CR_TZ, now: NOW });
    expect(s.calendarConsent).toBe("DISCONNECTED");
    expect(s.outlookEventCount).toBe(0);
    expect(s.spectreCommitmentCount).toBe(1);
    expect(s.items).toHaveLength(1);
    expect(s.items[0].source).toBe("SPECTRE_PROPOSED");
    expect(s.items[0].sourceLabel).toBe("Spectre proposed");
  });

  it("returns MAIL_ONLY when mailbox exists but grantedScopes lacks Calendars.Read", async () => {
    (prisma.proposedCommitment.findMany as any).mockResolvedValue([]);
    const s = await loadTodayCommitments({
      clubId: "cr", userId: "u1", clubTimezone: CR_TZ, now: NOW,
      loadUserMailbox: async () => ({ grantedScopes: ["Mail.Read", "Mail.Send"], accessToken: "tok" }),
    });
    expect(s.calendarConsent).toBe("MAIL_ONLY");
    expect(s.outlookEventCount).toBe(0);
    expect(s.items).toHaveLength(0);
  });

  it("returns CONNECTED + hybrid items when Calendars.Read is granted", async () => {
    (prisma.proposedCommitment.findMany as any).mockResolvedValue([
      { id: "pc1", clubId: "cr", workIntakeItemId: "wi1", title: "Approve payroll", dueAt: new Date("2026-08-05T22:00:00Z"), sourceRule: "PAYROLL_CUTOFF", rationaleCode: "R", confidence: 0.9, status: "PROPOSED" },
    ]);
    (fetchCalendarCommitmentsForToday as any).mockResolvedValue({
      state: "CONNECTED",
      events: [{
        externalEventId: "outlk1", subject: "GM sync — weekly",
        startAt: new Date("2026-08-05T15:30:00Z"), endAt: new Date("2026-08-05T16:00:00Z"),
        isAllDay: false, source: "OUTLOOK_CALENDAR",
      }],
    });
    const s = await loadTodayCommitments({
      clubId: "cr", userId: "u1", clubTimezone: CR_TZ, now: NOW,
      loadUserMailbox: async () => ({ grantedScopes: ["Mail.Read", "Calendars.Read"], accessToken: "tok" }),
    });
    expect(s.calendarConsent).toBe("CONNECTED");
    expect(s.outlookEventCount).toBe(1);
    expect(s.spectreCommitmentCount).toBe(1);
    expect(s.items).toHaveLength(2);
    // Chronological — Outlook 15:30 UTC (09:30 MDT) before payroll 22:00 UTC (16:00 MDT).
    expect(s.items[0].source).toBe("OUTLOOK_CALENDAR");
    expect(s.items[0].timeLabel).toBe("09:30");
    expect(s.items[1].source).toBe("SPECTRE_PROPOSED");
    expect(s.items[1].timeLabel).toBe("16:00");
  });

  it("EXCLUDES dismissed / completed proposals (prisma.findMany filter)", async () => {
    (prisma.proposedCommitment.findMany as any).mockImplementation((args: any) => {
      // Assert the loader passed status filter
      expect(args.where.status.in).toEqual(["PROPOSED", "ACCEPTED"]);
      return Promise.resolve([]);
    });
    await loadTodayCommitments({ clubId: "cr", userId: "u1", clubTimezone: CR_TZ, now: NOW });
  });

  it("does NOT fabricate calendar events when Graph returns PERMISSION_MISSING", async () => {
    (prisma.proposedCommitment.findMany as any).mockResolvedValue([]);
    (fetchCalendarCommitmentsForToday as any).mockResolvedValue({ state: "PERMISSION_MISSING" });
    const s = await loadTodayCommitments({
      clubId: "cr", userId: "u1", clubTimezone: CR_TZ, now: NOW,
      loadUserMailbox: async () => ({ grantedScopes: ["Mail.Read", "Calendars.Read"], accessToken: "tok" }),
    });
    expect(s.outlookEventCount).toBe(0);
    expect(s.items).toHaveLength(0);
    expect(s.calendarConsent).toBe("PERMISSION_MISSING");
  });

  it("all-day events sort first", async () => {
    (prisma.proposedCommitment.findMany as any).mockResolvedValue([]);
    (fetchCalendarCommitmentsForToday as any).mockResolvedValue({
      state: "CONNECTED",
      events: [
        { externalEventId: "a", subject: "Timed meeting", startAt: new Date("2026-08-05T15:00:00Z"), endAt: new Date("2026-08-05T16:00:00Z"), isAllDay: false, source: "OUTLOOK_CALENDAR" },
        { externalEventId: "b", subject: "Founders visit day", startAt: new Date("2026-08-05T06:00:00Z"), endAt: new Date("2026-08-06T06:00:00Z"), isAllDay: true, source: "OUTLOOK_CALENDAR" },
      ],
    });
    const s = await loadTodayCommitments({
      clubId: "cr", userId: "u1", clubTimezone: CR_TZ, now: NOW,
      loadUserMailbox: async () => ({ grantedScopes: ["Calendars.Read"], accessToken: "tok" }),
    });
    expect(s.items[0].isAllDay).toBe(true);
    expect(s.items[0].timeLabel).toBe("All day");
  });
});
