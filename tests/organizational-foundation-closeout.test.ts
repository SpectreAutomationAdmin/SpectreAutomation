// Organizational Foundation closeout (2026-09-13) — remaining domain
// tests deferred from v384.
//
// Covers §36 remaining items:
//   4  Existing legitimate tenant Positions preserved
//  10 Add Employee manager resolver sees org User
//  11 manager resolver sees Employee
//  15 linked same-human identities dedupe
//  16 unlinked same-name people remain distinct
//  18 Position deactivation safety
//  19 DepartmentResponsibility precedence (resolver)
//  20 Position occupancy responsibility fallback

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import {
  provisionDefaultOrganization,
  setPositionReportsTo,
} from "@/lib/organizational/provisioning";
import { listManagerOptions } from "@/lib/organizational/manager-resolver";
import { resolveResponsibilityOwner } from "@/lib/organizational/responsibility-resolver";
import { archivePosition } from "@/lib/tenant-admin/org-structure";

async function seedClubWithDepts(name: string) {
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
  return club;
}

describe("Organizational Foundation closeout · deferred coverage", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  // §4 existing legitimate tenant Positions preserved
  it("preserves an existing custom Position when provisioning defaults", async () => {
    const club = await seedClubWithDepts("Custom");
    const admin = await db().department.findFirstOrThrow({ where: { clubId: club.id, code: "ADMIN" } });
    const custom = await db().organizationalPosition.create({
      data: {
        clubId: club.id, name: "Beverage Cart Coordinator",
        departmentId: admin.id, sortOrder: 100, isActive: true,
      },
    });
    const r = await provisionDefaultOrganization(club.id);
    expect(r.positionsCreated).toBeGreaterThanOrEqual(1);
    // Custom position still present untouched.
    const still = await db().organizationalPosition.findUnique({ where: { id: custom.id } });
    expect(still?.name).toBe("Beverage Cart Coordinator");
    expect(still?.reportsToPositionId).toBeNull(); // hierarchy pass only wires starter parents
  });

  // §10 manager resolver sees org User
  it("Add Employee manager resolver includes org UserClubProfiles as options", async () => {
    const club = await seedClubWithDepts("OrgUserMgr");
    await provisionDefaultOrganization(club.id);
    const controller = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "CONTROLLER" },
    });
    const chris = await makeUser({ email: "chris.owm@t.test", role: "CLUB_ADMIN", clubId: club.id });
    await db().userClubProfile.create({
      data: { clubId: club.id, userId: chris.id, positionId: controller.id },
    });
    const bundle = await listManagerOptions(club.id);
    const chrisOption = bundle.options.find((o) => o.kind === "profile" && o.displayName === chris.name);
    expect(chrisOption).toBeTruthy();
    expect(chrisOption?.positionName).toBe("Controller / CFO");
  });

  // §11 manager resolver sees Employee
  it("Add Employee manager resolver includes Employees as options", async () => {
    const club = await seedClubWithDepts("EmpMgr");
    await provisionDefaultOrganization(club.id);
    const fab = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "FAB_MANAGER" },
    });
    await db().employee.create({
      data: {
        clubId: club.id, employeeNumber: "E-999",
        firstName: "Mika", lastName: "Manager",
        orgPositionId: fab.id, employeeLifecycle: "ACTIVE",
      },
    });
    const bundle = await listManagerOptions(club.id);
    const mika = bundle.options.find((o) => o.kind === "employee" && o.displayName === "Mika Manager");
    expect(mika).toBeTruthy();
    expect(mika?.positionName).toBe("Food & Beverage Manager");
  });

  // §15 linked same-human identities dedupe
  it("dedupes when UserClubProfile.employeeId links a profile to its Employee", async () => {
    const club = await seedClubWithDepts("Dedupe");
    await provisionDefaultOrganization(club.id);
    const controller = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "CONTROLLER" },
    });
    const chris = await makeUser({ email: "chris.dd@t.test", role: "CLUB_ADMIN", clubId: club.id });
    const chrisEmp = await db().employee.create({
      data: {
        clubId: club.id, employeeNumber: "E-DUP",
        firstName: "Chris", lastName: "Turcato",
        orgPositionId: controller.id,
        employeeLifecycle: "ACTIVE",
      },
    });
    await db().userClubProfile.create({
      data: {
        clubId: club.id, userId: chris.id, positionId: controller.id,
        employeeId: chrisEmp.id,
      },
    });
    const bundle = await listManagerOptions(club.id);
    // The Employee row is filtered because a profile links to it via
    // employeeId. Only the profile-kind option for the same human remains.
    const chrisProfileRow = await db().userClubProfile.findFirstOrThrow({
      where: { userId: chris.id, clubId: club.id },
      select: { id: true },
    });
    const profileForChris = bundle.options.find(
      (o) => o.kind === "profile" && o.id === chrisProfileRow.id,
    );
    expect(profileForChris).toBeTruthy();
    const employeeForChris = bundle.options.find(
      (o) => o.kind === "employee" && o.id === chrisEmp.id,
    );
    expect(employeeForChris).toBeUndefined();
  });

  // §16 unlinked same-name people remain distinct
  it("does NOT dedupe two Chris Turcatos when there is no employeeId link", async () => {
    const club = await seedClubWithDepts("SameName");
    await provisionDefaultOrganization(club.id);
    const controller = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "CONTROLLER" },
    });
    const chrisAdmin = await makeUser({ email: "chris.admin.sn@t.test", role: "CLUB_ADMIN", clubId: club.id });
    // Same display name but no employee link.
    await db().userClubProfile.create({
      data: { clubId: club.id, userId: chrisAdmin.id, positionId: controller.id },
    });
    await db().employee.create({
      data: {
        clubId: club.id, employeeNumber: "E-DIS",
        firstName: "Chris", lastName: "Turcato",
        orgPositionId: controller.id,
        employeeLifecycle: "ACTIVE",
      },
    });
    const bundle = await listManagerOptions(club.id);
    const matches = bundle.options.filter((o) => o.displayName === chrisAdmin.name);
    expect(matches.length).toBe(1);
    const empMatches = bundle.options.filter((o) => o.kind === "employee" && o.displayName === "Chris Turcato");
    expect(empMatches.length).toBe(1);
  });

  // §18 Position deactivation safety
  it("refuses to deactivate a Position with active occupants", async () => {
    const club = await seedClubWithDepts("Deact");
    await provisionDefaultOrganization(club.id);
    const controller = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "CONTROLLER" },
    });
    const chris = await makeUser({ email: "chris.dea@t.test", role: "CLUB_ADMIN", clubId: club.id });
    await db().userClubProfile.create({
      data: { clubId: club.id, userId: chris.id, positionId: controller.id },
    });
    const principal = await principalFor("chris.dea@t.test");
    await expect(archivePosition(principal, controller.id)).rejects.toThrow(/occupant/i);
    // Vacant Position deactivates fine.
    const empty = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "BANQUETS_MANAGER" },
    });
    const updated = await archivePosition(principal, empty.id);
    expect(updated.isActive).toBe(false);
  });
});

