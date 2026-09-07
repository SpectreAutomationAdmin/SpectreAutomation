// Scheduling Foundation · Phase D (2026-09-07) — reconciliation +
// week-window + week summary tests.
//
// Covers the founder-mandated invariants from the Phase D brief:
//   §11 orthogonal reconciliation (no mutation of Shift or
//       PayrollTimesheetEntry); matches by assignmentId + time window,
//       not by calendar date alone.
//   §11 overnight/date-boundary case does not incorrectly match
//       another shift.
//   §8  remaining hours = future/unmatched scheduled duration; NOT
//       scheduled - worked.
//   Ownership / tenant isolation on the reconciliation query.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import {
  reconcileEmployeeScheduleWindow,
  summariseReconciliation,
  nextShift,
} from "@/lib/scheduling/scheduled-vs-worked";
import { isoWeekStart, isoWeekWindow, addDays, isoWeekLabel } from "@/lib/scheduling/week-window";

const utc = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, mi));

async function makeDept(clubId: string, code: string, name: string) {
  return db().department.create({ data: { clubId, code, name, isActive: true } });
}
async function makeEmp(clubId: string, seed: string) {
  return db().employee.create({
    data: {
      clubId, firstName: "Test", lastName: `Emp-${seed}`,
      email: `${seed}@t.test`, hireDate: utc(2026, 1, 1),
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
      employeeNumber: `E-${seed}`, compensationType: "HOURLY",
      homeProvince: "AB", timekeepingMethod: "CLOCK_REQUIRED",
    },
  });
}
async function makeAssn(clubId: string, employeeId: string, departmentId: string) {
  return db().employeeEmploymentAssignment.create({
    data: {
      clubId, employeeId, role: "PRIMARY", employmentType: "PART_TIME",
      effectiveFrom: utc(2026, 1, 1), departmentId,
    },
  });
}
async function makeTemplate(clubId: string, departmentId: string, code: string, name: string, startMin: number, endMin: number) {
  return db().shiftTemplate.create({
    data: { clubId, departmentId, code, name, startTimeMinutes: startMin, endTimeMinutes: endMin, active: true },
  });
}
async function makeShiftAssignment(
  clubId: string, departmentId: string, templateId: string,
  employeeId: string, employmentAssignmentId: string,
  startAt: Date, endAt: Date,
) {
  const shift = await db().shift.create({
    data: {
      clubId, departmentId, shiftTemplateId: templateId,
      shiftDate: startAt, startAt, endAt, state: "PUBLISHED",
    },
  });
  const assn = await db().shiftAssignment.create({
    data: {
      clubId, shiftId: shift.id, employeeId, employmentAssignmentId,
      state: "ASSIGNED",
    },
  });
  return { shift, assignment: assn };
}
async function makePayGroupAndPeriod(clubId: string, seed: string, employeeId: string, periodStart: Date, periodEnd: Date) {
  const pg = await db().payrollPayGroup.create({
    data: {
      clubId, code: `PG-${seed}`, name: `Test-${seed}`,
      payFrequency: "BI_WEEKLY", payDateOffsetDays: 5,
      calendarAnchorDate: utc(2026, 1, 1), active: true,
    },
  });
  await db().payrollPayGroupMember.create({
    data: { clubId, payGroupId: pg.id, employeeId, effectiveFrom: utc(2020, 1, 1) },
  });
  const period = await db().payrollPayPeriod.create({
    data: {
      clubId, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 1,
      periodStart, periodEnd,
      payDate: addDays(periodEnd, 5), status: "OPEN",
    },
  });
  return { payGroup: pg, period };
}
async function makeTimesheetEntry(
  clubId: string, employeeId: string, payPeriodId: string,
  employmentAssignmentId: string, clockIn: Date, clockOut: Date,
) {
  const timesheet = await db().payrollTimesheet.upsert({
    where: {
      clubId_employeeId_payPeriodId: { clubId, employeeId, payPeriodId },
    },
    update: {},
    create: { clubId, employeeId, payPeriodId, status: "OPEN" },
  });
  const seconds = Math.floor((clockOut.getTime() - clockIn.getTime()) / 1000);
  return db().payrollTimesheetEntry.create({
    data: {
      clubId, timesheetId: timesheet.id, employeeId,
      workDate: clockIn, employmentAssignmentId,
      earningClassification: "REGULAR",
      clockInAt: clockIn, clockOutAt: clockOut,
      recordedSeconds: seconds, breakSeconds: 0,
    },
  });
}

