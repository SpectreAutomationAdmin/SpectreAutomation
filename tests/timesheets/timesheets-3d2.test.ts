// Payroll-3D-2 (2026-09-05) — Employee Timesheets + Correction Requests.
//
// Covers §67-§86 of the 3D-2 brief:
//   §67 basic materialization: 1 clean session → 1 entry
//   §68 idempotency: run twice → identical rows, no duplicates
//   §69 concurrency (parallel materializes → 1 canonical row set)
//   §70 break math (recorded = gross − break)
//   §71 multiple sessions on one day → multiple entries, same workDate
//   §72 cross-midnight: workDate = local CLOCK_IN date, not CLOCK_OUT
//   §73 pay-period-boundary: session belongs to period containing CLOCK_IN
//   §74 open session → MISSING_CLOCK_OUT exception + NEEDS_ATTENTION
//   §75 missing assignment → MISSING_ASSIGNMENT exception
//   §76 correction submit ADD_MISSING_CLOCK_OUT stores PENDING
//   §77 correction CORRECT_CLOCK_IN with originalClockEventId
//   §78 duplicate correction (same type + original) → idempotent success
//   §79 blank reason rejected
//   §80 invalid timestamp rejected (DST gap)
//   §81 employee isolation: cannot reference another employee's event
//   §82 tenant isolation: cannot read/materialize other club's data
//   §83 NO_TIME_ENTRY_REQUIRED: no timesheet materialized when no
//        pay-group membership at asOf (portal separately gates render)
//   §84 no payroll side effect: PayrollApprovedTimeEntry count == 0
//   §85 cancel PENDING correction
//   §86 already-cancelled correction cannot be cancelled again
//   §86c REGRESSION: mixed-state materialise (Session A complete +
//        Session B open on the same period) must not crash on
//        Postgres due to provenance duplicate-key aborting the
//        surrounding transaction. Local SQLite tolerates the
//        per-statement failure; Postgres promotes it to 25P02
//        "current transaction is aborted, commands ignored". Fix:
//        upsert the provenance rows instead of catching P2002.
//        Reproduces the staging /employee/timesheets crash (digest
//        1627805270) that surfaced during the founder walkthrough.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import {
  materializeEmployeeTimesheet,
  getMyCurrentTimesheet,
  getTimesheetForPeriod,
  extractCompletedSessions,
  localWorkDate,
} from "@/lib/timesheets/service";
import {
  submitCorrectionRequest,
  cancelCorrectionRequest,
  listMyCorrectionRequests,
  requestedLocalToUtc,
} from "@/lib/timesheets/correction-service";
import { clockIn, clockOut, breakStart, breakEnd } from "@/lib/timeclock/service";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";

const utc = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, mi));

async function makeEmp(
  clubId: string,
  seed: string,
  method: "CLOCK_REQUIRED" | "NO_TIME_ENTRY_REQUIRED" = "CLOCK_REQUIRED",
) {
  return db().employee.create({
    data: {
      clubId, firstName: "T", lastName: seed,
      email: `t.${seed}@t.test`, hireDate: utc(2026, 1, 1),
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
      employeeNumber: `E-${seed}`, compensationType: "HOURLY",
      homeProvince: "AB", timekeepingMethod: method,
    },
  });
}

async function makeAssn(clubId: string, employeeId: string) {
  return db().employeeEmploymentAssignment.create({
    data: {
      clubId, employeeId, role: "PRIMARY",
      employmentType: "PART_TIME", effectiveFrom: utc(2026, 1, 1),
    },
  });
}

