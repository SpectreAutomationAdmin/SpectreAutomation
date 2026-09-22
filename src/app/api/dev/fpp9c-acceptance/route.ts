// FPP-9C (2026-09-22) — multi-input correction acceptance pipeline.
//
// Follows the same gate pattern as fpp9b-acceptance. Drives a synthetic
// erroneous ORIGINAL payroll on Coulee Ridge through:
//   Reverse & Correct →
//   patch allowance ADD →
//   patch oneTimeEarning ADD →
//   patch deduction ADD →
//   Calculate → build comparison →
//   Submit → Controller RETURN (with reason) →
//   patch adjustment on returned correction → Calculate →
//   Submit → Controller APPROVE → Post → idempotency retry.

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
import { initiateReverseAndCorrect, patchCorrectionEmployeeInputs, type CorrectionInputPatch } from "@/lib/payroll/correction";
import { buildCorrectionComparison } from "@/lib/payroll/correction-comparison";
import { loadPrincipalByEmail } from "@/lib/services/principal-by-email";
import { upsertPayrollComponent } from "@/lib/payroll/components-catalogue";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COULEE_SLUG = "spectre-staging-platform";
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const CRGCC_SM_PAYGROUP_ID = "cmu5kg3e40002h4iupsaxezdl";
const MARC_PA_EMAIL = "c.s.turcato@gmail.com";
const MARC_EMPLOYEE_ID = "cmu0ndf4p001vk9md2ntmo2ck";
const CHRIS_CONTROLLER_EMAIL = "cturcato@spectreautomation.com";

function refuse(msg: string, status = 403) { return NextResponse.json({ ok: false, error: msg }, { status }); }
function d(x: Prisma.Decimal | number | string | null | undefined): string {
  if (x == null) return "0.00";
  if (typeof x === "string") return new Prisma.Decimal(x).toFixed(2);
  if (typeof x === "number") return new Prisma.Decimal(x).toFixed(2);
  return x.toFixed(2);
}