// ==================================================================
describe("Scheduling Foundation · Phase D · week-window helpers", () => {
  it("isoWeekStart snaps to Monday 00:00 UTC", () => {
    // 2026-09-10 is a Thursday → Monday 2026-09-07.
    expect(isoWeekStart(utc(2026, 9, 10, 14, 30)).toISOString())
      .toBe("2026-09-07T00:00:00.000Z");
    // 2026-09-07 (Monday itself) → same day.
    expect(isoWeekStart(utc(2026, 9, 7, 0, 0)).toISOString())
      .toBe("2026-09-07T00:00:00.000Z");
    // 2026-09-13 (Sunday) → 2026-09-07.
    expect(isoWeekStart(utc(2026, 9, 13, 23, 59)).toISOString())
      .toBe("2026-09-07T00:00:00.000Z");
  });

  it("isoWeekWindow bounds a 7-day [start, end) instant window", () => {
    const w = isoWeekWindow(utc(2026, 9, 10, 12, 0));
    expect(w.start.toISOString()).toBe("2026-09-07T00:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-09-14T00:00:00.000Z");
  });

  it("isoWeekLabel formats single-month weeks", () => {
    expect(isoWeekLabel(utc(2026, 9, 7))).toBe("September 7 – 13, 2026");
  });

  it("isoWeekLabel formats month-crossing weeks with abbreviated end month", () => {
    // Week starting 2026-08-31 (Monday) → ends 2026-09-06 (Sunday).
    expect(isoWeekLabel(utc(2026, 8, 31))).toBe("August 31 – Sep 6, 2026");
  });
});