async function makeSemiMonthlyPeriod(
  clubId: string,
  seed: string,
  employeeId: string,
  opts?: { periodStart?: Date; periodEnd?: Date; payDate?: Date; taxYear?: number; seq?: number },
) {
  const pg = await db().payrollPayGroup.create({
    data: {
      clubId, code: `SM-${seed}`, name: "Semi-Monthly Test",
      payFrequency: "SEMI_MONTHLY", payDateOffsetDays: 5,
      calendarAnchorDate: utc(2026, 1, 1), active: true,
    },
  });
  const period = await db().payrollPayPeriod.create({
    data: {
      clubId, payGroupId: pg.id,
      taxYear: opts?.taxYear ?? 2026, sequenceInYear: opts?.seq ?? 17,
      periodStart: opts?.periodStart ?? utc(2026, 9, 1),
      periodEnd:   opts?.periodEnd   ?? utc(2026, 9, 16),
      payDate:     opts?.payDate     ?? utc(2026, 9, 20),
      status: "OPEN",
    },
  });
  await db().payrollPayGroupMember.create({
    data: { clubId, payGroupId: pg.id, employeeId, effectiveFrom: utc(2020, 1, 1) },
  });
  return { pg, period };
}

function principalFrom(clubId: string, employeeId: string): EmployeePortalPrincipal {
  return { clubId, employeeId, generation: 1, establishedAt: new Date().toISOString() };
}

async function makeClockEvent(
  clubId: string, employeeId: string,
  kind: "CLOCK_IN" | "CLOCK_OUT" | "BREAK_START" | "BREAK_END",
  occurredAt: Date, opts?: { assignmentId?: string | null },
) {
  return db().timeClockEvent.create({
    data: {
      clubId, employeeId, kind, occurredAt,
      source: "EMPLOYEE_PORTAL",
      employmentAssignmentId: opts?.assignmentId ?? null,
    },
  });
}

