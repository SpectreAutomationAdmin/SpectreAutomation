import { PrismaClient } from "@prisma/client";

async function main() {
  // BigInt → Number serializer for console output
  (BigInt.prototype as unknown as { toJSON: () => number }).toJSON = function () {
    return Number(this);
  };
  const p = new PrismaClient();
  const dupes: Array<{ clubId: string; reportingYear: number; reportingMonth: number; n: number }> =
    await p.$queryRawUnsafe(`
      SELECT clubId, reportingYear, reportingMonth, COUNT(*) AS n
      FROM MonthlyPackage
      GROUP BY clubId, reportingYear, reportingMonth
      HAVING COUNT(*) > 1
      ORDER BY n DESC
    `);
  console.log("Duplicates:", JSON.stringify(dupes, null, 2));
  const total = await p.monthlyPackage.count();
  console.log("Total rows:", total);
  const byStatus: Array<{ status: string; n: number }> = await p.$queryRawUnsafe(`
    SELECT status, COUNT(*) AS n FROM MonthlyPackage GROUP BY status ORDER BY n DESC
  `);
  console.log("By status:", JSON.stringify(byStatus, null, 2));
  await p.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
