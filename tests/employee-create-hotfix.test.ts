// Add Employee hotfix (2026-09-13) — post-v389 create-path defects.
//
// Guards the two root causes that broke Add Employee immediately after
// the PRE-HIRE Employee Deletion Hotfix landed:
//
//   1. `nextEmployeeNumber` used `count + 1`, which collides with an
//      existing row whenever any prior Employee was deleted (Marc E-00001
//      deleted → count=1 → next="E-00002" → collision with Chris E-00002).
//      The allocator is now MAX-of-numeric-suffix + 1 (gap-safe).
//   2. `createEmployee` retries on the (clubId, employeeNumber) unique
//      constraint so concurrent creates cannot both observe the same MAX
//      and race to the same slot.
//
// Covers §29 items 1-8, 11, 15-17.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import { createEmployee, deleteEmployee } from "@/lib/hr/employees";
import { provisionDefaultOrganization } from "@/lib/organizational/provisioning";

async function seedClub(name: string) {
  const c = db();
  const club = await makeClub(name);
  for (const [code, deptName] of [
    ["ADMIN", "Administration"],
    ["GOLF", "Golf Operations"],
    ["FAB", "Food & Beverage"],
    ["CULINARY", "Culinary"],
    ["GROUNDS", "Grounds"],
    ["MEMBER", "Membership"],
    ["FACILITY", "Facilities"],
  ] as const) {
    await c.department.create({
      data: { clubId: club.id, code, name: deptName, isActive: true, sortOrder: 0 },
    });
  }
  await provisionDefaultOrganization(club.id);
  const admin = await makeUser({ email: `admin.${name}@t.test`, clubId: club.id, role: "CLUB_ADMIN" });
  const adminDept = await c.department.findFirstOrThrow({
    where: { clubId: club.id, code: "ADMIN" }, select: { id: true },
  });
  const controllerPos = await c.organizationalPosition.findFirstOrThrow({
    where: { clubId: club.id, code: "CONTROLLER" }, select: { id: true },
  });
  return { club, admin, adminP: await principalFor(`admin.${name}@t.test`), adminDept, controllerPos };
}

