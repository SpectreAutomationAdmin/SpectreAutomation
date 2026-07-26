import { db } from "../tests/util/db";
async function main() {
  const groups = await db().financialStatementGroup.findMany({
    where: { key: "BS_LONG_TERM_LIABILITIES" },
    select: { clubId: true, key: true, name: true },
  });
  console.log(`BS_LONG_TERM_LIABILITIES exists on ${groups.length} clubs:`);
  for (const g of groups) console.log(`  • ${g.clubId.slice(0,8)} → ${g.name}`);
}
main();
