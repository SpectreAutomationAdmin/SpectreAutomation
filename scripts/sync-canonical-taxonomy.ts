// One-shot migration to Spectre's canonical accounting taxonomy
// (founder rule 2026-07-19):
//   • Upserts every canonical Category + FS Group.
//   • Re-points every Account on this club whose Category or FS
//     Group is on the legacy maps.
//   • Removes legacy Category + FS Group rows once no Account
//     references them.
//
// Idempotent — safe to re-run.

import { PrismaClient } from "@prisma/client";
import { syncCanonicalAccountingTaxonomy } from "../src/lib/accounting/coa";

async function main() {
  const prisma = new PrismaClient();
  const clubs = await prisma.club.findMany({ select: { id: true, name: true } });
  console.log(`Migrating ${clubs.length} club(s) to the canonical accounting taxonomy…\n`);
  for (const c of clubs) {
    const r = await syncCanonicalAccountingTaxonomy(c.id);
    console.log(`  ${c.name.padEnd(40)}`);
    console.log(`    categories upserted     : ${r.categoriesUpserted}`);
    console.log(`    fs groups upserted      : ${r.fsGroupsUpserted}`);
    console.log(`    accounts retargeted     : ${r.accountsRetargeted}`);
    console.log(`    legacy fs groups removed: ${r.legacyFsGroupsRemoved}`);
    console.log(`    legacy categories removed: ${r.legacyCategoriesRemoved}`);
  }
  console.log("\nDone.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
