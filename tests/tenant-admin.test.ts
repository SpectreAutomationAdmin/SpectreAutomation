// TA-1B + TA-1B closeout — Tenant Administration acceptance tests.
//
// Covers the original TA-1B invariants + the three closeout corrections:
//
//   §3-§7  new-user vs existing-user activation split; wrong-session
//          refusal; existing User's password hash is byte-for-byte
//          preserved through invitation acceptance.
//   §10-19 admin invitations actually deliver via Spectre's canonical
//          email adapter (console/DEV_LOGGED in tests, not silent SENT).
//   §20-27 transferPrimaryTenantAdministrator is an explicit governance
//          operation distinct from generic assignPrimary; former Primary
//          is NOT auto-BACKUP.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";

// SQLite/WAL on Windows makes each transactional write here take
// ~4–5 seconds; a few tests chain 4-6 writes. Give them 60s.
vi.setConfig({ testTimeout: 60_000 });

import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import {
  db, makeClub, makeUser, resetDb, seedRbac, principalFor,
} from "./util/db";
import {
  createAdminInvitation,
  resendAdminInvitation,
  revokeAdminInvitation,
  activateAdminInvitationAsNewUser,
  acceptAdminInvitationAsExistingUser,
  describeInvitationForLanding,
  findInvitationByToken,
} from "@/lib/tenant-admin/invitations";
import {
  assignPrimary,
  addBackup,
  endAssignment,
  countActivePrimaries,
  ensureTenantAdministrationBootstrap,
  findActivePrimary,
  transferPrimaryTenantAdministrator,
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
    await ensureTenantAdministrationBootstrap({ clubId: club.id, userId: user.id, actor });
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

  it("SINGLE_PRIMARY: reassigning primary via assignPrimary closes the previous", async () => {
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
});

// ---------------------------------------------------------------------
// Closeout §20-§27 — Primary Tenant Administrator transfer semantics.
// ---------------------------------------------------------------------
describe("TA-1B closeout · transferPrimaryTenantAdministrator", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("transfers Primary atomically, ends previous, does NOT auto-BACKUP former Primary", async () => {
    const club = await makeClub("Tenant Xfer");
    const alice = await makeAdminUser(club.id, "alice@example.test");
    const bob = await makeAdminUser(club.id, "bob@example.test");
    const actor = await principalFor(alice.email);
    await upsertProfile({ clubId: club.id, userId: alice.id, actor });
    await upsertProfile({ clubId: club.id, userId: bob.id, actor });
    await assignPrimary({ clubId: club.id, userId: alice.id, responsibilityKey: "TENANT_ADMINISTRATION", actor });

    const result = await transferPrimaryTenantAdministrator({
      clubId: club.id, targetUserId: bob.id, actor,
    });
    expect(result.previousPrimaryUserId).toBe(alice.id);
    expect(result.newPrimary.userId).toBe(bob.id);

    // Exactly one active PRIMARY.
    expect(await countActivePrimaries(club.id, "TENANT_ADMINISTRATION")).toBe(1);
    // Alice is NOT silently a BACKUP.
    const aliceBackup = await db().responsibilityAssignment.count({
      where: { clubId: club.id, userId: alice.id, role: "BACKUP", effectiveTo: null },
    });
    expect(aliceBackup).toBe(0);
    // Audit event recorded distinctly from generic assignment.
    const auditRow = await db().auditLog.findFirst({
      where: { action: "tenant.administrator.transferred", clubId: club.id },
      orderBy: { createdAt: "desc" },
    });
    expect(auditRow).not.toBeNull();
  });

  it("refuses transfer to self (no-op)", async () => {
    const club = await makeClub("Tenant XferSelf");
    const alice = await makeAdminUser(club.id, "alice@example.test");
    const actor = await principalFor(alice.email);
    await upsertProfile({ clubId: club.id, userId: alice.id, actor });
    await assignPrimary({ clubId: club.id, userId: alice.id, responsibilityKey: "TENANT_ADMINISTRATION", actor });
    await expect(
      transferPrimaryTenantAdministrator({ clubId: club.id, targetUserId: alice.id, actor })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses transfer when no current Primary exists (use bootstrap)", async () => {
    const club = await makeClub("Tenant NoPrimary");
    const user = await makeAdminUser(club.id, "new@example.test");
    const actor = await principalFor(user.email);
    await expect(
      transferPrimaryTenantAdministrator({ clubId: club.id, targetUserId: user.id, actor })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses transfer to inactive target — old Primary retained", async () => {
    const club = await makeClub("Tenant XferInactive");
    const alice = await makeAdminUser(club.id, "alice@example.test");
    const bob = await makeAdminUser(club.id, "bob@example.test");
    const actor = await principalFor(alice.email);
    await upsertProfile({ clubId: club.id, userId: alice.id, actor });
    await upsertProfile({ clubId: club.id, userId: bob.id, actor });
    await assignPrimary({ clubId: club.id, userId: alice.id, responsibilityKey: "TENANT_ADMINISTRATION", actor });
    await db().user.update({ where: { id: bob.id }, data: { status: "LOCKED" } });
    await expect(
      transferPrimaryTenantAdministrator({ clubId: club.id, targetUserId: bob.id, actor })
    ).rejects.toBeInstanceOf(ValidationError);
    const primary = await findActivePrimary(club.id, "TENANT_ADMINISTRATION");
    expect(primary?.userId).toBe(alice.id);
  });

  it("adding a BACKUP does not transfer Primary", async () => {
    const club = await makeClub("Tenant BackupNoXfer");
    const alice = await makeAdminUser(club.id, "alice@example.test");
    const bob = await makeAdminUser(club.id, "bob@example.test");
    const actor = await principalFor(alice.email);
    await upsertProfile({ clubId: club.id, userId: alice.id, actor });
    await upsertProfile({ clubId: club.id, userId: bob.id, actor });
    await assignPrimary({ clubId: club.id, userId: alice.id, responsibilityKey: "TENANT_ADMINISTRATION", actor });
    await addBackup({ clubId: club.id, userId: bob.id, responsibilityKey: "TENANT_ADMINISTRATION", actor });
    const primary = await findActivePrimary(club.id, "TENANT_ADMINISTRATION");
    expect(primary?.userId).toBe(alice.id);
    expect(await countActivePrimaries(club.id, "TENANT_ADMINISTRATION")).toBe(1);
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

// ---------------------------------------------------------------------
// Closeout §10-§19 — Delivery + create/resend/revoke lifecycle.
// ---------------------------------------------------------------------
describe("TA-1B closeout · Invitation lifecycle + delivery", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("create dispatches delivery + returns rawToken exactly once", async () => {
    process.env.APP_URL = "https://staging.spectreautomation.com";
    const club = await makeClub("Tenant Deliver");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const result = await createAdminInvitation(actor, {
      clubId: club.id,
      email: "raelene@example.test",
      initialRoleKeys: ["PAYROLL_ADMIN"],
    });
    // Delivery attempted (console adapter in test env → DEV_LOGGED)
    expect(["DELIVERED", "DEV_LOGGED"]).toContain(result.delivery.status);
    // Raw token returned in the service-layer result (not exposed via API).
    expect(result.rawToken).toMatch(/^[A-Za-z0-9_-]{20,}$/);
    // tokenHash stored — not raw.
    expect(result.invitation.tokenHash.length).toBe(64);
    expect(result.invitation.tokenHash).not.toBe(result.rawToken);
    // Invitation reflected as SENT after successful delivery attempt.
    expect(result.invitation.status).toBe("SENT");
    // No audit contains raw token.
    const audits = await db().auditLog.findMany({ where: { action: "admin.invitation.created" } });
    expect(audits.some((a) => (a.afterJson ?? "").includes(result.rawToken))).toBe(false);
  });

  it("delivery failure surfaces honestly — invitation NOT marked SENT", async () => {
    // No APP_URL configured → resolvePublicHost throws → we route to FAILED.
    delete process.env.APP_URL;
    delete process.env.NEXT_PUBLIC_APP_URL;
    const club = await makeClub("Tenant FailDeliver");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const result = await createAdminInvitation(actor, {
      clubId: club.id, email: "raelene@example.test", initialRoleKeys: ["PAYROLL_ADMIN"],
    });
    expect(result.delivery.status).toBe("FAILED");
    expect(result.invitation.status).toBe("FAILED");
    expect(result.invitation.sentAt).toBeNull();
    // Restore for subsequent tests.
    process.env.APP_URL = "https://staging.spectreautomation.com";
  });

  it("SUPER_ADMIN cannot be granted through an invitation", async () => {
    process.env.APP_URL = "https://staging.spectreautomation.com";
    const club = await makeClub("Tenant Escalation");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    await expect(
      createAdminInvitation(actor, {
        clubId: club.id, email: "danger@example.test", initialRoleKeys: ["SUPER_ADMIN"],
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("Refuses invalid role literals", async () => {
    process.env.APP_URL = "https://staging.spectreautomation.com";
    const club = await makeClub("Tenant Roles");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    await expect(
      createAdminInvitation(actor, {
        clubId: club.id, email: "typo@example.test", initialRoleKeys: ["FB_MANAGER"],
      })
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("Refuses cross-tenant invitations", async () => {
    process.env.APP_URL = "https://staging.spectreautomation.com";
    const clubA = await makeClub("Alpha");
    const clubB = await makeClub("Bravo");
    const adminA = await makeAdminUser(clubA.id, "admin@alpha.test");
    const actor = await principalFor(adminA.email);
    await expect(
      createAdminInvitation(actor, {
        clubId: clubB.id, email: "target@bravo.test", initialRoleKeys: ["CONTROLLER"],
      })
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Refuses a duplicate live invitation to the same email at the same club", async () => {
    process.env.APP_URL = "https://staging.spectreautomation.com";
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
    process.env.APP_URL = "https://staging.spectreautomation.com";
    const club = await makeClub("Tenant Case");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const result = await createAdminInvitation(actor, {
      clubId: club.id, email: "  Raelene@Example.TEST  ", initialRoleKeys: ["PAYROLL_ADMIN"],
    });
    expect(result.invitation.email).toBe("raelene@example.test");
  });

  it("Resend rotates the token hash + old token replay refused", async () => {
    process.env.APP_URL = "https://staging.spectreautomation.com";
    const club = await makeClub("Tenant Resend");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const created = await createAdminInvitation(actor, {
      clubId: club.id, email: "raelene@example.test", initialRoleKeys: ["PAYROLL_ADMIN"],
    });
    // Simulate elapsed time to bypass the 60s dedupe on resend.
    await db().adminInvitation.update({
      where: { id: created.invitation.id },
      data: { sentAt: new Date(Date.now() - 120_000) },
    });
    const resent = await resendAdminInvitation(actor, created.invitation.id);
    expect(resent.rawToken).not.toBe(created.rawToken);
    expect(await findInvitationByToken(created.rawToken)).toBeNull();
    expect(await findInvitationByToken(resent.rawToken)).not.toBeNull();
  });

  it("Revoke marks REVOKED + refuses further activation", async () => {
    process.env.APP_URL = "https://staging.spectreautomation.com";
    const club = await makeClub("Tenant Revoke");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const created = await createAdminInvitation(actor, {
      clubId: club.id, email: "raelene@example.test", initialRoleKeys: ["PAYROLL_ADMIN"],
    });
    await revokeAdminInvitation(actor, created.invitation.id);
    await expect(
      activateAdminInvitationAsNewUser({
        token: created.rawToken, password: "SafePass1234!", confirmPassword: "SafePass1234!",
      })
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("Expired invitation refused + status flipped to EXPIRED", async () => {
    process.env.APP_URL = "https://staging.spectreautomation.com";
    const club = await makeClub("Tenant Expire");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const created = await createAdminInvitation(actor, {
      clubId: club.id, email: "raelene@example.test", initialRoleKeys: ["PAYROLL_ADMIN"],
    });
    await db().adminInvitation.update({
      where: { id: created.invitation.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
    await expect(
      activateAdminInvitationAsNewUser({
        token: created.rawToken, password: "SafePass1234!", confirmPassword: "SafePass1234!",
      })
    ).rejects.toBeInstanceOf(ConflictError);
    const after = await db().adminInvitation.findUnique({ where: { id: created.invitation.id } });
    expect(after?.status).toBe("EXPIRED");
  });
});

// ---------------------------------------------------------------------
// Closeout §3-§7 + §31 — Activation paths.
// ---------------------------------------------------------------------
describe("TA-1B closeout · Activation paths (new-user vs existing-user)", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("PATH A — new user: creates User + memberships + profile; refuses if email exists", async () => {
    process.env.APP_URL = "https://staging.spectreautomation.com";
    const club = await makeClub("Tenant NewUser");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const created = await createAdminInvitation(actor, {
      clubId: club.id, email: "brandnew@example.test",
      firstName: "Brand", lastName: "New", displayTitle: "Office Manager",
      initialRoleKeys: ["PAYROLL_ADMIN"],
    });
    const result = await activateAdminInvitationAsNewUser({
      token: created.rawToken, password: "SafePass1234!", confirmPassword: "SafePass1234!",
    });
    expect(result.createdUser).toBe(true);
    const newUser = await db().user.findUnique({ where: { id: result.userId } });
    expect(newUser?.email).toBe("brandnew@example.test");
    // Second attempt (existing email) via PATH A now refuses — must use existing-user path.
    const created2 = await createAdminInvitation(actor, {
      clubId: club.id, email: "brandnew@example.test", initialRoleKeys: ["STAFF"],
    }).catch(() => null);
    // May already be blocked by "already active member" — verify one way or another.
    if (created2) {
      await expect(
        activateAdminInvitationAsNewUser({
          token: created2.rawToken, password: "SafePass1234!", confirmPassword: "SafePass1234!",
        })
      ).rejects.toBeInstanceOf(ConflictError);
    }
  });

  it("PATH B — existing user multi-club: password hash is preserved byte-for-byte", async () => {
    process.env.APP_URL = "https://staging.spectreautomation.com";
    const clubA = await makeClub("Alpha");
    const clubB = await makeClub("Bravo");
    // Existing user established at Club A with the standard test password.
    const existing = await makeUser({
      email: "shared@example.test", role: "CLUB_ADMIN", clubId: clubA.id,
    });
    const HASH_BEFORE = existing.passwordHash;
    // Ensure a UserClubProfile at Club A too (representative of prior tenant state).
    const clubAAdmin = await makeAdminUser(clubA.id, "clubA-admin@example.test");
    await upsertProfile({
      clubId: clubA.id, userId: existing.id, actor: await principalFor(clubAAdmin.email), displayTitle: "Original",
    });
    // Club B invites the same email.
    const adminB = await makeAdminUser(clubB.id, "admin@bravo.test");
    const actorB = await principalFor(adminB.email);
    const created = await createAdminInvitation(actorB, {
      clubId: clubB.id, email: "shared@example.test", initialRoleKeys: ["CONTROLLER"],
    });
    // Existing user accepts — path B, authenticated as themselves.
    const principalExisting = await principalFor(existing.email);
    const result = await acceptAdminInvitationAsExistingUser({
      token: created.rawToken, principal: principalExisting,
    });
    expect(result.createdUser).toBe(false);
    expect(result.userId).toBe(existing.id);
    // HARD GATE: password hash unchanged.
    const after = await db().user.findUnique({ where: { id: existing.id } });
    expect(after?.passwordHash).toBe(HASH_BEFORE);
    // Only one User row for this email.
    const users = await db().user.findMany({ where: { email: "shared@example.test" } });
    expect(users.length).toBe(1);
    // Both Club A and Club B memberships present.
    const memberships = await db().userClubRole.findMany({ where: { userId: existing.id } });
    const clubIds = memberships.map((m) => m.clubId).sort();
    expect(clubIds).toContain(clubA.id);
    expect(clubIds).toContain(clubB.id);
    // Club B profile created; Club A profile unchanged (title still "Original").
    const bProfile = await db().userClubProfile.findUnique({
      where: { clubId_userId: { clubId: clubB.id, userId: existing.id } },
    });
    expect(bProfile).not.toBeNull();
    const aProfile = await db().userClubProfile.findUnique({
      where: { clubId_userId: { clubId: clubA.id, userId: existing.id } },
    });
    expect(aProfile?.displayTitle).toBe("Original");
  });

  it("PATH B — wrong signed-in User refused (no mutation)", async () => {
    process.env.APP_URL = "https://staging.spectreautomation.com";
    const club = await makeClub("Tenant Wrong");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    // Invitation belongs to alice.
    const alice = await makeUser({ email: "alice@example.test", role: "STAFF", clubId: null });
    const created = await createAdminInvitation(actor, {
      clubId: club.id, email: alice.email, initialRoleKeys: ["CONTROLLER"],
    });
    // Bob attempts to accept.
    const bob = await makeUser({ email: "bob@example.test", role: "STAFF", clubId: null });
    const principalBob = await principalFor(bob.email);
    await expect(
      acceptAdminInvitationAsExistingUser({ token: created.rawToken, principal: principalBob })
    ).rejects.toBeInstanceOf(ForbiddenError);
    // Invitation still SENT (not activated).
    const after = await db().adminInvitation.findUnique({ where: { id: created.invitation.id } });
    expect(after?.status).not.toBe("ACTIVATED");
    // No Club B membership on either user.
    const memberships = await db().userClubRole.count({
      where: { clubId: club.id, userId: { in: [alice.id, bob.id] } },
    });
    expect(memberships).toBe(0);
    // Bob's password hash unchanged.
    const bobAfter = await db().user.findUnique({ where: { id: bob.id } });
    expect(bobAfter?.passwordHash).toBe(bob.passwordHash);
  });

  it("PATH A — email that already exists blocks activation with a helpful message", async () => {
    process.env.APP_URL = "https://staging.spectreautomation.com";
    const club = await makeClub("Tenant OverlapEmail");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    // Existing User at another (or no) Club with this email.
    const existing = await makeUser({ email: "person@example.test", role: "STAFF", clubId: null });
    const HASH_BEFORE = existing.passwordHash;
    const created = await createAdminInvitation(actor, {
      clubId: club.id, email: "person@example.test", initialRoleKeys: ["CONTROLLER"],
    });
    // PATH A activation refuses — send them to path B instead.
    await expect(
      activateAdminInvitationAsNewUser({
        token: created.rawToken, password: "SafePass1234!", confirmPassword: "SafePass1234!",
      })
    ).rejects.toBeInstanceOf(ConflictError);
    // Password hash unchanged even though PATH A was attempted.
    const after = await db().user.findUnique({ where: { id: existing.id } });
    expect(after?.passwordHash).toBe(HASH_BEFORE);
  });

  it("Bootstrap invitation via PATH A assigns TENANT_ADMINISTRATION PRIMARY", async () => {
    process.env.APP_URL = "https://staging.spectreautomation.com";
    const club = await makeClub("Tenant Bootstrap");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const created = await createAdminInvitation(actor, {
      clubId: club.id, email: "firstadmin@example.test",
      initialRoleKeys: ["CLUB_ADMIN"], bootstrap: true,
    });
    const result = await activateAdminInvitationAsNewUser({
      token: created.rawToken, password: "TenantAdmin99!", confirmPassword: "TenantAdmin99!",
    });
    expect(result.bootstrapPrimaryAssigned).toBe(true);
    const primary = await findActivePrimary(club.id, "TENANT_ADMINISTRATION");
    expect(primary?.userId).toBe(result.userId);
  });

  it("describeInvitationForLanding routes correctly", async () => {
    process.env.APP_URL = "https://staging.spectreautomation.com";
    const club = await makeClub("Tenant Landing");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    // Case 1: new-user invitation.
    const newInv = await createAdminInvitation(actor, {
      clubId: club.id, email: "newperson@example.test", initialRoleKeys: ["STAFF"],
    });
    const summaryNew = await describeInvitationForLanding(newInv.rawToken);
    expect(summaryNew.requiresExistingUserSignIn).toBe(false);
    expect(summaryNew.existingUserId).toBeNull();
    // Case 2: existing-user invitation.
    await makeUser({ email: "existing@example.test", role: "STAFF", clubId: null });
    const existInv = await createAdminInvitation(actor, {
      clubId: club.id, email: "existing@example.test", initialRoleKeys: ["CONTROLLER"],
    });
    const summaryExist = await describeInvitationForLanding(existInv.rawToken);
    expect(summaryExist.requiresExistingUserSignIn).toBe(true);
    expect(summaryExist.existingUserId).not.toBeNull();
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
