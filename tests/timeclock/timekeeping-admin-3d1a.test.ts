// Payroll-3D-1A (2026-09-05) — admin timekeeping-method write path.
//
// Server-side coverage of the §23 required test list:
//   1  authorized admin reads Timekeeping Method
//   2  authorized admin changes Timekeeping Method
//   3  unauthorized admin denied
//   5  cross-tenant update denied
//   6  audit before/after recorded
//   7  invalid method rejected
//   8  Taylor CLOCK_REQUIRED can clock
//   9  Taylor NO_TIME_ENTRY_REQUIRED cannot clock

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "../util/db";
import { updateEmployee, getEmployee } from "@/lib/hr/employees";
import { clockIn } from "@/lib/timeclock/service";
import { ValidationError, ForbiddenError } from "@/lib/errors";
import type { EmployeePortalPrincipal } from "@/lib/employee-portal-session";

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

async function makeEmp(clubId: string, seed: string, method: string) {
  return db().employee.create({
    data: {
      clubId, firstName: "T", lastName: seed,
      email: `t.${seed}@t.test`, hireDate: utc(2026, 1, 1),
      status: "ACTIVE", employeeLifecycle: "ACTIVE",
      employeeNumber: `E-${seed}`, compensationType: "HOURLY",
      homeProvince: "AB",
      timekeepingMethod: method,
    },
  });
}

