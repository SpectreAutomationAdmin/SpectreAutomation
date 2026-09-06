// Payroll-3C-6 (2026-09-05) — programmatic Sam Complex post-to-GL for
// the Playwright acceptance spec. Prepares, calculates, approves, and
// posts Sam's next OPEN semi-monthly period so the browser can then
// verify the resulting balanced journal.
//
// Emits a single JSON line with {batchId, batchEmployeeId,
// journalEntryId, totalDebits, totalCredits} so Playwright can
// navigate deterministically.
//
// Idempotent: if the target period already has a POSTED batch, its
// existing journal is returned.

import { loadEnvFiles } from "./_lib/load-env";
loadEnvFiles();

import { PrismaClient } from "@prisma/client";
import { preparePayrollBatch } from "../src/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "../src/lib/payroll/calculation-execute";
import { approvePayrollBatch, postPayrollBatch } from "../src/lib/payroll/approve-and-post";

const prisma = new PrismaClient();
const COMPLEX_EMAIL = "complex.pay@preview.spectre.test";
const RAELENE_EMAIL = "raelene.sample@preview.spectre.test";
const CHRIS_EMAIL   = "chris.fixture@preview.spectre.test";

async function principal(email: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { email }, include: { clubRoles: true } });
  const memberships = u.clubRoles.map((r) => ({ clubId: r.clubId, roleKey: r.roleKey as string }));
  return {
    id: u.id, name: u.name, email: u.email, status: u.status,
    memberships, activeClubId: memberships.find((m) => m.clubId)?.clubId ?? null,
    memberId: u.memberId,
  } as never;
}

async function main() {
  const club = await prisma.club.findFirstOrThrow({ where: { slug: "coulee-ridge" } });
  const pg = await prisma.payrollPayGroup.findFirstOrThrow({
    where: { clubId: club.id, code: "SAL-SM-COMPLEX" },
  });

  // Pick the earliest seq that has no POSTED batch yet. The reset
  // script posted seq 4-16; seq 17 is the next available.
  const posted = await prisma.payrollBatch.findMany({
    where: { clubId: club.id, payGroupId: pg.id, status: "POSTED" },
    include: { payPeriod: true },
  });
  const postedSeqs = new Set(posted.map((b) => b.payPeriod.sequenceInYear));
  // Pin the acceptance target to seq 17 (Sept 15 pay date) so
  // repeated runs of this script produce the same batch + the same
  // GL journal. seq 17 is Sam's first post-flagship period and
  // was seeded by scripts/payroll-3c3d1-sam-reset-history.ts.
  const nextPp = await prisma.payrollPayPeriod.findFirstOrThrow({
    where: { clubId: club.id, payGroupId: pg.id, taxYear: 2026, sequenceInYear: 17 },
  });
  void postedSeqs;

  const paP  = await principal(RAELENE_EMAIL);
  const ctlr = await principal(CHRIS_EMAIL);

  // Idempotent — if there's already a batch on this period, reuse it.
  const existing = await prisma.payrollBatch.findFirst({ where: { payPeriodId: nextPp.id } });
  let batchId: string;
  if (existing?.status === "POSTED" && existing.glJournalEntryId) {
    batchId = existing.id;
  } else if (existing) {
    // Nuke and rebuild for determinism.
    await prisma.payrollBatchException.deleteMany({ where: { batchId: existing.id } });
    await prisma.payrollBatchComponentSnapshot.deleteMany({ where: { batchId: existing.id } });
    await prisma.payrollBatchDeduction.deleteMany({ where: { batchId: existing.id } });
    await prisma.payrollBatchEarning.deleteMany({ where: { batchId: existing.id } });
    await prisma.payrollBatchAllowanceSnapshot.deleteMany({ where: { batchId: existing.id } });
    await prisma.payrollBatchEmployee.deleteMany({ where: { batchId: existing.id } });
    await prisma.payrollBatch.delete({ where: { id: existing.id } });
    const prep = await preparePayrollBatch(paP, club.id, nextPp.id);
    await calculatePayrollBatch(paP, club.id, prep.batchId);
    await approvePayrollBatch(ctlr, prep.batchId);
    const posted = await postPayrollBatch(ctlr, prep.batchId);
    batchId = posted.batch!.id;
  } else {
    const prep = await preparePayrollBatch(paP, club.id, nextPp.id);
    await calculatePayrollBatch(paP, club.id, prep.batchId);
    await approvePayrollBatch(ctlr, prep.batchId);
    const posted = await postPayrollBatch(ctlr, prep.batchId);
    batchId = posted.batch!.id;
  }

  const b = await prisma.payrollBatch.findUniqueOrThrow({ where: { id: batchId } });
  const be = await prisma.payrollBatchEmployee.findFirstOrThrow({ where: { batchId } });
  const je = await prisma.journalEntry.findUniqueOrThrow({
    where: { id: b.glJournalEntryId! },
    include: { lines: { include: { account: true }, orderBy: { lineNumber: "asc" } } },
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    clubId: club.id,
    batchId, batchEmployeeId: be.id,
    payPeriodSequence: nextPp.sequenceInYear,
    payDateIso: nextPp.payDate.toISOString(),
    journalEntryId: je.id,
    entryNumber: je.entryNumber,
    totalDebits:  je.totalDebits.toString(),
    totalCredits: je.totalCredits.toString(),
    difference:   (Number(je.totalDebits) - Number(je.totalCredits)).toFixed(2),
    lines: je.lines.map((l) => ({
      accountNumber: l.account.accountNumber, accountName: l.account.name,
      debit: l.debit.toString(), credit: l.credit.toString(),
      description: l.description,
    })),
    samEmployeeStatutory: {
      grossPay:               Number(be.grossPay).toFixed(2),
      netPay:                 Number(be.netPay).toFixed(2),
      deductionFederalTax:    Number(be.deductionFederalTax).toFixed(2),
      deductionProvincialTax: Number(be.deductionProvincialTax).toFixed(2),
      employerCppCombined:    Number(be.employerCppCombined  ?? 0).toFixed(2),
      employerEi:             Number(be.employerEi           ?? 0).toFixed(2),
    },
  }));
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
