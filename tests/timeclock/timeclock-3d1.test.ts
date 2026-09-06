// Payroll-3D-1 (2026-09-05) — Time & Attendance foundation tests.
//
// Covers §65-§83 of the 3D-1 brief:
//   §65 basic clock in
//   §66 clock out + session duration
//   §67 break math (paid = gross − break)
//   §68 clock out during break (auto-close)
//   §69 double clock in (concurrent) → one event
//   §70 double clock out
//   §71 double break start / end
//   §72 invalid state transitions denied
//   §73 multiple shifts per day
//   §74 cross midnight
//   §75 employee authorization (cross-employee denied)
//   §76 tenant isolation
//   §77 inactive employee
//   §78 NO_TIME_ENTRY_REQUIRED cannot clock
//   §79 MANUAL_TIMESHEET cannot clock via clock service
//   §80 SCHEDULE_DERIVED cannot clock via clock service
//   §81 NO PayrollApprovedTimeEntry side effect
//   §83 append-only (event timestamps not silently updatable)

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, principalFor } from "../util/db";
import {
  clockIn, clockOut, breakStart, breakEnd,
  getMyClockState, listCompletedSessions,
} from "@/lib/timeclock/service";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";

const utc = (y: number, m: number, d: number, h = 0, mi = 0) =>
  new Date(Date.UTC(y, m - 1, d, h, mi));

async function makeEmp(
  clubId: string,
  seed: string,
  method: "CLOCK_REQUIRED" | "NO_TIME_ENTRY_REQUIRED" | "MANUAL_TIMESHEET" | "SCHEDULE_DERIVED" = "CLOCK_REQUIRED",
  opts?: { status?: string; lifecycle?: string },
) {
  return db().employee.create({
    data: {
      clubId, firstName: "T", lastName: seed,
      email: `t.${seed}@t.test`, hireDate: utc(2026, 1, 1),
      status: opts?.status ?? "ACTIVE",
      employeeLifecycle: opts?.lifecycle ?? "ACTIVE",
      employeeNumber: `E-${seed}`, compensationType: "HOURLY",
      homeProvince: "AB",
      timekeepingMethod: method,
    },
  });
}
function principalFrom(clubId: string, employeeId: string): EmployeePortalPrincipal {
  return { clubId, employeeId, generation: 1, establishedAt: new Date().toISOString() };
}

