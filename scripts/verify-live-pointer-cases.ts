// End-to-end verification of the founder's Live Pointer acceptance
// criteria (2026-06-28).
//
// This script seeds an isolated test club, runs each of the founder's
// four cases through the REAL `publishMonthlyPackage` lifecycle, and
// reports — in plain English — exactly what status each row ended up
// at and where the Board dashboard pointer landed.
//
// Cleans up the test club at the end so no test debris remains.

import { PrismaClient } from "@prisma/client";
import {
  generateDraftMonthlyPackage,
  publishMonthlyPackage,
  getMostRecentBoardPackageForUser,
} from "../src/lib/reporting/monthly-package-lifecycle";

const VERIFY_PREFIX = "VERIFY-LP";
const TENANT_LABEL = `${VERIFY_PREFIX}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

async function main() {
  const prisma = new PrismaClient();

  // Wire up a fresh club + an admin caller + a Board user so we can
  // demo all four cases without disturbing the founder's existing
  // demo data.
  const club = await prisma.club.create({
    data: {
      name: `${TENANT_LABEL} Club`,
      slug: `${TENANT_LABEL.toLowerCase()}-club`,
    },
  });
  const adminUser = await prisma.user.create({
    data: {
      email: `${TENANT_LABEL.toLowerCase()}-admin@example.com`,
      passwordHash: "x",
      name: "Verify Admin",
      role: "CLUB_ADMIN",
    },
  });
  await prisma.userClubRole.create({
    data: { userId: adminUser.id, clubId: club.id, roleKey: "CLUB_ADMIN" },
  });
  const boardUser = await prisma.user.create({
    data: {
      email: `${TENANT_LABEL.toLowerCase()}-board@example.com`,
      passwordHash: "x",
      name: "Verify Board",
      role: "BOARD_READ_ONLY",
    },
  });
  await prisma.userClubRole.create({
    data: { userId: boardUser.id, clubId: club.id, roleKey: "BOARD_READ_ONLY" },
  });

  const adminPrincipal = {
    id: adminUser.id,
    email: adminUser.email,
    name: adminUser.name,
    status: "ACTIVE",
    memberships: [{ clubId: club.id, roleKey: "CLUB_ADMIN" as const }],
    activeClubId: club.id,
    memberId: null,
  };
  const boardPrincipal = {
    id: boardUser.id,
    email: boardUser.email,
    name: boardUser.name,
    status: "ACTIVE",
    memberships: [{ clubId: club.id, roleKey: "BOARD_READ_ONLY" as const }],
    activeClubId: club.id,
    memberId: null,
  };

  const status = async (year: number, month: number) => {
    const row = await prisma.monthlyPackage.findUnique({
      where: {
        clubId_reportingYear_reportingMonth: {
          clubId: club.id,
          reportingYear: year,
          reportingMonth: month,
        },
      },
      select: { status: true, id: true },
    });
    return row?.status ?? "—";
  };
  const tilePeriod = async () => {
    const tile = await getMostRecentBoardPackageForUser(boardPrincipal, club.id);
    return tile ? `${tile.reportingYear}-${String(tile.reportingMonth).padStart(2, "0")}` : "(none)";
  };
  const rowCount = async (year: number, month: number) => {
    return prisma.monthlyPackage.count({
      where: { clubId: club.id, reportingYear: year, reportingMonth: month },
    });
  };

  const sep = () => console.log(`${"─".repeat(72)}`);

  console.log(`\nTest club: ${club.name} (${club.id})\n`);

  // ── CASE A — first publish (May 2026) → becomes Live ────────────
  sep();
  console.log("CASE A: First publish of May 2026 (no prior Live).");
  sep();
  const { package: may } = await generateDraftMonthlyPackage(adminPrincipal, club.id, {
    reportingYear: 2026, reportingMonth: 5,
  });
  const mayRes = await publishMonthlyPackage(adminPrincipal, may.id);
  console.log(`  transition       : ${mayRes.transition}`);
  console.log(`  resultingStatus  : ${mayRes.resultingStatus}`);
  console.log(`  May 2026 status  : ${await status(2026, 5)}`);
  console.log(`  Board tile points: ${await tilePeriod()}`);

  // ── CASE B — advance Live (publish June 2026 → newer) ───────────
  sep();
  console.log("CASE B: Publish June 2026 (newer than current Live = May).");
  sep();
  const { package: jun } = await generateDraftMonthlyPackage(adminPrincipal, club.id, {
    reportingYear: 2026, reportingMonth: 6,
  });
  const junRes = await publishMonthlyPackage(adminPrincipal, jun.id);
  console.log(`  transition       : ${junRes.transition}`);
  console.log(`  resultingStatus  : ${junRes.resultingStatus}`);
  console.log(`  liveAdvanced     : ${junRes.liveAdvanced}`);
  console.log(`  May 2026 status  : ${await status(2026, 5)}  (should be ARCHIVED)`);
  console.log(`  June 2026 status : ${await status(2026, 6)}  (should be PUBLISHED)`);
  console.log(`  Board tile points: ${await tilePeriod()}  (should be 2026-06)`);

  // ── CASE C — overwrite Live (re-publish June while June IS Live)
  sep();
  console.log("CASE C: Overwrite the current Live (re-publish June 2026 in place).");
  sep();
  const junAgain = await publishMonthlyPackage(adminPrincipal, jun.id);
  console.log(`  transition       : ${junAgain.transition}  (should be OVERWRITE_LIVE)`);
  console.log(`  resultingStatus  : ${junAgain.resultingStatus}`);
  console.log(`  liveAdvanced     : ${junAgain.liveAdvanced}`);
  console.log(`  June 2026 status : ${await status(2026, 6)}  (should be PUBLISHED)`);
  console.log(`  June 2026 rows   : ${await rowCount(2026, 6)}  (should be 1 — no duplicates)`);
  console.log(`  Board tile points: ${await tilePeriod()}  (should be 2026-06)`);

  // ── CASE D — historical correction (overwrite archived May while
  //              June is Live) — the no-regress case ─────────────
  sep();
  console.log("CASE D: Overwrite the archived May 2026 (Controller fixes an old error).");
  sep();
  const mayCorrection = await publishMonthlyPackage(adminPrincipal, may.id);
  console.log(`  transition       : ${mayCorrection.transition}  (should be OVERWRITE_HISTORICAL)`);
  console.log(`  resultingStatus  : ${mayCorrection.resultingStatus}  (should be ARCHIVED)`);
  console.log(`  liveAdvanced     : ${mayCorrection.liveAdvanced}  (should be false)`);
  console.log(`  May 2026 status  : ${await status(2026, 5)}  (should stay ARCHIVED)`);
  console.log(`  June 2026 status : ${await status(2026, 6)}  (should stay PUBLISHED)`);
  console.log(`  Board tile points: ${await tilePeriod()}  (should STILL be 2026-06 — no regression)`);

  // ── CASE E — uniqueness sanity (publish same period 3 times → 1
  //             row total) ─────────────────────────────────────────
  sep();
  console.log("CASE E: Three publishes of June → still exactly 1 row.");
  sep();
  await publishMonthlyPackage(adminPrincipal, jun.id);
  await publishMonthlyPackage(adminPrincipal, jun.id);
  console.log(`  June 2026 rows   : ${await rowCount(2026, 6)}  (should be 1)`);

  // ── Cleanup ─────────────────────────────────────────────────────
  sep();
  console.log("Cleaning up test club…");
  // Recipients cascade-delete on package delete; packages cascade
  // on club delete via no explicit cascade — delete manually first.
  await prisma.monthlyPackageRecipient.deleteMany({
    where: { monthlyPackage: { clubId: club.id } },
  });
  await prisma.monthlyPackage.deleteMany({ where: { clubId: club.id } });
  await prisma.auditLog.deleteMany({ where: { clubId: club.id } });
  await prisma.userClubRole.deleteMany({ where: { clubId: club.id } });
  await prisma.user.deleteMany({ where: { email: { contains: TENANT_LABEL.toLowerCase() } } });
  await prisma.club.delete({ where: { id: club.id } });
  console.log("Done.\n");

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