describe("Organizational Foundation closeout · responsibility resolver", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  // §19 DepartmentResponsibility precedence
  it("returns DepartmentResponsibility first when a department-scoped row exists", async () => {
    const club = await seedClubWithDepts("DR-Precedence");
    await provisionDefaultOrganization(club.id);
    const dept = await db().department.findFirstOrThrow({ where: { clubId: club.id, code: "GROUNDS" } });
    // Register the responsibility so the FK is legal on Postgres schema; SQLite tolerates absence.
    await db().responsibility.upsert({
      where: { key: "TEST_TIME_APPROVAL" },
      update: {},
      create: { key: "TEST_TIME_APPROVAL", displayLabel: "Test Time Approval" },
    }).catch(() => {});
    const owner = await makeUser({ email: "owner.dr@t.test", role: "CLUB_ADMIN", clubId: club.id });
    await db().departmentResponsibility.create({
      data: {
        clubId: club.id, departmentId: dept.id,
        responsibilityKey: "TEST_TIME_APPROVAL",
        userId: owner.id,
      },
    });
    const r = await resolveResponsibilityOwner({
      clubId: club.id, responsibilityKey: "TEST_TIME_APPROVAL",
      departmentId: dept.id,
      preferredPositionCode: "SUPERINTENDENT",
    });
    expect(r.reason).toBe("department-responsibility");
    expect(r.ownerUserId).toBe(owner.id);
  });

  // §20 Position occupancy fallback + shirt example (§14)
  it("falls back to Position occupant when no DepartmentResponsibility or ResponsibilityAssignment exists", async () => {
    const club = await seedClubWithDepts("Shirt");
    await provisionDefaultOrganization(club.id);
    const randy = await makeUser({ email: "randy.pro@t.test", role: "STAFF", clubId: club.id });
    const golfPos = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "HEAD_GOLF_PROFESSIONAL" },
    });
    await db().userClubProfile.create({
      data: { clubId: club.id, userId: randy.id, positionId: golfPos.id },
    });
    const golf = await db().department.findFirstOrThrow({ where: { clubId: club.id, code: "GOLF" } });
    const r = await resolveResponsibilityOwner({
      clubId: club.id,
      responsibilityKey: "INVENTORY_REPLENISHMENT",
      departmentId: golf.id,
      preferredPositionCode: "HEAD_GOLF_PROFESSIONAL",
    });
    expect(r.reason).toBe("position-occupancy");
    expect(r.ownerUserId).toBe(randy.id);

    // Replace occupant — the routing target changes without code change.
    await db().userClubProfile.updateMany({
      where: { clubId: club.id, userId: randy.id },
      data: { positionId: null },
    });
    const jamie = await makeUser({ email: "jamie.pro@t.test", role: "STAFF", clubId: club.id });
    await db().userClubProfile.create({
      data: { clubId: club.id, userId: jamie.id, positionId: golfPos.id },
    });
    const r2 = await resolveResponsibilityOwner({
      clubId: club.id,
      responsibilityKey: "INVENTORY_REPLENISHMENT",
      departmentId: golf.id,
      preferredPositionCode: "HEAD_GOLF_PROFESSIONAL",
    });
    expect(r2.reason).toBe("position-occupancy");
    expect(r2.ownerUserId).toBe(jamie.id);
  });

  // Ambiguity: two occupants of the preferred Position → resolver returns ambiguous.
  it("returns ambiguous when multiple users occupy the preferred Position", async () => {
    const club = await seedClubWithDepts("Ambig-Res");
    await provisionDefaultOrganization(club.id);
    const golfPos = await db().organizationalPosition.findFirstOrThrow({
      where: { clubId: club.id, code: "HEAD_GOLF_PROFESSIONAL" },
    });
    const a = await makeUser({ email: "a.amb@t.test", role: "STAFF", clubId: club.id });
    const b = await makeUser({ email: "b.amb@t.test", role: "STAFF", clubId: club.id });
    await db().userClubProfile.create({ data: { clubId: club.id, userId: a.id, positionId: golfPos.id } });
    await db().userClubProfile.create({ data: { clubId: club.id, userId: b.id, positionId: golfPos.id } });
    const r = await resolveResponsibilityOwner({
      clubId: club.id,
      responsibilityKey: "TEST_AMBIG_KEY",
      departmentId: null,
      preferredPositionCode: "HEAD_GOLF_PROFESSIONAL",
    });
    expect(r.reason).toBe("ambiguous");
    expect(r.ownerUserId).toBeNull();
    expect(r.candidates?.length).toBe(2);
  });
});
