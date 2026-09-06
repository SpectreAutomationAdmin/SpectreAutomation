// Payroll-3D-1A (2026-09-05) — forced-race concurrency tests.
//
// Proves the stateVersion compare-and-swap primitive prevents two
// concurrent Prisma transactions from BOTH committing a new
// TimeClockEvent for the same employee.
//
// Strategy: fire two truly parallel transitions via Promise.all and
// then assert the DATABASE row count — NOT just the API responses.
// Under the pre-3D-1A code (which relied only on a 3-second in-tx
// state check), Postgres could commit both events; under 3D-1A the
// second CAS matches zero rows, its transaction rolls back, and the
// second TimeClockEvent insert is annihilated.
//
// Also proves the immutable-history invariant: after each forced
// race, no illegal sequence (CLOCK_IN twice with no CLOCK_OUT
// between, etc.) is ever persisted.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub } from "../util/db";
import { clockIn, clockOut, breakStart, breakEnd } from "@/lib/timeclock/service";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";

const utc = (y: number, m: number, d: number, h = 0) => new Date(Date.UTC(y, m - 1, d, h));
async function makeClockEmp(clubId: string, seed: string) {
  return db().employee.create({
    data: {
      clubId, firstName: "T", lastName: seed,
      email: `t.${seed}@t.test`, hireDate: utc(2026, 1, 1),
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
      employeeNumber: `E-${seed}`, compensationType: "HOURLY",
      homeProvince: "AB",
      timekeepingMethod: "CLOCK_REQUIRED",
    },
  });
}
function principalFrom(clubId: string, employeeId: string): EmployeePortalPrincipal {
  return { clubId, employeeId, generation: 1, establishedAt: new Date().toISOString() };
}

/** Assert the event stream has no illegal sequence for an employee. */
async function assertNoInvalidHistory(employeeId: string) {
  const evs = await db().timeClockEvent.findMany({
    where: { employeeId }, orderBy: { occurredAt: "asc" },
    select: { kind: true, occurredAt: true },
  });
  let state = "OFF_CLOCK";
  for (const e of evs) {
    if (e.kind === "CLOCK_IN") {
      if (state !== "OFF_CLOCK") {
        throw new Error(`Invalid: CLOCK_IN while state=${state}`);
      }
      state = "WORKING";
    } else if (e.kind === "BREAK_START") {
      if (state !== "WORKING") {
        throw new Error(`Invalid: BREAK_START while state=${state}`);
      }
      state = "ON_BREAK";
    } else if (e.kind === "BREAK_END") {
      if (state !== "ON_BREAK") {
        throw new Error(`Invalid: BREAK_END while state=${state}`);
      }
      state = "WORKING";
    } else if (e.kind === "CLOCK_OUT") {
      if (state !== "WORKING" && state !== "ON_BREAK") {
        throw new Error(`Invalid: CLOCK_OUT while state=${state}`);
      }
      state = "OFF_CLOCK";
    }
  }
}

