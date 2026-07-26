import { PrismaClient } from "@prisma/client";

async function main() {
  const p = new PrismaClient();
  const rows = await p.monthlyPackage.findMany({
    select: {
      id: true,
      reportingYear: true,
      reportingMonth: true,
      status: true,
      publishedAt: true,
      club: { select: { name: true } },
    },
    orderBy: [{ reportingYear: "desc" }, { reportingMonth: "desc" }],
  });
  console.log("MonthlyPackage rows in dev DB:");
  for (const r of rows) {
    const period = `${r.reportingYear}-${String(r.reportingMonth).padStart(2, "0")}`;
    console.log(`  ${period}  ${r.status.padEnd(10)}  ${r.club.name}  (${r.id})`);
  }
  if (rows.length === 0) console.log("  (none)");
  await p.$disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });
