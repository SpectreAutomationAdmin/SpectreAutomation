// TA-1C — Organizational structure tests.
//
// Covers:
//   - OrganizationalPosition CRUD + tenant scope
//   - UserClubProfile organizational-field updates leave UserClubRole
//     UNCHANGED (role/title separation)
//   - reportsToProfileId graph:
//       - A → B valid
//       - A → A refused (self-manager)
//       - A → B → A refused
//       - A → B → C → A refused
//       - detach works
//       - cross-tenant manager refused
//       - inactive manager refused
//   - Multi-club: same user reports to different people at different clubs

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
vi.setConfig({ testTimeout: 60_000 });

import { ConflictError, ForbiddenError, ValidationError } from "@/lib/errors";
import {
  db, makeClub, makeUser, resetDb, seedRbac, principalFor,
} from "./util/db";
import {
  createPosition, updatePosition, archivePosition, listPositions,
  setProfileOrganizationalFields, setReportsTo, loadOrgTree,
} from "@/lib/tenant-admin/org-structure";
import { upsertProfile } from "@/lib/tenant-admin/profile";

async function makeAdminUser(clubId: string, email: string) {
  return makeUser({ email, name: email, role: "CLUB_ADMIN", clubId });
}

describe("TA-1C · OrganizationalPosition", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("creates a Club-defined position; unique per Club", async () => {
    const club = await makeClub("Alpha");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const p = await createPosition(actor, { clubId: club.id, name: "Director of Finance" });
    expect(p.name).toBe("Director of Finance");
    await expect(
      createPosition(actor, { clubId: club.id, name: "Director of Finance" }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("Department must belong to same Club", async () => {
    const a = await makeClub("A");
    const b = await makeClub("B");
    const adminA = await makeAdminUser(a.id, "adminA@example.test");
    const actorA = await principalFor(adminA.email);
    const foreignDept = await db().department.create({
      data: { clubId: b.id, code: "GRND", name: "Grounds" },
    });
    await expect(
      createPosition(actorA, { clubId: a.id, name: "Groundskeeper", departmentId: foreignDept.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("archive refuses when in use", async () => {
    const club = await makeClub("C");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const pos = await createPosition(actor, { clubId: club.id, name: "Controller" });
    const targetUser = await makeAdminUser(club.id, "target@example.test");
    await upsertProfile({ clubId: club.id, userId: targetUser.id, actor });
    await setProfileOrganizationalFields(actor, {
      clubId: club.id,
      profileId: (await db().userClubProfile.findFirstOrThrow({ where: { userId: targetUser.id, clubId: club.id } })).id,
      positionId: pos.id,
    });
    await expect(archivePosition(actor, pos.id)).rejects.toBeInstanceOf(ConflictError);
  });

  it("updates + archive succeed when unused", async () => {
    const club = await makeClub("D");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const pos = await createPosition(actor, { clubId: club.id, name: "CFO" });
    const updated = await updatePosition(actor, pos.id, { name: "Chief Financial Officer" });
    expect(updated.name).toBe("Chief Financial Officer");
    const archived = await archivePosition(actor, pos.id);
    expect(archived.isActive).toBe(false);
    const activeList = await listPositions(club.id);
    expect(activeList.find((p) => p.id === pos.id)).toBeUndefined();
  });
});

describe("TA-1C · Profile organizational-field edits preserve access role", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("changing title / position / department does NOT change UserClubRole", async () => {
    const club = await makeClub("Alpha");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const user = await makeUser({ email: "target@example.test", role: "PAYROLL_ADMIN", clubId: club.id });
    const rolesBefore = (await db().userClubRole.findMany({ where: { userId: user.id, clubId: club.id } })).map((r) => r.roleKey).sort();
    const profile = await upsertProfile({ clubId: club.id, userId: user.id, actor });
    const controller = await createPosition(actor, { clubId: club.id, name: "Controller" });
    await setProfileOrganizationalFields(actor, {
      clubId: club.id, profileId: profile.id,
      displayTitle: "Controller & Board Secretary",
      positionId: controller.id,
    });
    const rolesAfter = (await db().userClubRole.findMany({ where: { userId: user.id, clubId: club.id } })).map((r) => r.roleKey).sort();
    expect(rolesAfter).toEqual(rolesBefore);
  });
});

describe("TA-1C · Reporting relationship + cycle detection", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("A → B valid", async () => {
    const club = await makeClub("A");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const uA = await makeAdminUser(club.id, "a@example.test");
    const uB = await makeAdminUser(club.id, "b@example.test");
    const pA = await upsertProfile({ clubId: club.id, userId: uA.id, actor });
    const pB = await upsertProfile({ clubId: club.id, userId: uB.id, actor });
    const updated = await setReportsTo(actor, { clubId: club.id, profileId: pA.id, reportsToProfileId: pB.id });
    expect(updated.reportsToProfileId).toBe(pB.id);
  });

  it("A → A refused (self-manager)", async () => {
    const club = await makeClub("B");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const u = await makeAdminUser(club.id, "u@example.test");
    const p = await upsertProfile({ clubId: club.id, userId: u.id, actor });
    await expect(
      setReportsTo(actor, { clubId: club.id, profileId: p.id, reportsToProfileId: p.id }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("A → B → A refused (short cycle)", async () => {
    const club = await makeClub("C");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const uA = await makeAdminUser(club.id, "a@example.test");
    const uB = await makeAdminUser(club.id, "b@example.test");
    const pA = await upsertProfile({ clubId: club.id, userId: uA.id, actor });
    const pB = await upsertProfile({ clubId: club.id, userId: uB.id, actor });
    await setReportsTo(actor, { clubId: club.id, profileId: pA.id, reportsToProfileId: pB.id });
    await expect(
      setReportsTo(actor, { clubId: club.id, profileId: pB.id, reportsToProfileId: pA.id }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("A → B → C → A refused (three-hop cycle)", async () => {
    const club = await makeClub("D");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const uA = await makeAdminUser(club.id, "a@example.test");
    const uB = await makeAdminUser(club.id, "b@example.test");
    const uC = await makeAdminUser(club.id, "c@example.test");
    const pA = await upsertProfile({ clubId: club.id, userId: uA.id, actor });
    const pB = await upsertProfile({ clubId: club.id, userId: uB.id, actor });
    const pC = await upsertProfile({ clubId: club.id, userId: uC.id, actor });
    await setReportsTo(actor, { clubId: club.id, profileId: pA.id, reportsToProfileId: pB.id });
    await setReportsTo(actor, { clubId: club.id, profileId: pB.id, reportsToProfileId: pC.id });
    await expect(
      setReportsTo(actor, { clubId: club.id, profileId: pC.id, reportsToProfileId: pA.id }),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("Detach works — null is idempotent", async () => {
    const club = await makeClub("E");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const uA = await makeAdminUser(club.id, "a@example.test");
    const uB = await makeAdminUser(club.id, "b@example.test");
    const pA = await upsertProfile({ clubId: club.id, userId: uA.id, actor });
    const pB = await upsertProfile({ clubId: club.id, userId: uB.id, actor });
    await setReportsTo(actor, { clubId: club.id, profileId: pA.id, reportsToProfileId: pB.id });
    const detached = await setReportsTo(actor, { clubId: club.id, profileId: pA.id, reportsToProfileId: null });
    expect(detached.reportsToProfileId).toBeNull();
    const again = await setReportsTo(actor, { clubId: club.id, profileId: pA.id, reportsToProfileId: null });
    expect(again.reportsToProfileId).toBeNull();
  });

  it("Cross-tenant manager refused", async () => {
    const a = await makeClub("A");
    const b = await makeClub("B");
    const adminA = await makeAdminUser(a.id, "adminA@example.test");
    const actorA = await principalFor(adminA.email);
    const uA = await makeAdminUser(a.id, "userA@example.test");
    const uB = await makeAdminUser(b.id, "userB@example.test");
    const pA = await upsertProfile({ clubId: a.id, userId: uA.id, actor: actorA });
    const adminB = await makeAdminUser(b.id, "adminB@example.test");
    const actorB = await principalFor(adminB.email);
    const pB = await upsertProfile({ clubId: b.id, userId: uB.id, actor: actorB });
    await expect(
      setReportsTo(actorA, { clubId: a.id, profileId: pA.id, reportsToProfileId: pB.id }),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("Inactive manager refused", async () => {
    const club = await makeClub("F");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const uA = await makeAdminUser(club.id, "a@example.test");
    const uB = await makeAdminUser(club.id, "b@example.test");
    const pA = await upsertProfile({ clubId: club.id, userId: uA.id, actor });
    const pB = await upsertProfile({ clubId: club.id, userId: uB.id, actor });
    await db().userClubProfile.update({ where: { id: pB.id }, data: { status: "SUSPENDED" } });
    await expect(
      setReportsTo(actor, { clubId: club.id, profileId: pA.id, reportsToProfileId: pB.id }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("Multi-club: same user reports to different people at different clubs", async () => {
    const a = await makeClub("A");
    const b = await makeClub("B");
    const adminA = await makeAdminUser(a.id, "adminA@example.test");
    const adminB = await makeAdminUser(b.id, "adminB@example.test");
    const actorA = await principalFor(adminA.email);
    const actorB = await principalFor(adminB.email);
    // Chris is a member of BOTH clubs
    const chris = await makeUser({ email: "chris@example.test", role: "CLUB_ADMIN", clubId: a.id });
    await db().userClubRole.create({ data: { userId: chris.id, clubId: b.id, roleKey: "CLUB_ADMIN" } });

    const chrisA = await upsertProfile({ clubId: a.id, userId: chris.id, actor: actorA });
    const chrisB = await upsertProfile({ clubId: b.id, userId: chris.id, actor: actorB });

    const uAA = await makeAdminUser(a.id, "managerA@example.test");
    const uBB = await makeAdminUser(b.id, "managerB@example.test");
    const pAA = await upsertProfile({ clubId: a.id, userId: uAA.id, actor: actorA });
    const pBB = await upsertProfile({ clubId: b.id, userId: uBB.id, actor: actorB });

    await setReportsTo(actorA, { clubId: a.id, profileId: chrisA.id, reportsToProfileId: pAA.id });
    await setReportsTo(actorB, { clubId: b.id, profileId: chrisB.id, reportsToProfileId: pBB.id });

    const afterA = await db().userClubProfile.findUniqueOrThrow({ where: { id: chrisA.id } });
    const afterB = await db().userClubProfile.findUniqueOrThrow({ where: { id: chrisB.id } });
    expect(afterA.reportsToProfileId).toBe(pAA.id);
    expect(afterB.reportsToProfileId).toBe(pBB.id);
    expect(afterA.reportsToProfileId).not.toBe(afterB.reportsToProfileId);
  });
});

describe("TA-1C · Org tree read", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("loadOrgTree returns nodes with parent pointer + no HR-sensitive fields", async () => {
    const club = await makeClub("Tree");
    const admin = await makeAdminUser(club.id, "admin@example.test");
    const actor = await principalFor(admin.email);
    const gm = await makeAdminUser(club.id, "gm@example.test");
    const ct = await makeAdminUser(club.id, "ct@example.test");
    const pGm = await upsertProfile({ clubId: club.id, userId: gm.id, actor });
    const pCt = await upsertProfile({ clubId: club.id, userId: ct.id, actor });
    await setReportsTo(actor, { clubId: club.id, profileId: pCt.id, reportsToProfileId: pGm.id });
    const nodes = await loadOrgTree(club.id);
    const gmNode = nodes.find((n) => n.userEmail === "gm@example.test");
    const ctNode = nodes.find((n) => n.userEmail === "ct@example.test");
    expect(gmNode?.reportsToProfileId).toBeNull();
    expect(ctNode?.reportsToProfileId).toBe(pGm.id);
    // No HR fields leak.
    const serialised = JSON.stringify(nodes);
    expect(serialised).not.toMatch(/\bSIN\b|socialInsurance|passwordHash|enc:/);
  });
});
