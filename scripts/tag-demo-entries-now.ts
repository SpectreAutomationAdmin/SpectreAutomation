// One-shot: tag every existing JournalEntry that isn't from a real
// import as source="DEMO". Idempotent — safe to run multiple times.
import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
async function main() {
  const before = await prisma.journalEntry.count({ where: { source: { not: "DEMO" } } });
  const importCount = await prisma.journalEntry.count({ where: { source: "IMPORT" } });
  const result = await prisma.journalEntry.updateMany({
    where: { source: { not: "IMPORT" } },
    data: { source: "DEMO" },
  });
  console.log(`Before: ${before} non-DEMO rows total, ${importCount} already tagged IMPORT.`);
  console.log(`Retagged ${result.count} rows to source="DEMO".`);
  const after = await prisma.journalEntry.count({ where: { source: "DEMO" } });
  console.log(`After: ${after} rows now tagged DEMO.`);
}
main().finally(() => prisma.$disconnect());