// ==================================================================
// A · state machine + basic transitions
// ==================================================================
describe("Payroll-3D-1 · basic state machine", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§65 CLOCK_IN from OFF_CLOCK → WORKING with exactly one event", async () => {
    const club = await makeClub("timeclock A");
    const emp = await makeEmp(club.id, "a1");
    const p = principalFrom(club.id, emp.id);
    const initial = await getMyClockState(p);
    expect(initial.state).toBe("OFF_CLOCK");
    await clockIn(p);
    const st = await getMyClockState(p);
    expect(st.state).toBe("WORKING");
    const events = await db().timeClockEvent.count({ where: { employeeId: emp.id } });
    expect(events).toBe(1);
  });

  it("§66 CLOCK_OUT closes the session; completed session duration is correct", async () => {
    const club = await makeClub("timeclock B");
    const emp = await makeEmp(club.id, "b1");
    const p = principalFrom(club.id, emp.id);
    const inResult = await clockIn(p);
    // Simulate elapsed time by rewriting the CLOCK_IN's occurredAt
    // 30 minutes into the past. Justified for testing duration math
    // — production writes NEVER mutate events (§9); this test-only
    // rewrite is a synthetic time-travel, not a correction path.
    await db().timeClockEvent.update({
      where: { id: inResult.event.id },
      data: { occurredAt: new Date(Date.now() - 30 * 60 * 1000) },
    });
    await clockOut(p);
    const st = await getMyClockState(p);
    expect(st.state).toBe("OFF_CLOCK");
    const sessions = await listCompletedSessions(
      p,
      new Date(Date.now() - 60 * 60 * 1000),
      new Date(Date.now() + 60 * 1000),
    );
    expect(sessions.length).toBe(1);
    // Gross elapsed ≈ 30 min, no break → paid ≈ 30 min.
    expect(sessions[0].grossElapsedSeconds).toBeGreaterThanOrEqual(29 * 60);
    expect(sessions[0].grossElapsedSeconds).toBeLessThanOrEqual(31 * 60);
    expect(sessions[0].paidElapsedSeconds).toBe(sessions[0].grossElapsedSeconds);
    expect(sessions[0].breakSeconds).toBe(0);
  });

  it("§67 break math — paid duration = gross − break", async () => {
    const club = await makeClub("timeclock C");
    const emp = await makeEmp(club.id, "c1");
    const p = principalFrom(club.id, emp.id);
    // Craft a full session by inserting events directly with pinned
    // timestamps. Same synthetic time-travel rationale as §66.
    const nowStart = new Date(Date.now() - 60 * 60 * 1000);
    await db().timeClockEvent.createMany({
      data: [
        { clubId: club.id, employeeId: emp.id, kind: "CLOCK_IN",    occurredAt: nowStart,                                source: "EMPLOYEE_PORTAL" },
        { clubId: club.id, employeeId: emp.id, kind: "BREAK_START", occurredAt: new Date(nowStart.getTime() + 20 * 60_000), source: "EMPLOYEE_PORTAL" },
        { clubId: club.id, employeeId: emp.id, kind: "BREAK_END",   occurredAt: new Date(nowStart.getTime() + 30 * 60_000), source: "EMPLOYEE_PORTAL" },
        { clubId: club.id, employeeId: emp.id, kind: "CLOCK_OUT",   occurredAt: new Date(nowStart.getTime() + 60 * 60_000), source: "EMPLOYEE_PORTAL" },
      ],
    });
    const sessions = await listCompletedSessions(
      p,
      new Date(Date.now() - 2 * 60 * 60 * 1000),
      new Date(Date.now() + 60 * 1000),
    );
    expect(sessions.length).toBe(1);
    expect(sessions[0].grossElapsedSeconds).toBe(60 * 60);
    expect(sessions[0].breakSeconds).toBe(10 * 60);
    expect(sessions[0].paidElapsedSeconds).toBe(50 * 60);
  });

  it("§68 CLOCK_OUT during ON_BREAK closes the break at the CLOCK_OUT timestamp", async () => {
    const club = await makeClub("timeclock D");
    const emp = await makeEmp(club.id, "d1");
    const p = principalFrom(club.id, emp.id);
    const nowStart = new Date(Date.now() - 60 * 60 * 1000);
    await db().timeClockEvent.createMany({
      data: [
        { clubId: club.id, employeeId: emp.id, kind: "CLOCK_IN",    occurredAt: nowStart,                                source: "EMPLOYEE_PORTAL" },
        { clubId: club.id, employeeId: emp.id, kind: "BREAK_START", occurredAt: new Date(nowStart.getTime() + 40 * 60_000), source: "EMPLOYEE_PORTAL" },
      ],
    });
    // Should reach ON_BREAK.
    let st = await getMyClockState(p);
    expect(st.state).toBe("ON_BREAK");
    await clockOut(p);
    st = await getMyClockState(p);
    expect(st.state).toBe("OFF_CLOCK");
    // No dangling open break — completed session's breakSeconds
    // covers the interval BREAK_START → CLOCK_OUT.
    const sessions = await listCompletedSessions(
      p,
      new Date(Date.now() - 2 * 60 * 60 * 1000),
      new Date(Date.now() + 60 * 1000),
    );
    expect(sessions.length).toBe(1);
    // Break covers BREAK_START to CLOCK_OUT ≈ 20 min.
    expect(sessions[0].breakSeconds).toBeGreaterThanOrEqual(19 * 60);
  });
});

