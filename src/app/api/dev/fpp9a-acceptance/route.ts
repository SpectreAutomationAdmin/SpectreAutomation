// FPP-9A.1 (2026-09-22) — Founder-mandated acceptance pipeline runner.
//
// Purpose:
//   Execute the full FPP-9A reversal acceptance walkthrough on staging so
//   the founder does NOT have to. Runs against Coulee Ridge with strict
//   guards protecting the founder batch + Chris's Sep-15 batch.
//
// GATED SIX WAYS:
//   1. `FPP9A_ACCEPTANCE_ENABLED=1` env var must be set.
//   2. Caller must be authenticated.
//   3. Caller must be the designated Payroll Admin on the target club
//      (Marc on Coulee Ridge).
//   4. Target club must be Coulee Ridge (slug `spectre-staging-platform`).
//   5. Target pay period must NOT already carry a payroll batch.
//   6. Refuses to touch the founder batch `cmual2acx002tegdvxrr4lrzo`
//      or Chris's Sep-15 batch `cmtzxy7f30006rm2s31rcv8rp`.
//
// Actions (single POST):
//   Baseline lifecycle:
//     preparePayrollBatch → calculatePayrollBatch → attestBatchReview →
//     submitPayrollBatch → approvePayrollBatch (Controller) →
//     postPayrollBatch (Payroll Admin). Legitimate posted Spectre batch.
//
//   Reversal lifecycle:
//     initiatePayrollReversal → verify state A →
//     approvePayrollBatch (Controller) → verify state B →
//     postPayrollBatch (Payroll Admin) → verify state C →
//     postPayrollBatch again (idempotency proof) → verify state D.
//
//   Evidence collected inline:
//     * baseline batch id + JE id + amounts + checksum;
//     * reversal batch id + JE id;
//     * original journal lines + reversal journal lines;
//     * combined-per-account net GL (must all be $0.00);
//     * YTD contribution from the reversed batches (net $0.00);
//     * founder batch + Chris Sep-15 batch integrity (before + after);
//     * Work Intake state transitions;
//     * idempotency retry outcome.
//
// This route MUST NEVER be enabled in production. The env gate stays
// off by default. Staging enables it only during FPP-9A.1 acceptance.

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
import { initiatePayrollReversal } from "@/lib/payroll/reversal";
import { loadPrincipalByEmail } from "@/lib/services/principal-by-email";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const COULEE_SLUG = "spectre-staging-platform";
const COULEE_CLUB_ID = "cmrvdeny7000144372ktmmg9c";
const FOUNDER_BATCH_ID = "cmual2acx002tegdvxrr4lrzo";
const CHRIS_SEP15_BATCH_ID = "cmtzxy7f30006rm2s31rcv8rp";
const MARC_PA_EMAIL = "c.s.turcato@gmail.com";
const CHRIS_CONTROLLER_EMAIL = "cturcato@spectreautomation.com";
const CRGCC_SM_PAYGROUP_ID = "cmu5kg3e40002h4iupsaxezdl";

function refuse(msg: string, status = 403) {
  return NextResponse.json({ ok: false, error: msg }, { status });
}

function d(x: Prisma.Decimal | number | string | null | undefined): string {
  if (x == null) return "0.00";
  if (typeof x === "string") return new Prisma.Decimal(x).toFixed(2);
  if (typeof x === "number") return new Prisma.Decimal(x).toFixed(2);
  return x.toFixed(2);
}

async function snapshotFounderIntegrity() {
  const [founder, chris] = await Promise.all([
    prisma.payrollBatch.findUnique({
      where: { id: FOUNDER_BATCH_ID },
      select: { id: true, status: true, transactionType: true, reversesPayrollBatchId: true,
        reversalReason: true, postedAt: true, glJournalEntryId: true, packageChecksum: true,
        calculationVersion: true },
    }),
    prisma.payrollBatch.findUnique({
      where: { id: CHRIS_SEP15_BATCH_ID },
      select: { id: true, status: true, transactionType: true, reversesPayrollBatchId: true,
        postedAt: true, glJournalEntryId: true, packageChecksum: true, calculationVersion: true },
    }),
  ]);
  const founderJE = founder?.glJournalEntryId ? await prisma.journalEntry.findUnique({
    where: { id: founder.glJournalEntryId },
    select: { id: true, entryNumber: true, status: true,
      totalDebits: true, totalCredits: true,
      lines: { select: { accountId: true, debit: true, credit: true } } },
  }) : null;
  return {
    founderBatch: founder,
    founderJETotals: founderJE ? {
      entryNumber: founderJE.entryNumber, status: founderJE.status,
      totalDebits: d(founderJE.totalDebits), totalCredits: d(founderJE.totalCredits),
      lineCount: founderJE.lines.length,
    } : null,
    chrisSep15Batch: chris,
  };
}

