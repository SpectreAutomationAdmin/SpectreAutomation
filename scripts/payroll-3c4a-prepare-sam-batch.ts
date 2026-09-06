// Payroll-3C-4A (2026-09-09) — prepare a fresh Sam Complex batch for
// the local Playwright spec, and emit its ids as a single JSON line.
//
// Usage:
//   npx tsx scripts/payroll-3c4a-prepare-sam-batch.ts
//   → prints: {"batchId":"...","batchEmployeeId":"...","clubId":"..."}
//
// Preconditions:
//   • founder preview fixture reseeded
//   • payroll-3c1-components fixture reseeded

import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient } from "@prisma/client";
import { preparePayrollBatch } from "../src/lib/payroll/batch-preparation";

const prisma = new PrismaClient();
const RAELENE_EMAIL = "raelene.sample@preview.spectre.test";

async function buildPrincipal(email: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { email }, include: { clubRoles: true } });
  const memberships = u.clubRoles.map((r) => ({ clubId: r.clubId, roleKey: r.roleKey as string }));
  const firstScoped = memberships.find((m) => m.clubId)?.clubId ?? null;
  return {
    id: u.id, name: u.name, email: u.email, status: u.status,
    memberships, activeClubId: firstScoped, memberId: u.memberId,
  } as never;
}

async function main() {
  const club = await prisma.club.findFirstOrThrow({ where: { slug: "coulee-ridge" } });
  const pg = await prisma.payrollPayGroup.findFirstOrThrow({
    where: { clubId: club.id, code: "SAL-SM-COMPLEX" },
  });
  // Payroll-3C-3D.1 — pay periods before Sam's hireDate excluded
  // his membership, so preparing one yields an empty batch. Filter
  // for periods that begin ON or AFTER Sam's hireDate.
  const sam = await prisma.employee.findFirstOrThrow({
    where: { clubId: club.id, email: "complex.pay@preview.spectre.test" },
  });
  const hireDate = sam.hireDate!;
  const pp = await prisma.payrollPayPeriod.findFirstOrThrow({
    where: {
      clubId: club.id, payGroupId: pg.id, taxYear: 2026,
      batches: { none: {} },
      periodStart: { gte: hireDate },
    },
    orderBy: { periodStart: "asc" },
  });
  const raeleneP = await buildPrincipal(RAELENE_EMAIL);
  const prep = await preparePayrollBatch(raeleneP, club.id, pp.id);
  const be = await prisma.payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
  const line = JSON.stringify({ batchId: prep.batchId, batchEmployeeId: be.id, clubId: club.id });
  // eslint-disable-next-line no-console
  console.log(line);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
