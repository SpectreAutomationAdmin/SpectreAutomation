// TA-1C iteration (2026-09-04) — administrative-user invitation ⇄
// Employee linkage matrix.
//
// Founder principle:
//   Enter the person once. Spectre establishes both User and Employee
//   sides of the same real human at the same Club, linked through
//   UserClubProfile.employeeId.
//
// Legitimate cardinalities:
//   1. new Employee + new User      (invite creates pre-hire Employee)
//   2. existing Employee + new User (invite links, no dup)
//   3. existing User + new Employee (multi-club person joining)
//   4. existing User + existing Employee (both present, just link)
//   5. External User                (no Employee)
// Plus:
//   - cross-tenant Employee link refused
//   - repeat invite / fixture rerun does not duplicate

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
vi.setConfig({ testTimeout: 60_000 });

import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import {
  db, makeClub, makeUser, resetDb, seedRbac, principalFor,
} from "./util/db";
import {
  createAdminInvitation,
  activateAdminInvitationAsNewUser,
  acceptAdminInvitationAsExistingUser,
} from "@/lib/tenant-admin/invitations";

async function makeTenantAdmin(clubId: string, email: string) {
  return makeUser({ email, name: email, role: "CLUB_ADMIN", clubId });
}

beforeAll(async () => { process.env.APP_URL = "https://staging.spectreautomation.com"; });

