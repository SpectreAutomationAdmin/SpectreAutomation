// FPP-9B (2026-09-22) — Founder-mandated Reverse & Correct acceptance pipeline.
//
// Executes the FPP-9B acceptance walkthrough on staging so the founder
// does NOT have to. Runs against Coulee Ridge with strict guards
// protecting the founder batch, Chris's Sep-15 batch, and the accepted
// FPP-9A synthetic acceptance chain.
//
// Chain proven:
//   ORIGINAL (STANDARD, POSTED with intentional error)
//     → REVERSAL (POSTED)
//     → CORRECTION (POSTED with corrected input)
//
// Original + Reversal + Correction = Correction.
//
// GATED SIX WAYS (mirrors fpp9a-acceptance):
//   1. `FPP9B_ACCEPTANCE_ENABLED=1` env var must be set.
//   2. Caller must be authenticated.
//   3. Caller must be Marc (PA) or Chris (Controller) on Coulee Ridge.
//   4. Target club must be Coulee Ridge (slug `spectre-staging-platform`).
//   5. Target pay period must belong to Coulee Ridge + CRGCC-SM.
//   6. Refuses to touch the founder batch or Chris Sep-15 batch or any
//      FPP-9A accepted evidence chain.
//
// Stages (query param `stage=`):
//   baseline-error    → create the intentionally-wrong POSTED baseline
//   initiate          → initiate Reverse & Correct (reversal + correction pair)
//   post-reversal     → approve + post the reversal
//   patch-correction  → apply the input patch on the correction ($110,880 → $115,200)
//   calc-correction   → recalculate the correction with the patched input
//   post-correction   → approve + post the correction
//   full              → all of the above end-to-end + idempotency retry

import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentPrincipal } from "@/lib/services/principal";
import { preparePayrollBatch } from "@/lib/payroll/batch-preparation";
import { calculatePayrollBatch } from "@/lib/payroll/calculation-execute";
import { attestBatchReview } from "@/lib/payroll/batch-review";
import { submitPayrollBatch } from "@/lib/payroll/submit-payroll-batch";
import { approvePayrollBatch, postPayrollBatch } from "@/lib/payroll/approve-and-post";
import { initiateReverseAndCorrect, patchCorrectionEmployeeInputs } from "@/lib/payroll/correction";
import { loadPrincipalByEmail } from "@/lib/services/principal-by-email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COULEE_SLUG = "spectre-staging-platform";
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const CRGCC_SM_PAYGROUP_ID = "cmu5kg3e40002h4iupsaxezdl";
const MARC_PA_EMAIL = "c.s.turcato@gmail.com";
const MARC_EMPLOYEE_ID = "cmu0ndf4p001vk9md2ntmo2ck";
const CHRIS_CONTROLLER_EMAIL = "cturcato@spectreautomation.com";
// Untouchables — reject stage=baseline-error if the target period happens to
// coincide with any of these accepted evidence chains.
const UNTOUCHABLE_BATCH_IDS = new Set([
  "cmual2acx002tegdvxrr4lrzo",  // founder batch
  "cmtzxy7f30006rm2s31rcv8rp",  // Chris Sep-15
  "cmuc2vb6t000gxhie8tkqtqkd",  // FPP-9A.1 accepted synthetic baseline
  "cmuc2vgyo002kxhiezxzzsv9s",  // FPP-9A.1 accepted synthetic reversal
]);

function refuse(msg: string, status = 403) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}
function d(x: Prisma.Decimal | number | string | null | undefined): string {
  if (x == null) return "0.00";
  if (typeof x === "string") return new Prisma.Decimal(x).toFixed(2);
  if (typeof x === "number") return new Prisma.Decimal(x).toFixed(2);
  return x.toFixed(2);
}

async function loadJournalLines(journalEntryId: string) {
  const je = await prisma.journalEntry.findUnique({
    where: { id: journalEntryId },
    select: { id: true, entryNumber: true, status: true, entryDate: true,
      totalDebits: true, totalCredits: true, memo: true },
  });
  if (!je) return null;
  const lines = await prisma.journalEntryLine.findMany({
    where: { journalEntryId },
    orderBy: { lineNumber: "asc" },
    select: { lineNumber: true, debit: true, credit: true,
      account: { select: { accountNumber: true, name: true } } },
  });
  return {
    id: je.id, entryNumber: je.entryNumber, status: je.status, entryDate: je.entryDate,
    memo: je.memo, totalDebits: d(je.totalDebits), totalCredits: d(je.totalCredits),
    lines: lines.map(l => ({
      lineNumber: l.lineNumber,
      account: `${l.account.accountNumber} · ${l.account.name}`,
      debit: d(l.debit), credit: d(l.credit),
    })),
  };
}

