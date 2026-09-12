// Payroll 3A hotfix (2026-09-11) — read-only verification that
// Chris Turcato and Lise Montsion now have a projected SALARY
// earning row for the founder's Aug 30 – Sep 12 pay period on
// staging.

import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();
const COULEE = "cmrvdeny7000144372ktmmg9c";
const FOUNDER_PP = "cmtjc2wud001bgnjugkqrdz2r";

async function main() {
  const now = new Date();
  console.log(`\n== Payroll 3A hotfix — founder-period verification @ ${now.toISOString()} ==`);

  const batches = await prisma.payrollBatch.findMany({
    where: { clubId: COULEE, payPeriodId: FOUNDER_PP, status: { not: "VOIDED" } },
    orderBy: [{ sequence: "desc" }],
    select: {
      id: true, status: true, sequence: true, preparedAt: true, createdAt: true,
      _count: { select: { employees: true, exceptions: true, earnings: true } },
    },
  });
  console.log(`\nBatches for founder-period Aug 30 – Sep 12 (non-VOIDED):`);
  for (const b of batches) {
    console.log(`  ${b.id} · seq=${b.sequence} · status=${b.status} · employees=${b._count.employees} · earnings=${b._count.earnings} · exceptions=${b._count.exceptions}`);
  }
  if (batches.length === 0) {
    console.log("  (no batch — founder period still unprepared)");
    return;
  }

  const activeBatch = batches[0];
  console.log(`\nActive batch: ${activeBatch.id} (${activeBatch.status})`);

  // Chris Turcato & Lise Montsion — their PayrollBatchEmployee rows
  // + any SALARY earning attached.
  const employees = await prisma.payrollBatchEmployee.findMany({
    where: { batchId: activeBatch.id },
    include: {
      employee: { select: { firstName: true, lastName: true, personalEmail: true } },
    },
    orderBy: [{ employee: { lastName: "asc" } }],
  });

  console.log(`\nSalaried employees in batch:`);
  for (const be of employees) {
    if (!be.salaried) continue;
    const facts = JSON.parse(be.sourceFactsJson || "{}");
    const salaryComp = (facts.compensations || []).find((c) => c.payType === "SALARY");
    const salaryEarning = await prisma.payrollBatchEarning.findFirst({
      where: { batchEmployeeId: be.id, earningType: "SALARY" },
      select: { id: true, rate: true, quantity: true, rateSource: true },
    });
    const name = `${be.employee.firstName} ${be.employee.lastName}`;
    const fullPeriod = facts.coverage?.isFullPeriod;
    const annual = salaryComp?.annualSalary;
    console.log(`  ${name}`);
    console.log(`    · fullPeriod=${fullPeriod}`);
    console.log(`    · annualSalary=${annual ?? "(none)"}`);
    console.log(`    · SALARY earning: ${salaryEarning ? `rate=${salaryEarning.rate} qty=${salaryEarning.quantity} source=${salaryEarning.rateSource}` : "(none)"}`);
  }

  // KPI-visible gross pay total.
  const allEarnings = await prisma.payrollBatchEarning.findMany({
    where: { batchId: activeBatch.id },
    select: { quantity: true, rate: true, earningType: true },
  });
  const totalDollars = allEarnings.reduce((sum, e) => sum + Number(e.quantity) * Number(e.rate), 0);
  console.log(`\nTotal projected gross (Q × R across all earnings): $${totalDollars.toFixed(2)}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
