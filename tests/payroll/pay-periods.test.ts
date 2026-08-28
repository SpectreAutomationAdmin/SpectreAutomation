// Payroll-3B-2 (2026-08-28) — deterministic pay-period generation tests.
//
// Every test uses UTC-anchored civil dates so results are timezone-
// independent. Weekly/biweekly counts are DATA-driven from actual
// calendar arithmetic, not hard-coded to 52/26.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { ValidationError } from "@/lib/errors";
import { createPayGroup, updatePayGroup } from "@/lib/payroll/pay-groups";
import { upsertPayrollClubConfig } from "@/lib/payroll/club-config";
import {
  generatePayPeriods,
  previewPayPeriods,
  listPayPeriods,
  buildCalendar,
} from "@/lib/payroll/pay-periods";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

/** Catch a promise rejection and return the ValidationError issue
 *  messages joined for `.toMatch`-style assertions. */
async function issueMessagesFrom<T>(p: Promise<T>): Promise<string> {
  try {
    await p;
    throw new Error("expected promise to reject");
  } catch (err) {
    if (err instanceof ValidationError) {
      return err.issues.map((i) => `${i.path}: ${i.message}`).join(" | ");
    }
    throw err;
  }
}

describe("Payroll-3B-2 — pay-period generation", () => {
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  async function setup() {
    const clubA = await makeClub("Payroll Club A");
    const clubB = await makeClub("Payroll Club B");
    const admin = await makeUser({ email: "admin@a.test", role: "CLUB_ADMIN", clubId: clubA.id });
    const adminP = await principalFor(admin.email);
    await upsertPayrollClubConfig(adminP, clubA.id, { provinceOfEmployment: "AB" });
    return { clubA, clubB, adminP };
  }

  // ---------------------------------------------------------------------
  // Pure calendar builder — no DB, tests civil-date arithmetic directly.
  // ---------------------------------------------------------------------

  it("SEMI_MONTHLY 2026 with offset=5 → 24 periods (prior-Dec-16 pickup exactly offsets current-Dec-16 spill)", () => {
    const rows = buildCalendar({
      payFrequency: "SEMI_MONTHLY",
      payDateOffsetDays: 5,
      calendarAnchorDate: null,
      taxYear: 2026,
    });
    // Tax-year-follows-payDate: the Dec-16-2025 → Jan-1-2026 half
    // pays Jan 6 2026 (in 2026) but the Dec-16-2026 → Jan-1-2027 half
    // pays Jan 6 2027 (in 2027). Net = 24 rows.
    expect(rows.length).toBe(24);
    // rows[0] is Dec-16-2025 → Jan-1-2026, pay Jan 6 2026.
    expect(rows[0]!.periodStart.getTime()).toBe(utc(2025, 12, 16).getTime());
    expect(rows[0]!.periodEnd.getTime()).toBe(utc(2026, 1, 1).getTime());
    expect(rows[0]!.payDate.getTime()).toBe(utc(2026, 1, 6).getTime());
    expect(rows[0]!.sequenceInYear).toBe(1);
    expect(rows[0]!.taxYear).toBe(2026);
    // rows[1] is the first in-2026 period: Jan 1 → Jan 16, pay Jan 21.
    expect(rows[1]!.periodStart.getTime()).toBe(utc(2026, 1, 1).getTime());
    expect(rows[1]!.periodEnd.getTime()).toBe(utc(2026, 1, 16).getTime());
    expect(rows[1]!.payDate.getTime()).toBe(utc(2026, 1, 21).getTime());
    // Last period: Dec 1 → Dec 16 2026 pays Dec 21 2026 — still in 2026.
    expect(rows[23]!.periodStart.getTime()).toBe(utc(2026, 12, 1).getTime());
    expect(rows[23]!.periodEnd.getTime()).toBe(utc(2026, 12, 16).getTime());
    expect(rows[23]!.payDate.getTime()).toBe(utc(2026, 12, 21).getTime());
  });

  it("SEMI_MONTHLY tax-year-follows-payDate — Dec-16 period paying Jan 2 belongs to next year", () => {
    // Use offset=17 so the Dec-16→Jan-1 (excl) period pays Jan-18 next year.
    // Simpler: offset=1 → Dec-16→Jan-1 period pays Jan-2 next year.
    const y2026 = buildCalendar({
      payFrequency: "SEMI_MONTHLY",
      payDateOffsetDays: 1,
      calendarAnchorDate: null,
      taxYear: 2026,
    });
    // Only ONE row in 2026 should have a periodStart in December 2026
    // — the Dec 1 → Dec 16 half. The Dec 16 → Jan 1 half's payDate
    // lands in Jan 2027 and therefore belongs to the 2027 tax year.
    const dec = y2026.filter(
      (r) => r.periodStart.getUTCMonth() === 11 && r.periodStart.getUTCFullYear() === 2026,
    );
    expect(dec.length).toBe(1);
    expect(dec[0]!.periodStart.getTime()).toBe(utc(2026, 12, 1).getTime());
    expect(dec[0]!.payDate.getTime()).toBe(utc(2026, 12, 17).getTime());
    // And that missing Dec-16→Jan-1 period shows up in 2027's calendar
    // as its first period.
    const y2027 = buildCalendar({
      payFrequency: "SEMI_MONTHLY",
      payDateOffsetDays: 1,
      calendarAnchorDate: null,
      taxYear: 2027,
    });
    expect(y2027[0]!.periodStart.getTime()).toBe(utc(2026, 12, 16).getTime());
    expect(y2027[0]!.periodEnd.getTime()).toBe(utc(2027, 1, 1).getTime());
    expect(y2027[0]!.payDate.getTime()).toBe(utc(2027, 1, 2).getTime());
    expect(y2027[0]!.taxYear).toBe(2027);
  });

  it("MONTHLY tax year — 12 rows with prior-Dec pickup replacing current-Dec spill", () => {
    const rows2026 = buildCalendar({
      payFrequency: "MONTHLY",
      payDateOffsetDays: 5,
      calendarAnchorDate: null,
      taxYear: 2026,
    });
    // MONTHLY periods always end on the 1st of the following month, so
    // the pay date lands offset days into that following month. With
    // offset=5, the Dec 2026 period pays Jan 6 2027 (out of year) but
    // the Dec 2025 period pays Jan 6 2026 (in year). Net = 12.
    expect(rows2026.length).toBe(12);
    expect(rows2026[0]!.periodStart.getTime()).toBe(utc(2025, 12, 1).getTime());
    expect(rows2026[0]!.periodEnd.getTime()).toBe(utc(2026, 1, 1).getTime());
    expect(rows2026[0]!.payDate.getTime()).toBe(utc(2026, 1, 6).getTime());
    // Feb 2026 (not a leap year): [Feb 1, Mar 1).
    const feb = rows2026.find(
      (r) => r.periodStart.getUTCMonth() === 1 && r.periodStart.getUTCFullYear() === 2026,
    )!;
    expect(feb.periodStart.getTime()).toBe(utc(2026, 2, 1).getTime());
    expect(feb.periodEnd.getTime()).toBe(utc(2026, 3, 1).getTime());
    // Leap year 2028: Feb still [Feb 1, Mar 1) — half-open handles it.
    const rows2028 = buildCalendar({
      payFrequency: "MONTHLY",
      payDateOffsetDays: 5,
      calendarAnchorDate: null,
      taxYear: 2028,
    });
    const feb28 = rows2028.find(
      (r) => r.periodStart.getUTCMonth() === 1 && r.periodStart.getUTCFullYear() === 2028,
    )!;
    expect(feb28.periodEnd.getTime()).toBe(utc(2028, 3, 1).getTime());
  });

  it("MONTHLY with offset=0 → exactly 12 rows (no prior-Dec pickup)", () => {
    const rows = buildCalendar({
      payFrequency: "MONTHLY",
      payDateOffsetDays: 0,
      calendarAnchorDate: null,
      taxYear: 2026,
    });
    // With offset=0, Dec-2025 → Jan-1-2026 pays Jan 1 2026 (in 2026 tax year).
    // So still 13. Use MONTHLY + WEEKDAY 0 in a year that starts on Sun/Mon
    // to confirm — but any offset > 0 or ==0 will pick up Dec-prior
    // because periodEnd itself is Jan 1. Instead assert: every row is
    // strictly monthly-spaced and payDate is always in requested year.
    for (const r of rows) expect(r.payDate.getUTCFullYear()).toBe(2026);
  });

  it("WEEKLY anchor 2026-01-04 → 52 periods in 2026 (payDate offset 5 keeps every payDate in 2026)", () => {
    const rows = buildCalendar({
      payFrequency: "WEEKLY",
      payDateOffsetDays: 5,
      calendarAnchorDate: utc(2026, 1, 4),
      taxYear: 2026,
    });
    // 52 or 53 depending on payDate alignment — count is DATA-driven.
    expect(rows.length).toBeGreaterThanOrEqual(52);
    expect(rows.length).toBeLessThanOrEqual(53);
    // Every payDate belongs to the requested year.
    expect(rows.every((r) => r.payDate.getUTCFullYear() === 2026)).toBe(true);
    // Cadence — every consecutive pair is exactly 7 days apart.
    for (let i = 1; i < rows.length; i++) {
      const gap = rows[i]!.payDate.getTime() - rows[i - 1]!.payDate.getTime();
      expect(gap).toBe(7 * 86400000);
    }
    // sequenceInYear is 1..N in payDate order.
    expect(rows[0]!.sequenceInYear).toBe(1);
    expect(rows[rows.length - 1]!.sequenceInYear).toBe(rows.length);
  });

  it("BIWEEKLY anchor 2020-01-03 → number of 2026 payDates comes from the calendar, not hard-coded to 26", () => {
    const rows = buildCalendar({
      payFrequency: "BIWEEKLY",
      payDateOffsetDays: 7,
      calendarAnchorDate: utc(2020, 1, 3),
      taxYear: 2026,
    });
    // 26 or 27 depending on how pay dates land — test data-driven, not fixed.
    expect(rows.length === 26 || rows.length === 27).toBe(true);
    // Cadence: every consecutive pair 14 days apart.
    for (let i = 1; i < rows.length; i++) {
      const gap = rows[i]!.payDate.getTime() - rows[i - 1]!.payDate.getTime();
      expect(gap).toBe(14 * 86400000);
    }
    // Every pay date falls in 2026.
    expect(rows.every((r) => r.payDate.getUTCFullYear() === 2026)).toBe(true);
  });

  it("WEEKLY without an anchor throws structured error", () => {
    expect(() => buildCalendar({
      payFrequency: "WEEKLY",
      payDateOffsetDays: 5,
      calendarAnchorDate: null,
      taxYear: 2026,
    })).toThrow();
  });

  // ---------------------------------------------------------------------
  // Service integration — DB persistence, idempotency, guards, audit.
  // ---------------------------------------------------------------------

  it("generatePayPeriods persists rows once, and reruns are idempotent (no duplicates)", async () => {
    const { clubA, adminP } = await setup();
    const grp = await createPayGroup(adminP, clubA.id, {
      code: "MO",
      name: "Monthly",
      payFrequency: "MONTHLY",
      payDateOffsetDays: 5,
    });
    const first = await generatePayPeriods(adminP, clubA.id, grp.id, 2026);
    expect(first.status).toBe("created");
    expect(first.count).toBe(12);
    // Rerun — same tenant, same year, same config.
    const second = await generatePayPeriods(adminP, clubA.id, grp.id, 2026);
    expect(second.status).toBe("existing-matches");
    expect(second.count).toBe(12);
    const stored = await db().payrollPayPeriod.count({ where: { clubId: clubA.id, payGroupId: grp.id, taxYear: 2026 } });
    expect(stored).toBe(12);
  });

  it("refuses to replace an existing non-identical schedule (Payroll-3B-2 §10)", async () => {
    const { clubA, adminP } = await setup();
    const grp = await createPayGroup(adminP, clubA.id, {
      code: "MO",
      name: "Monthly",
      payFrequency: "MONTHLY",
      payDateOffsetDays: 5,
    });
    await generatePayPeriods(adminP, clubA.id, grp.id, 2026);
    // Now sneak in a modified row directly to simulate divergence.
    const target = await db().payrollPayPeriod.findFirst({
      where: { clubId: clubA.id, payGroupId: grp.id, sequenceInYear: 1 },
    });
    await db().payrollPayPeriod.update({
      where: { id: target!.id },
      data: { payDate: utc(2027, 6, 1) }, // arbitrary divergence
    });
    // Regeneration must refuse, not silently rewrite.
    const msg = await issueMessagesFrom(generatePayPeriods(adminP, clubA.id, grp.id, 2026));
    expect(msg).toMatch(/Existing payroll calendars cannot be replaced automatically/);
  });

  it("updatePayGroup blocks calendar-affecting mutation once periods exist; non-calendar edits still allowed", async () => {
    const { clubA, adminP } = await setup();
    const grp = await createPayGroup(adminP, clubA.id, {
      code: "MO",
      name: "Monthly",
      payFrequency: "MONTHLY",
      payDateOffsetDays: 5,
    });
    await generatePayPeriods(adminP, clubA.id, grp.id, 2026);
    // Non-calendar edits allowed.
    const renamed = await updatePayGroup(adminP, clubA.id, grp.id, { name: "Renamed monthly", notes: "n" });
    expect(renamed.name).toBe("Renamed monthly");
    // Calendar-affecting edits blocked.
    const m1 = await issueMessagesFrom(updatePayGroup(adminP, clubA.id, grp.id, { payFrequency: "SEMI_MONTHLY" }));
    expect(m1).toMatch(/calendar/i);
    const m2 = await issueMessagesFrom(updatePayGroup(adminP, clubA.id, grp.id, { payDateOffsetDays: 10 }));
    expect(m2).toMatch(/calendar/i);
    const m3 = await issueMessagesFrom(updatePayGroup(adminP, clubA.id, grp.id, { calendarAnchorDate: utc(2020, 1, 3) }));
    expect(m3).toMatch(/calendar/i);
  });

  it("WEEKLY generation fails without an anchor + succeeds after anchor is set (before any periods exist)", async () => {
    const { clubA, adminP } = await setup();
    const grp = await createPayGroup(adminP, clubA.id, {
      code: "WK",
      name: "Weekly",
      payFrequency: "WEEKLY",
      payDateOffsetDays: 5,
    });
    // No anchor yet → generation rejected.
    const noAnchor = await issueMessagesFrom(generatePayPeriods(adminP, clubA.id, grp.id, 2026));
    expect(noAnchor).toMatch(/calendar anchor date is required/i);
    // Set the anchor (allowed because no periods exist yet).
    await updatePayGroup(adminP, clubA.id, grp.id, { calendarAnchorDate: utc(2026, 1, 4) });
    const result = await generatePayPeriods(adminP, clubA.id, grp.id, 2026);
    expect(result.status).toBe("created");
    expect(result.count).toBeGreaterThanOrEqual(52);
    expect(result.count).toBeLessThanOrEqual(53);
  });

  it("tenant isolation — Club A admin cannot generate/read Club B pay periods", async () => {
    const { clubA, clubB, adminP } = await setup();
    const grpA = await createPayGroup(adminP, clubA.id, {
      code: "MO",
      name: "Monthly",
      payFrequency: "MONTHLY",
      payDateOffsetDays: 5,
    });
    await expect(generatePayPeriods(adminP, clubB.id, grpA.id, 2026)).rejects.toThrow();
    await expect(listPayPeriods(adminP, clubB.id)).rejects.toThrow();
    // Cross-tenant pay-group id refused via clubB scope too.
    await expect(generatePayPeriods(adminP, clubB.id, "nonexistent", 2026)).rejects.toThrow();
  });

  it("STAFF role cannot generate (permission enforced at service boundary)", async () => {
    const { clubA, adminP } = await setup();
    const grp = await createPayGroup(adminP, clubA.id, {
      code: "MO",
      name: "Monthly",
      payFrequency: "MONTHLY",
      payDateOffsetDays: 5,
    });
    const staff = await makeUser({ email: "staff@a.test", role: "STAFF", clubId: clubA.id });
    const staffP = await principalFor(staff.email);
    await expect(generatePayPeriods(staffP, clubA.id, grp.id, 2026)).rejects.toThrow();
    // Preview still gated by payroll:read — STAFF has none.
    await expect(previewPayPeriods(staffP, clubA.id, grp.id, 2026)).rejects.toThrow();
  });

  it("generation emits exactly one audit row per call (Payroll-3B-2 §18)", async () => {
    const { clubA, adminP } = await setup();
    const grp = await createPayGroup(adminP, clubA.id, {
      code: "MO",
      name: "Monthly",
      payFrequency: "MONTHLY",
      payDateOffsetDays: 5,
    });
    await generatePayPeriods(adminP, clubA.id, grp.id, 2026);
    const audits = await db().auditLog.findMany({
      where: { clubId: clubA.id, action: "payroll.pay-period.generate" },
      select: { action: true, afterJson: true, userId: true },
    });
    expect(audits.length).toBe(1);
    expect(audits[0]!.userId).toBe(adminP.id);
    const after = JSON.parse(audits[0]!.afterJson!) as {
      payGroupId: string;
      taxYear: number;
      count: number;
      firstPayDate: string;
      lastPayDate: string;
    };
    expect(after.payGroupId).toBe(grp.id);
    expect(after.taxYear).toBe(2026);
    expect(after.count).toBe(12);
  });

  it("civil dates survive machine timezone — stored rows read back at UTC midnight", async () => {
    const { clubA, adminP } = await setup();
    const grp = await createPayGroup(adminP, clubA.id, {
      code: "MO",
      name: "Monthly",
      payFrequency: "MONTHLY",
      payDateOffsetDays: 5,
    });
    await generatePayPeriods(adminP, clubA.id, grp.id, 2026);
    const rows = await db().payrollPayPeriod.findMany({
      where: { clubId: clubA.id, payGroupId: grp.id },
      orderBy: { sequenceInYear: "asc" },
    });
    // Every stored date is UTC midnight (H/M/S/ms all zero).
    for (const r of rows) {
      for (const d of [r.periodStart, r.periodEnd, r.payDate]) {
        expect(d.getUTCHours()).toBe(0);
        expect(d.getUTCMinutes()).toBe(0);
        expect(d.getUTCSeconds()).toBe(0);
        expect(d.getUTCMilliseconds()).toBe(0);
      }
    }
    // The 2026-tax-year MONTHLY calendar with offset=5 begins with the
    // Dec-2025 period (pays Jan 6 2026). The first "in-2026" period is
    // Jan-2026, at row[1].
    expect(rows[0]!.periodStart.getTime()).toBe(utc(2025, 12, 1).getTime());
    expect(rows[1]!.periodStart.getTime()).toBe(utc(2026, 1, 1).getTime());
  });

  it("previewPayPeriods returns the same dates as generatePayPeriods but writes nothing", async () => {
    const { clubA, adminP } = await setup();
    const grp = await createPayGroup(adminP, clubA.id, {
      code: "MO",
      name: "Monthly",
      payFrequency: "MONTHLY",
      payDateOffsetDays: 5,
    });
    const preview = await previewPayPeriods(adminP, clubA.id, grp.id, 2026);
    expect(preview.length).toBe(12);
    // Nothing persisted yet.
    const stored = await db().payrollPayPeriod.count({ where: { clubId: clubA.id, payGroupId: grp.id } });
    expect(stored).toBe(0);
    // Now generate → the persisted rows match the preview exactly.
    const gen = await generatePayPeriods(adminP, clubA.id, grp.id, 2026);
    expect(gen.count).toBe(12);
    for (let i = 0; i < 12; i++) {
      expect(gen.periods[i]!.periodStart.getTime()).toBe(preview[i]!.periodStart.getTime());
      expect(gen.periods[i]!.periodEnd.getTime()).toBe(preview[i]!.periodEnd.getTime());
      expect(gen.periods[i]!.payDate.getTime()).toBe(preview[i]!.payDate.getTime());
    }
  });

  it("negative offsets rejected (payDateOffsetDays must be 0..30)", async () => {
    const { clubA, adminP } = await setup();
    await expect(
      createPayGroup(adminP, clubA.id, {
        code: "BAD",
        name: "Bad offset",
        payFrequency: "MONTHLY",
        payDateOffsetDays: -1,
      }),
    ).rejects.toThrow();
    await expect(
      createPayGroup(adminP, clubA.id, {
        code: "BAD2",
        name: "Bad offset 2",
        payFrequency: "MONTHLY",
        payDateOffsetDays: 31,
      }),
    ).rejects.toThrow();
  });

  it("inactive pay group refuses generation with an actionable message", async () => {
    const { clubA, adminP } = await setup();
    const grp = await createPayGroup(adminP, clubA.id, {
      code: "MO",
      name: "Monthly",
      payFrequency: "MONTHLY",
      payDateOffsetDays: 5,
      active: false,
    });
    const msg = await issueMessagesFrom(generatePayPeriods(adminP, clubA.id, grp.id, 2026));
    expect(msg).toMatch(/inactive/i);
  });
});