// ==================================================================
// B · concurrency + duplicate protection (§69-§71)
// ==================================================================
describe("Payroll-3D-1 · concurrent transitions", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§69 two parallel CLOCK_IN calls create exactly ONE CLOCK_IN event", async () => {
    const club = await makeClub("timeclock E");
    const emp = await makeEmp(club.id, "e1");
    const p = principalFrom(club.id, emp.id);
    const results = await Promise.allSettled([clockIn(p), clockIn(p)]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded.length).toBeGreaterThanOrEqual(1);
    // Exactly one CLOCK_IN event in the DB.
    const events = await db().timeClockEvent.count({
      where: { employeeId: emp.id, kind: "CLOCK_IN" },
    });
    expect(events).toBe(1);
  });

  it("§70 two parallel CLOCK_OUT calls create exactly ONE CLOCK_OUT event", async () => {
    const club = await makeClub("timeclock F");
    const emp = await makeEmp(club.id, "f1");
    const p = principalFrom(club.id, emp.id);
    await clockIn(p);
    const results = await Promise.allSettled([clockOut(p), clockOut(p)]);
    expect(results.filter((r) => r.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    const events = await db().timeClockEvent.count({
      where: { employeeId: emp.id, kind: "CLOCK_OUT" },
    });
    expect(events).toBe(1);
  });

  it("§71 concurrent break-start / break-end must not duplicate", async () => {
    const club = await makeClub("timeclock G");
    const emp = await makeEmp(club.id, "g1");
    const p = principalFrom(club.id, emp.id);
    await clockIn(p);
    await Promise.allSettled([breakStart(p), breakStart(p)]);
    const startCount = await db().timeClockEvent.count({
      where: { employeeId: emp.id, kind: "BREAK_START" },
    });
    expect(startCount).toBe(1);
    await Promise.allSettled([breakEnd(p), breakEnd(p)]);
    const endCount = await db().timeClockEvent.count({
      where: { employeeId: emp.id, kind: "BREAK_END" },
    });
    expect(endCount).toBe(1);
  });
});

// ==================================================================
// C · invalid transitions denied (§72)
// ==================================================================
describe("Payroll-3D-1 · invalid transitions", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("OFF_CLOCK → CLOCK_OUT denied", async () => {
    const club = await makeClub("timeclock H");
    const emp = await makeEmp(club.id, "h1");
    const p = principalFrom(club.id, emp.id);
    await expect(clockOut(p)).rejects.toBeInstanceOf(ConflictError);
    const events = await db().timeClockEvent.count({ where: { employeeId: emp.id } });
    expect(events).toBe(0);
  });

  it("OFF_CLOCK → BREAK_START denied", async () => {
    const club = await makeClub("timeclock I");
    const emp = await makeEmp(club.id, "i1");
    const p = principalFrom(club.id, emp.id);
    await expect(breakStart(p)).rejects.toBeInstanceOf(ConflictError);
  });

  it("WORKING → BREAK_END denied", async () => {
    const club = await makeClub("timeclock J");
    const emp = await makeEmp(club.id, "j1");
    const p = principalFrom(club.id, emp.id);
    await clockIn(p);
    await expect(breakEnd(p)).rejects.toBeInstanceOf(ConflictError);
  });

  it("ON_BREAK → CLOCK_IN denied", async () => {
    const club = await makeClub("timeclock K");
    const emp = await makeEmp(club.id, "k1");
    const p = principalFrom(club.id, emp.id);
    await clockIn(p);
    await breakStart(p);
    await expect(clockIn(p)).rejects.toBeInstanceOf(ConflictError);
  });
});

