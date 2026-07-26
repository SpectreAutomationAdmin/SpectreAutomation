import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

(async () => {
  const club = await p.club.findFirst({ where: { slug: "silver-springs" }, select: { id: true } });
  const batches = await p.importBatch.findMany({
    where: { clubId: club!.id, domain: "OPENING_TRIAL_BALANCE" },
    select: { id: true, status: true, supersededAt: true, voidedAt: true, createdAt: true },
  });
  console.log("OTB import batches:", JSON.stringify(batches, null, 2));

  // Also look at posted journal entries covering account 2017:
  const acct = await p.account.findFirst({ where: { clubId: club!.id, accountNumber: "2017" }, select: { id: true, name: true, normalBalance: true } });
  console.log("Account 2017 CoA:", acct);
  if (acct) {
    const lines = await p.journalEntryLine.findMany({
      where: {
        clubId: club!.id,
        accountId: acct.id,
        entry: { status: "POSTED", entryDate: { lte: new Date(Date.UTC(2026, 4, 31, 23, 59, 59)) } },
      },
      include: { entry: { select: { source: true, entryDate: true, description: true } } },
      take: 20,
      orderBy: [{ entry: { entryDate: "desc" } }],
    });
    console.log("Journal entries for 2017 (top 20):");
    lines.forEach((l) => console.log(`  date=${l.entry.entryDate.toISOString()} src=${l.entry.source} debit=${l.debit} credit=${l.credit} desc=${l.entry.description}`));

    // Group totals
    const agg = await p.journalEntryLine.aggregate({
      where: {
        clubId: club!.id,
        accountId: acct.id,
        entry: { status: "POSTED", entryDate: { lte: new Date(Date.UTC(2026, 4, 31, 23, 59, 59)) } },
      },
      _sum: { debit: true, credit: true },
    });
    console.log("Aggregate for 2017: debit =", agg._sum.debit?.toString(), "credit =", agg._sum.credit?.toString());
  }

  await p.$disconnect();
})();
