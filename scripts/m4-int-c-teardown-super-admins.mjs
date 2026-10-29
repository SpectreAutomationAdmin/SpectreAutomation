// SIGNUP-2 M4-INT-C (2026-10-29) — Option C teardown.
//
// Removes the two M4-INT-C synthetic SUPER_ADMIN identities + all
// their UserClubRole grants + any live AuthSessions.  Preserves
// all other users.  Also re-runs the SUPER_ADMIN enumeration so
// the caller can assert zero remain.
//
// Safe to call repeatedly (idempotent).

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const TARGET_EMAILS = [
  "platform-admin-m4intc-a@spectreautomation.com",
  "platform-admin-m4intc-b@spectreautomation.com",
];

async function main() {
  const toDelete = await prisma.user.findMany({
    where: { email: { in: TARGET_EMAILS } },
    select: { id: true, email: true, name: true, role: true },
  });
  const userIds = toDelete.map((u) => u.id);

  // 1. Invalidate any auth sessions.  Guard against model not present.
  let sessionDeletedCount = 0;
  try {
    const sessionDelete = await prisma.authSession.deleteMany({
      where: { userId: { in: userIds } },
    });
    sessionDeletedCount = sessionDelete.count;
  } catch {
    // AuthSession model may not exist on all branches; ignore.
  }

  // 2. Remove the UserClubRole grants (platform SUPER_ADMIN + any accidental club roles).
  const roleDelete = await prisma.userClubRole.deleteMany({
    where: { userId: { in: userIds } },
  });

  // 3. Delete the User rows themselves.
  const userDelete = await prisma.user.deleteMany({
    where: { email: { in: TARGET_EMAILS } },
  });

  // 4. Re-run enumeration (same as m4-int-c-list-super-admins) so
  // the caller can assert zero remain on either path.
  const platformRows = await prisma.userClubRole.findMany({
    where: { clubId: null, roleKey: "SUPER_ADMIN" },
    select: { userId: true, user: { select: { email: true, name: true } } },
  });
  const legacyRows = await prisma.user.findMany({
    where: {
      OR: [
        { role: "SUPER_ADMIN" },
        { role: "SPECTRE_ADMIN" },
        { role: "PLATFORM_ADMIN" },
      ],
    },
    select: { id: true, email: true, name: true, role: true, status: true },
  });

  const mask = (e) => {
    if (!e) return "<null>";
    const [l, d] = e.split("@");
    return (l && l.length > 4 ? l.slice(0, 2) + "***" + l.slice(-2) : "***") + "@" + (d || "");
  };

  console.log(JSON.stringify({
    ok: true,
    sliceId: "m4-int-c",
    teardownAt: new Date().toISOString(),
    identifiedUsers: toDelete.map((u) => ({
      userIdTail: u.id.slice(-6),
      emailMasked: mask(u.email),
      wasPlatformAdmin: u.role === "SUPER_ADMIN",
    })),
    deletedAuthSessions: sessionDeletedCount,
    deletedUserClubRoles: roleDelete.count,
    deletedUsers: userDelete.count,
    remainingPlatformSuperAdmins: {
      total: platformRows.length,
      rows: platformRows.map((r) => ({
        userIdTail: r.userId.slice(-6),
        emailMasked: mask(r.user?.email),
      })),
    },
    remainingLegacyUserRole: {
      total: legacyRows.length,
      rows: legacyRows.map((u) => ({
        userIdTail: u.id.slice(-6),
        emailMasked: mask(u.email),
        role: u.role,
      })),
    },
  }, null, 2));
}

main()
  .catch((err) => {
    console.error("teardown failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
