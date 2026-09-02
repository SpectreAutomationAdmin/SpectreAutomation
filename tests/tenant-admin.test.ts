// TA-1B (2026-09-03) — Tenant Administration acceptance tests.
//
// Covers the invariants called out in the founder brief §44:
//   Tenant profile / Tenant Administrator (bootstrap, idempotent,
//   duplicate refused, backup allowed, inactive refused, last primary
//   removal refused) / Invitations (create/resend/revoke/expire/activate
//   /token replay refused / existing user attach / duplicate email
//   normalisation / cross-tenant misuse refused) / Security (SUPER_ADMIN
//   not tenant-assignable, tenant roles allow-list, Club A admin cannot
//   invite Club B, no invitation token in logs/audit) / Audit.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// SQLite/WAL on Windows makes each transactional write here take
// ~4–5 seconds, and a few tests chain 4–6 writes back to back. Give
// them 60s per test rather than fighting the default 5s ceiling.
vi.setConfig({ testTimeout: 60_000 });
import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import {
  db,
  makeClub,
  makeUser,
  resetDb,
  seedRbac,
  principalFor,
} from "./util/db";
import {
  createAdminInvitation,
  resendAdminInvitation,
  revokeAdminInvitation,
  activateAdminInvitation,
  findInvitationByToken,
} from "@/lib/tenant-admin/invitations";
import {
  assignPrimary,
  addBackup,
  endAssignment,
  countActivePrimaries,
  ensureTenantAdministrationBootstrap,
  findActivePrimary,
} from "@/lib/tenant-admin/responsibilities";
import { changeProfileStatus, upsertProfile, assertTenantUsersWrite } from "@/lib/tenant-admin/profile";

async function makeAdminUser(clubId: string, email: string) {
  return makeUser({ email, name: email, role: "CLUB_ADMIN", clubId });
}