// ==================================================================
describe("Scheduling Foundation · Phase D · reconciliation", () => {
  beforeAll(async () => { /* schema pre-applied */ });
  beforeEach(async () => {
    await resetDb();
    await seedRbac();
  });

  it("§11 matches worked entry to scheduled shift via assignmentId + time-window", async () => {
    const club = await makeClub("d-recon-1");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-r1");
    const asn = await makeAssn(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "DAY", "Day", 11 * 60, 17 * 60 + 30);
    const { assignment } = await makeShiftAssignment(
      club.id, events.id, t.id, emp.id, asn.id,
      utc(2026, 9, 7, 11, 0), utc(2026, 9, 7, 17, 30),
    );
    const { period } = await makePayGroupAndPeriod(
      club.id, "r1", emp.id, utc(2026, 9, 1), utc(2026, 9, 16),
    );
    // Actual worked: 10:58 → 17:42 (early clock-in + late clock-out).
    await makeTimesheetEntry(
      club.id, emp.id, period.id, asn.id,
      utc(2026, 9, 7, 10, 58), utc(2026, 9, 7, 17, 42),
    );

    const r = await reconcileEmployeeScheduleWindow(
      club.id, emp.id, utc(2026, 9, 7), utc(2026, 9, 14),
    );
    expect(r.entries.length).toBe(1);
    const e = r.entries[0];
    expect(e.assignmentId).toBe(assignment.id);
    expect(e.worked).not.toBeNull();
    expect(e.worked!.workedSeconds).toBe(6 * 3600 + 44 * 60);
    // Variance = +14 min.
    expect(e.varianceSeconds).toBe(14 * 60);
  });

  it("§11 overnight shift does NOT swallow the next-day's worked entry", async () => {
    const club = await makeClub("d-recon-2");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-r2");
    const asn = await makeAssn(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "EVENING", "Evening", 17 * 60, 23 * 60);
    // Sat overnight shift 22:00 → 02:00 (crosses midnight into Sunday).
    const overnight = await makeShiftAssignment(
      club.id, events.id, t.id, emp.id, asn.id,
      utc(2026, 9, 12, 22, 0), utc(2026, 9, 13, 2, 0),
    );
    // Sun daytime shift 11:00 → 17:30 — SAME date as overnight endAt.
    const sunday = await makeShiftAssignment(
      club.id, events.id, t.id, emp.id, asn.id,
      utc(2026, 9, 13, 11, 0), utc(2026, 9, 13, 17, 30),
    );
    const { period } = await makePayGroupAndPeriod(
      club.id, "r2", emp.id, utc(2026, 9, 1), utc(2026, 9, 16),
    );
    // Worked for the overnight only.
    await makeTimesheetEntry(
      club.id, emp.id, period.id, asn.id,
      utc(2026, 9, 12, 22, 5), utc(2026, 9, 13, 2, 10),
    );
    // Worked for the Sunday daytime shift.
    await makeTimesheetEntry(
      club.id, emp.id, period.id, asn.id,
      utc(2026, 9, 13, 11, 2), utc(2026, 9, 13, 17, 25),
    );

    const r = await reconcileEmployeeScheduleWindow(
      club.id, emp.id, utc(2026, 9, 7), utc(2026, 9, 14),
    );
    expect(r.entries.length).toBe(2);
    const byShift = new Map(r.entries.map((e) => [e.shiftId, e]));
    const eOver = byShift.get(overnight.shift.id)!;
    const eSun = byShift.get(sunday.shift.id)!;
    // Overnight worked entry is the 22:05 clock-in (closest to 22:00 start).
    expect(eOver.worked?.clockInAt.getUTCHours()).toBe(22);
    // Sunday daytime worked entry is the 11:02 clock-in.
    expect(eSun.worked?.clockInAt.getUTCHours()).toBe(11);
  });

  it("§8 remaining = future/unmatched scheduled duration, NOT scheduled - worked", async () => {
    const club = await makeClub("d-recon-3");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-r3");
    const asn = await makeAssn(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "DAY", "Day", 11 * 60, 17 * 60 + 30);
    // Two shifts in the window:
    //   Mon 2026-09-07 11:00 → 17:30 — WORKED (7h — worked 30m over)
    //   Fri 2026-09-11 11:00 → 17:30 — FUTURE (unworked)
    await makeShiftAssignment(
      club.id, events.id, t.id, emp.id, asn.id,
      utc(2026, 9, 7, 11, 0), utc(2026, 9, 7, 17, 30),
    );
    await makeShiftAssignment(
      club.id, events.id, t.id, emp.id, asn.id,
      utc(2026, 9, 11, 11, 0), utc(2026, 9, 11, 17, 30),
    );
    const { period } = await makePayGroupAndPeriod(
      club.id, "r3", emp.id, utc(2026, 9, 1), utc(2026, 9, 16),
    );
    // Worked Monday 11:00 → 18:00 (30m OVER scheduled).
    await makeTimesheetEntry(
      club.id, emp.id, period.id, asn.id,
      utc(2026, 9, 7, 11, 0), utc(2026, 9, 7, 18, 0),
    );
    const r = await reconcileEmployeeScheduleWindow(
      club.id, emp.id, utc(2026, 9, 7), utc(2026, 9, 14),
    );
    // Wed Sep 9 12:00 UTC — Monday shift is past + worked; Friday shift is future.
    const now = utc(2026, 9, 9, 12, 0);
    const summary = summariseReconciliation(r, now);
    // Scheduled = 2 × 6.5h = 13h.
    expect(summary.scheduledSeconds).toBe(2 * (6 * 3600 + 30 * 60));
    // Worked = Monday 7h (30m OVER).
    expect(summary.workedSeconds).toBe(7 * 3600);
    // Remaining = FUTURE UNMATCHED shift only = Friday 6.5h. NOT
    // scheduled - worked (which would be 6h, WRONG per §8).
    expect(summary.remainingSeconds).toBe(6 * 3600 + 30 * 60);
  });

  it("§11 no matching worked entry stays truthful (worked=null, variance=null)", async () => {
    const club = await makeClub("d-recon-4");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-r4");
    const asn = await makeAssn(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "DAY", "Day", 11 * 60, 17 * 60 + 30);
    await makeShiftAssignment(
      club.id, events.id, t.id, emp.id, asn.id,
      utc(2026, 9, 8, 11, 0), utc(2026, 9, 8, 17, 30),
    );
    const r = await reconcileEmployeeScheduleWindow(
      club.id, emp.id, utc(2026, 9, 7), utc(2026, 9, 14),
    );
    expect(r.entries.length).toBe(1);
    expect(r.entries[0].worked).toBeNull();
    expect(r.entries[0].varianceSeconds).toBeNull();
  });

  it("§ ownership — reconciliation returns only the employee's own shifts", async () => {
    const club = await makeClub("d-recon-5");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const alice = await makeEmp(club.id, "e-r5-alice");
    const bob = await makeEmp(club.id, "e-r5-bob");
    const aAsn = await makeAssn(club.id, alice.id, events.id);
    const bAsn = await makeAssn(club.id, bob.id, events.id);
    const t = await makeTemplate(club.id, events.id, "DAY", "Day", 11 * 60, 17 * 60 + 30);
    // Bob has a shift; Alice does not.
    await makeShiftAssignment(
      club.id, events.id, t.id, bob.id, bAsn.id,
      utc(2026, 9, 8, 11, 0), utc(2026, 9, 8, 17, 30),
    );
    const r = await reconcileEmployeeScheduleWindow(
      club.id, alice.id, utc(2026, 9, 7), utc(2026, 9, 14),
    );
    expect(r.entries.length).toBe(0);
  });

  it("§ tenant isolation — reconciliation refuses cross-club", async () => {
    const clubA = await makeClub("d-recon-6-a");
    const clubB = await makeClub("d-recon-6-b");
    const eventsA = await makeDept(clubA.id, "EVENTS", "Events");
    const empA = await makeEmp(clubA.id, "e-r6-a");
    const asnA = await makeAssn(clubA.id, empA.id, eventsA.id);
    const tA = await makeTemplate(clubA.id, eventsA.id, "DAY", "Day", 11 * 60, 17 * 60 + 30);
    await makeShiftAssignment(
      clubA.id, eventsA.id, tA.id, empA.id, asnA.id,
      utc(2026, 9, 8, 11, 0), utc(2026, 9, 8, 17, 30),
    );
    const r = await reconcileEmployeeScheduleWindow(
      clubB.id, empA.id, utc(2026, 9, 7), utc(2026, 9, 14),
    );
    expect(r.entries.length).toBe(0);
  });

  it("nextShift returns the earliest future shift", async () => {
    const club = await makeClub("d-recon-7");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-r7");
    const asn = await makeAssn(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "DAY", "Day", 11 * 60, 17 * 60 + 30);
    await makeShiftAssignment(
      club.id, events.id, t.id, emp.id, asn.id,
      utc(2027, 1, 12, 11, 0), utc(2027, 1, 12, 17, 30),
    );
    const earlier = await makeShiftAssignment(
      club.id, events.id, t.id, emp.id, asn.id,
      utc(2027, 1, 11, 11, 0), utc(2027, 1, 11, 17, 30),
    );
    const r = await reconcileEmployeeScheduleWindow(
      club.id, emp.id, utc(2027, 1, 11), utc(2027, 1, 18),
    );
    const next = nextShift(r, utc(2027, 1, 10, 12, 0));
    expect(next?.shiftId).toBe(earlier.shift.id);
  });

  it("§ inactive/replaced assignments do not appear in the week reconciliation", async () => {
    const club = await makeClub("d-recon-8");
    const events = await makeDept(club.id, "EVENTS", "Events");
    const emp = await makeEmp(club.id, "e-r8");
    const asn = await makeAssn(club.id, emp.id, events.id);
    const t = await makeTemplate(club.id, events.id, "DAY", "Day", 11 * 60, 17 * 60 + 30);
    const { assignment } = await makeShiftAssignment(
      club.id, events.id, t.id, emp.id, asn.id,
      utc(2026, 9, 8, 11, 0), utc(2026, 9, 8, 17, 30),
    );
    // Flip to REPLACED — reconciliation should exclude.
    await db().shiftAssignment.update({
      where: { id: assignment.id }, data: { state: "REPLACED" },
    });
    const r = await reconcileEmployeeScheduleWindow(
      club.id, emp.id, utc(2026, 9, 7), utc(2026, 9, 14),
    );
    expect(r.entries.length).toBe(0);
  });
});