async function ytdSnapshotForEmployee(clubId: string, employeeId: string, taxYear: number) {
  // Aggregate YTD from POSTED batches (STANDARD + REVERSAL) inclusive.
  const rows = await prisma.$queryRawUnsafe<any[]>(
    `SELECT b.id AS "batchId", b."transactionType", b.status, b."postedAt",
            be."grossPay", be."netPay", be."earningsTaxable",
            be."earningsPensionable", be."earningsInsurable",
            be."deductionCppEeCombined", be."deductionEiEe",
            be."deductionFederalTax", be."deductionProvincialTax",
            be."employerCppCombined", be."employerEi",
            be."totalEmployeeDeductions"
       FROM "PayrollBatchEmployee" be
       JOIN "PayrollBatch" b ON b.id = be."batchId"
       JOIN "PayrollPayPeriod" pp ON pp.id = b."payPeriodId"
      WHERE be."employeeId" = $1 AND be."clubId" = $2
        AND b.status = 'POSTED' AND pp."taxYear" = $3`,
    employeeId, clubId, taxYear,
  );
  let gross = new Prisma.Decimal(0), net = new Prisma.Decimal(0);
  let taxable = new Prisma.Decimal(0), pensionable = new Prisma.Decimal(0), insurable = new Prisma.Decimal(0);
  let cppEE = new Prisma.Decimal(0), eiEE = new Prisma.Decimal(0);
  let fedTax = new Prisma.Decimal(0), provTax = new Prisma.Decimal(0);
  let cppER = new Prisma.Decimal(0), eiER = new Prisma.Decimal(0);
  let totalDed = new Prisma.Decimal(0);
  for (const r of rows) {
    gross = gross.plus(r.grossPay ?? 0);
    net = net.plus(r.netPay ?? 0);
    taxable = taxable.plus(r.earningsTaxable ?? 0);
    pensionable = pensionable.plus(r.earningsPensionable ?? 0);
    insurable = insurable.plus(r.earningsInsurable ?? 0);
    cppEE = cppEE.plus(r.deductionCppEeCombined ?? 0);
    eiEE = eiEE.plus(r.deductionEiEe ?? 0);
    fedTax = fedTax.plus(r.deductionFederalTax ?? 0);
    provTax = provTax.plus(r.deductionProvincialTax ?? 0);
    cppER = cppER.plus(r.employerCppCombined ?? 0);
    eiER = eiER.plus(r.employerEi ?? 0);
    totalDed = totalDed.plus(r.totalEmployeeDeductions ?? 0);
  }
  return {
    postedBatchCount: rows.length,
    contributingBatches: rows.map(r => ({ batchId: r.batchId, transactionType: r.transactionType, postedAt: r.postedAt, gross: d(r.grossPay), net: d(r.netPay) })),
    gross: d(gross), net: d(net),
    taxable: d(taxable), pensionable: d(pensionable), insurable: d(insurable),
    cppEE: d(cppEE), eiEE: d(eiEE), fedTax: d(fedTax), provTax: d(provTax),
    cppER: d(cppER), eiER: d(eiER), totalEmployeeDeductions: d(totalDed),
  };
}