// ==================================================================
// D · multiple shifts + cross-midnight (§73-§74)
// ==================================================================
describe("Payroll-3D-1 · scheduling edge cases", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§73 supports multiple shifts on the same calendar day", async () => {
    const club = await makeClub("timeclock L");
    const emp = await makeEmp(club.id, "l1");
    const dayStart = new Date(Date.now() - 12 * 60 * 60 * 1000);
    // Two full sessions.
    await db().timeClockEvent.createMany({
      data: [
        { clubId: club.id, employeeId: emp.id, kind: "CLOCK_IN",  occurredAt: new Date(dayStart.getTime() + 0),               source: "EMPLOYEE_PORTAL" },
        { clubId: club.id, employeeId: emp.id, kind: "CLOCK_OUT", occurredAt: new Date(dayStart.getTime() + 4 * 60 * 60_000), source: "EMPLOYEE_PORTAL" },
        { clubId: club.id, employeeId: emp.id, kind: "CLOCK_IN",  occurredAt: new Date(dayStart.getTime() + 6 * 60 * 60_000), source: "EMPLOYEE_PORTAL" },
        { clubId: club.id, employeeId: emp.id, kind: "CLOCK_OUT", occurredAt: new Date(dayStart.getTime() + 9 * 60 * 60_000), source: "EMPLOYEE_PORTAL" },
      ],
    });
    const p = principalFrom(club.id, emp.id);
    const st = await getMyClockState(p);
    expect(st.state).toBe("OFF_CLOCK");
    const sessions = await listCompletedSessions(
      p,
      new Date(dayStart.getTime() - 60_000),
      new Date(dayStart.getTime() + 12 * 60 * 60_000),
    );
    expect(sessions.length).toBe(2);
    expect(sessions[0].grossElapsedSeconds).toBe(4 * 60 * 60);
    expect(sessions[1].grossElapsedSeconds).toBe(3 * 60 * 60);
  });

  it("§74 cross-midnight session — duration derived from timestamps", async () => {
    const club = await makeClub("timeclock M");
    const emp = await makeEmp(club.id, "m1");
    const clockInAt  = utc(2026, 9, 5, 22,  0);  // 10 PM
    const clockOutAt = utc(2026, 9, 6,  2,  0);  //  2 AM next day
    await db().timeClockEvent.createMany({
      data: [
        { clubId: club.id, employeeId: emp.id, kind: "CLOCK_IN",  occurredAt: clockInAt,  source: "EMPLOYEE_PORTAL" },
        { clubId: club.id, employeeId: emp.id, kind: "CLOCK_OUT", occurredAt: clockOutAt, source: "EMPLOYEE_PORTAL" },
      ],
    });
    const p = principalFrom(club.id, emp.id);
    const sessions = await listCompletedSessions(
      p,
      utc(2026, 9, 4),
      utc(2026, 9, 7),
    );
    expect(sessions.length).toBe(1);
    expect(sessions[0].grossElapsedSeconds).toBe(4 * 60 * 60);
    expect(sessions[0].grossElapsedSeconds).toBeGreaterThan(0);
  });
});

