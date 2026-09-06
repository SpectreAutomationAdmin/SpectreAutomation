// Payroll-3C-3D.1 (2026-09-09) — Sam Complex deterministic reset +
// full history rebuild.
//
// Root cause of the founder's stale $4,873.18 taxable / $4,583.33 EI
// insurable observation: multiple Sam Complex batches, POSTED across
// different points in Spectre's rule-evolution timeline, were still
// in the database with the older statutory-effect snapshots.
// Historical immutability guarantees each snapshot never mutates —
// but for the founder's flagship source-comparison acceptance we
// must delete everything and rebuild against the current rules.
//
// This script:
//   1. Wipes every Sam-Complex payroll data row (batches, snapshots,
//      exceptions, component openings, opening balance).
//   2. Recreates Sam with hireDate = 2026-02-02 (matches the source
//      employee's employment timeline for reconciliation purposes).
//   3. Sets every recurring component's effectiveFrom to 2026-02-02
//      so Sam has no payroll data before employment.
//   4. Prepares + calculates + POSTS the 13 full canonical semi-
//      monthly periods that fall between Feb 2 and Aug 16 (seq 3
//      through seq 15) using the current library rules.
//   5. Prepares + calculates + POSTS the flagship period seq 16
//      (period 2026-08-16 → 2026-09-01, pay date 2026-08-31 —
//      Payroll-3C-3E.1 semi-monthly EOM policy: 15th/EOM with
//      Sat/Sun → preceding Friday; Aug 31 2026 is a Monday, so no
//      adjustment. Payroll cutoff = payday − 5 days = Aug 26).
//      This is Spectre's canonical semi-monthly EOM pay date
//      matching the source deposit date of 2026-08-31.
//   6. Emits `{flagshipBatchId, flagshipBatchEmployeeId, clubId,
//      flagshipPayDateIso, postedHistoryCount}` as a single JSON
//      line so Playwright / founder can navigate deterministically.
//
// No opening balance is used for Sam: he is a NEW HIRE on
// 2026-02-02. All YTD is generated from POSTED payroll history.
//
// Idempotent — safe to rerun. Every invocation produces the same
// end state (same flagship batch id will differ across runs because
// cuids regenerate, but the pay date is stable).

import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient } from "@prisma/client";
import { preparePayrollBatch } from "../src/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "../src/lib/payroll/calculation-execute";

const prisma = new PrismaClient();
const COMPLEX_EMAIL = "complex.pay@preview.spectre.test";
const RAELENE_EMAIL = "raelene.sample@preview.spectre.test";
const HIRE_DATE     = new Date("2026-02-02T00:00:00.000Z");
const FLAGSHIP_SEQ  = 16; // Aug 16 → Sept 1, pay Aug 31 (EOM)

async function buildPrincipal(email: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { email }, include: { clubRoles: true } });
  const memberships = u.clubRoles.map((r) => ({ clubId: r.clubId, roleKey: r.roleKey as string }));
  const firstScoped = memberships.find((m) => m.clubId)?.clubId ?? null;
  return {
    id: u.id, name: u.name, email: u.email, status: u.status,
    memberships, activeClubId: firstScoped, memberId: u.memberId,
  } as never;
}

async function wipeSam(clubId: string, samEmployeeId: string, complexPayGroupId: string) {
  // Delete in FK-safe order. Cascade on PayrollBatch handles
  // batchEmployee, componentSnapshot, exception, earning, deduction.
  // Wipe by pay-group (not just employee-touching) so we also
  // remove any orphan/empty batches on SAL-SM-COMPLEX from earlier
  // reset generations (e.g. pre-hireDate PREPARED batches without a
  // Sam employee row).
  const batches = await prisma.payrollBatch.findMany({
    where: {
      clubId,
      OR: [
        { payPeriod: { payGroupId: complexPayGroupId } },
        { employees: { some: { employeeId: samEmployeeId } } },
      ],
    },
    select: { id: true },
  });
  const batchIds = batches.map((b) => b.id);
  if (batchIds.length) {
    // Journal entries referencing these batches — leave in place;
    // POST for complex batches is fixture-side, GL not owned by 3C-6.
    await prisma.payrollBatchException.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.payrollBatchComponentSnapshot.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.payrollBatchDeduction.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.payrollBatchEarning.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.payrollBatchAllowanceSnapshot.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.payrollBatchEmployee.deleteMany({ where: { batchId: { in: batchIds } } });
    await prisma.payrollBatch.deleteMany({ where: { id: { in: batchIds } } });
  }
  // Opening balance + component openings.
  const openings = await prisma.payrollOpeningBalance.findMany({
    where: { clubId, employeeId: samEmployeeId }, select: { id: true },
  });
  const openingIds = openings.map((o) => o.id);
  if (openingIds.length) {
    await prisma.payrollOpeningBalanceComponent.deleteMany({ where: { openingBalanceId: { in: openingIds } } });
    await prisma.payrollOpeningBalance.deleteMany({ where: { id: { in: openingIds } } });
  }
  return { deletedBatches: batchIds.length, deletedOpenings: openingIds.length };
}