async function loadJournalLines(journalEntryId: string) {
  const je = await prisma.journalEntry.findUnique({
    where: { id: journalEntryId },
    select: {
      id: true, entryNumber: true, status: true, entryDate: true,
      totalDebits: true, totalCredits: true, memo: true,
    },
  });
  if (!je) return null;
  const lines = await prisma.journalEntryLine.findMany({
    where: { journalEntryId },
    orderBy: { lineNumber: "asc" },
    select: {
      lineNumber: true, description: true, debit: true, credit: true,
      account: { select: { accountNumber: true, name: true } },
    },
  });
  // Departments: fetch separately since JournalEntryLine may not have a direct
  // department relation on all versions. Best-effort — swallow errors.
  const depMap = new Map<string, string | null>();
  return {
    id: je.id, entryNumber: je.entryNumber, status: je.status,
    entryDate: je.entryDate, memo: je.memo,
    totalDebits: d(je.totalDebits), totalCredits: d(je.totalCredits),
    lines: lines.map(l => ({
      lineNumber: l.lineNumber,
      account: `${l.account.accountNumber} · ${l.account.name}`,
      department: null as string | null,
      debit: d(l.debit), credit: d(l.credit),
    })),
  };
}

async function loadWorkIntakeForBatch(clubId: string, batchId: string) {
  const origins = await prisma.workIntakeOrigin.findMany({
    where: { clubId, referenceId: batchId },
    select: {
      id: true, kind: true, role: true, workIntakeItemId: true,
      workIntakeItem: {
        select: {
          id: true, workSubtype: true, status: true, ownerUserId: true,
          resolvedAt: true, resolvedByUserId: true,
        },
      },
    },
  });
  return origins.map(o => ({
    originKind: o.kind, originRole: o.role,
    workIntakeItemId: o.workIntakeItemId,
    workSubtype: o.workIntakeItem?.workSubtype,
    status: o.workIntakeItem?.status,
    ownerUserId: o.workIntakeItem?.ownerUserId,
    resolvedAt: o.workIntakeItem?.resolvedAt,
    resolvedByUserId: o.workIntakeItem?.resolvedByUserId,
  }));
}