describe("Payroll-3D-1A · Timekeeping admin — updateEmployee path", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("§1+§2 authorized HR admin reads and changes timekeepingMethod", async () => {
    const club = await makeClub("tk-write");
    const adminU = await makeUser({ email: "hr.admin@t.test", role: "CLUB_ADMIN", clubId: club.id });
    const adminP = await principalFor(adminU.email);
    const emp = await makeEmp(club.id, "e1", "NO_TIME_ENTRY_REQUIRED");

    // Read: field is exposed on the profile.
    const before = await getEmployee(adminP, emp.id);
    expect((before as { timekeepingMethod: string }).timekeepingMethod).toBe("NO_TIME_ENTRY_REQUIRED");

    // Write via canonical service.
    await updateEmployee(adminP, emp.id, { timekeepingMethod: "CLOCK_REQUIRED" });
    const after = await getEmployee(adminP, emp.id);
    expect((after as { timekeepingMethod: string }).timekeepingMethod).toBe("CLOCK_REQUIRED");
  });

  it("§3 unauthorized user (no hr:employee:write) denied", async () => {
    const club = await makeClub("tk-unauth");
    const staffU = await makeUser({ email: "staff@t.test", role: "STAFF", clubId: club.id });
    const staffP = await principalFor(staffU.email);
    const emp = await makeEmp(club.id, "e-unauth", "NO_TIME_ENTRY_REQUIRED");
    await expect(
      updateEmployee(staffP, emp.id, { timekeepingMethod: "CLOCK_REQUIRED" }),
    ).rejects.toThrow();
  });

  it("§5 cross-tenant admin denied", async () => {
    const clubA = await makeClub("tk-A");
    const clubB = await makeClub("tk-B");
    const admBU = await makeUser({ email: "hr.other@t.test", role: "CLUB_ADMIN", clubId: clubB.id });
    const admBP = await principalFor(admBU.email);
    const empInA = await makeEmp(clubA.id, "e-cross", "NO_TIME_ENTRY_REQUIRED");
    await expect(
      updateEmployee(admBP, empInA.id, { timekeepingMethod: "CLOCK_REQUIRED" }),
    ).rejects.toThrow();
  });

  it("§6 audit event records before + after timekeepingMethod", async () => {
    const club = await makeClub("tk-audit");
    const adminU = await makeUser({ email: "hr.audit@t.test", role: "CLUB_ADMIN", clubId: club.id });
    const adminP = await principalFor(adminU.email);
    const emp = await makeEmp(club.id, "e-audit", "NO_TIME_ENTRY_REQUIRED");
    await updateEmployee(adminP, emp.id, { timekeepingMethod: "CLOCK_REQUIRED" });
    // Look at ALL Employee updates and find the one where the
    // after-value flipped to CLOCK_REQUIRED — updateEmployee may
    // also emit provisioning audits with a subset of fields.
    const audits = await db().auditLog.findMany({
      where: {
        entityType: "Employee", entityId: emp.id,
        action: "hr.employee.write.update",
      },
      orderBy: { createdAt: "desc" },
    });
    let match: (typeof audits)[number] | null = null;
    for (const a of audits) {
      const after = JSON.parse(String(a.afterJson ?? "{}")) as Record<string, unknown>;
      if (after.timekeepingMethod === "CLOCK_REQUIRED") { match = a; break; }
    }
    expect(match).not.toBeNull();
    const beforeJson = JSON.parse(String(match!.beforeJson ?? "{}"));
    const afterJson  = JSON.parse(String(match!.afterJson  ?? "{}"));
    expect(beforeJson.timekeepingMethod).toBe("NO_TIME_ENTRY_REQUIRED");
    expect(afterJson.timekeepingMethod).toBe("CLOCK_REQUIRED");
  });

  it("§7 invalid method rejected", async () => {
    const club = await makeClub("tk-inv");
    const adminU = await makeUser({ email: "hr.inv@t.test", role: "CLUB_ADMIN", clubId: club.id });
    const adminP = await principalFor(adminU.email);
    const emp = await makeEmp(club.id, "e-inv", "NO_TIME_ENTRY_REQUIRED");
    await expect(
      updateEmployee(adminP, emp.id, { timekeepingMethod: "COMPLETELY_INVALID" }),
    ).rejects.toBeInstanceOf(ValidationError);
    const after = await db().employee.findUniqueOrThrow({ where: { id: emp.id } });
    expect(after.timekeepingMethod).toBe("NO_TIME_ENTRY_REQUIRED");
  });

  it("§8+§9 method flip changes clock eligibility", async () => {
    const club = await makeClub("tk-flip");
    const adminU = await makeUser({ email: "hr.flip@t.test", role: "CLUB_ADMIN", clubId: club.id });
    const adminP = await principalFor(adminU.email);
    const emp = await makeEmp(club.id, "e-flip", "CLOCK_REQUIRED");
    const empPrincipal: EmployeePortalPrincipal = {
      clubId: club.id, employeeId: emp.id, generation: 1, establishedAt: new Date().toISOString(),
    };
    // CLOCK_REQUIRED: clock succeeds.
    await clockIn(empPrincipal);
    expect(await db().timeClockEvent.count({ where: { employeeId: emp.id, kind: "CLOCK_IN" } })).toBe(1);
    // Flip to NO_TIME_ENTRY_REQUIRED via admin UI path.
    await updateEmployee(adminP, emp.id, { timekeepingMethod: "NO_TIME_ENTRY_REQUIRED" });
    // Subsequent clock attempts are refused.
    await expect(clockIn(empPrincipal)).rejects.toBeInstanceOf(ForbiddenError);
    // Flip back → clocking works again (after our earlier CLOCK_IN, we're WORKING, so clockIn is denied on state grounds. Prove eligibility by trying a DIFFERENT employee that starts OFF_CLOCK.)
    const emp2 = await makeEmp(club.id, "e-flip2", "NO_TIME_ENTRY_REQUIRED");
    const emp2P: EmployeePortalPrincipal = {
      clubId: club.id, employeeId: emp2.id, generation: 1, establishedAt: new Date().toISOString(),
    };
    await expect(clockIn(emp2P)).rejects.toBeInstanceOf(ForbiddenError);
    await updateEmployee(adminP, emp2.id, { timekeepingMethod: "CLOCK_REQUIRED" });
    await clockIn(emp2P);
    expect(await db().timeClockEvent.count({ where: { employeeId: emp2.id, kind: "CLOCK_IN" } })).toBe(1);
  });
});
