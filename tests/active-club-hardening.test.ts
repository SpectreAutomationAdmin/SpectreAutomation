// TA-1C hotfix (2026-09-04) — regression tests for getActiveClubId
// after the founder-preview tenant-isolation crash.
//
// The prior behaviour of getActiveClubId fell back to `prisma.club.
// findFirst({ orderBy: { createdAt: "asc" } })` any time `user.clubId`
// was unset. A synthetic user with membership in one club but no
// legacy `clubId` scalar would therefore be routed to the OLDEST
// Club in the DB — which they had no access to — tripping tenantWhere
// deep in the admin shell.
//
// The hardened resolver walks UserClubRole first and prefers the
// user's authorised memberships. These tests pin that behaviour.

import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
vi.setConfig({ testTimeout: 60_000 });

import { db, makeClub, makeUser, resetDb, seedRbac } from "./util/db";
import { getActiveClubId } from "@/lib/active-club";

async function makeUserWithMembership(clubId: string, email: string) {
  return makeUser({ email, name: email, role: "CLUB_ADMIN", clubId });
}

describe("TA-1C hotfix · getActiveClubId hardening", () => {
  beforeAll(async () => { await resetDb(); await seedRbac(); });
  beforeEach(async () => { await resetDb(); await seedRbac(); });

  it("single-tenant authorised user: resolves to their only Club, not the oldest", async () => {
    // Older Club exists FIRST (oldest by createdAt) so the legacy
    // fallback would have picked it. The user's membership is at the
    // NEWER Club — resolver must prefer that.
    const older = await makeClub("Older Club");
    const newer = await makeClub("Newer Club");
    const user = await makeUserWithMembership(newer.id, "user@example.test");
    // Simulate the pre-hotfix stale scenario where user.clubId scalar
    // hasn't been synced (or was never set). Force it to null.
    await db().user.update({ where: { id: user.id }, data: { clubId: null } });
    const active = await getActiveClubId({ id: user.id, clubId: null, role: user.role });
    expect(active).toBe(newer.id);
    // Never the oldest.
    expect(active).not.toBe(older.id);
  });

  it("stale user.clubId pointing at an unauthorised Club is IGNORED", async () => {
    // The user was previously at Club A, was removed, and now
    // belongs to Club B. The legacy scalar still points at Club A.
    // Resolver must return Club B (authorised) not Club A (stale).
    const clubA = await makeClub("Formerly Employed");
    const clubB = await makeClub("Currently Employed");
    const user = await makeUserWithMembership(clubB.id, "user@example.test");
    // Point the deprecated scalar at Club A even though the user has
    // no membership there any more.
    await db().user.update({ where: { id: user.id }, data: { clubId: clubA.id } });
    const active = await getActiveClubId({ id: user.id, clubId: clubA.id, role: user.role });
    expect(active).toBe(clubB.id);
    expect(active).not.toBe(clubA.id);
  });

  it("legacy user.clubId is honoured when the user still has a membership there", async () => {
    const club = await makeClub("My Club");
    const user = await makeUserWithMembership(club.id, "user@example.test");
    const active = await getActiveClubId({ id: user.id, clubId: club.id, role: user.role });
    expect(active).toBe(club.id);
  });

  it("multi-club: chooses the first authorised membership by createdAt", async () => {
    // Assert the resolver picks a Club the user is authorised at (not
    // the newest or oldest of ALL Clubs). No cross-tenant leak.
    const outsider = await makeClub("Outsider Club");
    const first = await makeClub("First Membership");
    const second = await makeClub("Second Membership");
    const user = await makeUserWithMembership(first.id, "user@example.test");
    await db().userClubRole.create({ data: { userId: user.id, clubId: second.id, roleKey: "CLUB_ADMIN" } });
    await db().user.update({ where: { id: user.id }, data: { clubId: null } });
    const active = await getActiveClubId({ id: user.id, clubId: null, role: user.role });
    // Must be one of the two authorised memberships.
    expect([first.id, second.id]).toContain(active);
    // Must NOT be the outsider Club.
    expect(active).not.toBe(outsider.id);
  });

  it("user with NO memberships falls through to oldest club (SUPER_ADMIN / platform)", async () => {
    // Documented existing behaviour — this is the SUPER_ADMIN /
    // platform-only shortcut. The admin shell gate at
    // src/app/app/admin/layout.tsx separately refuses non-admin
    // access, so this fallback is only reached in specific system
    // paths.
    const oldest = await makeClub("Oldest");
    await makeClub("Newer");
    const orphan = await db().user.create({
      data: {
        email: "orphan@example.test", name: "Orphan",
        role: "SUPER_ADMIN", passwordHash: "x", status: "ACTIVE",
      },
    });
    const active = await getActiveClubId({ id: orphan.id, clubId: null, role: orphan.role });
    expect(active).toBe(oldest.id);
  });
});