async function ytdForEmployee(clubId: string, employeeId: string, taxYear: number) {
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT b."transactionType", b.status, b."postedAt", b.id AS "batchId",
            be."grossPay", be."netPay", be."deductionCppEeCombined", be."deductionEiEe",
            be."deductionFederalTax", be."deductionProvincialTax",
            be."employerCppCombined", be."employerEi"
       FROM "PayrollBatchEmployee" be
       JOIN "PayrollBatch" b ON b.id = be."batchId"
       JOIN "PayrollPayPeriod" pp ON pp.id = b."payPeriodId"
      WHERE be."employeeId" = $1 AND be."clubId" = $2
        AND b.status = 'POSTED' AND pp."taxYear" = $3`,
    employeeId, clubId, taxYear,
  );
  let gross = new Prisma.Decimal(0), net = new Prisma.Decimal(0);
  let cppEE = new Prisma.Decimal(0), eiEE = new Prisma.Decimal(0);
  let fedTax = new Prisma.Decimal(0), provTax = new Prisma.Decimal(0);
  let cppER = new Prisma.Decimal(0), eiER = new Prisma.Decimal(0);
  for (const r of rows) {
    gross = gross.plus(r.grossPay ?? 0);
    net = net.plus(r.netPay ?? 0);
    cppEE = cppEE.plus(r.deductionCppEeCombined ?? 0);
    eiEE = eiEE.plus(r.deductionEiEe ?? 0);
    fedTax = fedTax.plus(r.deductionFederalTax ?? 0);
    provTax = provTax.plus(r.deductionProvincialTax ?? 0);
    cppER = cppER.plus(r.employerCppCombined ?? 0);
    eiER = eiER.plus(r.employerEi ?? 0);
  }
  return {
    postedBatchCount: rows.length,
    contributingBatches: rows.map(r => ({
      batchId: r.batchId, transactionType: r.transactionType,
      postedAt: r.postedAt, gross: d(r.grossPay), net: d(r.netPay),
    })),
    gross: d(gross), net: d(net),
    cppEE: d(cppEE), eiEE: d(eiEE), fedTax: d(fedTax), provTax: d(provTax),
    cppER: d(cppER), eiER: d(eiER),
  };
}

async function snapshotUntouchables() {
  const founder = await prisma.payrollBatch.findUnique({
    where: { id: "cmual2acx002tegdvxrr4lrzo" },
    select: { id: true, status: true, transactionType: true, glJournalEntryId: true, packageChecksum: true },
  });
  const chrisSep15 = await prisma.payrollBatch.findUnique({
    where: { id: "cmtzxy7f30006rm2s31rcv8rp" },
    select: { id: true, status: true, transactionType: true, glJournalEntryId: true, packageChecksum: true },
  });
  const fpp9a1Baseline = await prisma.payrollBatch.findUnique({
    where: { id: "cmuc2vb6t000gxhie8tkqtqkd" },
    select: { id: true, status: true, transactionType: true, glJournalEntryId: true, packageChecksum: true },
  });
  const fpp9a1Reversal = await prisma.payrollBatch.findUnique({
    where: { id: "cmuc2vgyo002kxhiezxzzsv9s" },
    select: { id: true, status: true, transactionType: true, glJournalEntryId: true, packageChecksum: true },
  });
  return { founder, chrisSep15, fpp9a1Baseline, fpp9a1Reversal };
}

export async function POST(req: NextRequest) {
  const evidence: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    guards: {},
    baseline: {},
    reversal: {},
    correction: {},
    gl: {},
    ytd: {},
    idempotency: {},
    integrity: {},
  };

  try {
    if (process.env.FPP9B_ACCEPTANCE_ENABLED !== "1") {
      return refuse("Endpoint disabled (FPP9B_ACCEPTANCE_ENABLED != 1).");
    }
    const caller = await getCurrentPrincipal();
    if (!caller) return refuse("Unauthenticated.", 401);
    if (caller.email !== MARC_PA_EMAIL && caller.email !== CHRIS_CONTROLLER_EMAIL) {
      return refuse(`Only ${MARC_PA_EMAIL} or ${CHRIS_CONTROLLER_EMAIL} may invoke this endpoint.`);
    }
    const club = await prisma.club.findFirst({ where: { slug: COULEE_SLUG } });
    if (!club || club.id !== COULEE_CLUB_ID) {
      return refuse("Refusing: target club must be Coulee Ridge.");
    }
    const url = new URL(req.url);
    const targetPeriodId = url.searchParams.get("periodId");
    if (!targetPeriodId) return refuse("Missing periodId query param.", 400);
    const stage = (url.searchParams.get("stage") ?? "full").toLowerCase();
    const validStages = new Set(["baseline-error", "initiate", "post-reversal", "patch-correction", "calc-correction", "post-correction", "full"]);
    if (!validStages.has(stage)) return refuse(`Invalid stage: ${stage}`, 400);
    (evidence.guards as Record<string, unknown>).stage = stage;

    const period = await prisma.payrollPayPeriod.findFirst({
      where: { id: targetPeriodId, clubId: COULEE_CLUB_ID, payGroupId: CRGCC_SM_PAYGROUP_ID },
      select: { id: true, periodStart: true, periodEnd: true, payDate: true, taxYear: true, status: true },
    });
    if (!period) return refuse(`Period ${targetPeriodId} not found on Coulee Ridge/CRGCC-SM.`, 404);
    (evidence.guards as Record<string, unknown>).targetPeriod = period;

    const marcP = await loadPrincipalByEmail(MARC_PA_EMAIL);
    const chrisP = await loadPrincipalByEmail(CHRIS_CONTROLLER_EMAIL);
    if (!marcP || !chrisP) return refuse("PA or Controller principal unavailable.", 500);

    (evidence.integrity as Record<string, unknown>).before = await snapshotUntouchables();

    // Refuse if any existing batch on the period is in the untouchables set.
    const existingBaseline = await prisma.payrollBatch.findFirst({
      where: { clubId: COULEE_CLUB_ID, payPeriodId: period.id, transactionType: "STANDARD" },
      select: { id: true, status: true },
    });
    if (existingBaseline && UNTOUCHABLE_BATCH_IDS.has(existingBaseline.id)) {
      return refuse(`Refusing to touch protected batch ${existingBaseline.id}.`);
    }
    (evidence.guards as Record<string, unknown>).existingBaseline = existingBaseline;

    // ── STAGE 1: baseline-error — create the intentionally-wrong POSTED baseline
    let baselineBatchId: string;
    if (existingBaseline && existingBaseline.status === "POSTED") {
      baselineBatchId = existingBaseline.id;
    } else {
      const prep = await preparePayrollBatch(marcP, club.id, period.id);
      const calc = await calculatePayrollBatch(marcP, club.id, prep.batchId);
      if (calc.lifecycleStatus !== "CALCULATED") {
        return NextResponse.json({ ok: false, phase: "calculate",
          error: "Baseline calculate did not reach CALCULATED.",
          calcResult: calc, evidence }, { status: 500 });
      }
      await attestBatchReview(marcP, club.id, prep.batchId, "CALCULATED_PAYROLL");
      await submitPayrollBatch(marcP, club.id, prep.batchId);
      await approvePayrollBatch(chrisP, prep.batchId);
      await postPayrollBatch(marcP, prep.batchId);
      baselineBatchId = prep.batchId;
    }

    // Capture baseline evidence
    const baselineBatch = await prisma.payrollBatch.findUnique({
      where: { id: baselineBatchId },
      select: { id: true, status: true, transactionType: true, calculationVersion: true,
        packageChecksum: true, glJournalEntryId: true, postedAt: true, postedByUserId: true },
    });
    const baselineEmps = await prisma.payrollBatchEmployee.findMany({
      where: { batchId: baselineBatchId },
      select: { id: true, employeeId: true, grossPay: true, netPay: true,
        deductionCppEeCombined: true, deductionEiEe: true, deductionFederalTax: true,
        deductionProvincialTax: true, employerCppCombined: true, employerEi: true,
        employee: { select: { firstName: true, lastName: true, employeeNumber: true } } },
    });
    const baselineJE = baselineBatch?.glJournalEntryId ? await loadJournalLines(baselineBatch.glJournalEntryId) : null;
    evidence.baseline = {
      batch: baselineBatch,
      employees: baselineEmps.map(e => ({
        employeeId: e.employeeId, name: `${e.employee?.firstName} ${e.employee?.lastName}`,
        employeeNumber: e.employee?.employeeNumber,
        gross: d(e.grossPay), net: d(e.netPay),
        cppEE: d(e.deductionCppEeCombined), eiEE: d(e.deductionEiEe),
        fedTax: d(e.deductionFederalTax), provTax: d(e.deductionProvincialTax),
        cppER: d(e.employerCppCombined), eiER: d(e.employerEi),
      })),
      journal: baselineJE,
      ytdAfterBaseline: await ytdForEmployee(club.id, MARC_EMPLOYEE_ID, period.taxYear),
    };
    if (stage === "baseline-error") {
      evidence.finishedAt = new Date().toISOString();
      return NextResponse.json({ ok: true, stoppedAtStage: stage, evidence });
    }

    // ── STAGE 2: initiate — creates reversal + correction pair
    let existingCorrection = await prisma.payrollBatch.findFirst({
      where: { clubId: COULEE_CLUB_ID, correctsPayrollBatchId: baselineBatchId,
        transactionType: "CORRECTION", status: { notIn: ["VOIDED", "RETURNED_FOR_CORRECTION"] } },
      select: { id: true, pairedReversalBatchId: true, status: true },
    });
    let reversalBatchId: string;
    let correctionBatchId: string;
    if (existingCorrection) {
      correctionBatchId = existingCorrection.id;
      reversalBatchId = existingCorrection.pairedReversalBatchId!;
    } else {
      const initResult = await initiateReverseAndCorrect(marcP, club.id, baselineBatchId, "FPP-9B acceptance — corrected salary");
      reversalBatchId = initResult.reversalBatchId;
      correctionBatchId = initResult.correctionBatchId;
    }
    evidence.reversal = { batchId: reversalBatchId };
    evidence.correction = { batchId: correctionBatchId };
    if (stage === "initiate") {
      const reversalNow = await prisma.payrollBatch.findUnique({ where: { id: reversalBatchId } });
      const correctionNow = await prisma.payrollBatch.findUnique({ where: { id: correctionBatchId } });
      evidence.reversal = { ...(evidence.reversal as Record<string, unknown>), state: reversalNow };
      evidence.correction = { ...(evidence.correction as Record<string, unknown>), state: correctionNow };
      evidence.finishedAt = new Date().toISOString();
      return NextResponse.json({ ok: true, stoppedAtStage: stage, evidence });
    }

    // ── STAGE 3: post-reversal — approve + post the reversal
    const reversalStatus = await prisma.payrollBatch.findUnique({ where: { id: reversalBatchId }, select: { status: true } });
    if (reversalStatus?.status === "SUBMITTED_FOR_APPROVAL") {
      await approvePayrollBatch(chrisP, reversalBatchId);
    }
    const reversalNow = await prisma.payrollBatch.findUnique({ where: { id: reversalBatchId }, select: { status: true, glJournalEntryId: true } });
    if (reversalNow?.status === "APPROVED") {
      await postPayrollBatch(marcP, reversalBatchId);
    }
    const reversalPosted = await prisma.payrollBatch.findUnique({
      where: { id: reversalBatchId },
      select: { id: true, status: true, transactionType: true, reversesPayrollBatchId: true,
        glJournalEntryId: true, packageChecksum: true, postedAt: true, postedByUserId: true,
        approvedAt: true, approvedByUserId: true, reversalReason: true },
    });
    const reversalJE = reversalPosted?.glJournalEntryId ? await loadJournalLines(reversalPosted.glJournalEntryId) : null;
    evidence.reversal = { batchId: reversalBatchId, batch: reversalPosted, journal: reversalJE,
      ytdAfterReversalPosted: await ytdForEmployee(club.id, MARC_EMPLOYEE_ID, period.taxYear) };
    if (stage === "post-reversal") {
      evidence.finishedAt = new Date().toISOString();
      return NextResponse.json({ ok: true, stoppedAtStage: stage, evidence });
    }

    // ── STAGE 4: patch-correction — apply the salary bump
    // Bump Marc's annualSalary on the correction from $85,000 → $88,400 (a
    // ~$142/period increase). The number is arbitrary but deliberately
    // non-trivial so the correction differs from the original.
    const correctionState1 = await prisma.payrollBatch.findUnique({
      where: { id: correctionBatchId }, select: { status: true },
    });
    if (correctionState1?.status === "PREPARED" || correctionState1?.status === "CALCULATED") {
      // Patch only if we haven't already patched this run (check current facts).
      const marcCorrEmp = await prisma.payrollBatchEmployee.findFirst({
        where: { batchId: correctionBatchId, employeeId: MARC_EMPLOYEE_ID },
        select: { sourceFactsJson: true },
      });
      const facts = typeof marcCorrEmp?.sourceFactsJson === "string"
        ? JSON.parse(marcCorrEmp.sourceFactsJson) : (marcCorrEmp?.sourceFactsJson ?? {});
      if (facts.compensations?.[0]?.annualSalary !== "88400") {
        await patchCorrectionEmployeeInputs(marcP, club.id, correctionBatchId, [
          { employeeId: MARC_EMPLOYEE_ID, annualSalary: "88400" },
        ]);
      }
    }
    const correctionAfterPatch = await prisma.payrollBatch.findUnique({
      where: { id: correctionBatchId },
      select: { status: true, calculationVersion: true, calculatedAt: true },
    });
    (evidence.correction as Record<string, unknown>).afterPatch = correctionAfterPatch;
    if (stage === "patch-correction") {
      evidence.finishedAt = new Date().toISOString();
      return NextResponse.json({ ok: true, stoppedAtStage: stage, evidence });
    }

    // ── STAGE 5: calc-correction — recompute
    const correctionState2 = await prisma.payrollBatch.findUnique({
      where: { id: correctionBatchId }, select: { status: true },
    });
    if (correctionState2?.status === "PREPARED") {
      const calc = await calculatePayrollBatch(marcP, club.id, correctionBatchId);
      if (calc.lifecycleStatus !== "CALCULATED") {
        return NextResponse.json({ ok: false, phase: "correction-calculate",
          error: "Correction calculate did not reach CALCULATED.",
          calcResult: calc, evidence }, { status: 500 });
      }
    }
    const correctionAfterCalc = await prisma.payrollBatch.findUnique({
      where: { id: correctionBatchId },
      select: { status: true, calculationVersion: true, packageChecksum: true, calculatedAt: true },
    });
    const correctionEmpsAfterCalc = await prisma.payrollBatchEmployee.findMany({
      where: { batchId: correctionBatchId },
      select: { employeeId: true, grossPay: true, netPay: true,
        deductionCppEeCombined: true, deductionEiEe: true,
        deductionFederalTax: true, deductionProvincialTax: true,
        employerCppCombined: true, employerEi: true, sourceFactsJson: true,
        employee: { select: { firstName: true, lastName: true, employeeNumber: true } } },
    });
    (evidence.correction as Record<string, unknown>).afterCalc = {
      batch: correctionAfterCalc,
      employees: correctionEmpsAfterCalc.map(e => ({
        employeeId: e.employeeId, name: `${e.employee?.firstName} ${e.employee?.lastName}`,
        employeeNumber: e.employee?.employeeNumber,
        gross: d(e.grossPay), net: d(e.netPay),
        cppEE: d(e.deductionCppEeCombined), eiEE: d(e.deductionEiEe),
        fedTax: d(e.deductionFederalTax), provTax: d(e.deductionProvincialTax),
        cppER: d(e.employerCppCombined), eiER: d(e.employerEi),
      })),
    };
    if (stage === "calc-correction") {
      evidence.finishedAt = new Date().toISOString();
      return NextResponse.json({ ok: true, stoppedAtStage: stage, evidence });
    }

    // ── STAGE 6: post-correction — attest + submit + approve + post
    const correctionState3 = await prisma.payrollBatch.findUnique({
      where: { id: correctionBatchId }, select: { status: true },
    });
    if (correctionState3?.status === "CALCULATED") {
      await attestBatchReview(marcP, club.id, correctionBatchId, "CALCULATED_PAYROLL");
      await submitPayrollBatch(marcP, club.id, correctionBatchId);
    }
    const correctionState4 = await prisma.payrollBatch.findUnique({
      where: { id: correctionBatchId }, select: { status: true },
    });
    if (correctionState4?.status === "SUBMITTED_FOR_APPROVAL") {
      await approvePayrollBatch(chrisP, correctionBatchId);
    }
    const correctionState5 = await prisma.payrollBatch.findUnique({
      where: { id: correctionBatchId }, select: { status: true, glJournalEntryId: true },
    });
    if (correctionState5?.status === "APPROVED") {
      await postPayrollBatch(marcP, correctionBatchId);
    }
    const correctionPosted = await prisma.payrollBatch.findUnique({
      where: { id: correctionBatchId },
      select: { id: true, status: true, transactionType: true, correctsPayrollBatchId: true,
        pairedReversalBatchId: true, correctionReason: true, glJournalEntryId: true,
        packageChecksum: true, calculationVersion: true, postedAt: true, postedByUserId: true,
        approvedAt: true, approvedByUserId: true, submittedAt: true, submittedByUserId: true,
        preparedByUserId: true },
    });
    const correctionJE = correctionPosted?.glJournalEntryId ? await loadJournalLines(correctionPosted.glJournalEntryId) : null;
    evidence.correction = { ...evidence.correction as Record<string, unknown>,
      posted: correctionPosted, journal: correctionJE };

    // Idempotency retry (only for full stage)
    if (stage === "full") {
      let idempOutcome: string;
      let idempJEId: string | null = null;
      try {
        const second = await postPayrollBatch(marcP, correctionBatchId);
        idempOutcome = second.journalEntryId === correctionPosted?.glJournalEntryId
          ? "SAME_JOURNAL_RETURNED" : "DIFFERENT_JOURNAL_RETURNED";
        idempJEId = second.journalEntryId;
      } catch (err) {
        idempOutcome = "REJECTED_WITH_ERROR";
        idempJEId = (err as Error).message;
      }
      const jeCount = correctionPosted?.glJournalEntryId
        ? await prisma.journalEntry.count({ where: { id: correctionPosted.glJournalEntryId } })
        : 0;
      evidence.idempotency = { outcome: idempOutcome, retryJournalId: idempJEId,
        jeRowCountForCorrectionJournalId: jeCount };
    }

    // Final YTD + integrity + GL chain proof
    evidence.ytd = {
      afterBaseline: (evidence.baseline as any).ytdAfterBaseline,
      afterReversalPosted: (evidence.reversal as any).ytdAfterReversalPosted,
      afterCorrectionPosted: await ytdForEmployee(club.id, MARC_EMPLOYEE_ID, period.taxYear),
    };
    (evidence.integrity as Record<string, unknown>).after = await snapshotUntouchables();
    const before = (evidence.integrity as any).before;
    const after = (evidence.integrity as any).after;
    (evidence.integrity as any).founderUnchanged = JSON.stringify(before.founder) === JSON.stringify(after.founder);
    (evidence.integrity as any).chrisSep15Unchanged = JSON.stringify(before.chrisSep15) === JSON.stringify(after.chrisSep15);
    (evidence.integrity as any).fpp9a1BaselineUnchanged = JSON.stringify(before.fpp9a1Baseline) === JSON.stringify(after.fpp9a1Baseline);
    (evidence.integrity as any).fpp9a1ReversalUnchanged = JSON.stringify(before.fpp9a1Reversal) === JSON.stringify(after.fpp9a1Reversal);

    // GL chain proof: original + reversal + correction by account
    if (baselineJE && reversalJE && correctionJE) {
      const netByAcc: Record<string, string> = {};
      const combined = new Map<string, Prisma.Decimal>();
      const acc = (l: { account: string; debit: string; credit: string }) => {
        const cur = combined.get(l.account) ?? new Prisma.Decimal(0);
        combined.set(l.account, cur.plus(l.debit).minus(l.credit));
      };
      for (const l of baselineJE.lines) acc(l);
      for (const l of reversalJE.lines) acc(l);
      const originalPlusReversal: Record<string, string> = {};
      for (const [k, v] of combined) originalPlusReversal[k] = v.toFixed(2);
      const finalNet = new Map<string, Prisma.Decimal>(combined);
      for (const l of correctionJE.lines) {
        const cur = finalNet.get(l.account) ?? new Prisma.Decimal(0);
        finalNet.set(l.account, cur.plus(l.debit).minus(l.credit));
      }
      const finalByAccount: Record<string, string> = {};
      for (const [k, v] of finalNet) finalByAccount[k] = v.toFixed(2);
      // Sanity: original+reversal per account should all be 0.00
      const originalPlusReversalAllZero = Object.values(originalPlusReversal).every(v => v === "0.00");
      evidence.gl = {
        baselineJournal: baselineJE, reversalJournal: reversalJE, correctionJournal: correctionJE,
        originalPlusReversalPerAccount: originalPlusReversal,
        originalPlusReversalAllZero,
        finalNetPerAccount: finalByAccount,
      };
    }

    evidence.finishedAt = new Date().toISOString();
    return NextResponse.json({ ok: true, stoppedAtStage: stage, evidence });
  } catch (err) {
    return NextResponse.json({ ok: false,
      error: (err as Error).message ?? "Unexpected error.",
      stack: (err as Error).stack?.split("\n").slice(0, 10),
      evidence,
    }, { status: 500 });
  }
}
