// One-shot dev / ops cleanup: run normalizeLivePointer for every club
// that has at least one non-DRAFT MonthlyPackage row. Use after a
// schema migration or when the DB drifted out of sync.
//
// Per CLAUDE.md operating rules: only touches MonthlyPackage status
// fields. NEVER touches ledger, members, club settings, users,
// roles, or permissions.

import { PrismaClient } from "@prisma/client";
import { normalizeLivePointer } from "../src/lib/reporting/monthly-package-lifecycle";

async function main() {
  const prisma = new PrismaClient();
  const clubs = await prisma.monthlyPackage.findMany({
    where: { status: { in: ["PUBLISHED", "SENT", "ARCHIVED"] } },
    distinct: ["clubId"],
    select: { clubId: true, club: { select: { name: true } } },
  });
  if (clubs.length === 0) {
    console.log("No clubs with non-DRAFT MonthlyPackage rows. Nothing to do.");
    await prisma.$disconnect();
    return;
  }
  for (const c of clubs) {
    const before = await prisma.monthlyPackage.findMany({
      where: { clubId: c.clubId, status: { in: ["PUBLISHED", "SENT", "ARCHIVED"] } },
      orderBy: [{ reportingYear: "desc" }, { reportingMonth: "desc" }],
      select: { reportingYear: true, reportingMonth: true, status: true },
    });
    const norm = await normalizeLivePointer(c.clubId);
    const after = await prisma.monthlyPackage.findMany({
      where: { clubId: c.clubId, status: { in: ["PUBLISHED", "SENT", "ARCHIVED"] } },
      orderBy: [{ reportingYear: "desc" }, { reportingMonth: "desc" }],
      select: { reportingYear: true, reportingMonth: true, status: true },
    });
    const fmt = (rows: typeof before) =>
      rows
        .map(
          (r) =>
            `${r.reportingYear}-${String(r.reportingMonth).padStart(2, "0")} ${r.status}`,
        )
        .join("  ");
    const changed = norm.promotedId !== null || norm.demotedIds.length > 0;
    console.log(`Club ${c.club.name} (${c.clubId.slice(0, 8)}…)`);
    console.log(`  Before : ${fmt(before)}`);
    console.log(`  After  : ${fmt(after)}`);
    console.log(`  Action : ${changed ? `promoted=${norm.promotedId ?? "-"}, demoted=${norm.demotedIds.length}` : "no change (already consistent)"}`);
    console.log("");
  }
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