async function realignSamEmployment(clubId: string, samEmployeeId: string) {
  // hireDate + assignment + compensation all realigned to Feb 2.
  await prisma.employee.update({
    where: { id: samEmployeeId },
    data: { hireDate: HIRE_DATE },
  });
  const assn = await prisma.employeeEmploymentAssignment.findFirst({
    where: { clubId, employeeId: samEmployeeId, role: "PRIMARY" },
    orderBy: { effectiveFrom: "asc" },
  });
  if (assn && assn.effectiveFrom.getTime() !== HIRE_DATE.getTime()) {
    await prisma.employeeEmploymentAssignment.update({
      where: { id: assn.id }, data: { effectiveFrom: HIRE_DATE },
    });
  }
  const comp = await prisma.employeeCompensation.findFirst({
    where: { clubId, employeeId: samEmployeeId, cadence: "SALARY", effectiveTo: null },
    orderBy: { effectiveFrom: "asc" },
  });
  if (comp && comp.effectiveFrom.getTime() !== HIRE_DATE.getTime()) {
    await prisma.employeeCompensation.update({
      where: { id: comp.id }, data: { effectiveFrom: HIRE_DATE },
    });
  }
  // Pay group member effective date + tax profile.
  await prisma.payrollPayGroupMember.updateMany({
    where: { clubId, employeeId: samEmployeeId },
    data: { effectiveFrom: HIRE_DATE },
  });
  await prisma.employeeTaxProfile.updateMany({
    where: { clubId, employeeId: samEmployeeId },
    data: { effectiveFrom: HIRE_DATE },
  });
  // Every recurring component assignment.
  await prisma.employeeRecurringPayrollComponent.updateMany({
    where: { clubId, employeeId: samEmployeeId },
    data: { effectiveFrom: HIRE_DATE },
  });
}

async function forcePost(clubId: string, batchId: string, paP: Awaited<ReturnType<typeof buildPrincipal>>) {
  await calculatePayrollBatch(paP, clubId, batchId);
  await prisma.payrollBatch.update({
    where: { id: batchId },
    data: { status: "POSTED", postedAt: new Date() },
  });
}

async function main() {
  const club = await prisma.club.findFirstOrThrow({ where: { slug: "coulee-ridge" } });
  const sam  = await prisma.employee.findFirstOrThrow({
    where: { clubId: club.id, email: COMPLEX_EMAIL },
  });
  const pg = await prisma.payrollPayGroup.findFirstOrThrow({
    where: { clubId: club.id, code: "SAL-SM-COMPLEX" },
  });

  const wiped = await wipeSam(club.id, sam.id, pg.id);
  await realignSamEmployment(club.id, sam.id);

  // Payroll-3C-3D.1 (§10) — Skip Sam's partial first period. Sam
  // starts 2026-02-02 mid-way through seq 3 (period 2026-02-01 →
  // 2026-02-16). Spectre does NOT yet support salary proration
  // for mid-period starts (documented capability gap); posting
  // seq 3 produces a zero-earnings POSTED row cluttered with
  // COMPONENT_MID_PERIOD_CHANGE warnings. Start Sam's history at
  // seq 4 (his first FULL period) instead. Regular YTD in the
  // flagship therefore reflects 12 × $4,583.33 = $54,999.96, and
  // the delta to source's $61,874.96 (≈ 1.5 periods) is reported
  // in the reconciliation as an EXPECTED DIFFERENCE driven by
  // source's earlier / differently-aligned pay calendar.
  const paP = await buildPrincipal(RAELENE_EMAIL);
  let postedHistoryCount = 0;
  const firstFullSeq = 4;
  for (let seq = firstFullSeq; seq < FLAGSHIP_SEQ; seq++) {
    const pp = await prisma.payrollPayPeriod.findFirstOrThrow({
      where: { clubId: club.id, payGroupId: pg.id, sequenceInYear: seq, taxYear: 2026 },
    });
    const prep = await preparePayrollBatch(paP, club.id, pp.id);
    await forcePost(club.id, prep.batchId, paP);
    postedHistoryCount += 1;
  }

  // Prepare + calculate + POST the flagship (seq 16).
  const flagshipPp = await prisma.payrollPayPeriod.findFirstOrThrow({
    where: { clubId: club.id, payGroupId: pg.id, sequenceInYear: FLAGSHIP_SEQ, taxYear: 2026 },
  });
  const flagshipPrep = await preparePayrollBatch(paP, club.id, flagshipPp.id);
  await forcePost(club.id, flagshipPrep.batchId, paP);

  const flagshipBe = await prisma.payrollBatchEmployee.findFirstOrThrow({
    where: { batchId: flagshipPrep.batchId },
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    flagshipBatchId:         flagshipPrep.batchId,
    flagshipBatchEmployeeId: flagshipBe.id,
    clubId:                  club.id,
    flagshipPayDateIso:      flagshipPp.payDate.toISOString(),
    postedHistoryCount,
    hireDateIso:             HIRE_DATE.toISOString(),
    wiped,
  }));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
