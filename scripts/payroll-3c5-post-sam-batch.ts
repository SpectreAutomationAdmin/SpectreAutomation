// Payroll-3C-5 (2026-09-09) — force-POST a Sam Complex batch for the
// admin Payroll History Playwright test.
//
// Component batches are still POST-blocked by the 3C-6 GL guard, so
// per §51 of the brief we bypass the operational POST path here by
// flipping status/postedAt directly under a fixture-only script.
// Production posting behaviour is unaffected.
//
// Usage: npx tsx scripts/payroll-3c5-post-sam-batch.ts
// Emits: {"batchId":"...","batchEmployeeId":"...","clubId":"..."}

import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient } from "@prisma/client";
import { preparePayrollBatch } from "../src/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "../src/lib/payroll/calculation-execute";

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
  const pp = await prisma.payrollPayPeriod.findFirstOrThrow({
    where: {
      clubId: club.id, payGroupId: pg.id, taxYear: 2026,
      batches: { none: {} },
    },
    orderBy: { periodStart: "asc" },
  });
  const raelene = await buildPrincipal(RAELENE_EMAIL);
  const prep = await preparePayrollBatch(raelene, club.id, pp.id);
  await calculatePayrollBatch(raelene, club.id, prep.batchId);
  // Direct force-POST — see §51.
  await prisma.payrollBatch.update({
    where: { id: prep.batchId },
    data: { status: "POSTED", postedAt: new Date() },
  });
  const be = await prisma.payrollBatchEmployee.findFirstOrThrow({ where: { batchId: prep.batchId } });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ batchId: prep.batchId, batchEmployeeId: be.id, clubId: club.id }));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