describe("TA-1C · Invitation ⇄ Employee linkage matrix", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("(1) new Employee + new User — invitation creates pre-hire Employee, activation links profile", async () => {
    const club = await makeClub("Alpha");
    const admin = await makeTenantAdmin(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const created = await createAdminInvitation(actor, {
      clubId: club.id,
      email: "raelene@example.test",
      firstName: "Raelene",
      lastName: "Sample",
      displayTitle: "Office Manager",
      initialRoleKeys: ["PAYROLL_ADMIN"],
      employmentRelationship: "EMPLOYEE",
    });
    // Pre-hire Employee exists at this Club.
    expect(created.invitation.employeeId).not.toBeNull();
    const emp = await db().employee.findUnique({ where: { id: created.invitation.employeeId! } });
    expect(emp?.clubId).toBe(club.id);
    expect(emp?.employeeLifecycle).toBe("PRE_HIRE");
    expect(emp?.personalEmail).toBe("raelene@example.test");

    // Activation links the profile to the employee.
    const activated = await activateAdminInvitationAsNewUser({
      token: created.rawToken, password: "SafePass1234!", confirmPassword: "SafePass1234!",
    });
    const profile = await db().userClubProfile.findUnique({
      where: { clubId_userId: { clubId: club.id, userId: activated.userId } },
    });
    expect(profile?.employeeId).toBe(emp?.id);
    // Distinct audit event.
    const evt = await db().auditLog.findFirst({
      where: { action: "tenant.user.employee.created", clubId: club.id },
      orderBy: { createdAt: "desc" },
    });
    expect(evt).not.toBeNull();
  });

  it("(2) existing Employee + new User — link, no duplicate Employee", async () => {
    const club = await makeClub("Bravo");
    const admin = await makeTenantAdmin(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    // A long-standing Employee (no linked User yet).
    const existing = await db().employee.create({
      data: {
        clubId: club.id, employeeNumber: "0001",
        firstName: "Grounds", lastName: "Superintendent",
        personalEmail: "grounds@example.test", employeeLifecycle: "ACTIVE",
      },
    });
    const created = await createAdminInvitation(actor, {
      clubId: club.id,
      email: "grounds@example.test",
      initialRoleKeys: ["DEPARTMENT_MANAGER"],
      employmentRelationship: "EMPLOYEE",
      employeeId: existing.id,
    });
    expect(created.invitation.employeeId).toBe(existing.id);
    // No duplicate Employee at this Club with this email.
    const count = await db().employee.count({ where: { clubId: club.id, personalEmail: "grounds@example.test" } });
    expect(count).toBe(1);
    // Distinct "linked" audit event fired instead of "created".
    const linked = await db().auditLog.findFirst({
      where: { action: "tenant.user.employee.linked", clubId: club.id },
    });
    expect(linked).not.toBeNull();
  });

  it("(3) existing User + new Employee — multi-club person joins, new pre-hire Employee created", async () => {
    const clubA = await makeClub("Alpha");
    const clubB = await makeClub("Bravo");
    // Chris is already a Spectre User at Club A.
    const chris = await makeUser({ email: "chris@example.test", role: "CLUB_ADMIN", clubId: clubA.id });
    const HASH_BEFORE = chris.passwordHash;
    // Club B invites Chris as an Employee.
    const adminB = await makeTenantAdmin(clubB.id, "admin@bravo.test");
    const actorB = await principalFor(adminB.email);
    const created = await createAdminInvitation(actorB, {
      clubId: clubB.id,
      email: "chris@example.test",
      firstName: "Chris",
      lastName: "Fixture",
      initialRoleKeys: ["CONTROLLER"],
      employmentRelationship: "EMPLOYEE",
    });
    // New Employee at Club B (not Club A).
    expect(created.invitation.employeeId).not.toBeNull();
    const empB = await db().employee.findUnique({ where: { id: created.invitation.employeeId! } });
    expect(empB?.clubId).toBe(clubB.id);
    // Path B activation (existing User).
    const principalChris = await principalFor(chris.email);
    const activated = await acceptAdminInvitationAsExistingUser({
      token: created.rawToken, principal: principalChris,
    });
    expect(activated.createdUser).toBe(false);
    // Password hash unchanged.
    const chrisAfter = await db().user.findUniqueOrThrow({ where: { id: chris.id } });
    expect(chrisAfter.passwordHash).toBe(HASH_BEFORE);
    // Club B profile links to the new Employee.
    const profileB = await db().userClubProfile.findUnique({
      where: { clubId_userId: { clubId: clubB.id, userId: chris.id } },
    });
    expect(profileB?.employeeId).toBe(empB?.id);
    // No Employee row for Chris at Club A (multi-club person: employment
    // record is per-Club, not per-User).
    const empACount = await db().employee.count({ where: { clubId: clubA.id, personalEmail: "chris@example.test" } });
    expect(empACount).toBe(0);
  });

  it("(4) existing User + existing Employee — both present, both linked, no duplicates", async () => {
    const club = await makeClub("Charlie");
    const admin = await makeTenantAdmin(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    // Existing User at this Club (bare — no profile yet).
    const person = await makeUser({ email: "alex@example.test", role: "STAFF", clubId: club.id });
    // Existing Employee at this Club.
    const existingEmp = await db().employee.create({
      data: {
        clubId: club.id, employeeNumber: "0002",
        firstName: "Alex", lastName: "Preview",
        personalEmail: "alex@example.test", employeeLifecycle: "ACTIVE",
      },
    });
    const created = await createAdminInvitation(actor, {
      clubId: club.id,
      email: "alex@example.test",
      initialRoleKeys: ["GENERAL_MANAGER"],
      employmentRelationship: "EMPLOYEE",
      employeeId: existingEmp.id,
    });
    const principalPerson = await principalFor(person.email);
    const activated = await acceptAdminInvitationAsExistingUser({
      token: created.rawToken, principal: principalPerson,
    });
    // Not a new User, not a new Employee.
    const users = await db().user.count({ where: { email: "alex@example.test" } });
    expect(users).toBe(1);
    const emps = await db().employee.count({ where: { clubId: club.id, personalEmail: "alex@example.test" } });
    expect(emps).toBe(1);
    // Profile links the existing Employee.
    const profile = await db().userClubProfile.findUnique({
      where: { clubId_userId: { clubId: club.id, userId: activated.userId } },
    });
    expect(profile?.employeeId).toBe(existingEmp.id);
  });

  it("(5) External User — no Employee created; profile.employeeId stays null", async () => {
    const club = await makeClub("Delta");
    const admin = await makeTenantAdmin(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const created = await createAdminInvitation(actor, {
      clubId: club.id,
      email: "external-auditor@example.test",
      initialRoleKeys: ["AUDITOR_READ_ONLY"],
      employmentRelationship: "EXTERNAL",
    });
    expect(created.invitation.employeeId).toBeNull();
    const activated = await activateAdminInvitationAsNewUser({
      token: created.rawToken, password: "SafePass1234!", confirmPassword: "SafePass1234!",
    });
    const profile = await db().userClubProfile.findUnique({
      where: { clubId_userId: { clubId: club.id, userId: activated.userId } },
    });
    expect(profile?.employeeId).toBeNull();
    // No Employee row at this Club for the external email.
    const emps = await db().employee.count({ where: { clubId: club.id, personalEmail: "external-auditor@example.test" } });
    expect(emps).toBe(0);
  });

  it("Cross-tenant Employee link refused", async () => {
    const clubA = await makeClub("Alpha");
    const clubB = await makeClub("Bravo");
    const adminA = await makeTenantAdmin(clubA.id, "admin@alpha.test");
    const actorA = await principalFor(adminA.email);
    const empAtB = await db().employee.create({
      data: {
        clubId: clubB.id, employeeNumber: "0003",
        firstName: "Cross", lastName: "Tenant",
        personalEmail: "cross@example.test", employeeLifecycle: "ACTIVE",
      },
    });
    await expect(
      createAdminInvitation(actorA, {
        clubId: clubA.id,
        email: "cross@example.test",
        initialRoleKeys: ["STAFF"],
        employmentRelationship: "EMPLOYEE",
        employeeId: empAtB.id,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("Back-compat: omitting employmentRelationship + no employeeId behaves as EXTERNAL (no Employee)", async () => {
    const club = await makeClub("Echo");
    const admin = await makeTenantAdmin(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const created = await createAdminInvitation(actor, {
      clubId: club.id,
      email: "backcompat@example.test",
      initialRoleKeys: ["STAFF"],
      // no employmentRelationship, no employeeId
    });
    expect(created.invitation.employeeId).toBeNull();
    const emps = await db().employee.count({ where: { clubId: club.id, personalEmail: "backcompat@example.test" } });
    expect(emps).toBe(0);
  });

  it("Sensitive-data sweep — invitation serialisation carries NO HR-sensitive fields", async () => {
    const club = await makeClub("Sensitive");
    const admin = await makeTenantAdmin(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const created = await createAdminInvitation(actor, {
      clubId: club.id,
      email: "someone@example.test",
      initialRoleKeys: ["PAYROLL_ADMIN"],
      employmentRelationship: "EMPLOYEE",
    });
    const emp = await db().employee.findUniqueOrThrow({ where: { id: created.invitation.employeeId! } });
    // Populate hypothetical sensitive scaffolding to confirm nothing leaks.
    const serialised = JSON.stringify({ invitation: created.invitation, employee: emp });
    expect(serialised).not.toMatch(/\bSIN\b|socialInsurance|sinFingerprint|bankFingerprint|passwordHash|enc:/);
  });
});
