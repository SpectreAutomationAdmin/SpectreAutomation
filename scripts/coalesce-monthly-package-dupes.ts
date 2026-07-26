// One-shot coalescer — collapses duplicate MonthlyPackage rows per
// (clubId, reportingYear, reportingMonth) down to ONE survivor.
//
// Background: an earlier slice's "Update Publication" flow created a
// NEW row + archived the predecessor on every same-period republish,
// which means the archive can accumulate multiple ARCHIVED rows for
// the same period. The new publication model requires exactly one
// row per period (enforced by a unique constraint in the schema),
// so this script must run BEFORE `prisma db push` is applied with
// the constraint in place.
//
// Survivor selection (per period group):
//   1. PUBLISHED beats SENT beats DRAFT beats ARCHIVED.
//   2. Tie-broken by `publishedAt DESC NULLS LAST`, then
//      `generatedAt DESC` — i.e. the freshest snapshot wins.
//
// Recipient handling:
//   • Recipients on losing rows are MERGED onto the survivor. If a
//     recipient (recipientUserId, recipientEmail) already exists on
//     the survivor, the loser's row is dropped silently — no schema
//     unique exists, but logical dedup keeps the NEW-badge / viewed
//     tracking consistent.
//   • Audit log + delivery-history rows pointing at deleted package
//     ids are untouched — the `MonthlyPackage` FK is the only
//     cascade boundary, and historical audit entries on a deleted
//     package id are accepted (they record an event that happened).
//
// Idempotent: re-running after a clean run is a no-op (no groups
// have count > 1).
//
// Scope: TOUCHES `MonthlyPackage` + `MonthlyPackageRecipient` only.
// Per CLAUDE.md operating rules, NEVER touches ledger data, member
// data, club settings, users, roles, or permissions.

import { PrismaClient } from "@prisma/client";

const STATUS_PREFERENCE: Record<string, number> = {
  PUBLISHED: 0,
  SENT: 1,
  DRAFT: 2,
  ARCHIVED: 3,
};

type PkgRow = {
  id: string;
  clubId: string;
  reportingYear: number;
  reportingMonth: number;
  status: string;
  publishedAt: Date | null;
  generatedAt: Date;
};

function pickSurvivor(rows: ReadonlyArray<PkgRow>): PkgRow {
  return [...rows].sort((a, b) => {
    const sp = (STATUS_PREFERENCE[a.status] ?? 99) - (STATUS_PREFERENCE[b.status] ?? 99);
    if (sp !== 0) return sp;
    const aPub = a.publishedAt?.getTime() ?? 0;
    const bPub = b.publishedAt?.getTime() ?? 0;
    if (aPub !== bPub) return bPub - aPub;
    return b.generatedAt.getTime() - a.generatedAt.getTime();
  })[0];
}

async function main() {
  // BigInt → Number for console.log on $queryRaw counts.
  (BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
    return Number(this);
  };
  const prisma = new PrismaClient();

  const groups: Array<{
    clubId: string;
    reportingYear: number;
    reportingMonth: number;
    n: number;
  }> = await prisma.$queryRawUnsafe(`
    SELECT clubId, reportingYear, reportingMonth, COUNT(*) AS n
    FROM MonthlyPackage
    GROUP BY clubId, reportingYear, reportingMonth
    HAVING COUNT(*) > 1
  `);

  if (groups.length === 0) {
    console.log("No duplicate periods. Nothing to coalesce.");
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${groups.length} duplicate period group(s).`);

  let totalDeleted = 0;
  let totalRecipientsMerged = 0;

  for (const g of groups) {
    const rows = await prisma.monthlyPackage.findMany({
      where: {
        clubId: g.clubId,
        reportingYear: g.reportingYear,
        reportingMonth: g.reportingMonth,
      },
      select: {
        id: true,
        clubId: true,
        reportingYear: true,
        reportingMonth: true,
        status: true,
        publishedAt: true,
        generatedAt: true,
      },
    });
    const survivor = pickSurvivor(rows);
    const losers = rows.filter((r) => r.id !== survivor.id);
    const periodLabel = `${g.clubId.slice(0, 8)}…/${g.reportingYear}-${String(g.reportingMonth).padStart(2, "0")}`;
    console.log(
      `  ${periodLabel}: ${rows.length} rows → keep ${survivor.id.slice(0, 8)}… (${survivor.status}), delete ${losers.length}`,
    );

    for (const loser of losers) {
      // Existing survivor recipients keyed by (userId|email) so we
      // can detect merge collisions logically.
      const survivorRecipients = await prisma.monthlyPackageRecipient.findMany({
        where: { monthlyPackageId: survivor.id },
        select: { recipientUserId: true, recipientEmail: true },
      });
      const survivorKeys = new Set(
        survivorRecipients.map(
          (r) => `${r.recipientUserId ?? ""}::${r.recipientEmail ?? ""}`,
        ),
      );
      const loserRecipients = await prisma.monthlyPackageRecipient.findMany({
        where: { monthlyPackageId: loser.id },
      });
      for (const lr of loserRecipients) {
        const key = `${lr.recipientUserId ?? ""}::${lr.recipientEmail ?? ""}`;
        if (survivorKeys.has(key)) continue; // dedup → drop
        await prisma.monthlyPackageRecipient.update({
          where: { id: lr.id },
          data: { monthlyPackageId: survivor.id },
        });
        totalRecipientsMerged++;
      }
      // The cascade on MonthlyPackageRecipient.monthlyPackage drops
      // any remaining loser recipients when the loser package is
      // deleted below.
      await prisma.monthlyPackage.delete({ where: { id: loser.id } });
      totalDeleted++;
    }
  }

  console.log(
    `Done. Deleted ${totalDeleted} duplicate package row(s); merged ${totalRecipientsMerged} recipient row(s).`,
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
