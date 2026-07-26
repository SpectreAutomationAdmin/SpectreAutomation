// One-shot cleanup of the legacy isHeader flag across every
// club in the dev DB.
//
// Founder spec 2026-07-08: the legacy header concept is gone;
// every existing isHeader=true account is converted to a normal
// posting account so the redesigned Finance → Chart of Accounts
// page renders them under their Category / FS Group like every
// other account.
//
// Idempotent — re-runs are a no-op once the dev DB is clean.

import { PrismaClient } from "@prisma/client";
import { clearLegacyHeaderFlags } from "../src/lib/accounting/coa";

async function main() {
  const prisma = new PrismaClient();
  const clubs = await prisma.club.findMany({ select: { id: true, name: true } });
  console.log(`Scanning ${clubs.length} club(s) for legacy header accounts…\n`);
  let totalConverted = 0;
  for (const c of clubs) {
    const before = await prisma.account.count({
      where: { clubId: c.id, isHeader: true },
    });
    const converted = await clearLegacyHeaderFlags(c.id);
    totalConverted += converted;
    console.log(`  ${c.name.padEnd(40)} ${before} legacy header(s) → ${converted} converted to posting accounts`);
  }
  console.log(`\nDone. ${totalConverted} legacy header account(s) converted across ${clubs.length} club(s).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
