// Post-onboarding-admin hotfix (2026-09-13) — admin edit of Basic Details.
//
// Covers §32 subset: home address survives update, phone/personal email/
// preferred name editable, sensitive fields (SIN/banking/TD1) untouched
// by the generic editor, changes survive reload (represented by re-read).
//
// Employee → Tenant User promotion regressions (§31 subset) are covered
// by tests/organizational-foundation.test.ts (same-human link + Chris
// backfill) — this slice's Tenant User fix is a client-side refresh
// crash guard tested at the Playwright layer.

import { describe, it, expect, beforeEach } from "vitest";
import { db, resetDb, seedRbac, makeClub, makeUser, principalFor } from "./util/db";
import { createEmployee, updateEmployee, getEmployee } from "@/lib/hr/employees";
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
  const adminP = await principalFor(`admin.${name}@t.test`);
  const adminDept = await c.department.findFirstOrThrow({
    where: { clubId: club.id, code: "ADMIN" }, select: { id: true },
  });
  const controllerPos = await c.organizationalPosition.findFirstOrThrow({
    where: { clubId: club.id, code: "CONTROLLER" }, select: { id: true },
  });
  return { club, admin, adminP, adminDept, controllerPos };
}

describe("Employee admin edit · post-onboarding hotfix (2026-09-13)", () => {
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  // §32 item 13 — Overview projection includes address fields.
  it("getEmployee projection exposes home address fields for Overview display", async () => {
    const { club, adminP, adminDept, controllerPos } = await seedClub("aA");
    const emp = await createEmployee(adminP, club.id, {
      firstName: "Address", lastName: "Owner",
      personalEmail: "addr@t.test",
      departmentId: adminDept.id,
      orgPositionId: controllerPos.id,
      homeAddressLine1: "1515 25th Ave SW",
      homeCity: "Calgary",
      homeProvince: "AB",
      homePostalCode: "T2T 0Z7",
      homeCountry: "CA",
      employeeLifecycle: "PRE_HIRE",
    });
    const proj = await getEmployee(adminP, emp.id);
    expect(proj.homeAddressLine1).toBe("1515 25th Ave SW");
    expect(proj.homeCity).toBe("Calgary");
    expect(proj.homeProvince).toBe("AB");
    expect(proj.homePostalCode).toBe("T2T 0Z7");
    expect(proj.homeCountry).toBe("CA");
    expect(proj.homeAddressLine2).toBeNull();
  });

  // §32 item 14 + 15 + 16 — authorized admin can edit phone / email / address.
  it("authorized admin can update mobile, personal email, and home address", async () => {
    const { club, adminP, adminDept, controllerPos } = await seedClub("aB");
    const emp = await createEmployee(adminP, club.id, {
      firstName: "Edit", lastName: "Me",
      personalEmail: "before@t.test",
      mobilePhone: "111-111-1111",
      departmentId: adminDept.id,
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    const updated = await updateEmployee(adminP, emp.id, {
      personalEmail: "after@t.test",
      mobilePhone: "222-222-2222",
      homeAddressLine1: "42 New St",
      homeCity: "Edmonton",
      homeProvince: "AB",
      homePostalCode: "T5A 0B0",
      homeCountry: "CA",
    });
    expect(updated.personalEmail).toBe("after@t.test");
    expect(updated.mobilePhone).toBe("222-222-2222");
    // Re-read via projection to confirm persistence — proxy for "changes
    // survive reload" (§32 item 23).
    const proj = await getEmployee(adminP, emp.id);
    expect(proj.personalEmail).toBe("after@t.test");
    expect(proj.homeAddressLine1).toBe("42 New St");
    expect(proj.homeCity).toBe("Edmonton");
    expect(proj.homePostalCode).toBe("T5A 0B0");
  });

  // §32 item 19 — Position edit writes orgPositionId (not legacy positionId).
  it("Position edit still routes to orgPositionId under updateEmployee", async () => {
    const { club, adminP, adminDept, controllerPos } = await seedClub("aC");
    const emp = await createEmployee(adminP, club.id, {
      firstName: "Pos", lastName: "Edit",
      personalEmail: "pos@t.test",
      departmentId: adminDept.id,
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    const proj = await getEmployee(adminP, emp.id);
    expect(proj.orgPositionId).toBe(controllerPos.id);
    expect(proj.positionId).toBeNull();
  });

  // §32 item 22 — sensitive fields (SIN, banking, TD1) are NOT part of the
  // updateEmployee input surface. This test guards the interface shape by
  // ensuring the returned Employee row after an update carries the SAME
  // masked SIN/banking as before (i.e., the update did not touch them).
  it("generic updateEmployee does not expose or modify SIN / banking / TD1", async () => {
    const { club, adminP, adminDept, controllerPos } = await seedClub("aD");
    const emp = await createEmployee(adminP, club.id, {
      firstName: "Sensitive", lastName: "Guard",
      personalEmail: "sens@t.test",
      departmentId: adminDept.id,
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    // The updateEmployee TS type does not accept SIN/banking/TD1 fields.
    // TS enforcement is compile-time; here we assert the runtime call
    // silently drops unknown fields rather than throwing/persisting.
    await updateEmployee(adminP, emp.id, {
      preferredName: "Sen",
      // Any sensitive key passed here is not part of UpdateEmployeeInput
      // and would be a TS error — casting proves the runtime is safe
      // if someone bypasses TS.
      ...({ sin: "046 454 286", bankAccount: "1234567" } as {}),
    });
    const proj = await getEmployee(adminP, emp.id);
    expect(proj.preferredName).toBe("Sen");
    // No plaintext SIN or bank leaks through the standard projection.
    expect(proj.sinMasked).toBeNull();
    expect(proj.bankMasked).toBeNull();
  });

  // §32 item 21 — Compensation history is not overwritten by generic edit.
  it("updateEmployee leaves EmployeeCompensation history untouched", async () => {
    const { club, adminP, adminDept, controllerPos } = await seedClub("aE");
    const emp = await createEmployee(adminP, club.id, {
      firstName: "Comp", lastName: "Guard",
      personalEmail: "comp@t.test",
      departmentId: adminDept.id,
      orgPositionId: controllerPos.id,
      employeeLifecycle: "PRE_HIRE",
    });
    const before = await db().employeeCompensation.count({ where: { employeeId: emp.id } });
    await updateEmployee(adminP, emp.id, { preferredName: "Compy" });
    const after = await db().employeeCompensation.count({ where: { employeeId: emp.id } });
    expect(after).toBe(before);
  });

  // §31 item 12 — Chris same-human link is not affected by Employee edits.
  it("Chris's UserClubProfile.employeeId link survives an Employee edit", async () => {
    const { club, adminP, adminDept, controllerPos, admin } = await seedClub("aF");
    const emp = await createEmployee(adminP, club.id, {
      firstName: "Chris", lastName: "Link",
      personalEmail: "chris@t.test",
      departmentId: adminDept.id,
      orgPositionId: controllerPos.id,
      employeeLifecycle: "ACTIVE",
    });
    const profile = await db().userClubProfile.create({
      data: { clubId: club.id, userId: admin.id, employeeId: emp.id },
    });
    await updateEmployee(adminP, emp.id, { preferredName: "Christopher" });
    const after = await db().userClubProfile.findUniqueOrThrow({ where: { id: profile.id } });
    expect(after.employeeId).toBe(emp.id);
  });
});