describe("Payroll-3D-1A · CAS concurrency invariant", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§N two parallel CLOCK_IN → EXACTLY 1 CLOCK_IN event; no invalid history", async () => {
    const club = await makeClub("cas-in");
    const emp = await makeClockEmp(club.id, "cas-in-a");
    const p = principalFrom(club.id, emp.id);
    await Promise.allSettled([clockIn(p), clockIn(p)]);
    const inCount = await db().timeClockEvent.count({
      where: { employeeId: emp.id, kind: "CLOCK_IN" },
    });
    expect(inCount).toBe(1);
    // stateVersion advanced exactly once.
    const empAfter = await db().employee.findUniqueOrThrow({ where: { id: emp.id } });
    expect(empAfter.timekeepingStateVersion).toBe(1);
    await assertNoInvalidHistory(emp.id);
  });

  it("§O two parallel CLOCK_OUT → EXACTLY 1 CLOCK_OUT event; no invalid history", async () => {
    const club = await makeClub("cas-out");
    const emp = await makeClockEmp(club.id, "cas-out-a");
    const p = principalFrom(club.id, emp.id);
    await clockIn(p); // WORKING
    await Promise.allSettled([clockOut(p), clockOut(p)]);
    const outCount = await db().timeClockEvent.count({
      where: { employeeId: emp.id, kind: "CLOCK_OUT" },
    });
    expect(outCount).toBe(1);
    const empAfter = await db().employee.findUniqueOrThrow({ where: { id: emp.id } });
    // After IN + OUT (each bumps once) version = 2.
    expect(empAfter.timekeepingStateVersion).toBe(2);
    await assertNoInvalidHistory(emp.id);
  });

  it("§P two parallel BREAK_START → EXACTLY 1 BREAK_START event; no invalid history", async () => {
    const club = await makeClub("cas-brk-start");
    const emp = await makeClockEmp(club.id, "cas-brk-a");
    const p = principalFrom(club.id, emp.id);
    await clockIn(p);
    await Promise.allSettled([breakStart(p), breakStart(p)]);
    const startCount = await db().timeClockEvent.count({
      where: { employeeId: emp.id, kind: "BREAK_START" },
    });
    expect(startCount).toBe(1);
    const empAfter = await db().employee.findUniqueOrThrow({ where: { id: emp.id } });
    expect(empAfter.timekeepingStateVersion).toBe(2); // IN + BREAK_START
    await assertNoInvalidHistory(emp.id);
  });

  it("§Q two parallel BREAK_END → EXACTLY 1 BREAK_END event; no invalid history", async () => {
    const club = await makeClub("cas-brk-end");
    const emp = await makeClockEmp(club.id, "cas-brk-b");
    const p = principalFrom(club.id, emp.id);
    await clockIn(p);
    await breakStart(p);
    await Promise.allSettled([breakEnd(p), breakEnd(p)]);
    const endCount = await db().timeClockEvent.count({
      where: { employeeId: emp.id, kind: "BREAK_END" },
    });
    expect(endCount).toBe(1);
    const empAfter = await db().employee.findUniqueOrThrow({ where: { id: emp.id } });
    expect(empAfter.timekeepingStateVersion).toBe(3); // IN + BREAK_START + BREAK_END
    await assertNoInvalidHistory(emp.id);
  });

  it("§R chained forced races produce no invalid history across a full session", async () => {
    const club = await makeClub("cas-chain");
    const emp = await makeClockEmp(club.id, "cas-chain-a");
    const p = principalFrom(club.id, emp.id);
    // Every transition attempted twice in parallel.
    await Promise.allSettled([clockIn(p), clockIn(p)]);
    await Promise.allSettled([breakStart(p), breakStart(p)]);
    await Promise.allSettled([breakEnd(p), breakEnd(p)]);
    await Promise.allSettled([clockOut(p), clockOut(p)]);
    const totals = await db().timeClockEvent.groupBy({
      by: ["kind"], where: { employeeId: emp.id }, _count: { _all: true },
    });
    const byKind = new Map(totals.map((t) => [t.kind, t._count._all]));
    expect(byKind.get("CLOCK_IN")).toBe(1);
    expect(byKind.get("BREAK_START")).toBe(1);
    expect(byKind.get("BREAK_END")).toBe(1);
    expect(byKind.get("CLOCK_OUT")).toBe(1);
    await assertNoInvalidHistory(emp.id);
  });

  it("§AF PayrollApprovedTimeEntry side-effect count remains 0 after all concurrency tests in this file", async () => {
    // Regenerate a small session under concurrency then assert.
    const club = await makeClub("cas-payroll");
    const emp = await makeClockEmp(club.id, "cas-payroll-a");
    const p = principalFrom(club.id, emp.id);
    await Promise.allSettled([clockIn(p), clockIn(p)]);
    await Promise.allSettled([clockOut(p), clockOut(p)]);
    const empRows = await db().payrollApprovedTimeEntry.count({ where: { employeeId: emp.id } });
    expect(empRows).toBe(0);
  });
});
