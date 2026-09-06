// Payroll MVP posting (2026-09-05) — helper for local Playwright.
//
// Drives the Payroll Preparation + Calculation service layer for
// the Founder Preview pay period so the Playwright spec can start
// from the "batch is CALCULATED" state and exercise the browser
// path from Mission Control → Approve → Post → GL → Paystubs.
//
// Local-only. Never runs against staging or production.

// Load .env.local / .env FIRST so this helper uses the same KMS
// provider as the dev server (see scripts/_lib/load-env.ts).
import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient } from "@prisma/client";
import { preparePayrollBatch } from "../src/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "../src/lib/payroll/calculation-execute";

const prisma = new PrismaClient();

async function principalFor(email: string) {
  const u = await prisma.user.findUnique({
    where: { email }, include: { clubRoles: true },
  });
  if (!u) throw new Error(`User missing: ${email}`);
  return {
    id: u.id, email: u.email, name: u.name,
    clubId: u.clubId, role: u.role,
    memberships: u.clubRoles.map((r) => ({ clubId: r.clubId, roleKey: r.roleKey })),
  } as never;
}

async function main() {
  const club = await prisma.club.findFirstOrThrow({ where: { slug: "coulee-ridge" } });
  const payGroup = await prisma.payrollPayGroup.findFirstOrThrow({
    where: { clubId: club.id, code: "SAL-SM" },
  });
  const payPeriod = await prisma.payrollPayPeriod.findFirstOrThrow({
    where: { clubId: club.id, payGroupId: payGroup.id, taxYear: 2026, sequenceInYear: 17 },
  });

  // Idempotency — clear any prior batch for this pay period.
  await prisma.payrollBatch.deleteMany({
    where: { clubId: club.id, payPeriodId: payPeriod.id },
  });

  const raeleneP = await principalFor("raelene.sample@preview.spectre.test");

  const prep = await preparePayrollBatch(raeleneP, club.id, payPeriod.id);
  const calc = await calculatePayrollBatch(raeleneP, club.id, prep.batchId);

  const result = {
    batchId: prep.batchId,
    status: calc.lifecycleStatus,
    persisted: calc.persisted,
    blockers: (calc.blockers ?? []).slice(0, 5).map((b) => ({ code: b.code, message: b.message, employeeId: b.employeeId })),
  };
  console.log(JSON.stringify(result));
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(async () => { await prisma.$disconnect(); });
