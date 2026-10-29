// SIGNUP-2 M4-INT-C §1 (2026-10-29) -- Read-only enumeration of
// legitimate platform SUPER_ADMIN identities on staging.
//
// Does NOT create, update, or delete any row.  Does NOT grant any
// role.  Does NOT reveal email addresses in full -- shows the local
// part + domain for operator identification without exposing them to
// logs.
//
// Run via:
//   flyctl ssh console --app spectre-staging --command "node /app/scripts/m4-int-c-list-super-admins.mjs"

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const rows = await prisma.userRole.findMany({
    where: { clubId: null, roleKey: "SUPER_ADMIN" },
    select: {
      id: true,
      createdAt: true,
      user: {
        select: {
          id: true,
          email: true,
          name: true,
          createdAt: true,
          deactivatedAt: true,
          emailVerifiedAt: true,
        },
      },
    },
    orderBy: { createdAt: "asc" },
  });
  const summary = rows.map((r) => {
    const email = r.user?.email ?? "<null>";
    const [local, domain] = email.split("@");
    const maskedLocal = local && local.length > 4
      ? local.slice(0, 2) + "***" + local.slice(-2)
      : "***";
    return {
      userIdTail: r.user?.id?.slice(-6) ?? null,
      userRoleIdTail: r.id.slice(-6),
      emailMasked: `${maskedLocal}@${domain ?? "<nodomain>"}`,
      name: r.user?.name ?? null,
      createdAtIso: r.createdAt.toISOString(),
      userCreatedAtIso: r.user?.createdAt?.toISOString() ?? null,
      deactivated: !!r.user?.deactivatedAt,
      emailVerified: !!r.user?.emailVerifiedAt,
    };
  });
  console.log(JSON.stringify({ totalSuperAdmins: rows.length, superAdmins: summary }, null, 2));
}

main()
  .catch((err) => {
    console.error("list-super-admins failed:", err instanceof Error ? err.message : String(err));
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