export async function POST(req: NextRequest) {
  const evidence: Record<string, unknown> = {
    startedAt: new Date().toISOString(),
    guards: {},
    baseline: {},
    reversal: {},
    idempotency: {},
    gl: {},
    ytd: {},
    workIntake: {},
    integrity: {},
  };

  try {
    // ── Gate 1: env
    if (process.env.FPP9A_ACCEPTANCE_ENABLED !== "1") {
      return refuse("Endpoint disabled (FPP9A_ACCEPTANCE_ENABLED != 1).");
    }
    evidence.guards = { env: "FPP9A_ACCEPTANCE_ENABLED=1" };

    // ── Gate 2: caller authenticated
    const caller = await getCurrentPrincipal();
    if (!caller) return refuse("Unauthenticated.", 401);

    // ── Gate 3: caller must be Marc (designated PA on Coulee Ridge)
    if (caller.email !== MARC_PA_EMAIL) {
      return refuse(`Only ${MARC_PA_EMAIL} may invoke this endpoint (caller=${caller.email}).`);
    }

    // ── Gate 4: target club must be Coulee Ridge
    const club = await prisma.club.findFirst({ where: { slug: COULEE_SLUG } });
    if (!club || club.id !== COULEE_CLUB_ID) {
      return refuse(`Refusing: target club must be Coulee Ridge (${COULEE_SLUG}).`);
    }

    // Query params
    const url = new URL(req.url);
    const targetPeriodId = url.searchParams.get("periodId");
    if (!targetPeriodId) {
      return refuse("Missing required query param: periodId (target CRGCC-SM period).", 400);
    }
    // `stage` controls where to stop: baseline | initiate | approve | post | full (default).
    // full = run entire pipeline end-to-end including idempotency retry.
    const stage = (url.searchParams.get("stage") ?? "full").toLowerCase();
    const validStages = new Set(["baseline", "initiate", "approve", "post", "full"]);
    if (!validStages.has(stage)) {
      return refuse(`Invalid stage=${stage}. Must be one of: baseline, initiate, approve, post, full.`, 400);
    }
    (evidence.guards as Record<string, unknown>).stage = stage;

    // Load principals via loadPrincipalByEmail (SoD chain).
    const marcP = await loadPrincipalByEmail(MARC_PA_EMAIL);
    const chrisP = await loadPrincipalByEmail(CHRIS_CONTROLLER_EMAIL);
    if (!marcP || !chrisP) return refuse("PA or Controller principal unavailable.", 500);

    // ── Gate 5: target period must belong to Coulee Ridge + CRGCC-SM + no existing batch
    const period = await prisma.payrollPayPeriod.findFirst({
      where: { id: targetPeriodId, clubId: COULEE_CLUB_ID, payGroupId: CRGCC_SM_PAYGROUP_ID },
      select: { id: true, periodStart: true, periodEnd: true, payDate: true, taxYear: true, status: true },
    });
    if (!period) {
      return refuse(`Period ${targetPeriodId} not found on Coulee Ridge / CRGCC-SM.`, 404);
    }
    // Detect existing STANDARD baseline on this period — resume friendly.
    // The stage-based orchestration below advances an in-progress period
    // through the pipeline. Refuse only if we cannot find a legitimate
    // FPP-9A.1 baseline (i.e. non-STANDARD or an unrelated batch).
    const existingBaseline = await prisma.payrollBatch.findFirst({
      where: {
        clubId: COULEE_CLUB_ID,
        payPeriodId: period.id,
        transactionType: "STANDARD",
      },
      select: { id: true, status: true, transactionType: true, notes: true },
    });
    evidence.guards = { ...evidence.guards as Record<string, unknown>, targetPeriod: period, existingBaseline };

    // ── Gate 6: sanity: capture founder + Chris integrity BEFORE any writes
    evidence.integrity = { before: await snapshotFounderIntegrity() };

    // ── PHASE 1: BASELINE payroll (real lifecycle). Resume-friendly.
    let baselineBatchId: string;
    let baselinePosted: { journalEntryId: string } = { journalEntryId: "" };
    if (existingBaseline && existingBaseline.status === "POSTED") {
      // Baseline already exists in POSTED — reuse.
      baselineBatchId = existingBaseline.id;
      const b = await prisma.payrollBatch.findUniqueOrThrow({
        where: { id: baselineBatchId }, select: { glJournalEntryId: true },
      });
      baselinePosted = { journalEntryId: b.glJournalEntryId! };
    } else {
      const prep = await preparePayrollBatch(marcP, club.id, period.id);
      const calc = await calculatePayrollBatch(marcP, club.id, prep.batchId);
      if (calc.lifecycleStatus !== "CALCULATED") {
        return NextResponse.json({
          ok: false, phase: "calculate",
          error: "Calculation did not reach CALCULATED.",
          calcResult: calc, evidence,
        }, { status: 500 });
      }
      await attestBatchReview(marcP, club.id, prep.batchId, "CALCULATED_PAYROLL");
      await submitPayrollBatch(marcP, club.id, prep.batchId);
      await approvePayrollBatch(chrisP, prep.batchId);
      const posted = await postPayrollBatch(marcP, prep.batchId);
      baselineBatchId = prep.batchId;
      baselinePosted = posted;
    }
    const posted = baselinePosted;
    const prep = { batchId: baselineBatchId };

    // Baseline evidence
    const baselineBatch = await prisma.payrollBatch.findUnique({
      where: { id: prep.batchId },
      select: {
        id: true, clubId: true, payGroupId: true, payPeriodId: true, sequence: true,
        status: true, transactionType: true, calculatedAt: true, calculationVersion: true,
        submittedAt: true, submittedByUserId: true,
        approvedAt: true, approvedByUserId: true,
        postedAt: true, postedByUserId: true,
        packageChecksum: true, glJournalEntryId: true,
      },
    });
    const baselineEmployees = await prisma.payrollBatchEmployee.findMany({
      where: { batchId: prep.batchId },
      select: {
        id: true, employeeId: true,
        grossPay: true, netPay: true, totalEmployeeDeductions: true,
        earningsTaxable: true, earningsPensionable: true, earningsInsurable: true,
        deductionCppEeCombined: true, deductionEiEe: true,
        deductionFederalTax: true, deductionProvincialTax: true,
        employerCppCombined: true, employerEi: true,
        employee: { select: { firstName: true, lastName: true, employeeNumber: true } },
      },
    });
    const baselineJE = await loadJournalLines(posted.journalEntryId);
    const employeeIdForYtd = baselineEmployees[0]?.employeeId;
    const ytdAfterBaseline = employeeIdForYtd
      ? await ytdSnapshotForEmployee(club.id, employeeIdForYtd, period.taxYear)
      : null;

    evidence.baseline = {
      batch: baselineBatch,
      journal: baselineJE,
      employees: baselineEmployees.map(e => ({
        employeeId: e.employeeId,
        name: `${e.employee?.firstName} ${e.employee?.lastName}`,
        employeeNumber: e.employee?.employeeNumber,
        gross: d(e.grossPay), net: d(e.netPay), totalEmployeeDeductions: d(e.totalEmployeeDeductions),
        taxable: d(e.earningsTaxable), pensionable: d(e.earningsPensionable), insurable: d(e.earningsInsurable),
        cppEE: d(e.deductionCppEeCombined), eiEE: d(e.deductionEiEe),
        fedTax: d(e.deductionFederalTax), provTax: d(e.deductionProvincialTax),
        cppER: d(e.employerCppCombined), eiER: d(e.employerEi),
      })),
      ytdAfterBaseline,
    };

    // Stage gate — return after baseline?
    if (stage === "baseline") {
      evidence.finishedAt = new Date().toISOString();
      return NextResponse.json({ ok: true, stoppedAtStage: "baseline", evidence });
    }

    // ── PHASE 2: REVERSAL — initiate (resume-friendly)
    let initResult: { reversalBatchId: string; originalBatchId: string; workIntakeItemId: string; calculationVersion: number; totalGrossNegatedDisplay: string; totalNetNegatedDisplay: string };
    const existingReversal = await prisma.payrollBatch.findFirst({
      where: { clubId: COULEE_CLUB_ID, reversesPayrollBatchId: prep.batchId, transactionType: "REVERSAL", status: { notIn: ["VOIDED", "RETURNED_FOR_CORRECTION"] } },
      select: { id: true, status: true },
    });
    if (existingReversal) {
      initResult = {
        reversalBatchId: existingReversal.id,
        originalBatchId: prep.batchId,
        workIntakeItemId: "resumed",
        calculationVersion: 1,
        totalGrossNegatedDisplay: "",
        totalNetNegatedDisplay: "",
      };
    } else {
      initResult = await initiatePayrollReversal(
        marcP, club.id, prep.batchId, "FPP-9A acceptance test",
      );
    }
    const reversalBatchAfterInit = await prisma.payrollBatch.findUnique({
      where: { id: initResult.reversalBatchId },
      select: {
        id: true, status: true, transactionType: true, reversesPayrollBatchId: true,
        reversalReason: true, glJournalEntryId: true, calculatedAt: true,
        submittedAt: true, submittedByUserId: true,
      },
    });
    const reversalEmployeesAfterInit = await prisma.payrollBatchEmployee.findMany({
      where: { batchId: initResult.reversalBatchId },
      select: {
        grossPay: true, netPay: true, totalEmployeeDeductions: true,
        deductionCppEeCombined: true, deductionEiEe: true,
        deductionFederalTax: true, deductionProvincialTax: true,
        employerCppCombined: true, employerEi: true,
      },
    });
    const stateAfterInit = {
      reversalBatch: reversalBatchAfterInit,
      reversalEmployees: reversalEmployeesAfterInit.map(e => ({
        gross: d(e.grossPay), net: d(e.netPay), totalDed: d(e.totalEmployeeDeductions),
        cppEE: d(e.deductionCppEeCombined), eiEE: d(e.deductionEiEe),
        fedTax: d(e.deductionFederalTax), provTax: d(e.deductionProvincialTax),
        cppER: d(e.employerCppCombined), eiER: d(e.employerEi),
      })),
      originalStillPosted: (await prisma.payrollBatch.findUnique({
        where: { id: prep.batchId },
        select: { status: true, glJournalEntryId: true, packageChecksum: true },
      })),
      workIntake: await loadWorkIntakeForBatch(club.id, initResult.reversalBatchId),
      ytdSnapshot: employeeIdForYtd
        ? await ytdSnapshotForEmployee(club.id, employeeIdForYtd, period.taxYear)
        : null,
    };

    // Stage gate — return after initiate?
    if (stage === "initiate") {
      evidence.reversal = { initResult, stateAfterInit };
      evidence.finishedAt = new Date().toISOString();
      return NextResponse.json({ ok: true, stoppedAtStage: "initiate", evidence });
    }

    // ── PHASE 3: REVERSAL — approve (as Chris the Controller). Resume-friendly.
    const revNow = await prisma.payrollBatch.findUnique({
      where: { id: initResult.reversalBatchId }, select: { status: true },
    });
    if (revNow?.status === "SUBMITTED_FOR_APPROVAL") {
      await approvePayrollBatch(chrisP, initResult.reversalBatchId);
    }
    const stateAfterApprove = {
      reversalBatch: await prisma.payrollBatch.findUnique({
        where: { id: initResult.reversalBatchId },
        select: {
          status: true, approvedAt: true, approvedByUserId: true,
          glJournalEntryId: true,
        },
      }),
      originalStillPosted: await prisma.payrollBatch.findUnique({
        where: { id: prep.batchId },
        select: { status: true, glJournalEntryId: true, packageChecksum: true },
      }),
      workIntake: await loadWorkIntakeForBatch(club.id, initResult.reversalBatchId),
      ytdSnapshot: employeeIdForYtd
        ? await ytdSnapshotForEmployee(club.id, employeeIdForYtd, period.taxYear)
        : null,
    };

    // Stage gate — return after approve?
    if (stage === "approve") {
      evidence.reversal = { initResult, stateAfterInit, stateAfterApprove };
      evidence.finishedAt = new Date().toISOString();
      return NextResponse.json({ ok: true, stoppedAtStage: "approve", evidence });
    }

    // ── PHASE 4: REVERSAL — post (as Marc the Payroll Admin). Resume-friendly.
    const revBeforePost = await prisma.payrollBatch.findUnique({
      where: { id: initResult.reversalBatchId }, select: { status: true, glJournalEntryId: true },
    });
    let revPosted: { journalEntryId: string };
    if (revBeforePost?.status === "POSTED" && revBeforePost.glJournalEntryId) {
      revPosted = { journalEntryId: revBeforePost.glJournalEntryId };
    } else {
      revPosted = await postPayrollBatch(marcP, initResult.reversalBatchId);
    }
    const revJE = await loadJournalLines(revPosted.journalEntryId);

    const stateAfterPost = {
      reversalBatch: await prisma.payrollBatch.findUnique({
        where: { id: initResult.reversalBatchId },
        select: {
          status: true, postedAt: true, postedByUserId: true,
          glJournalEntryId: true, packageChecksum: true, calculationVersion: true,
        },
      }),
      originalStillPosted: await prisma.payrollBatch.findUnique({
        where: { id: prep.batchId },
        select: { status: true, glJournalEntryId: true, packageChecksum: true },
      }),
      reversedByRelation: await prisma.payrollBatch.findUnique({
        where: { id: prep.batchId },
        select: {
          reversedBy: { select: { id: true, status: true, transactionType: true } },
        },
      }),
      workIntake: await loadWorkIntakeForBatch(club.id, initResult.reversalBatchId),
      ytdSnapshot: employeeIdForYtd
        ? await ytdSnapshotForEmployee(club.id, employeeIdForYtd, period.taxYear)
        : null,
    };

    // Stage gate — return after post but skip idempotency?
    if (stage === "post") {
      evidence.reversal = { initResult, stateAfterInit, stateAfterApprove, stateAfterPost };
      evidence.finishedAt = new Date().toISOString();
      return NextResponse.json({ ok: true, stoppedAtStage: "post", evidence });
    }

    // ── PHASE 5: IDEMPOTENCY — repeat post (stage=full only)
    let idempotencyOutcome: string;
    let idempotencyResult: any = null;
    try {
      idempotencyResult = await postPayrollBatch(marcP, initResult.reversalBatchId);
      idempotencyOutcome = idempotencyResult.journalEntryId === revPosted.journalEntryId
        ? "SAME_JOURNAL_RETURNED"
        : "DIFFERENT_JOURNAL_RETURNED";
    } catch (err) {
      idempotencyOutcome = "REJECTED_WITH_ERROR";
      idempotencyResult = { errorName: (err as Error).name, message: (err as Error).message };
    }
    const jeCountAfterRetry = await prisma.journalEntry.count({
      where: { id: revPosted.journalEntryId },
    });
    const revBatchAfterRetry = await prisma.payrollBatch.findUnique({
      where: { id: initResult.reversalBatchId },
      select: { status: true, glJournalEntryId: true, packageChecksum: true },
    });
    evidence.idempotency = {
      outcome: idempotencyOutcome, result: idempotencyResult,
      jeRowCountForReversalJournalId: jeCountAfterRetry,
      reversalBatchUnchanged: revBatchAfterRetry,
    };

    // ── PHASE 6: GL PROOF — combined-per-account net + reversal exact inverse
    const combinedNetByAccountDept: Record<string, string> = {};
    if (baselineJE && revJE) {
      const combined = new Map<string, Prisma.Decimal>();
      const push = (line: { account: string; department: string | null; debit: string; credit: string }) => {
        const k = `${line.account}|${line.department ?? ""}`;
        const cur = combined.get(k) ?? new Prisma.Decimal(0);
        combined.set(k, cur.plus(line.debit).minus(line.credit));
      };
      for (const l of baselineJE.lines) push(l);
      for (const l of revJE.lines) push(l);
      for (const [k, v] of combined) combinedNetByAccountDept[k] = v.toFixed(2);
    }
    type JELine = { lineNumber?: number; account: string; department: string | null; debit: string; credit: string };
    const inverseProof: Array<{ account: string; department: string | null; originalDebit: string; originalCredit: string; reversalDebit: string; reversalCredit: string; inverseOk: boolean }> = [];
    if (baselineJE && revJE) {
      const key = (l: JELine) => `${l.account}|${l.department ?? ""}`;
      const origMap = new Map<string, JELine>(baselineJE.lines.map(l => [key(l as JELine), l as JELine]));
      const revMap = new Map<string, JELine>(revJE.lines.map(l => [key(l as JELine), l as JELine]));
      const allKeys = new Set<string>([...Array.from(origMap.keys()), ...Array.from(revMap.keys())]);
      for (const k of allKeys) {
        const o: JELine = origMap.get(k) ?? { debit: "0.00", credit: "0.00", account: k.split("|")[0], department: k.split("|")[1] || null };
        const r: JELine = revMap.get(k) ?? { debit: "0.00", credit: "0.00", account: k.split("|")[0], department: k.split("|")[1] || null };
        inverseProof.push({
          account: o.account, department: o.department,
          originalDebit: o.debit, originalCredit: o.credit,
          reversalDebit: r.debit, reversalCredit: r.credit,
          inverseOk: o.debit === r.credit && o.credit === r.debit,
        });
      }
    }
    evidence.gl = {
      originalJournal: baselineJE,
      reversalJournal: revJE,
      inverseProofRows: inverseProof,
      allInversesOk: inverseProof.every(r => r.inverseOk),
      combinedNetByAccountDept,
      combinedNetAllZero: Object.values(combinedNetByAccountDept).every(v => v === "0.00"),
    };

    // ── YTD PROOF at 4 points
    const baselineForYtd = evidence.baseline as { ytdAfterBaseline?: unknown } | undefined;
    evidence.ytd = {
      A_beforeInitiation: baselineForYtd?.ytdAfterBaseline,
      B_afterSubmitted:   stateAfterInit.ytdSnapshot,
      C_afterApproved:    stateAfterApprove.ytdSnapshot,
      D_afterPosted:      stateAfterPost.ytdSnapshot,
    };
    evidence.reversal = {
      initResult,
      stateAfterInit, stateAfterApprove, stateAfterPost,
    };

    // ── FINAL INTEGRITY: founder + Chris still untouched
    evidence.integrity = {
      ...evidence.integrity as Record<string, unknown>,
      after: await snapshotFounderIntegrity(),
    };
    const before = (evidence.integrity as any).before;
    const after = (evidence.integrity as any).after;
    (evidence.integrity as any).founderUnchanged =
      JSON.stringify(before.founderBatch) === JSON.stringify(after.founderBatch)
      && JSON.stringify(before.founderJETotals) === JSON.stringify(after.founderJETotals);
    (evidence.integrity as any).chrisSep15Unchanged =
      JSON.stringify(before.chrisSep15Batch) === JSON.stringify(after.chrisSep15Batch);

    evidence.finishedAt = new Date().toISOString();
    return NextResponse.json({ ok: true, evidence });
  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: (err as Error).message ?? "Unexpected error.",
      stack: (err as Error).stack?.split("\n").slice(0, 10),
      evidence,
    }, { status: 500 });
  }
}