describe("TA-1B · Responsibility assignments", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("bootstrap assigns Tenant Administrator PRIMARY when none exists", async () => {
    const club = await makeClub("Tenant A");
    const user = await makeAdminUser(club.id, "alice@example.test");
    const actor = await principalFor(user.email);
    await ensureTenantAdministrationBootstrap({
      clubId: club.id, userId: user.id, actor,
    });
    const primary = await findActivePrimary(club.id, "TENANT_ADMINISTRATION");
    expect(primary?.userId).toBe(user.id);
  });

  it("bootstrap is idempotent — second call with a different user is a no-op", async () => {
    const club = await makeClub("Tenant B");
    const alice = await makeAdminUser(club.id, "alice@example.test");
    const bob = await makeAdminUser(club.id, "bob@example.test");
    const actor = await principalFor(alice.email);
    await ensureTenantAdministrationBootstrap({ clubId: club.id, userId: alice.id, actor });
    await ensureTenantAdministrationBootstrap({ clubId: club.id, userId: bob.id, actor });
    const primary = await findActivePrimary(club.id, "TENANT_ADMINISTRATION");
    expect(primary?.userId).toBe(alice.id);
    expect(await countActivePrimaries(club.id, "TENANT_ADMINISTRATION")).toBe(1);
  });

  it("SINGLE_PRIMARY: reassigning primary closes the previous and creates one active row", async () => {
    const club = await makeClub("Tenant C");
    const alice = await makeAdminUser(club.id, "alice@example.test");
    const bob = await makeAdminUser(club.id, "bob@example.test");
    const actor = await principalFor(alice.email);
    await assignPrimary({ clubId: club.id, userId: alice.id, responsibilityKey: "TENANT_ADMINISTRATION", actor });
    await assignPrimary({ clubId: club.id, userId: bob.id, responsibilityKey: "TENANT_ADMINISTRATION", actor });
    expect(await countActivePrimaries(club.id, "TENANT_ADMINISTRATION")).toBe(1);
    const primary = await findActivePrimary(club.id, "TENANT_ADMINISTRATION");
    expect(primary?.userId).toBe(bob.id);
  });

  it("BACKUP: multiple backups allowed; duplicate refused", async () => {
    const club = await makeClub("Tenant D");
    const alice = await makeAdminUser(club.id, "alice@example.test");
    const bob = await makeAdminUser(club.id, "bob@example.test");
    const actor = await principalFor(alice.email);
    await assignPrimary({ clubId: club.id, userId: alice.id, responsibilityKey: "TENANT_ADMINISTRATION", actor });
    await addBackup({ clubId: club.id, userId: bob.id, responsibilityKey: "TENANT_ADMINISTRATION", actor });
    await expect(
      addBackup({ clubId: club.id, userId: bob.id, responsibilityKey: "TENANT_ADMINISTRATION", actor })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("Inactive user cannot become primary", async () => {
    const club = await makeClub("Tenant E");
    const user = await makeAdminUser(club.id, "inactive@example.test");
    await db().user.update({ where: { id: user.id }, data: { status: "LOCKED" } });
    const actor = await principalFor("inactive@example.test").catch(() => null);
    await expect(
      assignPrimary({
        clubId: club.id, userId: user.id, responsibilityKey: "TENANT_ADMINISTRATION", actor,
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("User not a member of the club cannot hold a responsibility there", async () => {
    const clubA = await makeClub("Alpha");
    const clubB = await makeClub("Bravo");
    const foreignUser = await makeAdminUser(clubB.id, "foreigner@example.test");
    const actor = await principalFor(foreignUser.email);
    await expect(
      assignPrimary({ clubId: clubA.id, userId: foreignUser.id, responsibilityKey: "TENANT_ADMINISTRATION", actor })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Last-primary safety: cannot end the only active PRIMARY", async () => {
    const club = await makeClub("Tenant F");
    const user = await makeAdminUser(club.id, "solo@example.test");
    const actor = await principalFor(user.email);
    const primary = await assignPrimary({
      clubId: club.id, userId: user.id, responsibilityKey: "TENANT_ADMINISTRATION", actor,
    });
    await expect(endAssignment({ assignmentId: primary.id, actor })).rejects.toBeInstanceOf(ConflictError);
  });

  it("Last-primary safety: cannot suspend the only Tenant Administrator via profile status", async () => {
    const club = await makeClub("Tenant G");
    const user = await makeAdminUser(club.id, "solo@example.test");
    const actor = await principalFor(user.email);
    await upsertProfile({ clubId: club.id, userId: user.id, actor });
    await assignPrimary({ clubId: club.id, userId: user.id, responsibilityKey: "TENANT_ADMINISTRATION", actor });
    await expect(
      changeProfileStatus({ clubId: club.id, userId: user.id, nextStatus: "SUSPENDED", actor })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("Suspending is allowed once another Primary exists", async () => {
    const club = await makeClub("Tenant H");
    const alice = await makeAdminUser(club.id, "alice@example.test");
    const bob = await makeAdminUser(club.id, "bob@example.test");
    const actor = await principalFor(alice.email);
    await upsertProfile({ clubId: club.id, userId: alice.id, actor });
    await upsertProfile({ clubId: club.id, userId: bob.id, actor });
    await assignPrimary({ clubId: club.id, userId: alice.id, responsibilityKey: "TENANT_ADMINISTRATION", actor });
    // Reassign primary to bob first
    await assignPrimary({ clubId: club.id, userId: bob.id, responsibilityKey: "TENANT_ADMINISTRATION", actor });
    // Now alice is no longer primary — suspending her is fine
    const updated = await changeProfileStatus({ clubId: club.id, userId: alice.id, nextStatus: "SUSPENDED", actor });
    expect(updated.status).toBe("SUSPENDED");
  });
});

describe("TA-1B · UserClubProfile", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("unique per (clubId, userId)", async () => {
    const club = await makeClub("Tenant Uniq");
    const user = await makeAdminUser(club.id, "u@example.test");
    const actor = await principalFor(user.email);
    await upsertProfile({ clubId: club.id, userId: user.id, actor, displayTitle: "First" });
    const second = await upsertProfile({ clubId: club.id, userId: user.id, actor, displayTitle: "Second" });
    expect(second.displayTitle).toBe("Second");
    const count = await db().userClubProfile.count({ where: { clubId: club.id, userId: user.id } });
    expect(count).toBe(1);
  });

  it("Employee link must match Club", async () => {
    const clubA = await makeClub("Alpha");
    const clubB = await makeClub("Bravo");
    const user = await makeAdminUser(clubA.id, "cross@example.test");
    const foreignEmployee = await db().employee.create({
      data: { clubId: clubB.id, employeeNumber: "X-1", firstName: "Cross", lastName: "Tenant" },
    });
    const actor = await principalFor(user.email);
    await expect(
      upsertProfile({ clubId: clubA.id, userId: user.id, actor, employeeId: foreignEmployee.id })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("TA-1B · Admin invitations", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("create returns the raw token exactly once and stores only a hash", async () => {
    const club = await makeClub("Tenant Invite");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const { invitation, token } = await createAdminInvitation(actor, {
      clubId: club.id,
      email: "raelene@example.test",
      firstName: "Raelene",
      displayTitle: "Office Manager",
      initialRoleKeys: ["PAYROLL_ADMIN"],
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    expect(invitation.tokenHash.length).toBe(64); // sha256 hex
    expect(invitation.tokenHash).not.toBe(token);
    // No audit rows contain the raw token.
    const audits = await db().auditLog.findMany({ where: { action: "admin.invitation.created" } });
    expect(audits.some((a) => (a.afterJson ?? "").includes(token))).toBe(false);
  });

  it("SUPER_ADMIN cannot be granted through an invitation", async () => {
    const club = await makeClub("Tenant Escalation");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    await expect(
      createAdminInvitation(actor, {
        clubId: club.id,
        email: "danger@example.test",
        initialRoleKeys: ["SUPER_ADMIN"],
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("Refuses invalid role literals", async () => {
    const club = await makeClub("Tenant Roles");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    await expect(
      createAdminInvitation(actor, {
        clubId: club.id,
        email: "typo@example.test",
        initialRoleKeys: ["FB_MANAGER"], // canonical is F_AND_B_MANAGER
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("Refuses cross-tenant invitations", async () => {
    const clubA = await makeClub("Alpha");
    const clubB = await makeClub("Bravo");
    const adminA = await makeAdminUser(clubA.id, "admin@alpha.test");
    const actor = await principalFor(adminA.email);
    await expect(
      createAdminInvitation(actor, {
        clubId: clubB.id,
        email: "target@bravo.test",
        initialRoleKeys: ["CONTROLLER"],
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Refuses a duplicate live invitation to the same email at the same club", async () => {
    const club = await makeClub("Tenant Dupe");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    await createAdminInvitation(actor, {
      clubId: club.id, email: "raelene@example.test", initialRoleKeys: ["PAYROLL_ADMIN"],
    });
    await expect(
      createAdminInvitation(actor, {
        clubId: club.id, email: "raelene@example.test", initialRoleKeys: ["PAYROLL_ADMIN"],
      })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("Normalises email case + whitespace", async () => {
    const club = await makeClub("Tenant Case");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const { invitation } = await createAdminInvitation(actor, {
      clubId: club.id, email: "  Raelene@Example.TEST  ", initialRoleKeys: ["PAYROLL_ADMIN"],
    });
    expect(invitation.email).toBe("raelene@example.test");
  });

  it("Resend rotates the token hash and refuses replay of the old token", async () => {
    const club = await makeClub("Tenant Resend");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const { invitation, token: oldToken } = await createAdminInvitation(actor, {
      clubId: club.id, email: "raelene@example.test", initialRoleKeys: ["PAYROLL_ADMIN"],
    });
    const { token: newToken } = await resendAdminInvitation(actor, invitation.id);
    expect(newToken).not.toBe(oldToken);
    expect(await findInvitationByToken(oldToken)).toBeNull();
    expect(await findInvitationByToken(newToken)).not.toBeNull();
  });

  it("Revoke marks REVOKED and refuses further activation", async () => {
    const club = await makeClub("Tenant Revoke");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const { invitation, token } = await createAdminInvitation(actor, {
      clubId: club.id, email: "raelene@example.test", initialRoleKeys: ["PAYROLL_ADMIN"],
    });
    await revokeAdminInvitation(actor, invitation.id);
    await expect(
      activateAdminInvitation({ token, password: "SafePass1234!", confirmPassword: "SafePass1234!" })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("Expired invitation refused; status flipped to EXPIRED", async () => {
    const club = await makeClub("Tenant Expire");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const { invitation, token } = await createAdminInvitation(actor, {
      clubId: club.id, email: "raelene@example.test", initialRoleKeys: ["PAYROLL_ADMIN"],
    });
    await db().adminInvitation.update({
      where: { id: invitation.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await expect(
      activateAdminInvitation({ token, password: "SafePass1234!", confirmPassword: "SafePass1234!" })
    ).rejects.toBeInstanceOf(ConflictError);
    const after = await db().adminInvitation.findUnique({ where: { id: invitation.id } });
    expect(after?.status).toBe("EXPIRED");
  });

  it("Activation creates User + UserClubRole + UserClubProfile + audits", async () => {
    const club = await makeClub("Tenant Activate");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const { invitation, token } = await createAdminInvitation(actor, {
      clubId: club.id,
      email: "raelene@example.test",
      firstName: "Raelene",
      lastName: "Smith",
      displayTitle: "Office Manager",
      initialRoleKeys: ["PAYROLL_ADMIN"],
    });
    const result = await activateAdminInvitation({
      token, password: "SafePass1234!", confirmPassword: "SafePass1234!",
    });
    expect(result.createdUser).toBe(true);
    const newUser = await db().user.findUnique({ where: { id: result.userId } });
    expect(newUser?.email).toBe("raelene@example.test");
    expect(newUser?.status).toBe("ACTIVE");
    const roles = await db().userClubRole.findMany({ where: { userId: result.userId, clubId: club.id } });
    expect(roles.map((r) => r.roleKey).sort()).toEqual(["PAYROLL_ADMIN"]);
    const profile = await db().userClubProfile.findUnique({ where: { clubId_userId: { clubId: club.id, userId: result.userId } } });
    expect(profile?.displayTitle).toBe("Office Manager");
    // Invitation status flipped
    const after = await db().adminInvitation.findUnique({ where: { id: invitation.id } });
    expect(after?.status).toBe("ACTIVATED");
    expect(after?.activatedUserId).toBe(result.userId);
    // Second activation attempt refused
    await expect(
      activateAdminInvitation({ token, password: "SafePass1234!", confirmPassword: "SafePass1234!" })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("Activation attaches to an EXISTING user by email without creating a duplicate", async () => {
    const clubA = await makeClub("Alpha");
    const clubB = await makeClub("Bravo");
    const adminB = await makeAdminUser(clubB.id, "admin@bravo.test");
    const existing = await makeAdminUser(clubA.id, "shared@example.test");
    const bAdminActor = await principalFor(adminB.email);
    const { token } = await createAdminInvitation(bAdminActor, {
      clubId: clubB.id, email: "shared@example.test", initialRoleKeys: ["CONTROLLER"],
    });
    const result = await activateAdminInvitation({
      token, password: "AnotherPass99!", confirmPassword: "AnotherPass99!",
    });
    expect(result.createdUser).toBe(false);
    expect(result.userId).toBe(existing.id);
    // The user now has roles at BOTH clubs.
    const rolesB = await db().userClubRole.findMany({ where: { userId: existing.id, clubId: clubB.id } });
    expect(rolesB.map((r) => r.roleKey).sort()).toEqual(["CONTROLLER"]);
    const rolesA = await db().userClubRole.findMany({ where: { userId: existing.id, clubId: clubA.id } });
    expect(rolesA.length).toBe(1); // original Club A membership preserved
    // Only one User row with that email
    const users = await db().user.findMany({ where: { email: "shared@example.test" } });
    expect(users.length).toBe(1);
  });

  it("Bootstrap invitation activation assigns TENANT_ADMINISTRATION PRIMARY", async () => {
    const club = await makeClub("Tenant Bootstrap");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const { token } = await createAdminInvitation(actor, {
      clubId: club.id,
      email: "firstadmin@example.test",
      initialRoleKeys: ["CLUB_ADMIN"],
      bootstrap: true,
    });
    const result = await activateAdminInvitation({
      token, password: "TenantAdmin99!", confirmPassword: "TenantAdmin99!",
    });
    expect(result.bootstrapPrimaryAssigned).toBe(true);
    const primary = await findActivePrimary(club.id, "TENANT_ADMINISTRATION");
    expect(primary?.userId).toBe(result.userId);
  });

  it("Bootstrap activation is idempotent — second bootstrap invitation does NOT replace primary", async () => {
    const club = await makeClub("Tenant Boot2");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const { token: t1 } = await createAdminInvitation(actor, {
      clubId: club.id, email: "one@example.test", initialRoleKeys: ["CLUB_ADMIN"], bootstrap: true,
    });
    const r1 = await activateAdminInvitation({ token: t1, password: "Passphrase99!", confirmPassword: "Passphrase99!" });
    const { token: t2 } = await createAdminInvitation(actor, {
      clubId: club.id, email: "two@example.test", initialRoleKeys: ["CLUB_ADMIN"], bootstrap: true,
    });
    const r2 = await activateAdminInvitation({ token: t2, password: "Passphrase99!", confirmPassword: "Passphrase99!" });
    expect(r2.bootstrapPrimaryAssigned).toBe(false);
    const primary = await findActivePrimary(club.id, "TENANT_ADMINISTRATION");
    expect(primary?.userId).toBe(r1.userId); // still first bootstrap
  });

  it("Rejects a password missing complexity", async () => {
    const club = await makeClub("Tenant Pass");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const { token } = await createAdminInvitation(actor, {
      clubId: club.id, email: "weak@example.test", initialRoleKeys: ["PAYROLL_ADMIN"],
    });
    await expect(
      activateAdminInvitation({ token, password: "onlylowercase", confirmPassword: "onlylowercase" })
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe("TA-1B · Tenant users authorization", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("CLUB_ADMIN at Club A cannot manage Club B tenant users", async () => {
    const clubA = await makeClub("Alpha");
    const clubB = await makeClub("Bravo");
    const adminA = await makeAdminUser(clubA.id, "admin@alpha.test");
    const principal = await principalFor(adminA.email);
    await expect(assertTenantUsersWrite(principal, clubB.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(assertTenantUsersWrite(principal, clubA.id)).resolves.toBeUndefined();
  });

  it("A member without CLUB_ADMIN and without TENANT_ADMINISTRATION is refused", async () => {
    const club = await makeClub("Tenant Guest");
    const staff = await makeUser({ email: "staff@example.test", role: "STAFF", clubId: club.id });
    const principal = await principalFor(staff.email);
    await expect(assertTenantUsersWrite(principal, club.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