// ==================================================================
// E · authorization (§75, §76, §77)
// ==================================================================
describe("Payroll-3D-1 · authorization", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§75 employee-A principal cannot operate on employee-B", async () => {
    const club = await makeClub("timeclock N");
    const empA = await makeEmp(club.id, "n-A");
    const empB = await makeEmp(club.id, "n-B");
    const p = principalFrom(club.id, empA.id);
    await clockIn(p);
    // Read: passing a principal for A cannot ever return B's state.
    const stA = await getMyClockState(p);
    expect(stA.state).toBe("WORKING");
    // If someone forged a principal with B's employeeId but A's club,
    // getMyClockState would look up B — that's a different employee.
    // The service NEVER trusts a client-supplied employeeId; it uses
    // the principal ONLY. Test that principal-scoped queries stay
    // separate: B's state is unaffected by A's clock-in.
    const pB = principalFrom(club.id, empB.id);
    const stB = await getMyClockState(pB);
    expect(stB.state).toBe("OFF_CLOCK");
    expect(await db().timeClockEvent.count({ where: { employeeId: empB.id } })).toBe(0);
  });

  it("§76 cross-tenant read denies: employee lookup fails when clubId doesn't match", async () => {
    const clubA = await makeClub("timeclock tenant A");
    const clubB = await makeClub("timeclock tenant B");
    const empA = await makeEmp(clubA.id, "tA");
    // Attempt: someone forges a principal claiming empA's id but clubB's clubId.
    const forged = principalFrom(clubB.id, empA.id);
    await expect(clockIn(forged)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("§77 inactive employee cannot create new clock events", async () => {
    const club = await makeClub("timeclock O");
    const emp = await makeEmp(club.id, "o1", "CLOCK_REQUIRED", { lifecycle: "TERMINATED" });
    const p = principalFrom(club.id, emp.id);
    await expect(clockIn(p)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db().timeClockEvent.count({ where: { employeeId: emp.id } })).toBe(0);
  });
});

// ==================================================================
// F · timekeeping-method eligibility (§78-§80)
// ==================================================================
describe("Payroll-3D-1 · timekeeping method eligibility", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§78 NO_TIME_ENTRY_REQUIRED employee cannot clock in", async () => {
    const club = await makeClub("timeclock P");
    const emp = await makeEmp(club.id, "p1", "NO_TIME_ENTRY_REQUIRED");
    const p = principalFrom(club.id, emp.id);
    await expect(clockIn(p)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("§79 MANUAL_TIMESHEET employee cannot clock in via clock service", async () => {
    const club = await makeClub("timeclock Q");
    const emp = await makeEmp(club.id, "q1", "MANUAL_TIMESHEET");
    const p = principalFrom(club.id, emp.id);
    await expect(clockIn(p)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("§80 SCHEDULE_DERIVED employee cannot clock in via clock service", async () => {
    const club = await makeClub("timeclock R");
    const emp = await makeEmp(club.id, "r1", "SCHEDULE_DERIVED");
    const p = principalFrom(club.id, emp.id);
    await expect(clockIn(p)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

// ==================================================================
// G · no payroll side-effect (§81)
// ==================================================================
describe("Payroll-3D-1 · no PayrollApprovedTimeEntry side effect", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§81 CLOCK_IN + CLOCK_OUT creates ZERO PayrollApprovedTimeEntry rows", async () => {
    const club = await makeClub("timeclock S");
    const emp = await makeEmp(club.id, "s1");
    const p = principalFrom(club.id, emp.id);
    const before = await db().payrollApprovedTimeEntry.count();
    await clockIn(p);
    await clockOut(p);
    const after = await db().payrollApprovedTimeEntry.count();
    expect(after).toBe(before);
    // Also assert per-employee count is exactly 0.
    const empRows = await db().payrollApprovedTimeEntry.count({ where: { employeeId: emp.id } });
    expect(empRows).toBe(0);
  });
});

// ==================================================================
// H · append-only (§83)
// ==================================================================
describe("Payroll-3D-1 · append-only clock events", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§83 the service never UPDATEs an existing event's occurredAt", async () => {
    const club = await makeClub("timeclock T");
    const emp = await makeEmp(club.id, "t1");
    const p = principalFrom(club.id, emp.id);
    const r = await clockIn(p);
    const original = await db().timeClockEvent.findUniqueOrThrow({ where: { id: r.event.id } });
    // Break the session at a later time — this should create a NEW
    // BREAK_START event, NOT rewrite the CLOCK_IN.
    await breakStart(p);
    const after = await db().timeClockEvent.findUniqueOrThrow({ where: { id: r.event.id } });
    expect(after.occurredAt.getTime()).toBe(original.occurredAt.getTime());
    expect(after.kind).toBe(original.kind);
    // Two events total: original CLOCK_IN + new BREAK_START.
    expect(await db().timeClockEvent.count({ where: { employeeId: emp.id } })).toBe(2);
  });
});