// ==================================================================
// A · basic materialization + math
// ==================================================================
describe("Payroll-3D-2 · materialization basics", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§67 one clean session → one entry, status READY_FOR_REVIEW", async () => {
    const club = await makeClub("3D2-A");
    const emp = await makeEmp(club.id, "a1");
    const assn = await makeAssn(club.id, emp.id);
    const { period } = await makeSemiMonthlyPeriod(club.id, "a1", emp.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), { assignmentId: assn.id });
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: assn.id });

    const r = await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    expect(r.entriesUpserted).toBe(1);
    expect(r.status).toBe("READY_FOR_REVIEW");
    expect(r.exceptions).toHaveLength(0);

    const rows = await db().payrollTimesheetEntry.findMany({ where: { timesheetId: r.timesheetId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].recordedSeconds).toBe(8 * 60 * 60);
    expect(rows[0].breakSeconds).toBe(0);

    const prov = await db().payrollTimesheetEntryClockEvent.findMany({
      where: { timesheetEntryId: rows[0].id },
    });
    expect(prov).toHaveLength(2);
    expect(prov.map((p) => p.role).sort()).toEqual(["ANCHOR_IN", "ANCHOR_OUT"]);
  });

  it("§68 idempotent — running twice does not duplicate entries or provenance", async () => {
    const club = await makeClub("3D2-B");
    const emp = await makeEmp(club.id, "b1");
    const assn = await makeAssn(club.id, emp.id);
    const { period } = await makeSemiMonthlyPeriod(club.id, "b1", emp.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), { assignmentId: assn.id });
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: assn.id });

    const r1 = await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    const r2 = await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    expect(r1.timesheetId).toBe(r2.timesheetId);

    const entryCount = await db().payrollTimesheetEntry.count({ where: { timesheetId: r1.timesheetId } });
    expect(entryCount).toBe(1);
    const provCount = await db().payrollTimesheetEntryClockEvent.count({});
    expect(provCount).toBe(2);
  });

  it("§86c REGRESSION: mixed complete + open session on the same period rematerialises cleanly and returns the timesheet view without throwing", async () => {
    // Reproduces the staging /employee/timesheets crash from the
    // founder walkthrough (digest 1627805270). Session A completes
    // with a break, then Session B opens without a Clock Out. The
    // second materialise pass would re-insert Session A's provenance
    // rows (already there) and — on Postgres — abort the surrounding
    // transaction on the resulting P2002. Fix: upsert provenance
    // rather than swallowing P2002.
    const club = await makeClub("3D2-mix");
    const emp = await makeEmp(club.id, "mix1");
    const assn = await makeAssn(club.id, emp.id);
    const { period } = await makeSemiMonthlyPeriod(club.id, "mix1", emp.id);

    // Session A — complete with break.
    await makeClockEvent(club.id, emp.id, "CLOCK_IN",    utc(2026, 9, 5, 14, 0), { assignmentId: assn.id });
    await makeClockEvent(club.id, emp.id, "BREAK_START", utc(2026, 9, 5, 18, 0));
    await makeClockEvent(club.id, emp.id, "BREAK_END",   utc(2026, 9, 5, 19, 0));
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT",   utc(2026, 9, 5, 22, 0), { assignmentId: assn.id });

    // First materialise — Session A lands with its 4 provenance rows.
    const r1 = await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    expect(r1.entriesUpserted).toBe(1);
    expect(r1.status).toBe("READY_FOR_REVIEW");

    // Session B opens, no Clock Out.
    await makeClockEvent(club.id, emp.id, "CLOCK_IN",    utc(2026, 9, 6, 14, 0), { assignmentId: assn.id });

    // Second materialise — Session A's provenance already exists; the
    // materialiser must NOT crash. Session B must surface as an
    // exception, not as a completed entry.
    const r2 = await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    expect(r2.timesheetId).toBe(r1.timesheetId);
    expect(r2.exceptions.some((e) => e.kind === "MISSING_CLOCK_OUT")).toBe(true);
    expect(r2.status).toBe("NEEDS_ATTENTION");

    // Session B produced NO PayrollTimesheetEntry.
    const entries = await db().payrollTimesheetEntry.findMany({
      where: { timesheetId: r1.timesheetId }, orderBy: { clockInAt: "asc" },
    });
    expect(entries).toHaveLength(1);
    expect(entries[0].clockInAt.toISOString()).toBe(utc(2026, 9, 5, 14, 0).toISOString());

    // The user-facing view builder (backing /employee/timesheets) must
    // also succeed and report the exception.
    const view = await getTimesheetForPeriod(principalFrom(club.id, emp.id), period.id);
    expect(view.entries).toHaveLength(1);
    expect(view.exceptions.some((e) => e.kind === "MISSING_CLOCK_OUT")).toBe(true);
    expect(view.status).toBe("NEEDS_ATTENTION");

    // Provenance is deduped: Session A retains exactly its 4 rows
    // (ANCHOR_IN, ANCHOR_OUT, BREAK_START, BREAK_END). No duplicates.
    const prov = await db().payrollTimesheetEntryClockEvent.findMany({
      where: { timesheetEntryId: entries[0].id },
    });
    expect(prov).toHaveLength(4);

    // No payroll side effect from Session B open state.
    const approvedCount = await db().payrollApprovedTimeEntry.count({
      where: { clubId: club.id, employeeId: emp.id },
    });
    expect(approvedCount).toBe(0);

    // Third materialise + read for good measure — repeat pass with no
    // new events must remain clean.
    const r3 = await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    expect(r3.timesheetId).toBe(r1.timesheetId);
    const view2 = await getTimesheetForPeriod(principalFrom(club.id, emp.id), period.id);
    expect(view2.exceptions.some((e) => e.kind === "MISSING_CLOCK_OUT")).toBe(true);
  });

  it("§69 concurrent materialize → one canonical timesheet", async () => {
    const club = await makeClub("3D2-C");
    const emp = await makeEmp(club.id, "c1");
    const assn = await makeAssn(club.id, emp.id);
    const { period } = await makeSemiMonthlyPeriod(club.id, "c1", emp.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), { assignmentId: assn.id });
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: assn.id });

    const results = await Promise.all([
      materializeEmployeeTimesheet(club.id, emp.id, period.id),
      materializeEmployeeTimesheet(club.id, emp.id, period.id),
      materializeEmployeeTimesheet(club.id, emp.id, period.id),
    ]);
    const uniqueIds = new Set(results.map((r) => r.timesheetId));
    expect(uniqueIds.size).toBe(1);
    const entryCount = await db().payrollTimesheetEntry.count({});
    expect(entryCount).toBe(1);
  });

  it("§70 break math: 8h session with 60m unpaid break → recorded 7h", async () => {
    const club = await makeClub("3D2-D");
    const emp = await makeEmp(club.id, "d1");
    const assn = await makeAssn(club.id, emp.id);
    const { period } = await makeSemiMonthlyPeriod(club.id, "d1", emp.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_IN",    utc(2026, 9, 5, 14, 0), { assignmentId: assn.id });
    await makeClockEvent(club.id, emp.id, "BREAK_START", utc(2026, 9, 5, 18, 0));
    await makeClockEvent(club.id, emp.id, "BREAK_END",   utc(2026, 9, 5, 19, 0));
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT",   utc(2026, 9, 5, 22, 0), { assignmentId: assn.id });

    const r = await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    const rows = await db().payrollTimesheetEntry.findMany({ where: { timesheetId: r.timesheetId } });
    expect(rows[0].recordedSeconds).toBe(7 * 60 * 60);
    expect(rows[0].breakSeconds).toBe(60 * 60);

    const prov = await db().payrollTimesheetEntryClockEvent.findMany({
      where: { timesheetEntryId: rows[0].id },
    });
    expect(prov).toHaveLength(4);
    expect(prov.filter((p) => p.role === "BREAK_START")).toHaveLength(1);
    expect(prov.filter((p) => p.role === "BREAK_END")).toHaveLength(1);
  });

  it("§71 two sessions same day → two entries, same workDate", async () => {
    const club = await makeClub("3D2-E");
    const emp = await makeEmp(club.id, "e1");
    const assn = await makeAssn(club.id, emp.id);
    const { period } = await makeSemiMonthlyPeriod(club.id, "e1", emp.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 10, 0), { assignmentId: assn.id });
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 12, 0), { assignmentId: assn.id });
    await makeClockEvent(club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: assn.id });
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 18, 0), { assignmentId: assn.id });

    const r = await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    expect(r.entriesUpserted).toBe(2);
    const rows = await db().payrollTimesheetEntry.findMany({
      where: { timesheetId: r.timesheetId }, orderBy: { clockInAt: "asc" },
    });
    expect(rows[0].workDate.getTime()).toBe(rows[1].workDate.getTime());
    expect(rows[0].recordedSeconds).toBe(2 * 60 * 60);
    expect(rows[1].recordedSeconds).toBe(4 * 60 * 60);
  });

  it("§72 cross-midnight: workDate is CLOCK_IN's local date (Edmonton tz)", async () => {
    const club = await db().club.create({
      data: {
        name: "3D2-Edm", slug: "d2-edm", region: "AB", salesTaxRegion: "GST", foundedYear: 2020,
        timezone: "America/Edmonton",
      },
    });
    const emp = await makeEmp(club.id, "f1");
    const assn = await makeAssn(club.id, emp.id);
    const { period } = await makeSemiMonthlyPeriod(club.id, "f1", emp.id);
    // 2026-09-05 22:00 America/Edmonton = 2026-09-06 04:00Z (MDT UTC-6).
    // Session ends 2026-09-06 02:00 America/Edmonton = 2026-09-06 08:00Z.
    await makeClockEvent(club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 6, 4, 0), { assignmentId: assn.id });
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 6, 8, 0), { assignmentId: assn.id });

    const r = await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    const rows = await db().payrollTimesheetEntry.findMany({ where: { timesheetId: r.timesheetId } });
    expect(rows).toHaveLength(1);
    // workDate must be the LOCAL Edmonton date of CLOCK_IN — 2026-09-05.
    expect(rows[0].workDate.getUTCFullYear()).toBe(2026);
    expect(rows[0].workDate.getUTCMonth()).toBe(8);
    expect(rows[0].workDate.getUTCDate()).toBe(5);
    expect(rows[0].recordedSeconds).toBe(4 * 60 * 60);
  });

  it("§73 pay-period-boundary: session at end-of-period belongs to that period", async () => {
    const club = await makeClub("3D2-G");
    const emp = await makeEmp(club.id, "g1");
    const assn = await makeAssn(club.id, emp.id);
    const { pg, period: sept1 } = await makeSemiMonthlyPeriod(club.id, "g1", emp.id, {
      periodStart: utc(2026, 9, 1), periodEnd: utc(2026, 9, 16), payDate: utc(2026, 9, 20), seq: 17,
    });
    const sept2 = await db().payrollPayPeriod.create({
      data: {
        clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 18,
        periodStart: utc(2026, 9, 16), periodEnd: utc(2026, 10, 1),
        payDate: utc(2026, 10, 5), status: "OPEN",
      },
    });
    // Session starts 2026-09-15 22:00Z (inside sept1), ends 2026-09-16 02:00Z (inside sept2 by ts alone).
    await makeClockEvent(club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 15, 22, 0), { assignmentId: assn.id });
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 16, 2,  0), { assignmentId: assn.id });

    const r1 = await materializeEmployeeTimesheet(club.id, emp.id, sept1.id);
    const r2 = await materializeEmployeeTimesheet(club.id, emp.id, sept2.id);
    const rows1 = await db().payrollTimesheetEntry.findMany({ where: { timesheetId: r1.timesheetId } });
    const rows2 = await db().payrollTimesheetEntry.findMany({ where: { timesheetId: r2.timesheetId } });
    expect(rows1).toHaveLength(1);
    expect(rows2).toHaveLength(0);
  });

  it("§74 open session → MISSING_CLOCK_OUT exception + status NEEDS_ATTENTION", async () => {
    const club = await makeClub("3D2-H");
    const emp = await makeEmp(club.id, "h1");
    const assn = await makeAssn(club.id, emp.id);
    const { period } = await makeSemiMonthlyPeriod(club.id, "h1", emp.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), { assignmentId: assn.id });

    const r = await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    expect(r.status).toBe("NEEDS_ATTENTION");
    expect(r.exceptions.some((e) => e.kind === "MISSING_CLOCK_OUT")).toBe(true);
    const rows = await db().payrollTimesheetEntry.findMany({ where: { timesheetId: r.timesheetId } });
    expect(rows).toHaveLength(0);
  });

  it("§75 missing assignment → MISSING_ASSIGNMENT exception on the entry's clock-in", async () => {
    const club = await makeClub("3D2-I");
    const emp = await makeEmp(club.id, "i1");
    const { period } = await makeSemiMonthlyPeriod(club.id, "i1", emp.id);
    // Employee has no assignments → clock events carry assignmentId=null.
    await makeClockEvent(club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: null });
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: null });

    const r = await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    expect(r.exceptions.some((e) => e.kind === "MISSING_ASSIGNMENT")).toBe(true);
    expect(r.status).toBe("NEEDS_ATTENTION");
  });

  it("§82 tenant isolation: cannot materialize another club's period", async () => {
    const cA = await makeClub("3D2-J-A");
    const cB = await makeClub("3D2-J-B");
    const empA = await makeEmp(cA.id, "j1");
    const empB = await makeEmp(cB.id, "j2");
    await makeAssn(cA.id, empA.id);
    await makeAssn(cB.id, empB.id);
    const { period: periodB } = await makeSemiMonthlyPeriod(cB.id, "j2", empB.id);

    await expect(
      materializeEmployeeTimesheet(cA.id, empA.id, periodB.id),
    ).rejects.toThrow();
  });

  it("§83 no pay-group membership → getMyCurrentTimesheet returns NO_PAY_GROUP", async () => {
    const club = await makeClub("3D2-K");
    const emp = await makeEmp(club.id, "k1");
    const p = principalFrom(club.id, emp.id);
    const res = await getMyCurrentTimesheet(p, { asOf: utc(2026, 9, 5, 14, 0) });
    expect("state" in res && res.state).toBe("NO_PAY_GROUP");
  });

  it("§84 no PayrollApprovedTimeEntry side effect from materialization", async () => {
    const club = await makeClub("3D2-L");
    const emp = await makeEmp(club.id, "l1");
    const assn = await makeAssn(club.id, emp.id);
    const { period } = await makeSemiMonthlyPeriod(club.id, "l1", emp.id);
    await makeClockEvent(club.id, emp.id, "CLOCK_IN",  utc(2026, 9, 5, 14, 0), { assignmentId: assn.id });
    await makeClockEvent(club.id, emp.id, "CLOCK_OUT", utc(2026, 9, 5, 22, 0), { assignmentId: assn.id });

    await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    const approved = await db().payrollApprovedTimeEntry.count({
      where: { clubId: club.id, employeeId: emp.id },
    });
    expect(approved).toBe(0);
  });
});

