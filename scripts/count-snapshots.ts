import { PrismaClient } from "@prisma/client";
const p = new PrismaClient();

(async () => {
  const club = await p.club.findFirst({ where: { slug: "silver-springs" }, select: { id: true } });
  console.log("club:", club?.id);

  const counts = await p.reportingLedgerSnapshot.groupBy({
    by: ["entityKind", "batchState"],
    where: { clubId: club!.id },
    _count: true,
  });
  console.log("snapshot counts by (entityKind, batchState):", JSON.stringify(counts, null, 2));

  const tbs = await p.reportingLedgerSnapshot.findMany({
    where: { clubId: club!.id, entityKind: { in: ["trial-balance", "balance-sheet"] } },
    orderBy: [{ asOf: "desc" }],
    take: 10,
    select: { entityKind: true, asOf: true, batchState: true, dataSource: true, snapshotId: true, sourceSystem: true },
  });
  console.log("all TB/BS snapshots (top 10):", JSON.stringify(tbs, null, 2));

  // Also check TrialBalance/BalanceSheet as separate models if they exist.
  // Also, check Account for the CoA classification.
  const acct = await p.account.findFirst({
    where: { clubId: club!.id, accountNumber: "2017" },
    select: { accountNumber: true, name: true, type: true, normalBalance: true },
  });
  console.log("CoA 2017 (name/type/normalBalance):", acct);

  await p.$disconnect();
})();
