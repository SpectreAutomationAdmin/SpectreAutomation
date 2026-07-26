// Quick check: does June 2026 have a full packagePayloadJson
// snapshot stored? If not, the board view falls back to the
// "snapshot not available" message and we need to overwrite-
// publish June to capture one.

import { PrismaClient } from "@prisma/client";

async function main() {
  const prisma = new PrismaClient();
  const june = await prisma.monthlyPackage.findFirst({
    where: { reportingYear: 2026, reportingMonth: 6 },
    select: {
      id: true,
      status: true,
      atAGlanceKpisJson: true,
      executiveOpeningSnapshotJson: true,
      packagePayloadJson: true,
    },
  });
  if (!june) {
    console.log("No June 2026 package row.");
    await prisma.$disconnect();
    return;
  }
  console.log(`June 2026 package: ${june.id}`);
  console.log(`  status                     : ${june.status}`);
  console.log(`  atAGlanceKpisJson          : ${june.atAGlanceKpisJson ? `${june.atAGlanceKpisJson.length} chars` : "(null)"}`);
  console.log(`  executiveOpeningSnapshotJson: ${june.executiveOpeningSnapshotJson ? `${june.executiveOpeningSnapshotJson.length} chars` : "(null)"}`);
  console.log(`  packagePayloadJson         : ${june.packagePayloadJson ? `${june.packagePayloadJson.length} chars` : "(null)"}`);
  await prisma.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