// ==================================================================
// B · pure helpers
// ==================================================================
describe("Payroll-3D-2 · pure helpers", () => {
  it("extractCompletedSessions closes an open break when CLOCK_OUT fires mid-break", () => {
    const events = [
      { id: "1", kind: "CLOCK_IN",    occurredAt: utc(2026, 9, 5, 14, 0), employmentAssignmentId: "a" },
      { id: "2", kind: "BREAK_START", occurredAt: utc(2026, 9, 5, 15, 0), employmentAssignmentId: null },
      { id: "3", kind: "CLOCK_OUT",   occurredAt: utc(2026, 9, 5, 15, 30), employmentAssignmentId: "a" },
    ];
    const { sessions, openBreak } = extractCompletedSessions(events, "UTC");
    expect(sessions).toHaveLength(1);
    expect(sessions[0].breakSeconds).toBe(30 * 60);
    expect(sessions[0].recordedSeconds).toBe(60 * 60);
    expect(openBreak).toBeNull();
  });

  it("localWorkDate normalizes to UTC-midnight of the club-tz civil date", () => {
    // 2026-09-06 04:00Z is 2026-09-05 22:00 America/Edmonton (MDT).
    const d = localWorkDate(utc(2026, 9, 6, 4, 0), "America/Edmonton");
    expect(d.toISOString()).toBe("2026-09-05T00:00:00.000Z");
  });

  it("requestedLocalToUtc converts local wall-clock to UTC via Club tz", () => {
    const d = requestedLocalToUtc("2026-09-05T22:00", "America/Edmonton");
    expect(d.toISOString()).toBe("2026-09-06T04:00:00.000Z");
  });

  it("requestedLocalToUtc rejects a nonexistent DST spring-forward time", () => {
    // 2026-03-08 02:30 America/Edmonton skips (02:00 → 03:00 MDT).
    expect(() => requestedLocalToUtc("2026-03-08T02:30", "America/Edmonton"))
      .toThrow(ValidationError);
  });
});

