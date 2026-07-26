// One-shot taxonomy migration for the FS Group split (founder
// rule 2026-07-18):
//   • rename "Other Operating Expenses" → "Other Expenses" on
//     every existing club (key IS_OPEX_OTHER preserved so no
//     account-level mapping needs to change).
//   • add the two new dedicated tax buckets if missing
//     (IS_OPEX_INCOME_TAX + IS_OPEX_PROPERTY_TAX).
//
// Idempotent — safe to re-run.

import { PrismaClient } from "@prisma/client";
import { syncFsGroupTaxonomy } from "../src/lib/accounting/coa";

async function main() {
  const prisma = new PrismaClient();
  const clubs = await prisma.club.findMany({ select: { id: true, name: true } });
  console.log(`Scanning ${clubs.length} club(s) for FS Group taxonomy updates…\n`);
  for (const c of clubs) {
    const result = await syncFsGroupTaxonomy(c.id);
    const parts: string[] = [];
    if (result.renamedOther) parts.push('renamed Other Operating Expenses → Other Expenses');
    if (result.addedIncomeTax) parts.push('added Income Tax Expense');
    if (result.addedPropertyTax) parts.push('added Property Tax Expense');
    const summary = parts.length === 0 ? "already up to date" : parts.join(", ");
    console.log(`  ${c.name.padEnd(40)} ${summary}`);
  }
  console.log("\nDone.");
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