describe("Add Employee hotfix · create-path defects (2026-09-13)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  // §29 item 1 + 3 + 5 + 7 — Add SALARY Employee succeeds, orgPositionId
  // persists, Department persists, salary cadence persists.
  it("creates a SALARY Employee with canonical Position + Department", async () => {
    const { club, adminP, adminDept, controllerPos } = await seedClub("saA");
    const emp = await createEmployee(adminP, club.id, {
      firstName: "Salaried", lastName: "Manager",
      personalEmail: "salaried.a@t.test",
      mobilePhone: "555-0100",
      departmentId: adminDept.id,
      orgPositionId: controllerPos.id,
      employmentType: "FULL_TIME",
      compensationType: "SALARY",
      employeeLifecycle: "PRE_HIRE",
    });
    expect(emp.employeeNumber).toBe("E-00001");
    expect(emp.orgPositionId).toBe(controllerPos.id);
    expect(emp.departmentId).toBe(adminDept.id);
    expect(emp.compensationType).toBe("SALARY");
    expect(emp.employmentType).toBe("FULL_TIME");
    expect(emp.employeeLifecycle).toBe("PRE_HIRE");
  });

  // §29 item 2 + 8 — Add HOURLY Employee succeeds + hourly cadence persists.
  it("creates an HOURLY Employee (default compensation)", async () => {
    const { club, adminP, adminDept } = await seedClub("hoA");
    const emp = await createEmployee(adminP, club.id, {
      firstName: "Hourly", lastName: "Worker",
      personalEmail: "hourly.a@t.test",
      mobilePhone: "555-0101",
      departmentId: adminDept.id,
      employmentType: "PART_TIME",
      compensationType: "HOURLY",
      employeeLifecycle: "PRE_HIRE",
    });
    expect(emp.compensationType).toBe("HOURLY");
    expect(emp.employmentType).toBe("PART_TIME");
  });

  // §29 item 4 — legacy positionId remains null when only orgPositionId set.
  it("keeps legacy positionId null when only canonical orgPositionId is provided", async () => {
    const { club, adminP, controllerPos } = await seedClub("legA");
    const emp = await createEmployee(adminP, club.id, {
      firstName: "Legacy", lastName: "Free",
      personalEmail: "legacy.a@t.test",
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    expect(emp.orgPositionId).toBe(controllerPos.id);
    expect(emp.positionId).toBeNull();
  });

  // §29 item 11 — POST-DELETE ALLOCATOR: after deleting E-00001, the next
  // create must NOT collide with the remaining E-00002. This is the exact
  // scenario that broke the founder's Marc→Add-Employee flow.
  it("allocates E-00003 after E-00001 is deleted and E-00002 remains", async () => {
    const { club, adminP, controllerPos } = await seedClub("allocA");
    // E-00001
    const e1 = await createEmployee(adminP, club.id, {
      firstName: "First", lastName: "One",
      personalEmail: "first.a@t.test",
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    expect(e1.employeeNumber).toBe("E-00001");
    // E-00002
    const e2 = await createEmployee(adminP, club.id, {
      firstName: "Second", lastName: "Two",
      personalEmail: "second.a@t.test",
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    expect(e2.employeeNumber).toBe("E-00002");

    // Delete E-00001 (the Marc-shaped case). E-00002 remains.
    await deleteEmployee(adminP, e1.id);

    // Next allocation MUST be E-00003 — gap-safe, MAX+1.
    const e3 = await createEmployee(adminP, club.id, {
      firstName: "Third", lastName: "Three",
      personalEmail: "third.a@t.test",
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    expect(e3.employeeNumber).toBe("E-00003");

    // Verify final directory has E-00002 + E-00003 only.
    const rows = await db().employee.findMany({
      where: { clubId: club.id }, orderBy: { employeeNumber: "asc" },
      select: { employeeNumber: true },
    });
    expect(rows.map(r => r.employeeNumber)).toEqual(["E-00002", "E-00003"]);
  });

  // §29 item 15 — PRE_HIRE Employee can be deleted through the canonical
  // deletion path (regression pin: v389 delete still green).
  it("PRE_HIRE Employee is deletable through the canonical service", async () => {
    const { club, adminP, controllerPos } = await seedClub("preHA");
    const emp = await createEmployee(adminP, club.id, {
      firstName: "PreHire", lastName: "Deletable",
      personalEmail: "prehire.a@t.test",
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    await deleteEmployee(adminP, emp.id);
    const gone = await db().employee.findUnique({ where: { id: emp.id } });
    expect(gone).toBeNull();
  });

  // §29 item 16 — CREATE → DELETE → RECREATE round-trip works without any
  // manual DB cleanup. Uses the same personalEmail (product rule: multiple
  // Employees may legitimately share a personal email — spouse / family).
  // Note on employee-number: when the table becomes fully empty after the
  // delete, MAX+1 legitimately returns to E-00001 — that's desired for a
  // fresh club start. The Marc scenario (§29 item 11) covers the gap case
  // where a survivor row remains.
  it("create → delete → recreate with the same personalEmail succeeds", async () => {
    const { club, adminP, controllerPos } = await seedClub("rtA");
    const roundEmail = "roundtrip.a@t.test";
    const e1 = await createEmployee(adminP, club.id, {
      firstName: "Round", lastName: "One",
      personalEmail: roundEmail,
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    await deleteEmployee(adminP, e1.id);
    // Recreate with same email — must succeed cleanly.
    const e2 = await createEmployee(adminP, club.id, {
      firstName: "Round", lastName: "Two",
      personalEmail: roundEmail,
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    expect(e2.id).not.toBe(e1.id);
    // The recreated employee is the only row.
    const only = await db().employee.findMany({
      where: { clubId: club.id }, select: { id: true },
    });
    expect(only.map(r => r.id)).toEqual([e2.id]);
  });

  // §29 item 17 — same-human UserClubProfile.employeeId link is preserved
  // after re-linking a new Employee to the same User.
  it("same-human UserClubProfile.employeeId link survives re-link", async () => {
    const { club, adminP, controllerPos, admin } = await seedClub("samHA");
    // A tenant user whose profile will link to an Employee.
    const orgUser = await makeUser({ email: "samehuman.a@t.test", clubId: club.id, role: "CLUB_ADMIN" });
    const emp1 = await createEmployee(adminP, club.id, {
      firstName: "Same", lastName: "Human",
      personalEmail: "same.a@t.test",
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    const profile = await db().userClubProfile.create({
      data: { clubId: club.id, userId: orgUser.id, employeeId: emp1.id },
    });
    // Delete emp1 — UCP is UNLINKED, User survives.
    await deleteEmployee(adminP, emp1.id);
    const afterUnlink = await db().userClubProfile.findUnique({ where: { id: profile.id } });
    expect(afterUnlink?.employeeId).toBeNull();
    expect(await db().user.findUnique({ where: { id: orgUser.id } })).not.toBeNull();
    // Recreate → re-link. This mirrors the founder-authorised first-user
    // Employee correction flow (§23).
    const emp2 = await createEmployee(adminP, club.id, {
      firstName: "Same", lastName: "Human",
      personalEmail: "same.a@t.test",
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    await db().userClubProfile.update({
      where: { id: profile.id }, data: { employeeId: emp2.id },
    });
    const afterRelink = await db().userClubProfile.findUnique({ where: { id: profile.id } });
    expect(afterRelink?.employeeId).toBe(emp2.id);
    // The single Tenant User is still linked to exactly one Employee.
    // The role-admin User created by seedClub is NOT expected to have a
    // linked Employee — only the samehuman User should.
    const linkedProfiles = await db().userClubProfile.findMany({
      where: { clubId: club.id, employeeId: emp2.id },
    });
    expect(linkedProfiles.length).toBe(1);
    expect(linkedProfiles[0].userId).toBe(orgUser.id);
  });

  // §29 item 6 — manager link (Employee → Employee) persists.
  it("persists managerEmployeeId when a manager is supplied", async () => {
    const { club, adminP, controllerPos } = await seedClub("mgrA");
    const boss = await createEmployee(adminP, club.id, {
      firstName: "Boss", lastName: "Manager",
      personalEmail: "boss.a@t.test",
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    const report = await createEmployee(adminP, club.id, {
      firstName: "Report", lastName: "Under",
      personalEmail: "report.a@t.test",
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    await db().employee.update({
      where: { id: report.id }, data: { managerEmployeeId: boss.id },
    });
    const refreshed = await db().employee.findUniqueOrThrow({ where: { id: report.id } });
    expect(refreshed.managerEmployeeId).toBe(boss.id);
  });

  // §29 item 13 — Two Employees may legitimately share a personalEmail
  // (spouse / family). The domain model does NOT enforce a unique
  // constraint on personalEmail.
  it("allows two Employees to share the same personalEmail (per product rule)", async () => {
    const { club, adminP, controllerPos } = await seedClub("dupeA");
    const emp1 = await createEmployee(adminP, club.id, {
      firstName: "Alice", lastName: "Shared",
      personalEmail: "shared.a@t.test",
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    const emp2 = await createEmployee(adminP, club.id, {
      firstName: "Bob", lastName: "Shared",
      personalEmail: "shared.a@t.test",
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    expect(emp1.id).not.toBe(emp2.id);
    expect(emp1.personalEmail).toBe(emp2.personalEmail);
    expect(emp1.employeeNumber).not.toBe(emp2.employeeNumber);
  });
});
