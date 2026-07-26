// Dev-only cleanup for Monthly Reporting Package publication data.
//
// Run with:
//   npm run dev:reset-monthly-packages
// or
//   npx tsx scripts/dev-reset-monthly-packages.ts
//
// Wipes (FOR THE CURRENT TEST CLUB ONLY):
//   • MonthlyPackageRecipient — board recipient roster + per-user
//     NEW-banner / viewedAt tracking. Cascade-deletes when the
//     parent MonthlyPackage is removed, but we delete explicitly
//     so the printed counts are accurate.
//   • MonthlyPackage — all DRAFT / PUBLISHED / SENT / ARCHIVED rows
//     for the club. This is the storage that backs the launcher's
//     archive, the board dashboard tile, and the NEW badge state.
//
// Notification + view tracking: there is NO separate "Board
// dashboard notification" table in this codebase. The board
// dashboard tile is computed live from the most-recent
// PUBLISHED/SENT MonthlyPackage for the club; the NEW banner is
// derived from MonthlyPackageRecipient.viewedAt. Removing both
// tables above is therefore equivalent to "no tile, no NEW badge".
//
// ── EXPLICIT SAFETY GUARDS ──────────────────────────────────────
// • Refuses to run when NODE_ENV === "production".
// • Refuses to run when DATABASE_URL contains "amazonaws", "rds",
//   "supabase", "neon", or any other hosted-DB hostname signature
//   (defence in depth — local sqlite paths slip through).
// • Operates ONLY on the test club resolved by slug. The slug is
//   either:
//     1. The first CLI argument (e.g. `... silver-springs`)
//     2. The CLUB_SLUG env var
//     3. The default "silver-springs" (the local seed club)
//   Other clubs in the same DB are untouched.
// • Does NOT touch: ledger / accounts / journal entries / member
//   data / club settings / user accounts / roles / permissions /
//   audit log / any unrelated tables.
// • Runs both deletes inside a single $transaction so a partial
//   failure rolls back cleanly.

import { prisma } from "../src/lib/prisma";

const HOSTED_DB_SIGNATURES = [
  "amazonaws",
  "rds.amazonaws",
  "supabase",
  "neon.tech",
  "neon.io",
  "planetscale",
  "cockroachlabs",
  "azure.com",
  "gcp.cloud",
];

function refuseInProduction(): void {
  if (process.env.NODE_ENV === "production") {
    console.error(
      "Refusing to run: NODE_ENV=production. This script is dev-only.",
    );
    process.exit(2);
  }
  const url = process.env.DATABASE_URL ?? "";
  for (const sig of HOSTED_DB_SIGNATURES) {
    if (url.toLowerCase().includes(sig)) {
      console.error(
        `Refusing to run: DATABASE_URL looks like a hosted DB (matched "${sig}"). This script is dev-only.`,
      );
      process.exit(2);
    }
  }
}

function resolveClubSlug(): string {
  const fromArg = process.argv[2];
  if (fromArg) return fromArg;
  if (process.env.CLUB_SLUG) return process.env.CLUB_SLUG;
  return "silver-springs";
}

async function main() {
  refuseInProduction();

  const slug = resolveClubSlug();
  console.log(`\n→ Dev cleanup — Monthly Reporting Package publication data`);
  console.log(`  Club slug: "${slug}"`);
  console.log(`  Database:  ${process.env.DATABASE_URL ?? "(no DATABASE_URL)"}`);
  console.log(`  Mode:      ${process.env.NODE_ENV ?? "(unset; assumed dev)"}`);

  const club = await prisma.club.findFirst({
    where: { slug },
    select: { id: true, name: true },
  });
  if (!club) {
    console.error(`\n  ✗ No club found with slug "${slug}". Nothing to do.`);
    process.exit(1);
  }
  console.log(`  Target:    ${club.name} (id ${club.id})\n`);

  // Pre-count for the summary.
  const [recipBefore, pkgBefore] = await Promise.all([
    prisma.monthlyPackageRecipient.count({
      where: { monthlyPackage: { clubId: club.id } },
    }),
    prisma.monthlyPackage.count({ where: { clubId: club.id } }),
  ]);

  // Per-status breakdown (just for the printed summary so the
  // operator can see exactly what got removed).
  const byStatus = await prisma.monthlyPackage.groupBy({
    by: ["status"],
    where: { clubId: club.id },
    _count: { _all: true },
  });
  const statusSummary = Object.fromEntries(
    byStatus.map((s) => [s.status, s._count._all]),
  );

  if (pkgBefore === 0 && recipBefore === 0) {
    console.log("  Nothing to clean — both tables are already empty for this club.\n");
    await prisma.$disconnect();
    return;
  }

  // Wipe inside a single transaction. Recipients first (explicit
  // delete so counts surface; schema cascade would handle it too
  // if we deleted only packages).
  const [{ count: recipDeleted }, { count: pkgDeleted }] =
    await prisma.$transaction([
      prisma.monthlyPackageRecipient.deleteMany({
        where: { monthlyPackage: { clubId: club.id } },
      }),
      prisma.monthlyPackage.deleteMany({ where: { clubId: club.id } }),
    ]);

  console.log("  Deleted:");
  console.log(`    MonthlyPackageRecipient   ${recipDeleted}`);
  console.log(`    MonthlyPackage            ${pkgDeleted}`);
  if (Object.keys(statusSummary).length > 0) {
    console.log(`      (by status: ${Object.entries(statusSummary).map(([s, n]) => `${s}=${n}`).join(", ")})`);
  }
  console.log("\n  Untouched (safety guard):");
  console.log("    Ledger / accounts / journal entries");
  console.log("    Member data");
  console.log("    Club settings (incl. fiscal year end)");
  console.log("    Users / roles / permissions");
  console.log("    Audit log");
  console.log("    Any other club's MonthlyPackage rows\n");

  // Sanity post-check.
  const [recipAfter, pkgAfter] = await Promise.all([
    prisma.monthlyPackageRecipient.count({
      where: { monthlyPackage: { clubId: club.id } },
    }),
    prisma.monthlyPackage.count({ where: { clubId: club.id } }),
  ]);
  console.log(
    `  Verified:  MonthlyPackage=${pkgAfter}, MonthlyPackageRecipient=${recipAfter} for "${slug}"`,
  );
  console.log(`\n  Done. The launcher's Archive is now empty for this club.`);
  console.log(`  Board dashboard will show no Monthly Package tile until you publish a fresh one.\n`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("\n  ✗ Cleanup failed:", err);
  await prisma.$disconnect();
  process.exit(1);
});
