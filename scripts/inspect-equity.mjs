import { PrismaClient } from '@prisma/client';
const p = new PrismaClient();
const c = await p.club.findFirst({ where: { name: { contains: "Silver Springs" } } });
console.log("Club:", c?.id, c?.name);
const fys = await p.fiscalYear.findMany({ where: { clubId: c.id }, orderBy: { startDate: 'asc' } });
for (const f of fys) {
  console.log(f.label, "start=", f.startDate.toISOString().slice(0,10), "end=", f.endDate.toISOString().slice(0,10), "status=", f.status, "closingEquity=", f.closingEquity?.toString() ?? "null");
}
const pr = await p.clubProfile.findUnique({ where: { clubId: c.id } });
console.log("Profile: best=", pr?.equityBenchmarkBestCagrBps, "min=", pr?.equityBenchmarkMinCagrBps);
await p.$disconnect();