// ==================================================================
// C · correction requests
// ==================================================================
describe("Payroll-3D-2 · correction requests", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§76 ADD_MISSING_CLOCK_OUT: submit stores PENDING with requested time", async () => {
    const club = await db().club.create({
      data: {
        name: "3D2-M", slug: "d2-m", region: "AB", salesTaxRegion: "GST", foundedYear: 2020,
        timezone: "America/Edmonton",
      },
    });
    const emp = await makeEmp(club.id, "m1");
    await makeAssn(club.id, emp.id);
    const p = principalFrom(club.id, emp.id);
    const r = await submitCorrectionRequest(p, {
      requestType: "ADD_MISSING_CLOCK_OUT",
      requestedLocalIso: "2026-09-05T22:00",
      reason: "Forgot to clock out at end of shift",
    });
    expect(r.idempotent).toBe(false);
    expect(r.request.status).toBe("PENDING");
    expect(r.request.requestedOccurredAt?.toISOString()).toBe("2026-09-06T04:00:00.000Z");
    const list = await listMyCorrectionRequests(p);
    expect(list).toHaveLength(1);
  });

  it("§77 CORRECT_CLOCK_IN requires originalClockEventId", async () => {
    const club = await makeClub("3D2-N");
    const emp = await makeEmp(club.id, "n1");
    const assn = await makeAssn(club.id, emp.id);
    const p = principalFrom(club.id, emp.id);
    const ev = await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), { assignmentId: assn.id });
    const r = await submitCorrectionRequest(p, {
      requestType: "CORRECT_CLOCK_IN",
      originalClockEventId: ev.id,
      requestedLocalIso: "2026-09-05T09:00",
      reason: "Started earlier than logged",
    });
    expect(r.request.originalClockEventId).toBe(ev.id);
    expect(r.request.status).toBe("PENDING");

    // Missing originalClockEventId → rejected.
    await expect(
      submitCorrectionRequest(p, {
        requestType: "CORRECT_CLOCK_IN",
        requestedLocalIso: "2026-09-05T09:00",
        reason: "Started earlier",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("§78 duplicate correction (same type + original) → idempotent success", async () => {
    const club = await makeClub("3D2-O");
    const emp = await makeEmp(club.id, "o1");
    const assn = await makeAssn(club.id, emp.id);
    const p = principalFrom(club.id, emp.id);
    const ev = await makeClockEvent(club.id, emp.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), { assignmentId: assn.id });

    const r1 = await submitCorrectionRequest(p, {
      requestType: "CORRECT_CLOCK_IN",
      originalClockEventId: ev.id,
      requestedLocalIso: "2026-09-05T09:00",
      reason: "reason A",
    });
    const r2 = await submitCorrectionRequest(p, {
      requestType: "CORRECT_CLOCK_IN",
      originalClockEventId: ev.id,
      requestedLocalIso: "2026-09-05T09:00",
      reason: "reason B (dup)",
    });
    expect(r1.idempotent).toBe(false);
    expect(r2.idempotent).toBe(true);
    expect(r1.request.id).toBe(r2.request.id);
    const count = await db().timeClockCorrectionRequest.count({
      where: { employeeId: emp.id, status: "PENDING" },
    });
    expect(count).toBe(1);
  });

  it("§79 blank reason rejected", async () => {
    const club = await makeClub("3D2-P");
    const emp = await makeEmp(club.id, "p1");
    const p = principalFrom(club.id, emp.id);
    await expect(
      submitCorrectionRequest(p, {
        requestType: "ADD_MISSING_CLOCK_OUT",
        requestedLocalIso: "2026-09-05T22:00",
        reason: "   ",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("§80 invalid requestedLocalIso format rejected", async () => {
    const club = await makeClub("3D2-Q");
    const emp = await makeEmp(club.id, "q1");
    const p = principalFrom(club.id, emp.id);
    await expect(
      submitCorrectionRequest(p, {
        requestType: "ADD_MISSING_CLOCK_OUT",
        requestedLocalIso: "not-a-time",
        reason: "test",
      }),
    ).rejects.toThrow(ValidationError);
  });

  it("§81 employee isolation: cannot reference another employee's clock event", async () => {
    const club = await makeClub("3D2-R");
    const empA = await makeEmp(club.id, "r1");
    const empB = await makeEmp(club.id, "r2");
    const assnB = await makeAssn(club.id, empB.id);
    const evB = await makeClockEvent(club.id, empB.id, "CLOCK_IN", utc(2026, 9, 5, 14, 0), { assignmentId: assnB.id });
    const pA = principalFrom(club.id, empA.id);

    await expect(
      submitCorrectionRequest(pA, {
        requestType: "CORRECT_CLOCK_IN",
        originalClockEventId: evB.id,
        requestedLocalIso: "2026-09-05T09:00",
        reason: "malicious",
      }),
    ).rejects.toThrow(ForbiddenError);
  });

  it("§85 cancel PENDING correction transitions to CANCELLED", async () => {
    const club = await makeClub("3D2-S");
    const emp = await makeEmp(club.id, "s1");
    const p = principalFrom(club.id, emp.id);
    const r = await submitCorrectionRequest(p, {
      requestType: "ADD_MISSING_CLOCK_OUT",
      requestedLocalIso: "2026-09-05T22:00",
      reason: "test",
    });
    const cancelled = await cancelCorrectionRequest(p, r.request.id);
    expect(cancelled.status).toBe("CANCELLED");
  });

  it("§86 cancelling a non-PENDING request throws ConflictError", async () => {
    const club = await makeClub("3D2-T");
    const emp = await makeEmp(club.id, "t1");
    const p = principalFrom(club.id, emp.id);
    const r = await submitCorrectionRequest(p, {
      requestType: "ADD_MISSING_CLOCK_OUT",
      requestedLocalIso: "2026-09-05T22:00",
      reason: "test",
    });
    await cancelCorrectionRequest(p, r.request.id);
    await expect(cancelCorrectionRequest(p, r.request.id)).rejects.toThrow(ConflictError);
  });

  it("§86b cancelling another employee's request is ForbiddenError", async () => {
    const club = await makeClub("3D2-U");
    const empA = await makeEmp(club.id, "u1");
    const empB = await makeEmp(club.id, "u2");
    const pA = principalFrom(club.id, empA.id);
    const pB = principalFrom(club.id, empB.id);
    const r = await submitCorrectionRequest(pA, {
      requestType: "ADD_MISSING_CLOCK_OUT",
      requestedLocalIso: "2026-09-05T22:00",
      reason: "test",
    });
    await expect(cancelCorrectionRequest(pB, r.request.id)).rejects.toThrow(ForbiddenError);
  });
});

// ==================================================================
// D · end-to-end via clockIn/Out service (proves the 3D-1 → 3D-2 seam)
// ==================================================================
describe("Payroll-3D-2 · e2e via timeclock service", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("clockIn → breakStart → breakEnd → clockOut → materialize → 1 entry with break math", async () => {
    const club = await makeClub("3D2-V");
    const emp = await makeEmp(club.id, "v1");
    const assn = await makeAssn(club.id, emp.id);
    const { period } = await makeSemiMonthlyPeriod(club.id, "v1", emp.id);
    const p = principalFrom(club.id, emp.id);
    const inR = await clockIn(p, { employmentAssignmentId: assn.id });
    await db().timeClockEvent.update({
      where: { id: inR.event.id },
      data: { occurredAt: utc(2026, 9, 5, 14, 0) },
    });
    const bs = await breakStart(p);
    await db().timeClockEvent.update({
      where: { id: bs.event.id },
      data: { occurredAt: utc(2026, 9, 5, 18, 0) },
    });
    const be = await breakEnd(p);
    await db().timeClockEvent.update({
      where: { id: be.event.id },
      data: { occurredAt: utc(2026, 9, 5, 19, 0) },
    });
    const out = await clockOut(p);
    await db().timeClockEvent.update({
      where: { id: out.event.id },
      data: { occurredAt: utc(2026, 9, 5, 22, 0) },
    });

    const r = await materializeEmployeeTimesheet(club.id, emp.id, period.id);
    const rows = await db().payrollTimesheetEntry.findMany({ where: { timesheetId: r.timesheetId } });
    expect(rows).toHaveLength(1);
    expect(rows[0].recordedSeconds).toBe(7 * 60 * 60);
    expect(rows[0].breakSeconds).toBe(60 * 60);
    expect(r.status).toBe("READY_FOR_REVIEW");
  });
});
