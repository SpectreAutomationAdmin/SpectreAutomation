// One-shot dev helper: trigger the fixed `resendMonthlyPackage`
// against the current Live package so the recipient list rebuilds
// from the live Board roster (founder fix 2026-06-29). Useful when
// the founder wants to verify the fix in the browser without first
// clicking Re-send in the admin UI.
//
// Scope: touches MonthlyPackageRecipient rows for the Live package
// only. Does NOT touch ledger, members, club settings, users,
// roles, or permissions. Idempotent.

import { PrismaClient } from "@prisma/client";
import { resendMonthlyPackage } from "../src/lib/reporting/monthly-package-archive";

async function main() {
  const prisma = new PrismaClient();

  // Find any club with a current Live package.
  const live = await prisma.monthlyPackage.findFirst({
    where: { status: { in: ["PUBLISHED", "SENT"] } },
    orderBy: [{ reportingYear: "desc" }, { reportingMonth: "desc" }],
    select: { id: true, clubId: true, reportingYear: true, reportingMonth: true, club: { select: { name: true } } },
  });
  if (!live) {
    console.log("No live package found.");
    await prisma.$disconnect();
    return;
  }
  console.log(
    `Live package: ${live.club.name} · ${live.reportingYear}-${String(live.reportingMonth).padStart(2, "0")} (${live.id})`,
  );

  // Pick the first CLUB_ADMIN user for this club to act as the
  // resend principal — same path the admin UI uses.
  const adminRole = await prisma.userClubRole.findFirst({
    where: { clubId: live.clubId, roleKey: "CLUB_ADMIN" },
    include: { user: true },
  });
  if (!adminRole?.user) {
    console.log("No CLUB_ADMIN user found for this club; cannot run resend.");
    await prisma.$disconnect();
    return;
  }
  const principal = {
    id: adminRole.user.id,
    name: adminRole.user.name,
    email: adminRole.user.email,
    status: adminRole.user.status,
    memberships: [{ clubId: live.clubId, roleKey: "CLUB_ADMIN" as const }],
    activeClubId: live.clubId,
    memberId: null,
  };

  const before = await prisma.monthlyPackageRecipient.count({
    where: { monthlyPackageId: live.id },
  });
  console.log(`Recipients BEFORE resend: ${before}`);

  const result = await resendMonthlyPackage(principal, live.id);
  console.log(`Recipients AFTER resend:  ${result.recipientCount}`);

  const list = await prisma.monthlyPackageRecipient.findMany({
    where: { monthlyPackageId: live.id },
    include: { recipientUser: { select: { name: true, email: true } } },
  });
  for (const r of list) {
    console.log(
      `  - ${r.recipientUser?.name ?? "?"} <${r.recipientUser?.email ?? r.recipientEmail}> role=${r.recipientRole ?? "(none)"} status=${r.deliveryStatus} viewedAt=${r.viewedAt?.toISOString() ?? "(unviewed)"}`,
    );
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
