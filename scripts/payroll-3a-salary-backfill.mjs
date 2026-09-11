// Payroll 3A hotfix (2026-09-11) — SALARY earning backfill for
// DRAFT/PREPARED/CALCULATED batches created BEFORE v360 (i.e.
// before Prepare started projecting SALARY earnings).
//
// Idempotent by construction: skips a (batch, batchEmployee) pair
// when a SALARY earning already exists. Preserves the v360
// semantics exactly:
//   • Only for salaried && sourceFacts.coverage.isFullPeriod.
//   • rate = annualSalary / periodsPerYear (Decimal, no rounding).
//   • rateSource = "SALARY_PROJECTION".
//
// Non-destructive: never modifies an existing earning row, never
// changes batch status, never touches employee data. Only inserts
// a projected SALARY row where the projection is legitimately
// derivable from frozen source facts.

import { PrismaClient } from "@prisma/client";
import Decimal from "decimal.js";

const prisma = new PrismaClient();

async function main() {
  const now = new Date();
  console.log(`\n== Payroll 3A hotfix — SALARY earning backfill @ ${now.toISOString()} ==`);

  const batches = await prisma.payrollBatch.findMany({
    where: { status: { in: ["DRAFT", "PREPARED", "CALCULATED"] } },
    select: {
      id: true, clubId: true, payGroupId: true, payPeriodId: true, status: true, sequence: true,
      payPeriod: { select: { periodStart: true, periodEnd: true, payDate: true, taxYear: true } },
    },
    orderBy: [{ createdAt: "asc" }],
  });
  console.log(`Found ${batches.length} candidate batches (DRAFT / PREPARED / CALCULATED).`);

  let writes = 0;
  let skipped = 0;
  let ineligible = 0;

  for (const b of batches) {
    const salariedEmployees = await prisma.payrollBatchEmployee.findMany({
      where: { batchId: b.id, salaried: true },
      select: { id: true, employeeId: true, sourceFactsJson: true, status: true },
    });
    if (salariedEmployees.length === 0) continue;

    const periodsPerYear = await prisma.payrollPayPeriod.count({
      where: { clubId: b.clubId, payGroupId: b.payGroupId, taxYear: b.payPeriod.taxYear },
    });
    if (!periodsPerYear || periodsPerYear <= 0) {
      console.log(`  Batch ${b.id}: no periods in taxYear ${b.payPeriod.taxYear}; skip.`);
      continue;
    }

    for (const be of salariedEmployees) {
      const existing = await prisma.payrollBatchEarning.count({
        where: { batchEmployeeId: be.id, earningType: "SALARY" },
      });
      if (existing > 0) { skipped++; continue; }

      let facts;
      try { facts = JSON.parse(be.sourceFactsJson || "{}"); }
      catch { console.log(`  ${be.id}: sourceFactsJson unparseable; skip`); continue; }

      if (!facts.coverage || facts.coverage.isFullPeriod !== true) { ineligible++; continue; }

      const salaryComp = (facts.compensations || []).find((c) => c.payType === "SALARY" && c.annualSalary != null);
      if (!salaryComp) { ineligible++; continue; }

      const annual = new Decimal(salaryComp.annualSalary);
      const rate = annual.div(periodsPerYear);

      await prisma.payrollBatchEarning.create({
        data: {
          clubId: b.clubId,
          batchId: b.id,
          batchEmployeeId: be.id,
          employeeId: be.employeeId,
          earningType: "SALARY",
          rateSource: "SALARY_PROJECTION",
          quantity: "1",
          rate: rate.toString(),
          description: "Salary (annual / P) — backfilled (v360)",
        },
      });
      writes++;
      console.log(`  Batch ${b.id} status=${b.status} · be=${be.id} · rate=${rate.toString()} (annual=${annual.toString()} / P=${periodsPerYear})`);
    }
  }

  console.log(`\n== Summary ==`);
  console.log(`  SALARY rows written:              ${writes}`);
  console.log(`  Already-had-row (idempotent skip): ${skipped}`);
  console.log(`  Ineligible (non-full-period or no SALARY comp): ${ineligible}`);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
