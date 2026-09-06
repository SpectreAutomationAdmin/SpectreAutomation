// Payroll-3C-4A (2026-09-09) — calculate a Sam Complex batch after
// Playwright has added its adjustments through the UI.
//
// Usage:
//   npx tsx scripts/payroll-3c4a-calculate-sam-batch.ts <batchId> <clubId>
//
// Prints: {"status":"CALCULATED"}

import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient } from "@prisma/client";
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
  const [batchId, clubId] = process.argv.slice(2);
  if (!batchId || !clubId) { console.error("usage: <batchId> <clubId>"); process.exit(2); }
  const raeleneP = await buildPrincipal(RAELENE_EMAIL);
  await calculatePayrollBatch(raeleneP, clubId, batchId);
  const b = await prisma.payrollBatch.findUniqueOrThrow({ where: { id: batchId } });
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ status: b.status }));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
