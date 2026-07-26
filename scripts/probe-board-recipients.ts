// Probe: trace James Whitfield's Board access end-to-end and show
// what `defaultBoardRecipients` (the resolver used by publish/send)
// would produce vs. what the dashboard tile path produces, so we
// can pinpoint where the asymmetry lives.

import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient();
  const now = new Date();

  // 1. Find James.
  const james = await prisma.user.findFirst({
    where: {
      OR: [
        { email: { contains: "whitfield" } },
        { name: { contains: "Whitfield" } },
      ],
    },
    include: {
      member: {
        include: {
          boardRoles: true,
        },
      },
      clubRoles: true,
    },
  });
  if (!james) {
    console.log("James not found");
    await prisma.$disconnect();
    return;
  }

  console.log("=== JAMES WHITFIELD ===");
  console.log(`  user.id          : ${james.id}`);
  console.log(`  user.email       : ${james.email}`);
  console.log(`  user.status      : ${james.status}`);
  console.log(`  user.memberId    : ${james.memberId ?? "(null)"}`);
  console.log(`  user.role        : ${james.role}`);
  if (james.member) {
    console.log(`  member.id        : ${james.member.id}`);
    console.log(`  member.email     : ${james.member.email}`);
    console.log(`  member.status    : ${james.member.status}`);
    console.log(`  member.clubId    : ${james.member.clubId}`);
    console.log(`  BoardRoles       : ${james.member.boardRoles.length}`);
    for (const r of james.member.boardRoles) {
      console.log(`    - id           : ${r.id}`);
      console.log(`      roleTitle    : ${r.roleTitle}`);
      console.log(`      stored status: ${r.status}`);
      console.log(`      termStartDate: ${r.termStartDate.toISOString()}`);
      console.log(`      termEndDate  : ${r.termEndDate.toISOString()}`);
      const inWindow = r.termStartDate <= now && r.termEndDate >= now;
      console.log(`      in-window?   : ${inWindow}`);
    }
  } else {
    console.log("  member           : (null — James has no Member record!)");
  }
  console.log(`  clubRoles        : ${james.clubRoles.length}`);
  for (const cr of james.clubRoles) {
    console.log(`    - clubId=${cr.clubId} roleKey=${cr.roleKey}`);
  }

  if (!james.member) {
    await prisma.$disconnect();
    return;
  }

  const clubId = james.member.clubId;

  console.log("\n=== SIMULATING defaultBoardRecipients ===");

  // Path 1: UserClubRole BOARD_READ_ONLY
  const roleMemberships = await prisma.userClubRole.findMany({
    where: { clubId, roleKey: "BOARD_READ_ONLY" },
    include: { user: { select: { id: true, email: true, status: true, name: true } } },
  });
  console.log(`Path 1 (UserClubRole BOARD_READ_ONLY): ${roleMemberships.length} match(es)`);
  for (const m of roleMemberships) {
    console.log(`  - ${m.user?.name ?? "?"} <${m.user?.email}>  status=${m.user?.status}`);
  }

  // Path 2: Active BoardRole
  const activeBoardRoles = await prisma.boardRole.findMany({
    where: {
      clubId,
      status: { not: "EXPIRED" },
      termStartDate: { lte: now },
      termEndDate: { gte: now },
    },
    include: {
      member: {
        select: {
          id: true,
          firstName: true,
          lastName: true,
          email: true,
          user: { select: { id: true, email: true, status: true } },
        },
      },
    },
  });
  console.log(`Path 2 (active BoardRole): ${activeBoardRoles.length} match(es)`);
  for (const r of activeBoardRoles) {
    console.log(
      `  - ${r.member.firstName} ${r.member.lastName} <member.email=${r.member.email}>`,
    );
    console.log(
      `      member.user      : ${r.member.user ? `user.id=${r.member.user.id} user.email=${r.member.user.email} user.status=${r.member.user.status}` : "(no linked user)"}`,
    );
    console.log(`      stored status   : ${r.status}`);
    console.log(`      roleTitle       : ${r.roleTitle}`);
    // What the existing defaultBoardRecipients does:
    const linkedUser = r.member.user;
    if (!linkedUser) {
      console.log(`      → EXCLUDED       : no linked user`);
    } else if (linkedUser.status !== "ACTIVE") {
      console.log(`      → EXCLUDED       : user.status != ACTIVE (${linkedUser.status})`);
    } else {
      console.log(`      → INCLUDED       : email=${linkedUser.email} role=${r.roleTitle}`);
    }
  }

  // 3. Recipients currently on the June 2026 package.
  const club = await prisma.club.findUnique({ where: { id: clubId } });
  console.log(`\n=== CURRENT June 2026 RECIPIENTS for ${club?.name} ===`);
  const junePkg = await prisma.monthlyPackage.findUnique({
    where: {
      clubId_reportingYear_reportingMonth: {
        clubId,
        reportingYear: 2026,
        reportingMonth: 6,
      },
    },
    include: {
      recipients: { include: { recipientUser: { select: { name: true, email: true } } } },
    },
  });
  if (!junePkg) {
    console.log("  (no June 2026 package row)");
  } else {
    console.log(`  package.id       : ${junePkg.id}`);
    console.log(`  package.status   : ${junePkg.status}`);
    console.log(`  package.sentAt   : ${junePkg.sentAt?.toISOString() ?? "(null)"}`);
    console.log(`  recipients       : ${junePkg.recipients.length}`);
    for (const r of junePkg.recipients) {
      console.log(
        `    - ${r.recipientUser?.name ?? "?"} <${r.recipientUser?.email ?? r.recipientEmail}> role=${r.recipientRole ?? "(no role)"} status=${r.deliveryStatus} viewedAt=${r.viewedAt?.toISOString() ?? "(unviewed)"}`,
      );
    }
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