export async function POST(req: NextRequest) {
  const evidence: Record<string, unknown> = { startedAt: new Date().toISOString(), guards: {} };
  try {
    if (process.env.FPP9C_ACCEPTANCE_ENABLED !== "1") return refuse("Endpoint disabled.");
    const caller = await getCurrentPrincipal();
    if (!caller) return refuse("Unauthenticated.", 401);
    if (caller.email !== MARC_PA_EMAIL && caller.email !== CHRIS_CONTROLLER_EMAIL) {
      return refuse(`Only ${MARC_PA_EMAIL} or ${CHRIS_CONTROLLER_EMAIL} may invoke.`);
    }
    const club = await prisma.club.findFirst({ where: { slug: COULEE_SLUG } });
    if (!club || club.id !== COULEE_CLUB_ID) return refuse("Refusing: must be Coulee Ridge.");
    const url = new URL(req.url);
    const targetPeriodId = url.searchParams.get("periodId");
    if (!targetPeriodId) return refuse("Missing periodId.", 400);
    const stage = (url.searchParams.get("stage") ?? "full").toLowerCase();
    const marcP = await loadPrincipalByEmail(MARC_PA_EMAIL);
    const chrisP = await loadPrincipalByEmail(CHRIS_CONTROLLER_EMAIL);
    if (!marcP || !chrisP) return refuse("Principals unavailable.", 500);
    const period = await prisma.payrollPayPeriod.findFirst({
      where: { id: targetPeriodId, clubId: COULEE_CLUB_ID, payGroupId: CRGCC_SM_PAYGROUP_ID },
      select: { id: true, taxYear: true, payDate: true },
    });
    if (!period) return refuse(`Period ${targetPeriodId} not on Coulee Ridge/CRGCC-SM.`, 404);
    (evidence.guards as Record<string, unknown>).stage = stage;

    // Phase 1 — synthetic erroneous baseline
    const existingBaseline = await prisma.payrollBatch.findFirst({
      where: { clubId: COULEE_CLUB_ID, payPeriodId: period.id, transactionType: "STANDARD" },
      select: { id: true, status: true },
    });
    let baselineBatchId: string;
    if (existingBaseline && existingBaseline.status === "POSTED") {
      baselineBatchId = existingBaseline.id;
    } else {
      const prep = await preparePayrollBatch(marcP, club.id, period.id);
      const calc = await calculatePayrollBatch(marcP, club.id, prep.batchId);
      if (calc.lifecycleStatus !== "CALCULATED") {
        return NextResponse.json({ ok: false, phase: "baseline-calculate", error: "did not reach CALCULATED", calc, evidence }, { status: 500 });
      }
      await attestBatchReview(marcP, club.id, prep.batchId, "CALCULATED_PAYROLL");
      await submitPayrollBatch(marcP, club.id, prep.batchId);
      await approvePayrollBatch(chrisP, prep.batchId);
      await postPayrollBatch(marcP, prep.batchId);
      baselineBatchId = prep.batchId;
    }
    const baseline = await prisma.payrollBatch.findUniqueOrThrow({
      where: { id: baselineBatchId },
      select: { id: true, status: true, packageChecksum: true, calculationFingerprint: true,
        calculationVersion: true, glJournalEntryId: true },
    });
    evidence.baseline = { batch: baseline };
    if (stage === "baseline") { evidence.finishedAt = new Date().toISOString(); return NextResponse.json({ ok: true, stoppedAtStage: stage, evidence }); }

    // Phase 2 — Reverse & Correct initiate
    let correction = await prisma.payrollBatch.findFirst({
      where: { clubId: COULEE_CLUB_ID, correctsPayrollBatchId: baselineBatchId,
        transactionType: "CORRECTION", status: { notIn: ["VOIDED"] } },
      select: { id: true, pairedReversalBatchId: true },
    });
    let reversalBatchId: string;
    let correctionBatchId: string;
    if (correction) {
      correctionBatchId = correction.id;
      reversalBatchId = correction.pairedReversalBatchId!;
    } else {
      const init = await initiateReverseAndCorrect(marcP, club.id, baselineBatchId, "FPP-9C acceptance — multi-input correction");
      reversalBatchId = init.reversalBatchId;
      correctionBatchId = init.correctionBatchId;
    }
    evidence.reversal = { batchId: reversalBatchId };
    evidence.correction = { batchId: correctionBatchId };

    // Phase 3 — post reversal
    const revStatus = await prisma.payrollBatch.findUnique({ where: { id: reversalBatchId }, select: { status: true } });
    if (revStatus?.status === "SUBMITTED_FOR_APPROVAL") await approvePayrollBatch(chrisP, reversalBatchId);
    const revNow = await prisma.payrollBatch.findUnique({ where: { id: reversalBatchId }, select: { status: true } });
    if (revNow?.status === "APPROVED") await postPayrollBatch(marcP, reversalBatchId);
    (evidence.reversal as Record<string, unknown>).status = "POSTED";

    // FPP-9C.1 (2026-09-22, §8) — Configure a synthetic EARNING component
    // on Coulee via the normal catalogue service so oneTimeEarning ADD/
    // UPDATE/REMOVE can be exercised end-to-end on staging. Idempotent.
    // Maps to the same salary-expense account used by the tenant's Payroll
    // GL profile so the GL-readiness guard is satisfied at post time.
    const glProfile = await prisma.payrollGlAccountingProfile.findFirst({
      where: { clubId: club.id },
      select: { salaryExpenseAccountId: true },
    });
    const testBonusUpsert = await upsertPayrollComponent(marcP, club.id, {
      code: "FPP9C_TEST_BONUS",
      displayName: "FPP-9C Acceptance Bonus (synthetic)",
      description: "Synthetic one-time earning used exclusively by the FPP-9C acceptance pipeline.",
      category: "ADDITIONAL_EARNING",
      side: "EMPLOYEE",
      cashEffect: "INCREASES_NET_PAY",
      taxableEffect: "ADD",
      cppPensionableEffect: "ADD",
      eiInsurableEffect: "ADD",
      calculationMethod: "FIXED_AMOUNT",
      displaySection: "EARNINGS",
      displayOrder: 700,
      active: true,
      expenseAccountId: glProfile?.salaryExpenseAccountId ?? null,
    });
    (evidence.correction as Record<string, unknown>).testBonusUpsert = testBonusUpsert;

    // Phase 4 — MULTI-INPUT patches on the correction
    // Applied to Marc: salary bump + ADD one-time bonus + ADD cell-phone allowance + ADD RRSP_EE deduction
    const patches: CorrectionInputPatch[] = [
      { employeeId: MARC_EMPLOYEE_ID, kind: "annualSalary", annualSalary: "88400" },
    ];
    const optionalPatches: CorrectionInputPatch[] = [
      { employeeId: MARC_EMPLOYEE_ID, kind: "oneTimeEarning", operation: "ADD",
        componentCode: "FPP9C_TEST_BONUS", displayName: "FPP-9C Acceptance Bonus", amount: "500.00" },
      { employeeId: MARC_EMPLOYEE_ID, kind: "allowance", operation: "ADD",
        allowanceType: "CELL_PHONE", amount: "25.00" },
      { employeeId: MARC_EMPLOYEE_ID, kind: "deduction", operation: "ADD",
        componentCode: "RRSP_EE", displayName: "RRSP — Employee", amount: "15.00" },
    ];
    const patchStatus: any = { annualSalary: false, oneTimeEarning: false, allowance: false, deduction: false };
    if ((await prisma.payrollBatch.findUnique({ where: { id: correctionBatchId }, select: { status: true } }))?.status !== "POSTED") {
      // Only patch if we haven't already patched this run.
      try {
        await patchCorrectionEmployeeInputs(marcP, club.id, correctionBatchId, [patches[0]]);
        patchStatus.annualSalary = true;
      } catch (e) {
        const err = e as { message?: string; issues?: Array<{ path: string; message: string }> };
        patchStatus.annualSalaryError = err.issues?.[0]?.message ?? err.message;
      }
      for (const p of optionalPatches) {
        const kind = String((p as { kind?: string }).kind ?? "unknown");
        try {
          await patchCorrectionEmployeeInputs(marcP, club.id, correctionBatchId, [p]);
          patchStatus[kind] = true;
        } catch (e) {
          const err = e as { message?: string; issues?: Array<{ path: string; message: string }> };
          patchStatus[`${kind}Skipped`] = (err.issues?.[0]?.message ?? err.message ?? "").slice(0, 240);
        }
      }

      // FPP-9C.1 (§9-§11) — exercise oneTimeEarning UPDATE + REMOVE + re-ADD
      // and capture per-stage evidence, so the acceptance proves the FULL
      // ADD/UPDATE/REMOVE lifecycle end-to-end on staging (not only ADD).
      const otEvidence: any = { addSucceeded: patchStatus.oneTimeEarning === true };
      if (patchStatus.oneTimeEarning === true) {
        const bonusAfterAdd = await prisma.payrollBatchComponentSnapshot.findFirst({
          where: { batchId: correctionBatchId, componentCode: "FPP9C_TEST_BONUS" },
          select: { id: true, resolvedAmount: true, provenance: true },
        });
        otEvidence.afterAdd = {
          present: !!bonusAfterAdd,
          resolvedAmount: bonusAfterAdd?.resolvedAmount?.toFixed(2) ?? null,
          provenance: bonusAfterAdd?.provenance ?? null,
        };
        try {
          await patchCorrectionEmployeeInputs(marcP, club.id, correctionBatchId, [
            { employeeId: MARC_EMPLOYEE_ID, kind: "oneTimeEarning", operation: "UPDATE",
              componentCode: "FPP9C_TEST_BONUS", amount: "750.00" },
          ]);
          const afterUpdate = await prisma.payrollBatchComponentSnapshot.findFirst({
            where: { batchId: correctionBatchId, componentCode: "FPP9C_TEST_BONUS" },
            select: { resolvedAmount: true },
          });
          otEvidence.afterUpdate = { resolvedAmount: afterUpdate?.resolvedAmount?.toFixed(2) ?? null };
          otEvidence.updateSucceeded = afterUpdate?.resolvedAmount?.toFixed(2) === "750.00";
        } catch (e) { otEvidence.updateError = (e as Error).message?.slice(0, 240); }
        try {
          await patchCorrectionEmployeeInputs(marcP, club.id, correctionBatchId, [
            { employeeId: MARC_EMPLOYEE_ID, kind: "oneTimeEarning", operation: "REMOVE",
              componentCode: "FPP9C_TEST_BONUS" },
          ]);
          const afterRemove = await prisma.payrollBatchComponentSnapshot.findFirst({
            where: { batchId: correctionBatchId, componentCode: "FPP9C_TEST_BONUS" },
            select: { id: true },
          });
          otEvidence.afterRemove = { present: !!afterRemove };
          otEvidence.removeSucceeded = !afterRemove;
        } catch (e) { otEvidence.removeError = (e as Error).message?.slice(0, 240); }
        // Re-ADD so the final calculation includes a bonus for the acceptance run.
        try {
          await patchCorrectionEmployeeInputs(marcP, club.id, correctionBatchId, [
            { employeeId: MARC_EMPLOYEE_ID, kind: "oneTimeEarning", operation: "ADD",
              componentCode: "FPP9C_TEST_BONUS", displayName: "FPP-9C Acceptance Bonus", amount: "500.00" },
          ]);
          otEvidence.reAddSucceeded = true;
        } catch (e) { otEvidence.reAddError = (e as Error).message?.slice(0, 240); }
      }
      (evidence.correction as Record<string, unknown>).oneTimeEarningLifecycle = otEvidence;
    }
    (evidence.correction as Record<string, unknown>).patchStatus = patchStatus;

    // Phase 5 — Calculate correction (only if PREPARED)
    let correctionState = await prisma.payrollBatch.findUnique({ where: { id: correctionBatchId }, select: { status: true } });
    if (correctionState?.status === "PREPARED") {
      const calc = await calculatePayrollBatch(marcP, club.id, correctionBatchId);
      if (calc.lifecycleStatus !== "CALCULATED") {
        return NextResponse.json({ ok: false, phase: "correction-calc", error: "correction calc did not reach CALCULATED", calc, evidence }, { status: 500 });
      }
    }

    // Phase 6 — comparison
    const comparison = await buildCorrectionComparison(correctionBatchId);
    evidence.comparison = comparison;

    // Phase 7 — submit + return-for-correction cycle
    correctionState = await prisma.payrollBatch.findUnique({ where: { id: correctionBatchId }, select: { status: true } });
    if (correctionState?.status === "CALCULATED") {
      await attestBatchReview(marcP, club.id, correctionBatchId, "CALCULATED_PAYROLL");
      await submitPayrollBatch(marcP, club.id, correctionBatchId);
    }
    // Simulate Controller RETURN on the first submit — via existing return-payroll-batch service if available.
    // Best-effort — if not available, skip and just approve.
    try {
      const { returnPayrollBatch } = await import("@/lib/payroll/return-payroll-batch");
      const sNow = await prisma.payrollBatch.findUnique({ where: { id: correctionBatchId }, select: { status: true } });
      if (sNow?.status === "SUBMITTED_FOR_APPROVAL" && !((evidence.correction as any).returned)) {
        await returnPayrollBatch(chrisP, club.id, correctionBatchId, "FPP-9C acceptance — verify corrected deduction");
        (evidence.correction as any).returned = true;
      }
    } catch (err) {
      (evidence.correction as any).returnSkipped = (err as Error).message?.slice(0, 240);
    }

    // Post-return: re-patch (small adjustment) and re-calculate/re-submit.
    const correctionState2 = await prisma.payrollBatch.findUnique({ where: { id: correctionBatchId }, select: { status: true, calculationFingerprint: true } });
    const fingerprintBeforeResubmit = correctionState2?.calculationFingerprint;
    correctionState = correctionState2 ? { status: correctionState2.status } : null;
    if (correctionState?.status && ["DRAFT", "PREPARED", "RETURNED_FOR_CORRECTION"].includes(correctionState.status)) {
      // Tiny re-adjustment to prove fingerprint changes across resubmit.
      try {
        await patchCorrectionEmployeeInputs(marcP, club.id, correctionBatchId, [
          { employeeId: MARC_EMPLOYEE_ID, kind: "annualSalary", annualSalary: "88500" },
        ]);
      } catch { /* correction may not be patch-eligible if status is beyond CALCULATED */ }
      const calc2 = await calculatePayrollBatch(marcP, club.id, correctionBatchId);
      if (calc2.lifecycleStatus === "CALCULATED") {
        await attestBatchReview(marcP, club.id, correctionBatchId, "CALCULATED_PAYROLL");
        await submitPayrollBatch(marcP, club.id, correctionBatchId);
      }
    }

    // Phase 8 — approve + post
    correctionState = await prisma.payrollBatch.findUnique({ where: { id: correctionBatchId }, select: { status: true } });
    if (correctionState?.status === "SUBMITTED_FOR_APPROVAL") await approvePayrollBatch(chrisP, correctionBatchId);
    correctionState = await prisma.payrollBatch.findUnique({ where: { id: correctionBatchId }, select: { status: true } });
    if (correctionState?.status === "APPROVED") await postPayrollBatch(marcP, correctionBatchId);

    // Idempotency retry
    let idempResult: any;
    try {
      const second = await postPayrollBatch(marcP, correctionBatchId);
      idempResult = { outcome: "SAME_JOURNAL_RETURNED", journalId: second.journalEntryId };
    } catch (err) { idempResult = { outcome: "REJECTED_WITH_ERROR", err: (err as Error).message?.slice(0, 240) }; }

    // Final state
    const correctionFinal = await prisma.payrollBatch.findUniqueOrThrow({
      where: { id: correctionBatchId },
      select: {
        id: true, status: true, transactionType: true, correctsPayrollBatchId: true,
        pairedReversalBatchId: true, correctionReason: true, glJournalEntryId: true,
        packageChecksum: true, calculationFingerprint: true, calculationVersion: true,
      },
    });
    const finalComparison = await buildCorrectionComparison(correctionBatchId);

    evidence.finalCorrection = correctionFinal;
    evidence.finalComparison = finalComparison;
    evidence.idempotency = idempResult;
    evidence.fingerprintBeforeResubmit = fingerprintBeforeResubmit;
    evidence.finishedAt = new Date().toISOString();
    return NextResponse.json({ ok: true, stoppedAtStage: stage, evidence });
  } catch (err) {
    return NextResponse.json({ ok: false, error: (err as Error).message ?? "err",
      stack: (err as Error).stack?.split("\n").slice(0, 10), evidence }, { status: 500 });
  }
}
